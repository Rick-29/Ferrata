//! The commands the UI calls (`invoke("name", { ... })`). Offline ones read the open file; online
//! ones go to the public indexers through the embedded connectors.

use std::path::{Path, PathBuf};

use alloy_primitives::Address;
use serde::{Deserialize, Serialize};
use sq_adapters::chain::{AddressReport, ChainHeader, ChainVerification, DatasetRow, ModelInfo, Network, TxKind, ValidationStatus};
use sq_connectors::preview::{AmountSpec, RiskPreview};
use sq_connectors::provenance::ProvenanceAssessment;
use sq_connectors::report::{ReportConfig, TransferReport};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::error::{AppError, AppResult};
use crate::graph::{self, Expansion, GraphNode, NodeInsight, parse_hash};
use crate::report::{self, FileInfo, ProfileCard, Report};
use crate::state::{AppState, EventView, NodeRef, Opened, RecentFile, open_file_with};

pub const OPENED_EVENT: &str = "chain://opened";
pub const PROGRESS_EVENT: &str = "chain://progress";

#[derive(Debug, Clone, Serialize)]
pub struct ProgressEvent {
    pub stage: String,
    pub done: u64,
    pub total: u64,
}

/// Opens a file on a blocking thread, streaming `chain://progress` to the window.
async fn open_with_progress(app: &AppHandle, path: PathBuf) -> AppResult<Opened> {
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        open_file_with(&path, &|stage, done, total| {
            let _ = app2.emit(PROGRESS_EVENT, ProgressEvent { stage: stage.to_string(), done, total });
        })
    })
    .await
    .map_err(|e| AppError::Internal(e.to_string()))?
}
pub const CLOSED_EVENT: &str = "chain://closed";

#[derive(Debug, Clone, Serialize)]
pub struct ChainSummary {
    pub file: FileInfo,
    pub header: ChainHeader,
    pub verification: ChainVerification,
    pub validation: ValidationStatus,
}

fn summary(opened: &Opened) -> ChainSummary {
    ChainSummary { file: report::file_info(opened), header: opened.header.clone(), verification: opened.verification.clone(), validation: opened.chain.validation(20) }
}

pub fn install(app: &AppHandle, state: &AppState, opened: Opened) -> AppResult<ChainSummary> {
    let s = summary(&opened);
    if let Some(p) = &opened.path {
        state.remember(RecentFile {
            path: p.display().to_string(),
            name: opened.name.clone(),
            chain_id: opened.header.chain_id,
            network: opened.header.network.name.clone(),
            blocks: opened.blocks_total,
            events: opened.events.len() as u64,
            verified_ok: Some(opened.verification.ok),
            last_opened: crate::state::now(),
        })?;
    }
    *state.lock(&state.opened)? = Some(opened);
    state.lock(&state.verdicts)?.clear();
    *state.lock(&state.auto)? = Default::default();
    let _ = app.emit(OPENED_EVENT, &s);
    Ok(s)
}

#[tauri::command]
pub async fn open_chain(app: AppHandle, state: State<'_, AppState>, path: String) -> AppResult<ChainSummary> {
    let opened = open_with_progress(&app, PathBuf::from(&path)).await?;
    install(&app, &state, opened)
}

#[derive(Debug, Clone, Serialize)]
pub struct DemoChain {
    pub id: String,
    pub name: String,
    pub description: String,
    pub path: Option<String>,
}

const DEMOS: [(&str, &str, &str, &str); 3] = [
    ("testnet", "Demo testnet", "TON testnet + Sepolia around one simulated owner, no validator verdicts yet.", "ferra-testnet.jsonl"),
    ("testnet-validated", "Demo testnet (validated)", "The same testnet chain after the validation worker wrote its flags.", "ferra-testnet.validated.jsonl"),
    ("mainnet", "Demo mainnet", "TON, Ethereum, Bitcoin and Solana mainnet history around one simulated owner.", "ferra-mainnet.jsonl"),
];

pub fn fixtures_dir(app: &AppHandle) -> Option<PathBuf> {
    let bundled = app.path().resolve("fixtures", tauri::path::BaseDirectory::Resource).ok().filter(|p| p.join("model.json").exists());
    bundled.or_else(|| {
        let dev = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures");
        dev.join("model.json").exists().then(|| dev.canonicalize().unwrap_or(dev))
    })
}

fn demo_path(app: &AppHandle, file: &str) -> Option<PathBuf> {
    fixtures_dir(app).map(|d| d.join("chains").join(file)).filter(|p| p.exists())
}

