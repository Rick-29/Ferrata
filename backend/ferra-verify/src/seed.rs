//! `ferra-seed`: builds a Ferra chain file from real network history, for testing the validator
//! and the verifier on semi-real data.
//!
//! One simulated owner (our user) is created on a fresh chain. Every `to` address of the pairs
//! is treated as one of that owner's addresses on its network: its history is fetched from the
//! public indexers and every event is recorded as a Swissquote-attested `external` event, in
//! chronological order, so the chain reads like a wallet that lived through those transfers.
//! The other side (`from`) stays what it is on the real network: a counterparty to judge.

#![allow(clippy::print_stdout, clippy::print_stderr)]

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::process::ExitCode;

use alloy_primitives::{Bytes, U256, keccak256};
use clap::Parser;
use ed25519_dalek::SigningKey;
use serde::Deserialize;
use sq_adapters::chain::{JsonlBlockStore, MockChain, OwnerKey};
use sq_adapters::{ChainConfig, Ed25519Signer, Network, ReceiptSigner, TokenInfo};
use sq_connectors::ObservedEvent;

/// Build a Ferra chain file whose owner received the given transfers on real networks.
#[derive(Parser, Debug)]
#[command(name = "ferra-seed", version, about = "Seed a Ferra chain file from real network history: one simulated owner, the receivers' addresses as its external addresses")]
struct Cli {
    /// Pairs as `<network>:<from>:<to>`; the `to` side becomes the owner's address on that network.
    #[arg(value_name = "NETWORK:FROM:TO")]
    pairs: Vec<String>,
    /// JSON file with `[{ "network": "...", "from": "...", "to": "..." }, …]`.
    #[arg(long, value_name = "FILE")]
    file: Option<PathBuf>,
    /// Only pairs on these networks (repeatable). Default: all pairs in the input.
    #[arg(long = "network", value_name = "NAME")]
    networks: Vec<String>,
    /// Chain file to write (NDJSON). Refuses to overwrite unless --reset.
    #[arg(long, value_name = "FILE")]
    out: PathBuf,
    /// Delete an existing chain file first.
    #[arg(long)]
    reset: bool,
    /// Pages of history per address (50 events each).
    #[arg(long, default_value_t = 2)]
    pages: u32,
    /// Ferra chain id written in the header (the server's fixtures use 84532).
    #[arg(long, default_value_t = 84532)]
    chain_id: u64,
    /// Swissquote co-signing seed, 32 bytes hex. Default: the dev seed from `dev.sh`.
    #[arg(long, value_name = "HEX", default_value = "1111111111111111111111111111111111111111111111111111111111111111")]
    signing_seed: String,
    /// Validator seed, 32 bytes hex. Default: derived from the signing seed exactly as the server does.
    #[arg(long, value_name = "HEX")]
    validator_seed: Option<String>,
    /// Seed byte of the simulated owner's Ed25519 passkey.
    #[arg(long, default_value_t = 7)]
    owner_seed: u8,
}

#[derive(Debug, Clone, Deserialize)]
struct Pair {
    network: String,
    /// Kept for symmetry with `ferra-report` inputs; the sender stays a real-network counterparty.
    #[allow(dead_code)]
    from: String,
    to: String,
}

fn parse_seed(h: &str) -> Result<[u8; 32], String> {
    let bytes = hex::decode(h.trim().trim_start_matches("0x")).map_err(|e| format!("seed: {e}"))?;
    bytes.try_into().map_err(|_| "seed must be 32 bytes".to_string())
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
        let from = parts.next().unwrap_or_default().to_string();
        let to = parts.next().unwrap_or_default().to_string();
        if network.is_empty() || from.is_empty() || to.is_empty() {
            return Err(format!("bad pair {a:?}: expected NETWORK:FROM:TO"));
        }
        out.push(Pair { network, from, to });
    }
    if !cli.networks.is_empty() {
        out.retain(|p| cli.networks.iter().any(|n| n.eq_ignore_ascii_case(&p.network)));
    }
    if out.is_empty() {
        return Err("no pairs: pass NETWORK:FROM:TO arguments or --file".into());
    }
    Ok(out)
}

pub fn main() -> ExitCode {
    let cli = Cli::parse();
    match run(cli) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::from(2)
        }
    }
}

