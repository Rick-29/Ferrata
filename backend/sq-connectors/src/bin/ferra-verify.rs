//! Standalone verifier over a Ferra chain file.
//!
//! ```text
//! ferra-verify chain.jsonl                 integrity: rebuild, re-check every hash, signature, state root
//! ferra-verify chain.jsonl --events        … plus one line per event (wallet risk, reviewed risk, flags)
//! ferra-verify chain.jsonl --behaviour     … plus each account's profile and behaviour findings (offline)
//! ferra-verify chain.jsonl --provenance    … plus, for external events, the counterparty's standing
//!                                          on its origin network (needs the network; TON, Bitcoin, Base Sepolia)
//! ```
//! Exit code 0 = intact, 1 = tampered, 2 = usage / read error.

#![allow(clippy::print_stdout, clippy::print_stderr, clippy::print_literal)]

use std::collections::BTreeSet;
use std::io::BufReader;
use std::process::ExitCode;

use sq_adapters::chain::{JsonlBlockStore, MockChain, TxKind};
use sq_connectors::{SourceRegistry, provenance};

struct Opts {
    events: bool,
    behaviour: bool,
    provenance: bool,
}

fn run(path: &str, o: &Opts) -> Result<bool, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("{path}: {e}"))?;
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
    let now = head.timestamp;
    let events = chain.events();

    if o.events {
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

    if o.behaviour {
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

    if o.provenance {
        let sources = SourceRegistry::new()
            .register(Box::new(sq_connectors::ton::TonCenterSource::new(true, std::env::var("SQ_TONCENTER_API_KEY").ok())))
            .register(Box::new(sq_connectors::bitcoin::EsploraSource::new(true)))
            .register(Box::new(sq_connectors::evm::BlockscoutSource::base_sepolia()));
        let rt = tokio::runtime::Runtime::new().map_err(|e| e.to_string())?;
        println!("\nprovenance (origin-network check of each external event's counterparty)");
        for tx in events.iter().filter(|t| t.kind == TxKind::External) {
            let Ok(source) = sources.get(&tx.network.name) else {
                println!("  block {:>4}  {:<16} no connector for this network", tx.block_number, tx.network.name);
                continue;
            };
            match rt.block_on(provenance::assess(source, tx, &[], 50)) {
                Ok(a) => println!(
                    "  block {:>4}  {:<16} {:<9} score={:<3} checked={:<3} {} {}",
                    tx.block_number,
                    a.network.name,
                    format!("{:?}", a.risk),
                    a.score,
                    a.events_checked,
                    a.counterparty.chars().take(24).collect::<String>(),
                    a.reasons.iter().map(|r| r.code.as_str()).collect::<Vec<_>>().join(",")
                ),
                Err(e) => println!("  block {:>4}  error: {e}", tx.block_number),
            }
        }
    }
    Ok(true)
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(path) = args.iter().find(|a| !a.starts_with("--")) else {
        eprintln!("usage: ferra-verify <chain.jsonl> [--events] [--behaviour] [--provenance]");
        return ExitCode::from(2);
    };
    let has = |f: &str| args.iter().any(|a| a == f);
    let opts = Opts { events: has("--events"), behaviour: has("--behaviour"), provenance: has("--provenance") };
    match run(path, &opts) {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::from(1),
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::from(2)
        }
    }
}