pub fn demos(app: &AppHandle) -> Vec<DemoChain> {
    DEMOS.iter().map(|(id, name, description, file)| DemoChain { id: id.to_string(), name: name.to_string(), description: description.to_string(), path: demo_path(app, file).map(|p| p.display().to_string()) }).collect()
}

#[tauri::command]
pub async fn open_demo(app: AppHandle, state: State<'_, AppState>, id: String) -> AppResult<ChainSummary> {
    let (_, _, _, file) = DEMOS.iter().find(|(d, ..)| *d == id).ok_or_else(|| AppError::NotFound(format!("demo {id}")))?;
    let path = demo_path(&app, file).ok_or_else(|| AppError::NotFound(format!("demo chain {file} is not bundled with this build")))?;
    let opened = open_with_progress(&app, path).await?;
    install(&app, &state, opened)
}

/// Re-reads the file and verifies it again.
#[tauri::command]
pub async fn reload_chain(app: AppHandle, state: State<'_, AppState>) -> AppResult<ChainSummary> {
    let path = state.with_chain(|o| Ok(o.path.clone()))?.ok_or_else(|| AppError::BadRequest("this chain has no file to re-read".into()))?;
    let opened = open_with_progress(&app, path).await?;
    install(&app, &state, opened)
}

#[tauri::command]
pub fn close_chain(app: AppHandle, state: State<'_, AppState>) -> AppResult<()> {
    *state.lock(&state.opened)? = None;
    let _ = app.emit(CLOSED_EVENT, ());
    Ok(())
}

#[tauri::command]
pub fn current_chain(state: State<'_, AppState>) -> AppResult<Option<ChainSummary>> {
    Ok(state.lock(&state.opened)?.as_ref().map(summary))
}

#[tauri::command]
pub fn list_recent(state: State<'_, AppState>) -> AppResult<Vec<RecentFile>> {
    Ok(state.lock(&state.recent)?.clone())
}

#[tauri::command]
pub fn forget_recent(state: State<'_, AppState>, path: String) -> AppResult<Vec<RecentFile>> {
    let mut list = state.lock(&state.recent)?;
    list.retain(|r| r.path != path);
    let _ = std::fs::write(state.recent_path(), serde_json::to_string_pretty(&*list).unwrap_or_default());
    Ok(list.clone())
}

#[derive(Debug, Clone, Serialize)]
pub struct AppInfo {
    pub version: String,
    pub fixtures_dir: Option<String>,
    pub model: Option<ModelInfo>,
    pub model_error: Option<String>,
    pub networks: Vec<Network>,
    pub demos: Vec<DemoChain>,
    pub data_dir: String,
}

#[tauri::command]
pub fn app_info(app: AppHandle, state: State<'_, AppState>) -> AppResult<AppInfo> {
    Ok(AppInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        fixtures_dir: state.online.fixtures_dir.as_ref().map(|p| p.display().to_string()),
        model: state.online.model().map(|m| m.describe()),
        model_error: state.online.model_error.clone(),
        networks: state.online.registry.networks(),
        demos: demos(&app),
        data_dir: state.data_dir.display().to_string(),
    })
}

// ----- events -----

/// Every event in chain order, with derived fields. The canvas draws from this alone.
#[tauri::command]
pub fn list_events(state: State<'_, AppState>) -> AppResult<Vec<EventView>> {
    state.merged_events()
}

// ----- the in-app validator -----

#[tauri::command]
pub fn validate_start(app: AppHandle, online: Option<bool>, halt_after: Option<usize>) -> AppResult<()> {
    crate::validator::start(app, online.unwrap_or(true), halt_after.unwrap_or(3))
}

#[tauri::command]
pub fn validate_stop(state: State<'_, AppState>) -> AppResult<()> {
    crate::validator::stop(&state)
}

#[tauri::command]
pub fn validation_status(state: State<'_, AppState>) -> AppResult<crate::validator::ValidationSummary> {
    crate::validator::summary(&state)
}

#[tauri::command]
pub fn manual_verdict(app: AppHandle, state: State<'_, AppState>, verdict: crate::validator::ManualVerdict) -> AppResult<EventView> {
    crate::validator::manual(&app, &state, verdict)
}

#[derive(Debug, Clone, Serialize)]
pub struct EventDetail {
    pub event: EventView,
    /// Other validatable events with the same counterparty, newest first.
    pub related: Vec<EventView>,
    /// `intent` / `intent_outcome` events that led to this one.
    pub intents: Vec<EventView>,
    /// The `flag` events that targeted this one.
    pub flag_events: Vec<EventView>,
    pub counterparty: Option<GraphNode>,
    pub reports: Vec<AddressReport>,
}

