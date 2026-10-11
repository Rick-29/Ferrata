//! `ferra-report`: transfer reports as JSON, one per `<network>:<from>:<to>` pair.

#![allow(clippy::print_stdout, clippy::print_stderr)]

use std::path::PathBuf;
use std::process::ExitCode;

use clap::Parser;
use serde::Deserialize;
use sq_connectors::provenance::Watchlists;
use sq_adapters::{LinearModel, RiskModel};
use sq_connectors::report::{ReportConfig, transfer_report};

/// Report everything the connected indexers know about transfers from one address to another:
/// both parties, each transfer with date / amount / fee, where the sender got the money, the
/// sender's recent activity and a provenance verdict on the receiver. Same JSON on every network.
#[derive(Parser, Debug)]
#[command(name = "ferra-report", version, about = "Transfer reports from live indexers as JSON: parties, transfers, funding sources, receiver provenance")]
struct Cli {
    /// Pairs as `<network>:<from>:<to>`. Networks: ton, ton-testnet, bitcoin, bitcoin-testnet, solana, solana-devnet, eth-sepolia, base-sepolia, optimism-sepolia, ethereum, base, arbitrum, optimism, polygon, gnosis, scroll.
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

#[derive(Debug, Clone, Deserialize)]
struct Pair {
    network: String,
    from: String,
    to: String,
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
    let reg = crate::common::registry();
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
    // Every pair is its own tokio task: all of them are researched at once, the per-network
    // in-flight limit inside the connectors keeps public indexers from being burst.
    let reg = std::sync::Arc::new(reg);
    let lists = std::sync::Arc::new(lists);
    let model: Option<std::sync::Arc<dyn RiskModel>> = model.map(std::sync::Arc::from);
    let reports: Vec<serde_json::Value> = rt.block_on(async {
        let mut set = tokio::task::JoinSet::new();
        for (i, p) in pairs.iter().cloned().enumerate() {
            eprintln!("· {} {} → {}", p.network, p.from, p.to);
            let (reg, lists, model) = (reg.clone(), lists.clone(), model.clone());
            set.spawn(async move {
                let value = match reg.get(&p.network) {
                    Err(e) => serde_json::json!({ "network": p.network, "from_input": p.from, "to_input": p.to, "error": e.to_string() }),
                    Ok(source) => match transfer_report(source, &p.from, &p.to, &lists, cfg, model.as_deref(), now).await {
                        Ok(r) => serde_json::to_value(&r).unwrap_or_default(),
                        Err(e) => serde_json::json!({ "network": p.network, "from_input": p.from, "to_input": p.to, "error": e.to_string() }),
                    },
                };
                eprintln!("✓ {} {} → {}", p.network, p.from, p.to);
                (i, value)
            });
        }
        let mut done: Vec<(usize, serde_json::Value)> = Vec::new();
        while let Some(r) = set.join_next().await {
            match r {
                Ok(v) => done.push(v),
                Err(e) => eprintln!("error: task failed: {e}"),
            }
        }
        done.sort_by_key(|(i, _)| *i);
        done.into_iter().map(|(_, v)| v).collect()
    });
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
