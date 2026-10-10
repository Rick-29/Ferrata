//! `ferra-report`: transfer reports as JSON, one per `<network>:<from>:<to>` pair.

#![allow(clippy::print_stdout, clippy::print_stderr)]

use std::path::PathBuf;
use std::process::ExitCode;

use clap::Parser;
use serde::Deserialize;
use sq_connectors::SourceRegistry;
use sq_connectors::provenance::Watchlists;
use sq_adapters::{LinearModel, RiskModel};
use sq_connectors::report::{ReportConfig, transfer_report};

/// Report everything the connected indexers know about transfers from one address to another:
/// both parties, each transfer with date / amount / fee, where the sender got the money, the
/// sender's recent activity and a provenance verdict on the receiver. Same JSON on every network.
#[derive(Parser, Debug)]
#[command(name = "ferra-report", version, about = "Transfer reports from live indexers as JSON: parties, transfers, funding sources, receiver provenance")]
struct Cli {
    /// Pairs as `<network>:<from>:<to>`. Networks: ton, ton-testnet, bitcoin, bitcoin-testnet, solana, solana-devnet, eth-sepolia, base-sepolia, ethereum.
    #[arg(value_name = "NETWORK:FROM:TO")]
    pairs: Vec<String>,
    /// JSON file with `[{ "network": "...", "from": "...", "to": "..." }, …]`.
    #[arg(long, value_name = "FILE")]
    file: Option<PathBuf>,
    /// Pages of the sender's history to scan (50 events each).
    #[arg(long, default_value_t = 4)]
    pages: u32,
    /// Funding sources listed per transfer.
    #[arg(long, default_value_t = 5)]
    max_funding: usize,
    /// Skip the exposure trace on the receiver (fewer requests).
    #[arg(long)]
    no_exposure: bool,
    /// Write the JSON here instead of stdout.
    #[arg(long, value_name = "FILE")]
    out: Option<PathBuf>,
    /// Risk model to score each transfer with (`fixtures/model.json`); heuristics only when absent.
    #[arg(long, value_name = "FILE", default_value = "../fixtures/model.json")]
    model: PathBuf,
}

#[derive(Debug, Deserialize)]
struct Pair {
    network: String,
    from: String,
    to: String,
}

fn registry() -> SourceRegistry {
    let tonapi = std::env::var("SQ_TONAPI_KEY").ok();
    let toncenter = std::env::var("SQ_TONCENTER_API_KEY").ok();
    let mut reg = SourceRegistry::new()
        .register(Box::new(sq_conn_ton::TonSource::new(true, tonapi.clone(), toncenter.clone())))
        .register(Box::new(sq_conn_ton::TonSource::new(false, tonapi, toncenter)))
        .register(Box::new(sq_conn_btc::EsploraBitcoinSource::testnet()))
        .register(Box::new(sq_conn_btc::EsploraBitcoinSource::mainnet()))
        .register(Box::new(sq_conn_sol::SolanaSource::new(true, std::env::var("SQ_SOLANA_RPC").ok())))
        .register(Box::new(sq_conn_sol::SolanaSource::new(false, std::env::var("SQ_SOLANA_RPC").ok())));
    for s in sq_conn_evm::well_known() {
        reg = reg.register(Box::new(s));
    }
    reg
}

fn pairs(cli: &Cli) -> Result<Vec<Pair>, String> {
    let mut out = Vec::new();
    if let Some(path) = &cli.file {
        let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
        let list: Vec<Pair> = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
        out.extend(list);
    }
    for a in &cli.pairs {
        let mut parts = a.splitn(3, ':');
        let network = parts.next().unwrap_or_default().to_string();
        let from = parts.next().ok_or_else(|| format!("{a}: expected network:from:to"))?.to_string();
        let to = parts.next().ok_or_else(|| format!("{a}: expected network:from:to"))?.to_string();
        out.push(Pair { network, from, to });
    }
    if out.is_empty() {
        return Err("no pairs given: pass NETWORK:FROM:TO arguments or --file".into());
    }
    Ok(out)
}

pub fn main() -> ExitCode {
    let cli = Cli::parse();
    let pairs = match pairs(&cli) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("error: {e}");
            return ExitCode::from(2);
        }
    };
    let cfg = ReportConfig { max_pages: cli.pages, max_funding_sources: cli.max_funding, with_exposure: !cli.no_exposure, ..Default::default() };
    let reg = registry();
    let lists = Watchlists::default();
    let model: Option<Box<dyn RiskModel>> = match LinearModel::load(&cli.model) {
        Ok(m) => Some(Box::new(m)),
        Err(e) => {
            eprintln!("note: no model loaded ({e}); heuristics only");
            None
        }
    };
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let rt = match tokio::runtime::Runtime::new() {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("error: {e}");
            return ExitCode::from(2);
        }
    };
    let mut reports = Vec::new();
    for p in &pairs {
        eprintln!("· {} {} → {}", p.network, p.from, p.to);
        let source = match reg.get(&p.network) {
            Ok(s) => s,
            Err(e) => {
                reports.push(serde_json::json!({ "network": p.network, "from_input": p.from, "to_input": p.to, "error": e.to_string() }));
                continue;
            }
        };
        match rt.block_on(transfer_report(source, &p.from, &p.to, &lists, cfg, model.as_deref(), now)) {
            Ok(r) => reports.push(serde_json::to_value(&r).unwrap_or_default()),
            Err(e) => reports.push(serde_json::json!({ "network": p.network, "from_input": p.from, "to_input": p.to, "error": e.to_string() })),
        }
    }
    let text = serde_json::to_string_pretty(&reports).unwrap_or_default();
    match &cli.out {
        Some(path) => match std::fs::write(path, &text) {
            Ok(()) => eprintln!("wrote {}", path.display()),
            Err(e) => {
                eprintln!("error: {}: {e}", path.display());
                return ExitCode::from(2);
            }
        },
        None => println!("{text}"),
    }
    ExitCode::SUCCESS
}
