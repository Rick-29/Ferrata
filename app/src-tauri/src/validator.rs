//! The in-app automatic validator. It judges every validatable event the way the service's
//! worker does (reports against the counterparty, the origin network's provenance when online,
//! the risk model on the stored features, behaviour findings) but keeps the verdicts in the app
//! instead of writing `Flag` events to the chain. Verdicts stream to the window one by one;
//! after a configurable number of High / Critical verdicts the run halts and asks for a human.

use std::collections::HashMap;
use std::sync::Arc;

use alloy_primitives::B256;
use serde::{Deserialize, Serialize};
use sq_adapters::chain::{ChainTx, Flag, FlagSource, TxKind};
use sq_connectors::report::{self, ReportConfig};
use sq_connectors::provenance;
use tauri::{AppHandle, Emitter, Manager};
use wallet_core::RiskBand;

use crate::error::{AppError, AppResult};
use crate::state::{AppState, EventView, NodeRef, band_rank, counterparty_of, now};

pub const VERDICT_EVENT: &str = "validation://verdict";
pub const STATUS_EVENT: &str = "validation://status";

/// Where a run stands. Serialised to the UI after every verdict.
#[derive(Debug, Clone, Serialize, Default)]
pub struct ValidationSummary {
    pub validatable: u64,
    pub validated: u64,
    pub pending: u64,
    pub percent: f64,
    pub by_band: HashMap<String, u64>,
    pub running: bool,
    pub checked_this_run: u64,
    /// Events judged High or Critical during this run, newest last.
    pub high: Vec<B256>,
    pub halted: Option<String>,
    pub last_error: Option<String>,
    pub phase: Option<String>,
}