#[tauri::command]
pub fn get_event(state: State<'_, AppState>, hash: String) -> AppResult<EventDetail> {
    let hash = parse_hash(&hash)?;
    let merged = state.merged_events()?;
    state.with_chain(|o| {
        let event = merged.iter().find(|e| e.tx.hash == hash).cloned().ok_or_else(|| AppError::NotFound(format!("event {hash}")))?;
        let mut related: Vec<EventView> = match &event.counterparty {
            Some(c) => merged.iter().filter(|e| e.tx.hash != hash && e.counterparty.as_ref().is_some_and(|x| x.id == c.id)).cloned().collect(),
            None => Vec::new(),
        };
        related.sort_by_key(|e| std::cmp::Reverse(e.tx.timestamp));

        let user_op = format!("{:#x}", event.tx.user_op_hash);
        let hash_str = format!("{hash:#x}");
        let mut intent_ids: Vec<String> = Vec::new();
        let mut intents: Vec<EventView> = Vec::new();
        for e in o.events.iter().filter(|e| e.wallet == event.wallet && e.tx.kind == TxKind::Intent) {
            let Some(intent) = e.tx.extra.get("intent") else { continue };
            let matches = intent.get("user_op_hash").and_then(|v| v.as_str()).is_some_and(|h| h.eq_ignore_ascii_case(&user_op) && event.tx.user_op_hash != alloy_primitives::B256::ZERO);
            if matches {
                if let Some(id) = intent.get("id").and_then(|v| v.as_str()) {
                    intent_ids.push(id.to_string());
                }
                intents.push(e.clone());
            }
        }
        for e in o.events.iter().filter(|e| e.wallet == event.wallet && e.tx.kind == TxKind::IntentOutcome) {
            let Some(outcome) = e.tx.extra.get("outcome") else { continue };
            let by_tx = outcome.get("tx_hash").and_then(|v| v.as_str()).is_some_and(|h| h.eq_ignore_ascii_case(&hash_str));
            let by_id = outcome.get("intent_id").and_then(|v| v.as_str()).is_some_and(|id| intent_ids.iter().any(|x| x == id));
            if by_tx || by_id {
                if by_tx && let Some(id) = outcome.get("intent_id").and_then(|v| v.as_str()) && !intent_ids.iter().any(|x| x == id) {
                    intent_ids.push(id.to_string());
                    if let Some(i) = o.events.iter().find(|x| x.tx.kind == TxKind::Intent && x.tx.extra.get("intent").and_then(|v| v.get("id")).and_then(|v| v.as_str()) == Some(id)) {
                        intents.push(i.clone());
                    }
                }
                intents.push(e.clone());
            }
        }
        intents.sort_by_key(|e| e.tx.block_number);
        intents.dedup_by(|a, b| a.tx.hash == b.tx.hash);

        let flag_events: Vec<EventView> = o
            .events
            .iter()
            .filter(|e| e.tx.kind == TxKind::Flag && e.tx.extra.get("flag").and_then(|f| f.get("target")).and_then(|v| v.as_str()).is_some_and(|t| t.eq_ignore_ascii_case(&hash_str)))
            .cloned()
            .collect();

        let (counterparty, reports) = match &event.counterparty {
            Some(c) => {
                let node = graph_node_offline(o, &state.online, c);
                (Some(node), o.chain.reports_of(&c.network, &c.address))
            }
            None => (None, Vec::new()),
        };
        Ok(EventDetail { event, related, intents, flag_events, counterparty, reports })
    })
}

fn graph_node_offline(o: &Opened, online: &crate::online::Online, node: &NodeRef) -> GraphNode {
    // Reuse the graph builder for a single node: cheap enough per click.
    let idx_events = graph::chain_events_for(o, node);
    let mut n = GraphNode {
        id: node.id.clone(),
        network: node.network.clone(),
        address: node.address.clone(),
        is_wallet: false,
        is_account: node.network == o.ferra_network() && node.address.parse::<Address>().is_ok_and(|a| o.chain.has_account(a)),
        label: None,
        labels: Vec::new(),
        reports: o.chain.report_count(&node.network, &node.address),
        report_categories: Vec::new(),
        sanctioned: online.is_sanctioned(&node.address),
        flagged: online.is_flagged(&node.address),
        scam: false,
        worst_risk: None,
        tx_count: idx_events.len() as u64,
        in_count: idx_events.iter().filter(|e| !e.incoming).count() as u64,
        out_count: idx_events.iter().filter(|e| e.incoming).count() as u64,
        first_seen: idx_events.iter().map(|e| e.tx.timestamp).min(),
        last_seen: idx_events.iter().map(|e| e.tx.timestamp).max(),
        info: None,
        sources: vec!["chain".into()],
        aliases: Vec::new(),
    };
    for e in &idx_events {
        n.worst_risk = crate::state::max_band(n.worst_risk, e.effective_risk);
    }
    if n.sanctioned {
        n.worst_risk = Some(wallet_core::RiskBand::Critical);
    } else if n.reports > 0 || n.flagged {
        n.worst_risk = crate::state::max_band(n.worst_risk, Some(wallet_core::RiskBand::High));
    }
    let mut cats: Vec<String> = o.chain.reports_of(&node.network, &node.address).into_iter().map(|r| r.category).collect();
    cats.sort();
    cats.dedup();
    n.report_categories = cats;
    n
}

