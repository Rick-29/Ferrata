//! Offline pipeline over the bundled demo chains: open, verify, report, graph, detail, exports.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use ferra_visualizer_lib::graph;
use ferra_visualizer_lib::online::Online;
use ferra_visualizer_lib::report;
use ferra_visualizer_lib::state::{AppState, NodeRef, open_file};

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures")
}

fn state() -> AppState {
    AppState { opened: Mutex::new(None), verdicts: Mutex::new(Default::default()), auto: Mutex::new(Default::default()), online: Arc::new(Online::new(Some(fixtures()))), recent: Mutex::new(Vec::new()), data_dir: std::env::temp_dir().join("ferra-visualizer-test") }
}

#[test]
fn opens_and_verifies_demo_chains() {
    for (file, min_events) in [("ferra-testnet.jsonl", 300), ("ferra-mainnet.jsonl", 450), ("ferra-testnet.validated.jsonl", 300)] {
        let o = open_file(&fixtures().join("chains").join(file)).unwrap();
        assert!(o.verification.ok, "{file}: {:?}", o.verification.reason);
        assert!(o.events.len() >= min_events, "{file}: {} events", o.events.len());
        assert_eq!(o.wallets.len(), 1, "{file}: one simulated owner");
        assert!(o.events.iter().all(|e| e.trusted));
        let validatable = o.events.iter().filter(|e| e.validatable).count();
        assert!(validatable > 100);
        assert!(!o.aliases.is_empty(), "{file}: the wallet has addresses on other networks");
        let ext = o.events.iter().find(|e| e.tx.kind == sq_adapters::chain::TxKind::External).unwrap();
        assert!(ext.amount_units > 0.0, "{file}: external amount decoded");
        assert!(ext.counterparty.is_some());
        println!("{file}: blocks={} events={} validatable={} aliases={:?}", o.blocks_total, o.events.len(), validatable, o.aliases.keys().collect::<Vec<_>>());
    }
}

#[test]
fn validated_chain_has_verdicts_and_report_orders_attention() {
    let o = open_file(&fixtures().join("chains").join("ferra-testnet.validated.jsonl")).unwrap();
    let v = o.chain.validation(5);
    assert!(v.percent > 50.0, "validated {}%", v.percent);
    let r = report::build(&o, &o.events);
    assert!(!r.flag_summary.is_empty());
    assert!(r.flag_summary.iter().any(|f| f.code == "VALIDATED"));
    let ranks: Vec<u8> = r.attention.iter().map(|a| ferra_visualizer_lib::state::band_rank(a.risk)).collect();
    assert!(ranks.windows(2).all(|w| w[0] >= w[1]), "attention sorted by band");
    assert_eq!(r.profiles.len(), 1);
    assert_eq!(r.profiles[0].profile.hour_histogram.len(), 24);
    let total: u64 = r.distribution.bands.iter().map(|b| b.count).sum();
    assert_eq!(total, r.file.validatable);
    println!("validation {:.1}%  flags {:?}", v.percent, r.flag_summary.iter().map(|f| (f.code.clone(), f.count)).collect::<Vec<_>>());
    println!("top attention: {:?}", r.attention.iter().take(3).map(|a| (a.risk, a.kind, a.amount_units, a.asset_symbol.clone())).collect::<Vec<_>>());
}

#[test]
fn tampered_file_opens_with_a_break() {
    let src = std::fs::read_to_string(fixtures().join("chains").join("ferra-testnet.jsonl")).unwrap();
    let mut lines: Vec<String> = src.lines().map(String::from).collect();
    let n = lines.len();
    // Flip one byte of a hash deep in the file.
    let target = n / 2;
    let line = &lines[target];
    let idx = line.find("\"parent_hash\":\"0x").unwrap() + 17;
    let digit = line.as_bytes()[idx];
    let replacement = if digit == b'a' { "b" } else { "a" };
    lines[target].replace_range(idx..idx + 1, replacement);
    let path = std::env::temp_dir().join("ferra-tampered-test.jsonl");
    std::fs::write(&path, lines.join("\n")).unwrap();
    let o = open_file(&path).unwrap();
    assert!(!o.verification.ok);
    let bad = o.verification.first_bad_block.unwrap();
    assert!(bad > 0 && bad < n as u64);
    assert!(o.events.iter().any(|e| !e.trusted));
    assert!(o.events.iter().any(|e| e.trusted));
    assert!(o.events.iter().filter(|e| !e.trusted).all(|e| e.tx.block_number >= bad));
    println!("tampered at block {bad}: {}", o.verification.reason.as_deref().unwrap_or(""));
}

