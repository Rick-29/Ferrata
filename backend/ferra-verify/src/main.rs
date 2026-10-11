//! `ferra-verify`: standalone verifier over a Ferra chain file. Exit code 0 = intact, 1 = tampered,
//! 2 = usage / read error.
//!
//! `--provenance` asks each external counterparty's origin network about it. Counterparties are
//! looked up once however many events they appear in, every lookup is its own tokio task (the
//! connectors cap requests per network so public indexers are not burst), and `--top` keeps the
//! lookups to the counterparties that matter most for a wallet: most events, then most value.

#![allow(clippy::print_stdout, clippy::print_stderr, clippy::print_literal)]

use std::collections::{BTreeMap, BTreeSet};
use std::io::BufReader;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Instant;

use clap::Parser;
use sq_adapters::chain::{ChainTx, ExternalRef, JsonlBlockStore, MockChain, TxKind};
use sq_connectors::provenance::{self, ProvenanceAssessment, Watchlists};

mod common;

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
    /// Only the N counterparties with the most events (then the most value) per network;
    /// 0 = all of them.
    #[arg(long, default_value_t = 0, value_name = "N")]
    top: usize,
    /// Events of the counterparty's own history fetched per lookup.
    #[arg(long, default_value_t = 25, value_name = "EVENTS")]
    depth: u32,
    /// Only these networks for `--provenance` (repeatable).
    #[arg(long = "network", value_name = "NAME")]
    networks: Vec<String>,
    /// Give up on one counterparty lookup after this many seconds (an indexer that keeps
    /// rate-limiting us must not hold the whole run).
    #[arg(long, default_value_t = 90, value_name = "SECS")]
    timeout: u64,
    /// Stage timings on stderr.
    #[arg(long)]
    timing: bool,
    /// Connector logs on stderr (what each indexer answered, retries, rate limits). `RUST_LOG`
    /// overrides the filter.
    #[arg(long, short)]
    verbose: bool,
}

/// One counterparty on one network, as the wallet sees it.
struct Party {
    network: String,
    /// Events it took part in, in chain order.
    events: Vec<ChainTx>,
    /// Sum of the amounts in native units (ranking only).
    value: f64,
}

fn units(amount: &str, decimals: u8) -> f64 {
    amount.parse::<f64>().unwrap_or(0.0) / 10f64.powi(i32::from(decimals))
}

/// External events grouped by their counterparty, so each is looked up once. The key is the
/// connector's canonical form of the address, so two spellings of one address merge too.
fn parties(events: &[ChainTx], registry: &sq_connectors::SourceRegistry, networks: &[String]) -> (Vec<Party>, Vec<String>) {
    let mut by_key: BTreeMap<(String, String), Party> = BTreeMap::new();
    let mut skipped: BTreeSet<String> = BTreeSet::new();
    for tx in events.iter().filter(|t| t.kind == TxKind::External) {
        if !networks.is_empty() && !networks.iter().any(|n| n.eq_ignore_ascii_case(&tx.network.name)) {
            continue;
        }
        let Ok(source) = registry.get(&tx.network.name) else {
            skipped.insert(tx.network.name.clone());
            continue;
        };
        let Some(ext) = tx.extra.get("external").cloned().and_then(|v| serde_json::from_value::<ExternalRef>(v).ok()) else { continue };
        let incoming = tx.extra.get("incoming").and_then(|v| v.as_bool()).unwrap_or(true);
        let raw = if incoming { &ext.from_raw } else { &ext.to_raw };
        let counterparty = source.canonical(raw);
        let value = units(&ext.amount, ext.decimals);
        let p = by_key.entry((tx.network.name.clone(), counterparty)).or_insert_with(|| Party { network: tx.network.name.clone(), events: Vec::new(), value: 0.0 });
        p.events.push(tx.clone());
        p.value += value;
    }
    (by_key.into_values().collect(), skipped.into_iter().collect())
}

/// `--top N`: per network, the N counterparties with the most events, then the most value.
fn keep_top(mut parties: Vec<Party>, top: usize) -> Vec<Party> {
    if top == 0 {
        return parties;
    }
    parties.sort_by(|a, b| a.network.cmp(&b.network).then(b.events.len().cmp(&a.events.len())).then(b.value.partial_cmp(&a.value).unwrap_or(std::cmp::Ordering::Equal)));
    let mut seen: BTreeMap<String, usize> = BTreeMap::new();
    parties.retain(|p| {
        let n = seen.entry(p.network.clone()).or_insert(0);
        *n += 1;
        *n <= top
    });
    parties
}

fn stage(cli: &Cli, t: &mut Instant, what: &str) {
    if cli.timing {
        eprintln!("⏱ {what}: {} ms", t.elapsed().as_millis());
    }
    *t = Instant::now();
}

