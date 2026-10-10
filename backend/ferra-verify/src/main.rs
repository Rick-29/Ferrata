//! `ferra-verify`: standalone verifier over a Ferra chain file. Exit code 0 = intact, 1 = tampered,
//! 2 = usage / read error.

#![allow(clippy::print_stdout, clippy::print_stderr, clippy::print_literal)]

use std::collections::BTreeSet;
use std::io::BufReader;
use std::path::PathBuf;
use std::process::ExitCode;

use clap::Parser;
use sq_adapters::chain::{JsonlBlockStore, MockChain, TxKind};
use sq_connectors::SourceRegistry;
use sq_connectors::provenance::{self, Watchlists};

/// Verify a Ferra chain file with nothing but the file: rebuild it, re-check every hash,
/// signature and state root, and optionally explain what is on it.
#[derive(Parser, Debug)]
#[command(name = "ferra-verify", version, about)]
struct Cli {
    /// The NDJSON chain file written by the service (`SQ_CHAIN_FILE`).
    chain: PathBuf,
    /// One line per event: kind, network, the wallet's risk level, the reviewed risk, flags.
    #[arg(long)]
    events: bool,
    /// Each account's profile and behaviour findings (offline).
    #[arg(long)]
    behaviour: bool,
    /// For every external event, the counterparty's standing on its origin network (needs the network).
    #[arg(long)]
    provenance: bool,
    /// Use TON mainnet instead of testnet for `--provenance`.
    #[arg(long)]
    ton_mainnet: bool,
}

fn run(cli: &Cli) -> Result<bool, String> {
    let file = std::fs::File::open(&cli.chain).map_err(|e| format!("{}: {e}", cli.chain.display()))?;
    let loaded = JsonlBlockStore::parse(BufReader::new(file)).map_err(|e| e.to_string())?;
    let header = loaded.header.clone().ok_or("no header record: not a self-contained ferra-chain file")?;
    println!("ferra-chain v{}  chain_id={}  network={}  blocks={}", header.format_version, header.chain_id, header.network.name, loaded.blocks.len());
    println!("cosigner  {}", header.cosigner);
    println!("validator {}", header.validator);

    let chain = match MockChain::from_loaded(&loaded) {
        Ok(c) => c,
        Err(e) => {
            println!("TAMPERED  {e}");
            return Ok(false);
        }
    };
    let head = chain.latest();
    println!("OK  head={}  state_root={}", head.hash, head.state_root);
    let v = chain.validation(5);
    println!("validated {}/{} events ({:.0}%), {} pending", v.validated, v.validatable, v.percent, v.pending);
    let now = head.timestamp;
    let events = chain.events();

    if cli.events {
        println!("\n{:>5}  {:<16} {:<16} {:<9} {:<9} {}", "block", "kind", "network", "wallet", "reviewed", "flags");
        for tx in &events {
            println!(
                "{:>5}  {:<16} {:<16} {:<9} {:<9} {}",
                tx.block_number,
                format!("{:?}", tx.kind).to_lowercase(),
                tx.network.name,
                tx.risk_level.map(|r| format!("{r:?}")).unwrap_or_else(|| "-".into()),
                tx.reviewed_risk.map(|r| format!("{r:?}")).unwrap_or_else(|| "-".into()),
                tx.flags.iter().map(|f| f.code.as_str()).collect::<Vec<_>>().join(",")
            );
        }
    }

    if cli.behaviour {
        let accounts: BTreeSet<_> = events.iter().filter(|t| t.kind == TxKind::AccountCreated).map(|t| t.from).collect();
        for a in accounts {
            let p = chain.profile(a, now);
            println!(
                "\naccount {a}\n  archetype={:?} activity={:?} out={} in={} mean_out={:.2} p95_out={:.2} holding={:.0}% cancel_rate={:.0}% settings_changes={} own_limit={}%",
                p.archetype, p.activity, p.out_count, p.in_count, p.mean_out, p.p95_out, p.holding_ratio * 100.0, p.cancel_rate * 100.0, p.settings_changes, p.settings.per_tx_limit_pct
            );
            for f in chain.behaviour_findings(a, now) {
                println!("  {:<9} {:<22} block {}  {}", format!("{:?}", f.severity), f.code, events.iter().find(|t| t.hash == f.target).map(|t| t.block_number).unwrap_or(0), f.message);
            }
        }
    }

    if cli.provenance {
        let tonapi = std::env::var("SQ_TONAPI_KEY").ok();
        let toncenter = std::env::var("SQ_TONCENTER_API_KEY").ok();
        let mut sources = SourceRegistry::new()
            .register(Box::new(sq_conn_ton::TonSource::new(!cli.ton_mainnet, tonapi.clone(), toncenter.clone())))
            .register(Box::new(sq_conn_ton::TonSource::new(cli.ton_mainnet, tonapi, toncenter)))
            .register(Box::new(sq_conn_btc::EsploraBitcoinSource::testnet()))
            .register(Box::new(sq_conn_btc::EsploraBitcoinSource::mainnet()))
            .register(Box::new(sq_conn_sol::SolanaSource::new(true, None)))
            .register(Box::new(sq_conn_sol::SolanaSource::new(false, None)));
        for s in sq_conn_evm::well_known() {
            sources = sources.register(Box::new(s));
        }
        let lists = Watchlists::default();
        let rt = tokio::runtime::Runtime::new().map_err(|e| e.to_string())?;
        println!("\nprovenance (origin-network check of each external event's counterparty)");
        for tx in events.iter().filter(|t| t.kind == TxKind::External) {
            let Ok(source) = sources.get(&tx.network.name) else {
                println!("  block {:>4}  {:<16} no connector for this network", tx.block_number, tx.network.name);
                continue;
            };
            match rt.block_on(provenance::assess(source, tx, &lists, 50)) {
                Ok(a) => println!(
                    "  block {:>4}  {:<16} {:<9} score={:<3} checked={:<3} {} {}{}",
                    tx.block_number,
                    a.network.name,
                    format!("{:?}", a.risk),
                    a.score,
                    a.events_checked,
                    a.counterparty.chars().take(24).collect::<String>(),
                    a.reasons.iter().map(|r| r.code.as_str()).collect::<Vec<_>>().join(","),
                    a.counterparty_info.as_ref().and_then(|i| i.name.clone()).map(|n| format!("  ({n})")).unwrap_or_default()
                ),
                Err(e) => println!("  block {:>4}  error: {e}", tx.block_number),
            }
        }
    }
    Ok(true)
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    match run(&cli) {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::from(1),
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::from(2)
        }
    }
}