#[tokio::test]
async fn graph_expands_offline_and_explains() {
    let st = state();
    let o = open_file(&fixtures().join("chains").join("ferra-mainnet.jsonl")).unwrap();
    let wallet = NodeRef::ferra(o.ferra_network(), o.wallets[0]).id;
    *st.opened.lock().unwrap() = Some(o);

    let x = graph::expand(&st, &wallet, None, 30, false).await.unwrap();
    assert!(x.root.is_wallet);
    assert!(!x.edges.is_empty());
    assert!(!x.nodes.is_empty());
    assert!(x.edges.windows(2).all(|w| w[0].timestamp >= w[1].timestamp), "newest first");
    assert!(x.edges.iter().all(|e| e.from == wallet || e.to == wallet));
    println!("wallet {wallet}: {} edges, {} neighbours, aliases {:?}, source {}", x.edges.len(), x.nodes.len(), x.root.aliases.iter().map(|a| a.id.clone()).collect::<Vec<_>>(), x.source);

    // Expand the most recent counterparty: its chain edges come back, offline says so.
    let first = x.nodes.iter().max_by_key(|n| n.last_seen).unwrap();
    let y = graph::expand(&st, &first.id, None, 30, false).await.unwrap();
    assert_eq!(y.root.id, first.id);
    assert!(y.edges.iter().all(|e| e.from == first.id || e.to == first.id));
    assert!(y.source.contains("offline"));

    // Expanding one of the wallet's aliases resolves to the wallet node.
    let alias = x.root.aliases[0].id.clone();
    let z = graph::expand(&st, &alias, None, 30, false).await.unwrap();
    assert_eq!(z.root.id, wallet);

    let i = graph::insight(&st, &first.id, false).await.unwrap();
    assert!(!i.events.is_empty());
    assert!(!i.reasons.is_empty());
    assert!(i.preview.is_none());
    println!("insight {}: {:?}", first.id, i.reasons.iter().map(|r| (r.code.clone(), r.severity)).collect::<Vec<_>>());
}

#[test]
fn reported_addresses_are_linked_to_events() {
    let o = open_file(&fixtures().join("chains").join("ferra-mainnet.jsonl")).unwrap();
    let r = report::build(&o, &o.events);
    for rep in &r.reported {
        assert!(rep.node_id.contains(':'));
        println!("reported {} x{} -> {} events", rep.node_id, rep.reported.count, rep.events.len());
    }
    let with_reports = o.events.iter().filter(|e| e.counterparty_reports > 0).count();
    assert_eq!(with_reports > 0, !r.reported.is_empty());
}