#[derive(Debug, Default)]
pub struct AutoState {
    pub running: bool,
    pub stop: bool,
    pub checked: u64,
    pub high: Vec<B256>,
    pub halted: Option<String>,
    pub last_error: Option<String>,
    pub phase: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct VerdictEvent {
    pub event: EventView,
    pub summary: ValidationSummary,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ManualVerdict {
    pub hash: B256,
    pub band: RiskBand,
    pub note: Option<String>,
}

fn flag(tx: &ChainTx, source: FlagSource, severity: RiskBand, code: &str, message: String) -> Flag {
    Flag { code: code.into(), severity, source, message, at: now(), target: tx.hash, data: Default::default() }
}

/// Offline part of the judgement: instant, no network.
fn judge_offline(state: &AppState, ev: &EventView) -> Vec<Flag> {
    let tx = &ev.tx;
    let mut out = Vec::new();
    let (reports, behaviour, sanctioned) = state
        .with_chain(|o| {
            let reports = ev.counterparty_reports;
            let behaviour: Vec<Flag> = o.chain.behaviour_findings(ev.wallet, o.chain.latest().timestamp).into_iter().filter(|f| f.target == tx.hash).collect();
            let sanctioned = counterparty_of(o, tx).is_some_and(|c| state.online.is_sanctioned(&c.address));
            Ok((reports, behaviour, sanctioned))
        })
        .unwrap_or((0, Vec::new(), false));
    out.extend(behaviour);
    if sanctioned {
        out.push(flag(tx, FlagSource::Review, RiskBand::Critical, "SANCTIONED_COUNTERPARTY", "the counterparty is on the sanctions list".into()));
    }
    if reports > 0 {
        let severity = if reports >= 3 { RiskBand::Critical } else { RiskBand::High };
        let mut f = flag(tx, FlagSource::Review, severity, "REPORTED_COUNTERPARTY", format!("the counterparty was reported {reports} time(s) as a scam or fraud"));
        f.data.insert("reports".into(), serde_json::json!(reports));
        out.push(f);
    }
    if tx.kind == TxKind::EscapeExit {
        out.push(flag(tx, FlagSource::Review, RiskBand::High, "ESCAPE_EXIT", "left through the escape hatch without a Swissquote signature".into()));
    }
    match (state.online.model(), &tx.features) {
        (Some(model), Some(f)) => {
            let score = model.score(f);
            let threshold = model.describe().threshold;
            if score >= threshold {
                let severity = if score >= 0.85 { RiskBand::High } else { RiskBand::Medium };
                let mut fl = flag(tx, FlagSource::Model, severity, "MODEL_RISK", format!("{} scores {score:.2}", model.name()));
                fl.data.insert("score".into(), serde_json::json!(score));
                fl.data.insert("top".into(), serde_json::json!(model.explain(f, 5)));
                out.push(fl);
            } else {
                let mut fl = flag(tx, FlagSource::Model, RiskBand::Low, "VALIDATED", format!("checked by the validator, {} scores {score:.2}", model.name()));
                fl.data.insert("score".into(), serde_json::json!(score));
                out.push(fl);
            }
        }
        _ => out.push(flag(tx, FlagSource::Model, RiskBand::Low, "VALIDATED", "checked by the validator (no model or no feature vector)".into())),
    }
    out
}

/// Online part: the counterparty's standing on its origin network (external events only).
async fn judge_online(state: &AppState, ev: &EventView) -> AppResult<Vec<Flag>> {
    let tx = &ev.tx;
    if tx.kind != TxKind::External {
        return Ok(Vec::new());
    }
    let src = state.online.registry.get(&tx.network.name)?;
    let lists = state.with_chain(|o| Ok(state.online.watchlists(Some(o))))?;
    let r = report::report_for_event(src, tx, &lists, ReportConfig { max_pages: 1, with_exposure: true, ..Default::default() }, state.online.model(), now()).await?;
    let mut out = Vec::new();
    if let Some(p) = &r.receiver_provenance
        && p.risk != RiskBand::Low
    {
        let mut f = flag(tx, FlagSource::Provenance, p.risk, "PROVENANCE", format!("counterparty {} on {}: {}", p.counterparty, p.network.name, p.reasons.iter().map(|r| r.code.as_str()).collect::<Vec<_>>().join(", ")));
        f.data = provenance::as_flag_data(p);
        out.push(f);
    }
    if let Some(risk) = r.transfers.first().and_then(|t| t.risk.as_ref()) {
        for reason in risk.reasons.iter().filter(|r| r.points >= 100) {
            out.push(flag(tx, FlagSource::Review, RiskBand::Critical, &reason.code, reason.message.clone()));
        }
    }
    Ok(out)
}

/// Current counts from the merged events plus the run state.
pub fn summary(state: &AppState) -> AppResult<ValidationSummary> {
    let events = state.merged_events()?;
    let validatable = events.iter().filter(|e| e.validatable).count() as u64;
    let validated = events.iter().filter(|e| e.validatable && !e.pending).count() as u64;
    let mut by_band: HashMap<String, u64> = HashMap::new();
    for e in events.iter().filter(|e| e.validatable && !e.pending) {
        *by_band.entry(e.effective_risk.map(|b| format!("{b:?}")).unwrap_or_else(|| "Pending".into())).or_insert(0) += 1;
    }
    let auto = state.lock(&state.auto)?;
    Ok(ValidationSummary {
        validatable,
        validated,
        pending: validatable - validated,
        percent: if validatable == 0 { 100.0 } else { validated as f64 * 100.0 / validatable as f64 },
        by_band,
        running: auto.running,
        checked_this_run: auto.checked,
        high: auto.high.clone(),
        halted: auto.halted.clone(),
        last_error: auto.last_error.clone(),
        phase: auto.phase.clone(),
    })
}

fn emit_status(app: &AppHandle, state: &AppState) {
    if let Ok(s) = summary(state) {
        let _ = app.emit(STATUS_EVENT, &s);
    }
}

fn record(app: &AppHandle, state: &AppState, hash: B256, flags: Vec<Flag>, replace: bool) -> AppResult<Option<RiskBand>> {
    {
        let mut v = state.lock(&state.verdicts)?;
        let entry = v.entry(hash).or_default();
        if replace {
            *entry = flags;
        } else {
            entry.extend(flags);
        }
    }
    let ev = state.merged_event(hash)?;
    let band = ev.effective_risk;
    if let Ok(s) = summary(state) {
        let _ = app.emit(VERDICT_EVENT, VerdictEvent { event: ev, summary: s });
    }
    Ok(band)
}

/// Starts a run in the background. `halt_after` High / Critical verdicts stop it for a human.
pub fn start(app: AppHandle, online: bool, halt_after: usize) -> AppResult<()> {
    let state: tauri::State<'_, AppState> = app.state();
    {
        let mut auto = state.lock(&state.auto)?;
        if auto.running {
            return Err(AppError::BadRequest("a validation run is already in progress".into()));
        }
        *auto = AutoState { running: true, phase: Some("offline checks".into()), ..Default::default() };
    }
    emit_status(&app, &state);
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        let st: tauri::State<'_, AppState> = app2.state();
        let result = run(&app2, &st, online, halt_after).await;
        if let Ok(mut auto) = st.lock(&st.auto) {
            auto.running = false;
            auto.phase = None;
            if let Err(e) = result {
                auto.last_error = Some(e.to_string());
            }
        }
        emit_status(&app2, &st);
    });
    Ok(())
}

