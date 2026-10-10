//! The owner's side of the Ferra chain: settings (owner-signed), intents (cancel), the computed
//! profile, and provenance checks of external events.

use alloy_primitives::{Address, B256};
use api_types::{IntentOutcomeKind, IntentState, ProvenanceResponse, SetSettingsRequest, SettingsHashRequest, SettingsResponse, WalletProfile, HashResponse};
use axum::extract::{Path, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use sq_adapters::{Flag, FlagSource, IntentOutcome, TxKind};
use sq_connectors::provenance;

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
    let sanctioned = state.config.sanctioned_raw.clone();
    let assessment = provenance::assess(source, &tx, &sanctioned, 50).await.map_err(|e| ServiceError::Upstream { provider: "connector", msg: e.to_string() })?;
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