/// Hits the public TON indexer: run by hand with `cargo test -- --ignored online`.
#[tokio::test]
#[ignore]
async fn online_expand_and_insight() {
    let st = state();
    let o = open_file(&fixtures().join("chains").join("ferra-mainnet.jsonl")).unwrap();
    let wallet = NodeRef::ferra(o.ferra_network(), o.wallets[0]).id;
    *st.opened.lock().unwrap() = Some(o);
    let x = graph::expand(&st, &wallet, None, 20, true).await.unwrap();
    println!("source={} edges={} nodes={} notes={:?} next={:?}", x.source, x.edges.len(), x.nodes.len(), x.notes, x.next_cursor);
    let observed = x.edges.iter().filter(|e| !e.on_chain).count();
    println!("observed-only edges: {observed}; root label={:?} labels={:?}", x.root.label, x.root.labels);
    let cp = x.nodes.iter().find(|n| n.network == "ton").unwrap();
    let y = graph::expand(&st, &cp.id, None, 20, true).await.unwrap();
    println!("counterparty {}: source={} edges={} nodes={} notes={:?}", cp.id, y.source, y.edges.len(), y.nodes.len(), y.notes);
    let i = graph::insight(&st, &cp.id, true).await.unwrap();
    println!("insight reasons={:?} preview_error={:?}", i.reasons.iter().map(|r| r.code.clone()).collect::<Vec<_>>(), i.preview_error);
    if let Some(p) = &i.preview {
        println!("preview: band={:?} odds={:.1} summary={}", p.band, p.odds_vs_baseline, p.summary);
    }
}

/// Writes browser-preview fixtures to `app/public/mock` so the UI can run outside the Tauri window
/// (Figma preview, plain `pnpm dev`). Run with `cargo test -- --ignored dump_mock`.
#[tokio::test]
#[ignore]
async fn dump_mock() {
    use std::collections::BTreeMap;
    let st = state();
    let o = open_file(&fixtures().join("chains").join("ferra-mainnet.jsonl")).unwrap();
    let out = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../public/mock");
    std::fs::create_dir_all(&out).unwrap();
    let summary = ferra_visualizer_lib::commands::ChainSummary { file: report::file_info(&o), header: o.header.clone(), verification: o.verification.clone(), validation: o.chain.validation(20) };
    std::fs::write(out.join("summary.json"), serde_json::to_string(&summary).unwrap()).unwrap();
    std::fs::write(out.join("report.json"), serde_json::to_string(&report::build(&o, &o.events)).unwrap()).unwrap();
    std::fs::write(out.join("events.json"), serde_json::to_string(&o.events).unwrap()).unwrap();
    let wallet = NodeRef::ferra(o.ferra_network(), o.wallets[0]).id;
    *st.opened.lock().unwrap() = Some(o);
    let mut expansions: BTreeMap<String, serde_json::Value> = BTreeMap::new();
    let mut insights: BTreeMap<String, serde_json::Value> = BTreeMap::new();
    // Every page of the wallet's chain transfers, keyed `id|cursor` so the preview can page.
    let mut neighbours: Vec<String> = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let x = graph::expand(&st, &wallet, cursor.clone(), 24, false).await.unwrap();
        neighbours.extend(x.nodes.iter().map(|n| n.id.clone()));
        let next = x.next_cursor.clone();
        expansions.insert(format!("{wallet}|{}", cursor.clone().unwrap_or_default()), serde_json::to_value(x).unwrap());
        match next {
            Some(c) => cursor = Some(c),
            None => break,
        }
    }
    insights.insert(wallet.clone(), serde_json::to_value(graph::insight(&st, &wallet, false).await.unwrap()).unwrap());
    for (i, id) in neighbours.iter().enumerate() {
        let x = graph::expand(&st, id, None, 24, false).await.unwrap();
        if i < 12 {
            for n in &x.nodes {
                let key = format!("{}|", n.id);
                if !expansions.contains_key(&key) {
                    expansions.insert(key, serde_json::to_value(graph::expand(&st, &n.id, None, 24, false).await.unwrap()).unwrap());
                }
            }
        }
        expansions.insert(format!("{id}|"), serde_json::to_value(x).unwrap());
        if i < 40 {
            insights.insert(id.clone(), serde_json::to_value(graph::insight(&st, id, false).await.unwrap()).unwrap());
        }
    }
    std::fs::write(out.join("expand.json"), serde_json::to_string(&expansions).unwrap()).unwrap();
    std::fs::write(out.join("insight.json"), serde_json::to_string(&insights).unwrap()).unwrap();
    println!("wrote {} expansions, {} insights to {}", expansions.len(), insights.len(), out.display());
}
