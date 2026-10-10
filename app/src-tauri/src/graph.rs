//! Manual mode: the chain as a graph of addresses and transfers that grows on demand. Expanding a
//! node returns its transfers newest first and the addresses on the other end; expanding one of
//! those repeats the process, on the Ferra chain from the file and on other networks from their
//! public indexers. Every expansion is self-contained so the canvas can keep adding to itself.

use std::collections::{BTreeMap, HashMap};
use std::time::Instant;

use alloy_primitives::{Address, B256};
use serde::Serialize;
use sq_adapters::chain::{AddressReport, Flag, TxKind};
use sq_connectors::AccountInfo;
use sq_connectors::preview::{RiskPreview, SenderContext};
use sq_connectors::report::ReportConfig;
use wallet_core::RiskBand;

use crate::error::{AppError, AppResult};
use crate::state::{AppState, EventView, NodeRef, Opened, band_rank, external_ref, max_band, reports_index};

#[derive(Debug, Clone, Serialize)]
pub struct GraphNode {
    pub id: String,
    pub network: String,
    pub address: String,
    /// The wallet under review (or one of its addresses on another network).
    pub is_wallet: bool,
    /// Registered on this Ferra chain.
    pub is_account: bool,
    pub label: Option<String>,
    pub labels: Vec<String>,
    pub reports: u64,
    pub report_categories: Vec<String>,
    pub sanctioned: bool,
    /// On the mixer / hack list used by the exposure trace.
    pub flagged: bool,
    /// The origin network's indexer marks it as a scam.
    pub scam: bool,
    /// Worst band seen on chain events involving this address, raised by sanctions / reports.
    pub worst_risk: Option<RiskBand>,
    pub tx_count: u64,
    pub in_count: u64,
    pub out_count: u64,
    pub first_seen: Option<u64>,
    pub last_seen: Option<u64>,
    pub info: Option<AccountInfo>,
    pub sources: Vec<String>,
    /// For the wallet: its addresses on the other networks.
    pub aliases: Vec<NodeRef>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GraphEdge {
    pub id: String,
    pub from: String,
    pub to: String,
    pub network: String,
    pub timestamp: u64,
    pub amount_units: f64,
    pub asset_symbol: String,
    pub fee: Option<f64>,
    pub risk: Option<RiskBand>,
    pub event_hash: Option<B256>,
    pub tx_id: Option<String>,
    pub explorer_url: Option<String>,
    pub flag_codes: Vec<String>,
    /// `cosigned`, `external`, `escape_exit`, `faucet` for chain events; `observed` from an indexer.
    pub kind: String,
    pub scam_flag: bool,
    pub trusted: bool,
    pub on_chain: bool,
}

#[derive(Debug, Serialize)]
pub struct Expansion {
    pub root: GraphNode,
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    /// Pass back to get older indexer transfers; `None` when there is nothing more.
    pub next_cursor: Option<String>,
    pub exhausted: bool,
    /// `chain`, `indexer`, `chain+indexer`, `chain (offline)`.
    pub source: String,
    pub elapsed_ms: u64,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Reason {
    pub code: String,
    pub severity: Option<RiskBand>,
    pub message: String,
    pub events: Vec<B256>,
}

#[derive(Debug, Serialize)]
pub struct NodeInsight {
    pub node: GraphNode,
    pub reports: Vec<AddressReport>,
    pub events: Vec<EventView>,
    pub flags: Vec<Flag>,
    pub reasons: Vec<Reason>,
    pub preview: Option<RiskPreview>,
    pub preview_error: Option<String>,
    pub elapsed_ms: u64,
}

/// `(tx_count, in_count, out_count, first_seen, last_seen)` for one address.
type Counts = (u64, u64, u64, Option<u64>, Option<u64>);

/// Per-address aggregates over the chain events, computed once per request.
struct ChainIndex {
    reports: BTreeMap<String, u64>,
    categories: BTreeMap<String, Vec<String>>,
    risk: HashMap<String, Option<RiskBand>>,
    counts: HashMap<String, Counts>,
}

impl ChainIndex {
    fn build(opened: &Opened) -> Self {
        let reports = reports_index(opened);
        let mut categories = BTreeMap::new();
        for r in opened.chain.reported_addresses() {
            categories.insert(sq_adapters::chain::report_key(&r.network, &r.address), r.categories);
        }
        let mut risk: HashMap<String, Option<RiskBand>> = HashMap::new();
        let mut counts: HashMap<String, Counts> = HashMap::new();
        let mut touch = |id: &str, e: &EventView, incoming_for_node: bool| {
            let r = risk.entry(id.to_string()).or_insert(None);
            *r = max_band(*r, e.effective_risk);
            let c = counts.entry(id.to_string()).or_insert((0, 0, 0, None, None));
            c.0 += 1;
            if incoming_for_node { c.1 += 1 } else { c.2 += 1 }
            c.3 = Some(c.3.map_or(e.tx.timestamp, |t: u64| t.min(e.tx.timestamp)));
            c.4 = Some(c.4.map_or(e.tx.timestamp, |t: u64| t.max(e.tx.timestamp)));
        };
        for e in opened.events.iter().filter(|e| e.validatable || e.tx.kind == TxKind::Faucet) {
            let wallet_id = NodeRef::ferra(opened.ferra_network(), e.wallet).id;
            touch(&wallet_id, e, e.incoming);
            if let Some(c) = &e.counterparty {
                touch(&c.id, e, !e.incoming);
            }
        }
        Self { reports, categories, risk, counts }
    }
}

fn node_from(opened: &Opened, online: &crate::online::Online, idx: &ChainIndex, node: &NodeRef) -> GraphNode {
    let node = opened.resolve_alias(node);
    let key = node.report_key();
    let is_account = node.network == opened.ferra_network() && node.address.parse::<Address>().is_ok_and(|a| opened.chain.has_account(a));
    let is_wallet = node.network == opened.ferra_network() && node.address.parse::<Address>().is_ok_and(|a| opened.wallets.contains(&a));
    let sanctioned = online.is_sanctioned(&node.address);
    let flagged = online.is_flagged(&node.address);
    let reports = idx.reports.get(&key).copied().unwrap_or(0);
    let mut worst = idx.risk.get(&node.id).copied().flatten();
    if sanctioned {
        worst = Some(RiskBand::Critical);
    } else if reports > 0 || flagged {
        worst = max_band(worst, Some(RiskBand::High));
    }
    let (tx_count, in_count, out_count, first_seen, last_seen) = idx.counts.get(&node.id).copied().unwrap_or((0, 0, 0, None, None));
    let aliases = if is_wallet {
        opened.aliases.iter().filter(|(_, v)| **v == node.id).filter_map(|(k, _)| NodeRef::parse(k).ok()).collect()
    } else {
        Vec::new()
    };
    GraphNode {
        id: node.id.clone(),
        network: node.network.clone(),
        address: node.address.clone(),
        is_wallet,
        is_account,
        label: None,
        labels: Vec::new(),
        reports,
        report_categories: idx.categories.get(&key).cloned().unwrap_or_default(),
        sanctioned,
        flagged,
        scam: false,
        worst_risk: worst,
        tx_count,
        in_count,
        out_count,
        first_seen,
        last_seen,
        info: None,
        sources: if tx_count > 0 || is_account { vec!["chain".into()] } else { Vec::new() },
        aliases,
    }
}

/// A chain event as an edge between its wallet and its counterparty.
fn edge_from_event(opened: &Opened, e: &EventView) -> Option<GraphEdge> {
    let cp = e.counterparty.as_ref()?;
    let wallet = NodeRef::ferra(opened.ferra_network(), e.wallet);
    let (from, to) = if e.incoming { (cp.id.clone(), wallet.id) } else { (wallet.id, cp.id.clone()) };
    let ext = external_ref(&e.tx);
    Some(GraphEdge {
        id: format!("chain:{}", e.tx.hash),
        from,
        to,
        network: e.tx.network.name.clone(),
        timestamp: ext.as_ref().and_then(|x| x.timestamp).unwrap_or(e.tx.timestamp),
        amount_units: e.amount_units,
        asset_symbol: e.asset_symbol.clone(),
        fee: ext.as_ref().and_then(|x| x.fee),
        risk: e.effective_risk,
        event_hash: Some(e.tx.hash),
        tx_id: ext.as_ref().map(|x| x.tx_id.clone()),
        explorer_url: ext.as_ref().and_then(|x| x.explorer_url.clone()),
        flag_codes: e.flag_codes.clone(),
        kind: serde_json::to_value(e.tx.kind).ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_default(),
        scam_flag: false,
        trusted: e.trusted,
        on_chain: true,
    })
}

/// Events on the chain that involve `node` (as the wallet or as the counterparty), newest first.
pub fn chain_events_for(opened: &Opened, node: &NodeRef) -> Vec<EventView> {
    let node = opened.resolve_alias(node);
    let wallet_addr: Option<Address> = (node.network == opened.ferra_network()).then(|| node.address.parse().ok()).flatten();
    let mut out: Vec<EventView> = opened
        .events
        .iter()
        .filter(|e| e.validatable || e.tx.kind == TxKind::Faucet)
        .filter(|e| wallet_addr.is_some_and(|w| e.wallet == w) || e.counterparty.as_ref().is_some_and(|c| c.id == node.id))
        .cloned()
        .collect();
    out.sort_by(|a, b| b.tx.timestamp.cmp(&a.tx.timestamp).then(b.tx.block_number.cmp(&a.tx.block_number)));
    out
}

struct LocalPart {
    root: GraphNode,
    nodes: BTreeMap<String, GraphNode>,
    edges: Vec<GraphEdge>,
    ferra_network: String,
    wallet_on_network: Option<String>,
    sender: Option<SenderContext>,
}

fn local_part(state: &AppState, node: &NodeRef, with_sender: Option<&str>) -> AppResult<LocalPart> {
    state.with_chain(|opened| {
        let idx = ChainIndex::build(opened);
        let node = opened.resolve_alias(node);
        let root = node_from(opened, &state.online, &idx, &node);
        let mut nodes = BTreeMap::new();
        let mut edges = Vec::new();
        for e in chain_events_for(opened, &node) {
            if let Some(edge) = edge_from_event(opened, &e) {
                for id in [&edge.from, &edge.to] {
                    if *id != root.id && !nodes.contains_key(id) {
                        let n = NodeRef::parse(id)?;
                        nodes.insert(id.clone(), node_from(opened, &state.online, &idx, &n));
                    }
                }
                edges.push(edge);
            }
        }
        let wallet_on_network = root.aliases.iter().find(|a| a.network == node.network).map(|a| a.address.clone()).or_else(|| {
            // Expanding an external address: the wallet's own address on that network, if any.
            opened.aliases.keys().filter_map(|k| NodeRef::parse(k).ok()).find(|a| a.network == node.network).map(|a| a.address)
        });
        let sender = with_sender.and_then(|network| opened.primary_wallet().map(|w| sender_context(opened, w, network, &node.address)));
        Ok(LocalPart { root, nodes, edges, ferra_network: opened.ferra_network().to_string(), wallet_on_network, sender })
    })
}

/// Expands one node: a page of its chain transfers (from the file, newest first), then, once those
/// run out, pages of indexer history when the node lives on a network with a connector and
/// `online` is allowed. `next_cursor` carries the phase.
pub async fn expand(state: &AppState, id: &str, cursor: Option<String>, limit: u32, online: bool) -> AppResult<Expansion> {
    let started = Instant::now();
    let node = NodeRef::parse(id)?;
    let mut notes = Vec::new();
    let LocalPart { mut root, mut nodes, mut edges, ferra_network, wallet_on_network: _, sender: _ } = local_part(state, &node, None)?;
    let root_ref = NodeRef::parse(&root.id)?;
    // Which raw address to ask the indexer about: the node itself, or (for the wallet) its alias on the requested network.
    let (lookup_network, lookup_address) = if root.is_wallet && root_ref.network == ferra_network {
        match root.aliases.iter().find(|a| a.network == node.network && node.network != ferra_network).or_else(|| root.aliases.first()) {
            Some(a) => (a.network.clone(), a.address.clone()),
            None => (root_ref.network.clone(), root_ref.address.clone()),
        }
    } else {
        (root_ref.network.clone(), root_ref.address.clone())
    };

    // Cursor scheme: `c:<offset>` pages the chain transfers (always available, from the file);
    // once those are exhausted `i:<indexer cursor>` pages the origin network's indexer.
    let limit_n = limit.clamp(5, 200) as usize;
    let (chain_offset, indexer_cursor, chain_phase): (usize, Option<String>, bool) = match cursor.as_deref() {
        None => (0, None, true),
        Some(c) if c.starts_with("c:") => (c[2..].parse().unwrap_or(0), None, true),
        Some(c) if c.starts_with("i:") => (usize::MAX, Some(c[2..].to_string()).filter(|x| !x.is_empty()), false),
        Some(c) => (usize::MAX, Some(c.to_string()), false),
    };
    edges.sort_by_key(|e| std::cmp::Reverse(e.timestamp));
    let mut next_cursor = None;
    let mut exhausted = true;
    let mut source = String::new();
    let mut chain_more = false;
    if chain_phase {
        let total = edges.len();
        let page: Vec<GraphEdge> = edges.into_iter().skip(chain_offset).take(limit_n).collect();
        let keep: std::collections::HashSet<String> = page.iter().flat_map(|e| [e.from.clone(), e.to.clone()]).collect();
        nodes.retain(|id, _| keep.contains(id));
        edges = page;
        source = "chain".into();
        if chain_offset + limit_n < total {
            chain_more = true;
            next_cursor = Some(format!("c:{}", chain_offset + limit_n));
            exhausted = false;
        }
    } else {
        edges.clear();
        nodes.clear();
    }
    let first_page = chain_phase && chain_offset == 0;
    let cursor = indexer_cursor;

    let can_online = !chain_more && online && lookup_network != ferra_network && state.online.has_network(&lookup_network);
    if !chain_more && online && lookup_network != ferra_network && !can_online {
        notes.push(format!("no connector for network {lookup_network}"));
    }
    if can_online {
        let src = state.online.registry.get(&lookup_network)?;
        let limit = limit.clamp(5, 100);
        let (page, info) = tokio::join!(src.fetch(&lookup_address, cursor.as_deref(), limit), async {
            if first_page { Some(src.account_info(&lookup_address).await) } else { None }
        });
        match info {
            Some(Ok(i)) => {
                root.label = i.name.clone();
                root.labels = i.labels.clone();
                root.scam = i.is_scam;
                if i.is_scam {
                    root.worst_risk = Some(RiskBand::Critical);
                }
                root.tx_count = root.tx_count.max(i.tx_count.unwrap_or(0));
                root.first_seen = match (root.first_seen, i.first_seen) {
                    (Some(a), Some(b)) => Some(a.min(b)),
                    (a, b) => a.or(b),
                };
                root.last_seen = match (root.last_seen, i.last_active) {
                    (Some(a), Some(b)) => Some(a.max(b)),
                    (a, b) => a.or(b),
                };
                root.info = Some(i);
            }
            Some(Err(e)) => notes.push(format!("account info: {e}")),
            None => {}
        }
        match page {
            Ok(p) => {
                let known: std::collections::HashSet<String> = state.with_chain(|o| Ok(chain_events_for(o, &root_ref).iter().filter_map(|e| external_ref(&e.tx).map(|x| x.tx_id)).collect()))?;
                let observed = state.with_chain(|opened| {
                    let idx = ChainIndex::build(opened);
                    let mut out = Vec::new();
                    for ev in &p.events {
                        if known.contains(&ev.external.tx_id) {
                            continue;
                        }
                        let other_raw = if ev.incoming { &ev.external.from_raw } else { &ev.external.to_raw };
                        let other = opened.resolve_alias(&NodeRef::new(&ev.external.network.name, other_raw));
                        let mut other_node = node_from(opened, &state.online, &idx, &other);
                        if ev.scam_flag {
                            other_node.scam = true;
                            other_node.worst_risk = Some(RiskBand::Critical);
                        }
                        if let Some(l) = &ev.counterparty_label {
                            other_node.label = Some(l.clone());
                        }
                        if !other_node.sources.iter().any(|s| s == "indexer") {
                            other_node.sources.push("indexer".into());
                        }
                        let risk = if ev.scam_flag || other_node.sanctioned {
                            Some(RiskBand::Critical)
                        } else if other_node.reports > 0 || other_node.flagged {
                            Some(RiskBand::High)
                        } else {
                            None
                        };
                        let (from, to) = if ev.incoming { (other.id.clone(), root.id.clone()) } else { (root.id.clone(), other.id.clone()) };
                        let amount = ev.external.amount.parse::<f64>().unwrap_or(0.0) / 10f64.powi(i32::from(ev.external.decimals));
                        out.push((
                            other_node,
                            GraphEdge {
                                id: format!("{}:{}:{}", ev.external.network.name, ev.external.tx_id, if ev.incoming { "in" } else { "out" }),
                                from,
                                to,
                                network: ev.external.network.name.clone(),
                                timestamp: ev.external.timestamp.unwrap_or(0),
                                amount_units: amount,
                                asset_symbol: ev.external.asset_symbol.clone(),
                                fee: ev.external.fee,
                                risk,
                                event_hash: None,
                                tx_id: Some(ev.external.tx_id.clone()),
                                explorer_url: ev.external.explorer_url.clone(),
                                flag_codes: Vec::new(),
                                kind: "observed".into(),
                                scam_flag: ev.scam_flag,
                                trusted: true,
                                on_chain: false,
                            },
                        ));
                    }
                    Ok(out)
                })?;
                for (n, e) in observed {
                    if n.id != root.id {
                        nodes.entry(n.id.clone()).or_insert(n);
                    }
                    edges.push(e);
                }
                next_cursor = p.next_cursor.map(|c| format!("i:{c}"));
                exhausted = next_cursor.is_none();
                source = if source.is_empty() { "indexer".into() } else { format!("{source}+indexer") };
                if !root.sources.iter().any(|s| s == "indexer") {
                    root.sources.push("indexer".into());
                }
            }
            Err(e) => {
                notes.push(format!("{lookup_network}: {e}"));
                if source.is_empty() {
                    source = "offline".into();
                } else {
                    source = format!("{source} (offline)");
                }
            }
        }
    } else if !online && !chain_more {
        source = if source.is_empty() { "offline".into() } else { format!("{source} (offline)") };
    }

    // Newest first, as the admin reads them.
    edges.sort_by_key(|e| std::cmp::Reverse(e.timestamp));
    let nodes: Vec<GraphNode> = nodes.into_values().collect();
    Ok(Expansion { root, nodes, edges, next_cursor, exhausted, source, elapsed_ms: started.elapsed().as_millis() as u64, notes })
}

/// Sender side of a risk preview: the wallet as the chain profile describes it (same shape the
/// service builds).
pub fn sender_context(opened: &Opened, wallet: Address, network: &str, counterparty: &str) -> SenderContext {
    let now = crate::state::now();
    let profile = opened.chain.profile(wallet, now);
    let day_ago = now.saturating_sub(86_400);
    let mut out_count_24h = 0u64;
    let mut known_recipient = opened.chain.settings_of(wallet).allowlist.iter().any(|a| format!("{a:#x}").eq_ignore_ascii_case(counterparty));
    for e in opened.events.iter().filter(|e| e.wallet == wallet && !e.incoming && matches!(e.tx.kind, TxKind::Cosigned | TxKind::External)) {
        if e.tx.timestamp >= day_ago {
            out_count_24h += 1;
        }
        if let Some(c) = &e.counterparty
            && c.network == network.to_ascii_lowercase()
            && c.address.eq_ignore_ascii_case(counterparty)
        {
            known_recipient = true;
        }
    }
    let balance_units = opened.chain.balances_of(wallet).first().map(|b| b.amount.to_string().parse::<f64>().unwrap_or(0.0) / 10f64.powi(i32::from(b.decimals))).unwrap_or(0.0);
    SenderContext {
        balance_units,
        prior_out_count: profile.out_count,
        mean_out_units: profile.mean_out,
        p95_out_units: profile.p95_out,
        age_secs: profile.age_secs,
        known_recipient,
        out_count_24h,
        archetype: serde_json::to_value(profile.archetype).ok().and_then(|v| v.as_str().map(String::from)),
    }
}

/// The sidebar: what the chain says about an address and why it is coloured the way it is, plus
/// (online) the model's preview of paying it again.
pub async fn insight(state: &AppState, id: &str, online: bool) -> AppResult<NodeInsight> {
    let started = Instant::now();
    let node = NodeRef::parse(id)?;
    let LocalPart { root, ferra_network, wallet_on_network, sender, .. } = local_part(state, &node, Some(&node.network))?;
    let (reports, events, flags, mut reasons) = state.with_chain(|opened| {
        let node = opened.resolve_alias(&node);
        let reports = opened.chain.reports_of(&node.network, &node.address);
        let events = chain_events_for(opened, &node);
        let mut flags: Vec<Flag> = events.iter().flat_map(|e| e.tx.flags.iter().cloned()).collect();
        flags.sort_by(|a, b| band_rank(Some(b.severity)).cmp(&band_rank(Some(a.severity))).then(b.at.cmp(&a.at)));
        Ok((reports, events, flags, Vec::<Reason>::new()))
    })?;

    if root.sanctioned {
        reasons.push(Reason { code: "SANCTIONED".into(), severity: Some(RiskBand::Critical), message: "On the sanctions list: any transfer to it is refused.".into(), events: Vec::new() });
    }
    if root.flagged {
        reasons.push(Reason { code: "MIXER_OR_HACK".into(), severity: Some(RiskBand::High), message: "Listed as a mixer / hack / drainer address.".into(), events: Vec::new() });
    }
    if !reports.is_empty() {
        let mut cats: Vec<String> = reports.iter().map(|r| r.category.clone()).collect();
        cats.sort();
        cats.dedup();
        reasons.push(Reason { code: "REPORTED".into(), severity: Some(RiskBand::High), message: format!("{} report(s) filed against this address: {}.", reports.len(), cats.join(", ")), events: Vec::new() });
    }
    // Flags grouped by code: worst severity, how many events, the first message as the example.
    // code -> (worst severity, events it was raised on, example message)
    type Group = (Option<RiskBand>, Vec<B256>, String);
    let mut by_code: BTreeMap<String, Group> = BTreeMap::new();
    for f in &flags {
        let entry = by_code.entry(f.code.clone()).or_insert((None, Vec::new(), f.message.clone()));
        entry.0 = max_band(entry.0, Some(f.severity));
        if !entry.1.contains(&f.target) {
            entry.1.push(f.target);
        }
    }
    let mut grouped: Vec<(String, Group)> = by_code.into_iter().collect();
    grouped.sort_by_key(|(_, g)| std::cmp::Reverse(band_rank(g.0)));
    for (code, (sev, evs, msg)) in grouped {
        let message = if evs.len() > 1 { format!("{code} on {} events, e.g. {msg}", evs.len()) } else { msg };
        reasons.push(Reason { code, severity: sev, message, events: evs });
    }
    let escapes: Vec<B256> = events.iter().filter(|e| e.tx.kind == TxKind::EscapeExit).map(|e| e.tx.hash).collect();
    if !escapes.is_empty() {
        reasons.push(Reason { code: "ESCAPE_EXIT".into(), severity: Some(RiskBand::High), message: format!("{} transfer(s) left through the escape hatch without a Swissquote signature.", escapes.len()), events: escapes });
    }
    let disagreements: Vec<B256> = events.iter().filter(|e| e.disagreement).map(|e| e.tx.hash).collect();
    if !disagreements.is_empty() {
        reasons.push(Reason { code: "VERDICT_DISAGREEMENT".into(), severity: Some(RiskBand::Medium), message: format!("On {} event(s) the validators concluded differently from the wallet's policy at signing time.", disagreements.len()), events: disagreements });
    }
    let pending: Vec<B256> = events.iter().filter(|e| e.pending).map(|e| e.tx.hash).collect();
    if !pending.is_empty() {
        reasons.push(Reason { code: "PENDING".into(), severity: None, message: format!("{} event(s) with this address have no validator verdict yet.", pending.len()), events: pending });
    }
    let untrusted: Vec<B256> = events.iter().filter(|e| !e.trusted).map(|e| e.tx.hash).collect();
    if !untrusted.is_empty() {
        reasons.push(Reason { code: "CHAIN_TAMPERED".into(), severity: Some(RiskBand::Critical), message: format!("{} event(s) sit after the integrity break and cannot be trusted.", untrusted.len()), events: untrusted });
    }
    if reasons.is_empty() && !events.is_empty() {
        reasons.push(Reason { code: "CLEAN".into(), severity: Some(RiskBand::Low), message: "Checked, nothing found on the chain for this address.".into(), events: Vec::new() });
    }

    let mut preview = None;
    let mut preview_error = None;
    let root_ref = NodeRef::parse(&root.id)?;
    if online && root_ref.network != ferra_network {
        if state.online.has_network(&root_ref.network) {
            let lists = state.with_chain(|o| Ok(state.online.watchlists(Some(o))))?;
            let src = state.online.registry.get(&root_ref.network)?;
            match sq_connectors::preview::risk_preview(src, &root_ref.address, wallet_on_network.as_deref(), None, sender.as_ref(), &lists, state.online.model(), ReportConfig { max_pages: 2, ..Default::default() }, crate::state::now()).await {
                Ok(p) => {
                    if p.counterparty_info.as_ref().is_some_and(|i| i.is_scam) {
                        reasons.insert(0, Reason { code: "INDEXER_SCAM_LABEL".into(), severity: Some(RiskBand::Critical), message: format!("{} marks this address as a scam.", root_ref.network), events: Vec::new() });
                    }
                    preview = Some(p);
                }
                Err(e) => preview_error = Some(e.to_string()),
            }
        } else {
            preview_error = Some(format!("no connector for network {}", root_ref.network));
        }
    } else if online {
        preview_error = Some("Ferra addresses are judged from the chain file; no origin-network lookup.".into());
    }

    let mut root = root;
    if let Some(p) = &preview {
        if let Some(i) = &p.counterparty_info {
            root.label = i.name.clone();
            root.labels = i.labels.clone();
            root.scam = i.is_scam;
            root.info = Some(i.clone());
        }
        root.worst_risk = max_band(root.worst_risk, Some(p.band));
    }
    Ok(NodeInsight { node: root, reports, events, flags, reasons, preview, preview_error, elapsed_ms: started.elapsed().as_millis() as u64 })
}

pub fn parse_hash(hash: &str) -> AppResult<B256> {
    hash.parse::<B256>().map_err(|e| AppError::BadRequest(format!("hash {hash}: {e}")))
}