// ----- automatic mode -----

#[tauri::command]
pub fn get_report(state: State<'_, AppState>) -> AppResult<Report> {
    let events = state.merged_events()?;
    state.with_chain(|o| Ok(report::build(o, &events)))
}

#[tauri::command]
pub fn get_profile(state: State<'_, AppState>, address: Option<String>) -> AppResult<ProfileCard> {
    state.with_chain(|o| {
        let wallet = match address {
            Some(a) => a.parse::<Address>().map_err(|e| AppError::BadRequest(format!("address {a}: {e}")))?,
            None => o.primary_wallet().ok_or_else(|| AppError::NotFound("no account on this chain".into()))?,
        };
        let now = o.chain.latest().timestamp;
        Ok(ProfileCard { profile: o.chain.profile(wallet, now), node_id: NodeRef::ferra(o.ferra_network(), wallet).id, findings: o.chain.behaviour_findings(wallet, now) })
    })
}

#[tauri::command]
pub fn get_dataset(state: State<'_, AppState>) -> AppResult<Vec<DatasetRow>> {
    state.with_chain(|o| Ok(o.chain.dataset(0, usize::MAX)))
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExportWhat {
    Report,
    Events,
    Dataset,
}

/// Writes the report, the events or the dataset as JSON (or the dataset as CSV) to `path`.
#[tauri::command]
pub fn export_file(state: State<'_, AppState>, what: ExportWhat, format: String, path: String) -> AppResult<String> {
    let events = state.merged_events()?;
    let text = state.with_chain(|o| {
        Ok(match (what, format.as_str()) {
            (ExportWhat::Report, "json") => serde_json::to_string_pretty(&report::build(o, &events))?,
            (ExportWhat::Events, "json") => serde_json::to_string_pretty(&events)?,
            (ExportWhat::Dataset, "json") => serde_json::to_string_pretty(&o.chain.dataset(0, usize::MAX))?,
            (ExportWhat::Dataset, "csv") => dataset_csv(&o.chain.dataset(0, usize::MAX)),
            (ExportWhat::Events, "csv") => events_csv(&events),
            (ExportWhat::Report, "csv") => attention_csv(&report::build(o, &events)),
            (_, f) => return Err(AppError::BadRequest(format!("unsupported format {f}"))),
        })
    })?;
    std::fs::write(&path, text).map_err(|e| AppError::Io(format!("{path}: {e}")))?;
    Ok(path)
}

fn csv_cell(s: &str) -> String {
    if s.contains([',', '"', '\n']) { format!("\"{}\"", s.replace('"', "\"\"")) } else { s.to_string() }
}

fn dataset_csv(rows: &[DatasetRow]) -> String {
    let keys: Vec<String> = rows.first().map(|r| r.features.to_vector().keys().cloned().collect()).unwrap_or_default();
    let mut out = String::new();
    out.push_str("tx_hash,block_number,label,label_codes");
    for k in &keys {
        out.push(',');
        out.push_str(k);
    }
    out.push('\n');
    for r in rows {
        let v = r.features.to_vector();
        out.push_str(&format!("{:#x},{},{},{}", r.tx_hash, r.block_number, r.label.map(|b| format!("{b:?}")).unwrap_or_default(), csv_cell(&r.label_codes.join("|"))));
        for k in &keys {
            out.push(',');
            out.push_str(&v.get(k).map(|x| x.to_string()).unwrap_or_default());
        }
        out.push('\n');
    }
    out
}

fn events_csv(events: &[EventView]) -> String {
    let mut out = String::from("hash,block,timestamp,kind,network,incoming,amount,asset,counterparty,risk_level,reviewed_risk,effective_risk,pending,trusted,flags\n");
    for e in events {
        out.push_str(&format!(
            "{:#x},{},{},{:?},{},{},{},{},{},{},{},{},{},{},{}\n",
            e.tx.hash,
            e.tx.block_number,
            e.tx.timestamp,
            e.tx.kind,
            e.tx.network.name,
            e.incoming,
            e.amount_units,
            csv_cell(&e.asset_symbol),
            csv_cell(&e.counterparty.as_ref().map(|c| c.id.clone()).unwrap_or_default()),
            e.tx.risk_level.map(|b| format!("{b:?}")).unwrap_or_default(),
            e.tx.reviewed_risk.map(|b| format!("{b:?}")).unwrap_or_default(),
            e.effective_risk.map(|b| format!("{b:?}")).unwrap_or_default(),
            e.pending,
            e.trusted,
            csv_cell(&e.flag_codes.join("|"))
        ));
    }
    out
}

fn attention_csv(r: &Report) -> String {
    let mut out = String::from("risk,timestamp,kind,network,amount,asset,counterparty,reports,flags,hash\n");
    for a in &r.attention {
        out.push_str(&format!(
            "{},{},{:?},{},{},{},{},{},{},{:#x}\n",
            a.risk.map(|b| format!("{b:?}")).unwrap_or_else(|| "pending".into()),
            a.timestamp,
            a.kind,
            a.network,
            a.amount_units,
            csv_cell(&a.asset_symbol),
            csv_cell(&a.counterparty.as_ref().map(|c| c.id.clone()).unwrap_or_default()),
            a.counterparty_reports,
            csv_cell(&a.flag_codes.join("|")),
            a.hash
        ));
    }
    out
}

// ----- manual mode: the graph -----

#[tauri::command]
pub async fn expand_node(state: State<'_, AppState>, id: String, cursor: Option<String>, limit: Option<u32>, online: Option<bool>) -> AppResult<Expansion> {
    graph::expand(&state, &id, cursor, limit.unwrap_or(24), online.unwrap_or(true)).await
}

#[tauri::command]
pub async fn node_insight(state: State<'_, AppState>, id: String, online: Option<bool>) -> AppResult<NodeInsight> {
    graph::insight(&state, &id, online.unwrap_or(true)).await
}

// ----- online: indexers through the embedded connectors -----

/// Transfer report for an external event: the counterparty researched on its origin network.
#[tauri::command]
pub async fn event_report(state: State<'_, AppState>, hash: String) -> AppResult<TransferReport> {
    let hash = parse_hash(&hash)?;
    let (tx, lists) = state.with_chain(|o| {
        let e = o.event(hash)?;
        if e.tx.kind != TxKind::External {
            return Err(AppError::BadRequest("transfer reports exist for external events only; Ferra-native events are judged from the chain".into()));
        }
        Ok((e.tx.clone(), state.online.watchlists(Some(o))))
    })?;
    let src = state.online.registry.get(&tx.network.name)?;
    Ok(sq_connectors::report::report_for_event(src, &tx, &lists, ReportConfig { max_pages: 2, ..Default::default() }, state.online.model(), crate::state::now()).await?)
}

/// The counterparty's standing on its origin network. Reads only; writes no flag.
#[tauri::command]
pub async fn provenance_check(state: State<'_, AppState>, hash: String) -> AppResult<ProvenanceAssessment> {
    let hash = parse_hash(&hash)?;
    let (tx, lists) = state.with_chain(|o| {
        let e = o.event(hash)?;
        if e.tx.kind != TxKind::External {
            return Err(AppError::BadRequest("provenance applies to external events".into()));
        }
        Ok((e.tx.clone(), state.online.watchlists(Some(o))))
    })?;
    let src = state.online.registry.get(&tx.network.name)?;
    Ok(sq_connectors::provenance::assess(src, &tx, &lists, 50).await?)
}

/// "What if the wallet paid this address again": odds against a typical transfer, with factors.
#[tauri::command]
pub async fn risk_preview(state: State<'_, AppState>, network: String, counterparty: String, amount: Option<AmountSpec>) -> AppResult<RiskPreview> {
    let (lists, sender, wallet_raw) = state.with_chain(|o| {
        let wallet = o.primary_wallet();
        let sender = wallet.map(|w| graph::sender_context(o, w, &network, &counterparty));
        let alias = o.aliases.keys().filter_map(|k| NodeRef::parse(k).ok()).find(|a| a.network == network.to_ascii_lowercase()).map(|a| a.address);
        Ok((state.online.watchlists(Some(o)), sender, alias))
    })?;
    let src = state.online.registry.get(&network)?;
    Ok(sq_connectors::preview::risk_preview(src, &counterparty, wallet_raw.as_deref(), amount, sender.as_ref(), &lists, state.online.model(), ReportConfig { max_pages: 2, ..Default::default() }, crate::state::now()).await?)
}