fn run(cli: &Cli) -> Result<bool, String> {
    let mut t = Instant::now();
    let file = std::fs::File::open(&cli.chain).map_err(|e| format!("{}: {e}", cli.chain.display()))?;
    let loaded = JsonlBlockStore::parse(BufReader::new(file)).map_err(|e| e.to_string())?;
    stage(cli, &mut t, "parse");
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
    stage(cli, &mut t, "replay + verify");
    let head = chain.latest();
    println!("OK  head={}  state_root={}", head.hash, head.state_root);
    let v = chain.validation(5);
    println!("validated {}/{} events ({:.0}%), {} pending", v.validated, v.validatable, v.percent, v.pending);
    let now = head.timestamp;
    let events = chain.events();

    let reported = chain.reported_addresses();
    if !reported.is_empty() {
        println!("reported addresses: {}", reported.len());
        for r in &reported {
            println!("  {:<14} {:<48} {} report(s): {}", r.network, r.address, r.count, r.categories.join(", "));
        }
    }
    stage(cli, &mut t, "summary");

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
        stage(cli, &mut t, "events");
    }

    if cli.behaviour {
        let block_of: BTreeMap<_, _> = events.iter().map(|t| (t.hash, t.block_number)).collect();
        let accounts: BTreeSet<_> = events.iter().filter(|t| t.kind == TxKind::AccountCreated).map(|t| t.from).collect();
        for a in accounts {
            let p = chain.profile(a, now);
            println!(
                "\naccount {a}\n  archetype={:?} activity={:?} out={} in={} mean_out={:.2} p95_out={:.2} holding={:.0}% cancel_rate={:.0}% settings_changes={} own_limit={}%",
                p.archetype, p.activity, p.out_count, p.in_count, p.mean_out, p.p95_out, p.holding_ratio * 100.0, p.cancel_rate * 100.0, p.settings_changes, p.settings.per_tx_limit_pct
            );
            for f in chain.behaviour_findings(a, now) {
                println!("  {:<9} {:<22} block {}  {}", format!("{:?}", f.severity), f.code, block_of.get(&f.target).copied().unwrap_or(0), f.message);
            }
        }
        stage(cli, &mut t, "behaviour");
    }

    if cli.provenance {
        let registry = Arc::new(common::registry());
        let (parties, skipped) = parties(&events, &registry, &cli.networks);
        let total_events: usize = parties.iter().map(|p| p.events.len()).sum();
        let parties = keep_top(parties, cli.top);
        let kept_events: usize = parties.iter().map(|p| p.events.len()).sum();
        println!("\nprovenance: {} counterparties behind {} external events{}", parties.len(), kept_events, if cli.top > 0 { format!(" (top {} per network, {} events in all)", cli.top, total_events) } else { String::new() });
        for n in &skipped {
            println!("  {n:<16} no connector for this network, skipped");
        }
        let lists = Arc::new(Watchlists::default());
        let rt = tokio::runtime::Runtime::new().map_err(|e| e.to_string())?;
        let depth = cli.depth.max(1);
        let timeout = std::time::Duration::from_secs(cli.timeout.max(1));
        let n_parties = parties.len();
        let results: Vec<(usize, Result<ProvenanceAssessment, String>, f64)> = rt.block_on(async {
            let mut set = tokio::task::JoinSet::new();
            for (i, p) in parties.iter().enumerate() {
                // The first event stands for the counterparty: the verdict is about the address,
                // the event only supplies the direction and the wallet's side.
                let Some(tx) = p.events.first().cloned() else { continue };
                let (registry, lists) = (registry.clone(), lists.clone());
                set.spawn(async move {
                    let started = Instant::now();
                    let r = match registry.get(&tx.network.name) {
                        Ok(source) => match tokio::time::timeout(timeout, provenance::assess(source, &tx, &lists, depth)).await {
                            Ok(r) => r.map_err(|e| e.to_string()),
                            Err(_) => Err(format!("timed out after {}s", timeout.as_secs())),
                        },
                        Err(e) => Err(e.to_string()),
                    };
                    (i, r, started.elapsed().as_secs_f64())
                });
            }
            let mut done = Vec::with_capacity(n_parties);
            while let Some(r) = set.join_next().await {
                match r {
                    Ok(x) => {
                        done.push(x);
                        eprint!("\r  {}/{} counterparties checked", done.len(), n_parties);
                    }
                    Err(e) => eprintln!("\n  lookup task failed: {e}"),
                }
            }
            if !done.is_empty() {
                eprintln!();
            }
            done.sort_by_key(|(i, _, _)| *i);
            done
        });
        stage(cli, &mut t, "provenance lookups");

        // Readable order: chain order of the first event the counterparty appears in.
        let mut rows: Vec<(u64, &Party, &Result<ProvenanceAssessment, String>, f64)> = results.iter().map(|(i, r, secs)| (parties[*i].events[0].block_number, &parties[*i], r, *secs)).collect();
        rows.sort_by_key(|(b, _, _, _)| *b);
        for (block, p, r, secs) in rows {
            let blocks: Vec<String> = p.events.iter().map(|e| e.block_number.to_string()).collect();
            let where_ = if blocks.len() <= 6 { blocks.join(",") } else { format!("{},… ({} events)", blocks[..4].join(","), blocks.len()) };
            match r {
                Ok(a) => println!(
                    "  block {:>4}  {:<16} {:<9} score={:<3} checked={:<3} {:<24} {}{}  [{} event(s): {where_}]  {secs:.1}s",
                    block,
                    a.network.name,
                    format!("{:?}", a.risk),
                    a.score,
                    a.events_checked,
                    a.counterparty.chars().take(24).collect::<String>(),
                    a.reasons.iter().map(|r| r.code.as_str()).collect::<Vec<_>>().join(","),
                    a.counterparty_info.as_ref().and_then(|i| i.name.clone()).map(|n| format!("  ({n})")).unwrap_or_default(),
                    p.events.len(),
                ),
                Err(e) => println!("  block {:>4}  {:<16} error: {e}  [{} event(s): {where_}]  {secs:.1}s", block, p.network, p.events.len()),
            }
        }
    }
    Ok(true)
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    if cli.verbose || std::env::var_os("RUST_LOG").is_some() {
        let filter = tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("warn,sq_connectors=debug,sq_conn_ton=debug,sq_conn_evm=debug,sq_conn_btc=debug,sq_conn_sol=debug"));
        tracing_subscriber::fmt().with_env_filter(filter).with_writer(std::io::stderr).with_target(false).compact().init();
    }
    match run(&cli) {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::from(1),
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::from(2)
        }
    }
}
