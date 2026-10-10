//! The automatic validation worker. It walks `validation.next` (the oldest events on the Ferra
//! chain that no validator has judged yet), runs the same checks a compliance officer would, and
//! writes the verdict back as append-only `Flag` events. A clean event gets a `VALIDATED` flag
//! with the model score, so "validated %" counts clean events too.
//!
//! Each event is its own tokio task, bounded by `batch`; events that fail (indexer down, rate
//! limit) are retried on a later pass. Nothing here moves funds or refuses anything: the worker
//! only adds evidence.

use std::collections::{BTreeMap, HashMap};
use std::time::Duration;

use alloy_primitives::B256;
use api_types::{ValidationPass, ValidatorStatus};
use axum::extract::{Query, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use sq_adapters::{ChainTx, Flag, FlagSource, TxKind};
use sq_connectors::report::{self, ReportConfig};
use sq_connectors::provenance;
use tokio::task::JoinSet;
use wallet_core::RiskBand;

use crate::error::{ApiResult, ServiceError};
use crate::state::{AppState, SharedState};

/// Seconds before a failed event is tried again.
const RETRY_AFTER: u64 = 300;

#[derive(Default)]
pub struct ValidatorState {
    pub passes: u64,
    pub events_checked: u64,
    pub flags_written: u64,
    pub last_pass_at: Option<u64>,
    pub last_error: Option<String>,
    /// Event hash -> earliest time to try again.
    pub retry_after: HashMap<B256, u64>,
}

#[derive(Debug, Deserialize)]
pub struct RunQuery {
    pub batch: Option<usize>,
}

pub fn routes() -> Router<SharedState> {
    Router::new().route("/validator", get(status)).route("/validator/run", post(run))
}

async fn status(State(state): State<SharedState>) -> ApiResult<ValidatorStatus> {
    Ok(Json(status_of(&state)?))
}

/// One pass now, for demos and tests. The background loop keeps running regardless.
async fn run(State(state): State<SharedState>, Query(q): Query<RunQuery>) -> ApiResult<ValidationPass> {
    let batch = q.batch.unwrap_or(state.config.validator_batch).clamp(1, 32);
    Ok(Json(validate_pending(&state, batch).await?))
}

fn status_of(state: &AppState) -> Result<ValidatorStatus, ServiceError> {
    let v = state.lock(&state.validator)?;
    Ok(ValidatorStatus {
        enabled: state.config.validator_interval_secs > 0,
        interval_secs: state.config.validator_interval_secs,
        batch: state.config.validator_batch as u64,
        passes: v.passes,
        events_checked: v.events_checked,
        flags_written: v.flags_written,
        last_pass_at: v.last_pass_at,
        last_error: v.last_error.clone(),
        retrying: v.retry_after.len() as u64,
        validation: state.chain()?.validation(10),
    })
}

/// Starts the loop. Returns immediately; `SQ_VALIDATOR_INTERVAL_SECS=0` disables it.
pub fn spawn(state: SharedState) {
    let every = state.config.validator_interval_secs;
    if every == 0 {
        tracing::info!("validation worker disabled");
        return;
    }
    let batch = state.config.validator_batch;
    tokio::spawn(async move {
        tracing::info!(every, batch, "validation worker started");
        loop {
            match validate_pending(&state, batch).await {
                Ok(p) if p.checked > 0 => tracing::info!(checked = p.checked, flags = p.flags_written, percent = p.validation.percent, "validation pass"),
                Ok(_) => {}
                Err(e) => tracing::warn!(error = %e, "validation pass failed"),
            }
            tokio::time::sleep(Duration::from_secs(every)).await;
        }
    });
}

/// Validates up to `batch` pending events concurrently and writes their flags.
pub async fn validate_pending(state: &SharedState, batch: usize) -> Result<ValidationPass, ServiceError> {
    let now = state.now();
    let pending = state.chain()?.validation(batch * 4).next;
    let due: Vec<B256> = {
        let v = state.lock(&state.validator)?;
        pending.into_iter().filter(|h| v.retry_after.get(h).is_none_or(|t| *t <= now)).take(batch).collect()
    };

    let mut set = JoinSet::new();
    for hash in due.iter().copied() {
        let st = state.clone();
        set.spawn(async move { (hash, judge_event(&st, hash).await) });
    }
    let mut checked = 0u64;
    let mut written = 0u64;
    let mut failed = 0u64;
    let mut results: Vec<(B256, Result<Vec<Flag>, ServiceError>)> = Vec::new();
    while let Some(r) = set.join_next().await {
        match r {
            Ok(x) => results.push(x),
            Err(e) => tracing::warn!(error = %e, "validation task panicked"),
        }
    }
    for (hash, r) in results {
        match r {
            Ok(flags) => {
                checked += 1;
                let mut chain = state.chain()?;
                for f in flags {
                    if chain.flag(f, now)?.is_some() {
                        written += 1;
                    }
                }
                state.lock(&state.validator)?.retry_after.remove(&hash);
            }
            Err(e) => {
                failed += 1;
                tracing::warn!(tx = %hash, error = %e, "event validation deferred");
                let mut v = state.lock(&state.validator)?;
                v.retry_after.insert(hash, now + RETRY_AFTER);
                v.last_error = Some(format!("{hash}: {e}"));
            }
        }
    }
    {
        let mut v = state.lock(&state.validator)?;
        v.passes += 1;
        v.events_checked += checked;
        v.flags_written += written;
        v.last_pass_at = Some(now);
    }
    Ok(ValidationPass { checked, failed, flags_written: written, validation: state.chain()?.validation(10) })
}

fn flag(tx: &ChainTx, source: FlagSource, severity: RiskBand, code: &str, message: String, at: u64) -> Flag {
    Flag { code: code.into(), severity, source, message, at, target: tx.hash, data: BTreeMap::new() }
}

/// All findings for one event. Pure except for the origin-network lookups.
pub async fn judge_event(state: &AppState, hash: B256) -> Result<Vec<Flag>, ServiceError> {
    let now = state.now();
    let (tx, reports, behaviour) = {
        let chain = state.chain()?;
        let tx = chain.tx(hash)?;
        let wallet = if tx.kind == TxKind::External && tx.extra.get("incoming").and_then(|v| v.as_bool()).unwrap_or(false) { tx.to } else { tx.from };
        let behaviour: Vec<Flag> = chain.behaviour_findings(wallet, now).into_iter().filter(|f| f.target == hash).collect();
        let reports = counterparty_reports(&chain, &tx);
        (tx, reports, behaviour)
    };
    if !matches!(tx.kind, TxKind::Cosigned | TxKind::EscapeExit | TxKind::External) {
        return Err(ServiceError::BadRequest(format!("{hash} is not a validatable event")));
    }
    let mut out = behaviour;

    // 1. Reports filed by users or compliance against the counterparty.
    if reports > 0 {
        let severity = if reports >= 3 { RiskBand::Critical } else { RiskBand::High };
        let mut f = flag(&tx, FlagSource::Review, severity, "REPORTED_COUNTERPARTY", format!("the counterparty was reported {reports} time(s) as a scam or fraud"), now);
        f.data.insert("reports".into(), serde_json::json!(reports));
        out.push(f);
    }

    // 2. The origin network, for external events we can reach.
    let model = state.model.clone();
    let mut model_score: Option<f64> = None;
    if tx.kind == TxKind::External
        && let Ok(source) = state.sources.get(&tx.network.name)
    {
        let lists = state.watchlists()?;
        let r = report::report_for_event(source, &tx, &lists, ReportConfig { max_pages: 1, with_exposure: true, ..Default::default() }, Some(model.as_ref()), now)
            .await
            .map_err(|e| ServiceError::Upstream { provider: "connector", msg: e.to_string() })?;
        if let Some(p) = &r.receiver_provenance
            && p.risk != RiskBand::Low
        {
            let mut f = flag(&tx, FlagSource::Provenance, p.risk, "PROVENANCE", format!("counterparty {} on {}: {}", p.counterparty, p.network.name, p.reasons.iter().map(|r| r.code.as_str()).collect::<Vec<_>>().join(", ")), now);
            f.data = provenance::as_flag_data(p);
            out.push(f);
        }
        if let Some(risk) = r.transfers.first().and_then(|t| t.risk.as_ref()) {
            for reason in risk.reasons.iter().filter(|r| r.points >= 100) {
                out.push(flag(&tx, FlagSource::Review, RiskBand::Critical, &reason.code, reason.message.clone(), now));
            }
            if let Some(m) = &risk.model {
                model_score = Some(m.score);
            }
        }
    }

    // 3. The model on the features the chain computed at commit (always available).
    let threshold = model.describe().threshold;
    if let Some(f) = &tx.features {
        let score = model_score.unwrap_or_else(|| model.score(f));
        if score >= threshold {
            let severity = if score >= 0.85 { RiskBand::High } else { RiskBand::Medium };
            let mut fl = flag(&tx, FlagSource::Model, severity, "MODEL_RISK", format!("{} scores {score:.2}", model.name()), now);
            fl.data.insert("score".into(), serde_json::json!(score));
            fl.data.insert("top".into(), serde_json::json!(model.explain(f, 5)));
            out.push(fl);
        } else {
            let mut fl = flag(&tx, FlagSource::Model, RiskBand::Low, "VALIDATED", format!("checked by the validator, {} scores {score:.2}", model.name()), now);
            fl.data.insert("score".into(), serde_json::json!(score));
            out.push(fl);
        }
    } else {
        out.push(flag(&tx, FlagSource::Model, RiskBand::Low, "VALIDATED", "checked by the validator (no feature vector on this event)".into(), now));
    }
    Ok(out)
}

/// Reports against the counterparty of `tx`, via the chain's own index (no network).
fn counterparty_reports(chain: &sq_adapters::chain::ChainGuard<'_>, tx: &ChainTx) -> u64 {
    match tx.kind {
        TxKind::External => {
            let incoming = tx.extra.get("incoming").and_then(|v| v.as_bool()).unwrap_or(false);
            tx.extra
                .get("external")
                .and_then(|e| e.get(if incoming { "from_raw" } else { "to_raw" }))
                .and_then(|v| v.as_str())
                .map(|raw| chain.reports_of(&tx.network.name, raw).len() as u64)
                .unwrap_or(0)
        }
        _ => tx.action.counterparty().filter(|c| *c != tx.from).map(|c| chain.reports_of(&chain.info().network.name, &format!("{c:#x}")).len() as u64).unwrap_or(0),
    }
}