fn run(cli: Cli) -> Result<(), String> {
    let pairs = pairs(&cli)?;
    if cli.out.exists() {
        if cli.reset {
            std::fs::remove_file(&cli.out).map_err(|e| format!("{}: {e}", cli.out.display()))?;
        } else {
            return Err(format!("{} exists; pass --reset to replace it", cli.out.display()));
        }
    }
    let signing_seed = parse_seed(&cli.signing_seed)?;
    let validator_seed = match &cli.validator_seed {
        Some(h) => parse_seed(h)?,
        None => keccak256([signing_seed.as_slice(), b"validator"].concat()).0,
    };
    let sq = Ed25519Signer::from_seed(signing_seed);
    let rt = tokio::runtime::Runtime::new().map_err(|e| e.to_string())?;
    let reg = crate::common::registry();

    // 1. The owner's addresses on each network: the receivers.
    let mut addresses: BTreeSet<(String, String)> = BTreeSet::new();
    for p in &pairs {
        let source = reg.get(&p.network).map_err(|e| e.to_string())?;
        addresses.insert((p.network.clone(), source.canonical(&p.to)));
    }

    // 2. Their histories, fetched concurrently (one task per address), then merged by time.
    let fetched: Vec<(String, String, Result<Vec<ObservedEvent>, String>)> = rt.block_on(async {
        let mut set = tokio::task::JoinSet::new();
        let reg = std::sync::Arc::new(reg);
        for (network, address) in addresses.iter().cloned() {
            let reg = reg.clone();
            let pages = cli.pages;
            set.spawn(async move {
                let result = async {
                    let source = reg.get(&network).map_err(|e| e.to_string())?;
                    let mut all = Vec::new();
                    let mut cursor: Option<String> = None;
                    for _ in 0..pages {
                        let page = source.fetch(&address, cursor.as_deref(), 50).await.map_err(|e| e.to_string())?;
                        all.extend(page.events);
                        cursor = page.next_cursor;
                        if cursor.is_none() {
                            break;
                        }
                    }
                    Ok::<_, String>(all)
                }
                .await;
                (network, address, result)
            });
        }
        let mut out = Vec::new();
        while let Some(r) = set.join_next().await {
            if let Ok(x) = r {
                out.push(x);
            }
        }
        out
    });

    let mut events: Vec<ObservedEvent> = Vec::new();
    let mut seen: BTreeSet<(String, String)> = BTreeSet::new();
    for (network, address, r) in &fetched {
        match r {
            Ok(evs) => {
                let n = evs.len();
                for ev in evs {
                    if seen.insert((ev.external.network.name.clone(), ev.external.tx_id.clone())) {
                        events.push(ev.clone());
                    }
                }
                eprintln!("· {network} {address}: {n} events");
            }
            Err(e) => eprintln!("· {network} {address}: FAILED ({e})"),
        }
    }
    if events.is_empty() {
        return Err("no events fetched; nothing to seed".into());
    }
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    events.sort_by_key(|e| e.external.timestamp.unwrap_or(now));
    let first = events.iter().filter_map(|e| e.external.timestamp).min().unwrap_or(now);

    // 3. The chain: genesis just before the first real event, one owner, funded, then the events.
    let cfg = ChainConfig {
        chain_id: cli.chain_id,
        network: Network::ferra(cli.chain_id),
        cosigner: sq.verifying_key(),
        escape_delay_secs: 120,
        tokens: vec![TokenInfo { address: alloy_primitives::Address::repeat_byte(0xaa), symbol: "USDC".into(), decimals: 6 }],
        genesis_time: first.saturating_sub(3_600),
    };
    let mut chain = MockChain::new(cfg, SigningKey::from_bytes(&validator_seed), Box::new(JsonlBlockStore::new(cli.out.clone()))).map_err(|e| e.to_string())?;
    let owner_key = SigningKey::from_bytes(&[cli.owner_seed; 32]);
    let owner = OwnerKey::Ed25519 { key: Bytes::copy_from_slice(owner_key.verifying_key().as_bytes()) };
    let t0 = first.saturating_sub(3_000);
    let wallet = chain.create_account(owner, t0).map_err(|e| e.to_string())?;
    chain.fund(wallet, None, U256::from(10u64.pow(18)), t0 + 1).map_err(|e| e.to_string())?;
    chain.fund(wallet, Some(alloy_primitives::Address::repeat_byte(0xaa)), U256::from(500_000_000u64), t0 + 2).map_err(|e| e.to_string())?;

    let mut recorded = 0usize;
    let mut per_network: std::collections::BTreeMap<String, usize> = Default::default();
    for ev in events {
        let at = ev.external.timestamp.unwrap_or(now);
        let hash = chain.external_hash(wallet, &ev.external);
        let cosig = sq.cosign(&hash);
        let name = ev.external.network.name.clone();
        match chain.ingest_external(wallet, ev.external, ev.counterparty, ev.incoming, &cosig, at) {
            Ok(_) => {
                recorded += 1;
                *per_network.entry(name).or_default() += 1;
            }
            Err(e) => eprintln!("skip {name} event: {e}"),
        }
    }

    let v = chain.verify();
    let status = chain.validation(5);
    println!("wrote {}", cli.out.display());
    println!("owner {wallet:#x} (ed25519 seed byte {})", cli.owner_seed);
    println!("addresses: {}", addresses.iter().map(|(n, a)| format!("{n}:{a}")).collect::<Vec<_>>().join(", "));
    println!("events recorded: {recorded}  per network: {}", per_network.iter().map(|(n, c)| format!("{n}={c}")).collect::<Vec<_>>().join(", "));
    println!("blocks: {}  verify: {}  validatable: {}  validated: {}", chain.latest().number + 1, if v.ok { "OK" } else { "FAILED" }, status.validatable, status.validated);
    println!("run the server on it: SQ_CHAIN_FILE={} SQ_SIGNING_SEED={} cargo run -p sq-services", cli.out.display(), cli.signing_seed);
    Ok(())
}
