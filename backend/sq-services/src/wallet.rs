//! The owner's side of the Ferra chain: settings (owner-signed), intents (cancel), the computed
//! profile, and provenance checks of external events.

use alloy_primitives::{Address, B256};
use api_types::{HashResponse, IntentOutcomeKind, IntentState, ProvenanceResponse, RiskPreviewRequest, SetSettingsRequest, SettingsHashRequest, SettingsResponse, WalletProfile};
use axum::extract::{Path, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use sq_adapters::{ExternalRef, Flag, FlagSource, IntentOutcome, TxKind};
use sq_connectors::preview::{self, RiskPreview, SenderContext};
use sq_connectors::provenance;
use sq_connectors::report::{self, ReportConfig, TransferReport};

use crate::auth::Caller;
use crate::error::{ApiResult, ServiceError};
use crate::state::{AppState, SharedState};

pub fn routes() -> Router<SharedState> {
    Router::new()
        .route("/settings/{address}", get(get_settings).post(set_settings))
        .route("/settings/{address}/hash", post(settings_hash))
        .route("/intents/{address}/{id}", get(get_intent))
        .route("/intents/{address}/{id}/cancel", post(cancel_intent))
        .route("/profile/{address}", get(profile))
        .route("/provenance/{hash}", post(provenance_check))
        .route("/report/event/{hash}", post(event_report))
        .route("/risk/preview", post(risk_preview))
}

/// Risk **before** signing: the counterparty is researched on its network, the sender side comes
/// from the Ferra chain profile of `wallet` (or the caller's own `sender` context), and the model
/// explains the result as multiplicative factors the UI can read out. Writes nothing.
async fn risk_preview(State(state): State<SharedState>, Json(req): Json<RiskPreviewRequest>) -> ApiResult<RiskPreview> {
    let source = state.sources.get(&req.network).map_err(|e| ServiceError::BadRequest(e.to_string()))?;
    let lists = state.watchlists()?;
    let model = state.model.clone();
    let now = state.now();
    let sender = match (req.sender, req.wallet) {
        (Some(s), _) => Some(s),
        (None, Some(w)) => sender_context(&state, w, &req.network, req.amount.as_ref().map(|a| a.asset_symbol.as_str()), &source.canonical(&req.counterparty))?,
        (None, None) => None,
    };
    let wallet = req.wallet.map(|w| w.to_string());
    let r = preview::risk_preview(source, &req.counterparty, wallet.as_deref(), req.amount, sender.as_ref(), &lists, Some(model.as_ref()), ReportConfig { max_pages: 2, ..Default::default() }, now)
        .await
        .map_err(|e| ServiceError::Upstream { provider: "connector", msg: e.to_string() })?;
    Ok(Json(r))
}

/// What the Ferra chain knows about one of our wallets, shaped for the preview.
fn sender_context(state: &AppState, wallet: alloy_primitives::Address, network: &str, symbol: Option<&str>, counterparty: &str) -> Result<Option<SenderContext>, ServiceError> {
    let chain = state.chain()?;
    if !chain.has_account(wallet) {
        return Ok(None);
    }
    let now = state.now();
    let profile = chain.profile(wallet, now);
    let history = chain.history(wallet);
    let day_ago = now.saturating_sub(86_400);
    let mut out_count_24h = 0u64;
    let mut known_recipient = chain.settings_of(wallet).allowlist.iter().any(|a| a.to_string().eq_ignore_ascii_case(counterparty));
    for t in &history {
        if t.from != wallet || !matches!(t.kind, TxKind::Cosigned | TxKind::External) {
            continue;
        }
        if t.timestamp >= day_ago {
            out_count_24h += 1;
        }
        if t.kind == TxKind::External {
            if let Some(ext) = t.extra.get("external").and_then(|e| serde_json::from_value::<ExternalRef>(e.clone()).ok())
                && ext.network.name == network
                && ext.to_raw.eq_ignore_ascii_case(counterparty)
            {
                known_recipient = true;
            }
        } else if t.action.counterparty().is_some_and(|c| c.to_string().eq_ignore_ascii_case(counterparty)) {
            known_recipient = true;
        }
    }
    let balance_units = chain
        .balances_of_view(wallet)
        .into_iter()
        .find(|b| symbol.is_none_or(|s| b.symbol.eq_ignore_ascii_case(s)))
        .map(|b| b.amount.to::<u128>() as f64 / 10f64.powi(i32::from(b.decimals)))
        .unwrap_or(0.0);
    Ok(Some(SenderContext {
        balance_units,
        prior_out_count: profile.out_count,
        mean_out_units: profile.mean_out,
        p95_out_units: profile.p95_out,
        age_secs: profile.age_secs,
        known_recipient,
        out_count_24h,
        archetype: Some(serde_json::to_value(profile.archetype).ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_default()),
    }))
}

/// The one-sided transfer report for an external event: only the counterparty is researched,
/// the predicted risk includes the validator's model. Writes nothing; the review does that.
async fn event_report(State(state): State<SharedState>, Path(hash): Path<B256>) -> ApiResult<TransferReport> {
    let tx = state.chain()?.tx(hash)?;
    let source = state.sources.get(&tx.network.name).map_err(|e| ServiceError::BadRequest(e.to_string()))?;
    let lists = state.watchlists()?;
    let model = state.model.clone();
    let r = report::report_for_event(source, &tx, &lists, ReportConfig { max_pages: 2, ..Default::default() }, Some(model.as_ref()), state.now())
        .await
        .map_err(|e| ServiceError::Upstream { provider: "connector", msg: e.to_string() })?;
    Ok(Json(r))
}

async fn get_settings(State(state): State<SharedState>, caller: Caller, Path(address): Path<Address>) -> ApiResult<SettingsResponse> {
    state.check_owner(&caller, address)?;
    Ok(Json(SettingsResponse { address, settings: state.chain()?.settings_of(address), tx: None }))
}

/// Hash the owner signs to apply `settings` (bound to the account's current nonce).
async fn settings_hash(State(state): State<SharedState>, caller: Caller, Path(address): Path<Address>, Json(req): Json<SettingsHashRequest>) -> ApiResult<HashResponse> {
    state.check_owner(&caller, address)?;
    let chain = state.chain()?;
    let nonce = chain.account(address, state.now())?.nonce;
    Ok(Json(HashResponse { hash: chain.settings_hash(address, nonce, &req.settings), nonce }))
}

async fn set_settings(State(state): State<SharedState>, caller: Caller, Path(address): Path<Address>, Json(req): Json<SetSettingsRequest>) -> ApiResult<SettingsResponse> {
    state.check_owner(&caller, address)?;
    if req.settings.per_tx_limit_pct > 100 || req.settings.step_up_above_pct > 100 {
        return Err(ServiceError::BadRequest("percentages must be 0..=100".into()));
    }
    let mut chain = state.chain()?;
    let tx = chain.set_settings(address, req.settings.clone(), &req.signature, state.now())?;
    tracing::info!(%address, "wallet settings changed on-chain");
    Ok(Json(SettingsResponse { address, settings: req.settings, tx: Some(tx) }))
}

async fn get_intent(State(state): State<SharedState>, caller: Caller, Path((address, id)): Path<(Address, String)>) -> ApiResult<IntentState> {
    state.check_owner(&caller, address)?;
    let (intent, outcome) = state.chain()?.intent_by_id(address, &id).ok_or_else(|| ServiceError::NotFound(format!("intent {id}")))?;
    Ok(Json(IntentState { intent, outcome }))
}

/// The user backed out before signing. Recorded: cancel patterns are behavioural data.
async fn cancel_intent(State(state): State<SharedState>, caller: Caller, Path((address, id)): Path<(Address, String)>) -> ApiResult<IntentState> {
    state.check_owner(&caller, address)?;
    let mut chain = state.chain()?;
    let (intent, outcome) = chain.intent_by_id(address, &id).ok_or_else(|| ServiceError::NotFound(format!("intent {id}")))?;
    if matches!(outcome, Some(IntentOutcomeKind::Submitted | IntentOutcomeKind::Cancelled | IntentOutcomeKind::Refused)) {
        return Err(ServiceError::Conflict(format!("intent is already {outcome:?}")));
    }
    let o = IntentOutcome { intent_id: id.clone(), outcome: IntentOutcomeKind::Cancelled, tx_hash: None };
    let cosig = state.signer.cosign(&chain.intent_hash(address, &format!("{id}:Cancelled")));
    chain.record_intent_outcome(address, o, &cosig, state.now())?;
    Ok(Json(IntentState { intent, outcome: Some(IntentOutcomeKind::Cancelled) }))
}

async fn profile(State(state): State<SharedState>, Path(address): Path<Address>) -> ApiResult<WalletProfile> {
    Ok(Json(state.chain()?.profile(address, state.now())))
}

/// Checks one external event's counterparty on its origin network and records the verdict as a flag.
pub async fn provenance_for(state: &AppState, hash: B256) -> Result<ProvenanceResponse, ServiceError> {
    let tx = state.chain()?.tx(hash)?;
    if tx.kind != TxKind::External {
        return Err(ServiceError::BadRequest("provenance applies to external events".into()));
    }
    let source = state.sources.get(&tx.network.name).map_err(|e| ServiceError::BadRequest(e.to_string()))?;
    let lists = state.watchlists()?;
    let assessment = provenance::assess(source, &tx, &lists, 50).await.map_err(|e| ServiceError::Upstream { provider: "connector", msg: e.to_string() })?;
    let mut flagged = false;
    if assessment.risk != wallet_core::RiskBand::Low {
        let flag = Flag {
            code: "PROVENANCE".into(),
            severity: assessment.risk,
            source: FlagSource::Provenance,
            message: format!("counterparty {} on {}: {}", assessment.counterparty, assessment.network.name, assessment.reasons.iter().map(|r| r.code.as_str()).collect::<Vec<_>>().join(", ")),
            at: state.now(),
            target: hash,
            data: provenance::as_flag_data(&assessment),
        };
        flagged = state.chain()?.flag(flag, state.now())?.is_some();
    }
    Ok(ProvenanceResponse { tx_hash: hash, assessment, flagged })
}

async fn provenance_check(State(state): State<SharedState>, Path(hash): Path<B256>) -> ApiResult<ProvenanceResponse> {
    Ok(Json(provenance_for(&state, hash).await?))
}