async fn run(app: &AppHandle, state: &AppState, online: bool, halt_after: usize) -> AppResult<()> {
    let halt_after = halt_after.max(1);
    // Pending events, the least suspicious first: the wallet's own policy band, then amount.
    let mut pending: Vec<EventView> = state.merged_events()?.into_iter().filter(|e| e.validatable && e.pending).collect();
    pending.sort_by(|a, b| band_rank(a.tx.risk_level).cmp(&band_rank(b.tx.risk_level)).then(a.amount_units.partial_cmp(&b.amount_units).unwrap_or(std::cmp::Ordering::Equal)));

    let should_stop = |state: &AppState| -> AppResult<bool> { Ok(state.lock(&state.auto)?.stop) };
    let note_band = |state: &AppState, hash: B256, band: Option<RiskBand>| -> AppResult<bool> {
        let mut auto = state.lock(&state.auto)?;
        auto.checked += 1;
        if matches!(band, Some(RiskBand::High | RiskBand::Critical)) && !auto.high.contains(&hash) {
            auto.high.push(hash);
        }
        if auto.high.len() >= halt_after {
            auto.halted = Some(format!("{} transfers came back High or Critical: automatic validation stopped, the rest needs a manual look on the canvas", auto.high.len()));
            auto.stop = true;
            return Ok(true);
        }
        Ok(false)
    };

    // Phase 1: everything the file alone can tell, instantly.
    for ev in &pending {
        if should_stop(state)? {
            return Ok(());
        }
        let flags = judge_offline(state, ev);
        let band = record(app, state, ev.tx.hash, flags, true)?;
        if note_band(state, ev.tx.hash, band)? {
            return Ok(());
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }

    // Phase 2: the origin networks, for external events, a few at a time.
    if online {
        {
            let mut auto = state.lock(&state.auto)?;
            auto.phase = Some("origin networks".into());
        }
        emit_status(app, state);
        let externals: Vec<EventView> = pending.into_iter().filter(|e| e.tx.kind == TxKind::External && state.online.has_network(&e.tx.network.name)).collect();
        for chunk in externals.chunks(4) {
            if should_stop(state)? {
                return Ok(());
            }
            let mut set = tokio::task::JoinSet::new();
            for ev in chunk.iter().cloned() {
                let app = app.clone();
                set.spawn(async move {
                    let st: tauri::State<'_, AppState> = app.state();
                    let r = tokio::time::timeout(std::time::Duration::from_secs(25), judge_online(&st, &ev)).await;
                    (ev.tx.hash, r)
                });
            }
            while let Some(j) = set.join_next().await {
                let Ok((hash, r)) = j else { continue };
                match r {
                    Ok(Ok(flags)) if !flags.is_empty() => {
                        let band = record(app, state, hash, flags, false)?;
                        if note_band(state, hash, band)? {
                            return Ok(());
                        }
                    }
                    Ok(Ok(_)) => {}
                    Ok(Err(e)) => {
                        if let Ok(mut auto) = state.lock(&state.auto) {
                            auto.last_error = Some(e.to_string());
                        }
                    }
                    Err(_) => {
                        if let Ok(mut auto) = state.lock(&state.auto) {
                            auto.last_error = Some("origin network timed out".into());
                        }
                    }
                }
            }
            emit_status(app, state);
        }
    }
    Ok(())
}

pub fn stop(state: &AppState) -> AppResult<()> {
    let mut auto = state.lock(&state.auto)?;
    if auto.running {
        auto.stop = true;
    }
    Ok(())
}

/// A human's verdict. Replaces whatever the automatic run said about the event.
pub fn manual(app: &AppHandle, state: &AppState, m: ManualVerdict) -> AppResult<EventView> {
    let tx = state.with_chain(|o| Ok(o.event(m.hash)?.tx.clone()))?;
    let mut f = flag(&tx, FlagSource::Manual, m.band, "MANUAL_REVIEW", m.note.clone().filter(|n| !n.trim().is_empty()).unwrap_or_else(|| format!("reviewed by hand: {:?}", m.band)));
    f.data.insert("by".into(), serde_json::json!("admin"));
    record(app, state, m.hash, vec![f], true)?;
    {
        let mut auto = state.lock(&state.auto)?;
        auto.high.retain(|h| *h != m.hash);
        if auto.halted.is_some() && auto.high.is_empty() {
            auto.halted = None;
        }
    }
    emit_status(app, state);
    state.merged_event(m.hash)
}

/// Shared handle type for the verdict map.
pub type Verdicts = Arc<std::sync::Mutex<HashMap<B256, Vec<Flag>>>>;

#[allow(dead_code)]
fn _unused(_: NodeRef) {}
