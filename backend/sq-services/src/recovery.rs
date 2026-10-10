//! Device recovery: new passkey + mock KYC → timelock → any existing device can cancel →
//! after the timelock Swissquote co-signs the owner rotation on the pseudo-chain.

use alloy_primitives::{B256, keccak256};
use api_types::{CancelRecoveryRequest, RecoveryState, RecoveryStatus, StartRecoveryRequest};
use axum::extract::{Path, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use sq_adapters::chain::auth::verify_owner;

use crate::error::{ApiResult, ServiceError};
use crate::state::{AppState, SharedState};

pub fn routes() -> Router<SharedState> {
    Router::new()
        .route("/recovery/start", post(start))
        .route("/recovery/{id}", get(get_recovery))
        .route("/recovery/{id}/cancel", post(cancel))
        .route("/recovery/{id}/execute", post(execute))
}

fn cancel_hash(id: &str) -> B256 {
    keccak256([b"SQW-RECOVERY-CANCEL-v1".as_slice(), id.as_bytes()].concat())
}

async fn start(State(state): State<SharedState>, Json(req): Json<StartRecoveryRequest>) -> ApiResult<RecoveryState> {
    req.new_owner.validate().map_err(|e| ServiceError::BadRequest(format!("new owner key: {e}")))?;
    if !state.chain()?.has_account(req.address) {
        return Err(ServiceError::NotFound(format!("account {}", req.address)));
    }
    {
        let recoveries = state.lock(&state.recoveries)?;
        if recoveries.values().any(|r| r.address == req.address && matches!(r.status, RecoveryStatus::Pending { .. })) {
            return Err(ServiceError::Conflict("recovery already pending for this account".into()));
        }
    }
    let script = state
        .config
        .kyc_scripts
        .iter()
        .find(|s| s.id == req.kyc.script_id)
        .ok_or_else(|| ServiceError::BadRequest(format!("unknown KYC script {}", req.kyc.script_id)))?;
    let kyc_passed = script.outcome == "pass";
    let now = state.now();
    let id = AppState::new_id("rec");
    let status = if kyc_passed {
        RecoveryStatus::Pending { unlock_at: now + state.config.seed.recovery_delay_secs }
    } else {
        RecoveryStatus::Rejected { reason: format!("simulated video identification failed: {}", script.label) }
    };
    let rec = RecoveryState { cancel_hash: cancel_hash(&id), id: id.clone(), address: req.address, new_owner: req.new_owner, status, started_at: now, kyc_passed };
    tracing::warn!(%id, address = %req.address, kyc_passed, "recovery started");
    state.lock(&state.recoveries)?.insert(id, rec.clone());
    Ok(Json(rec))
}

async fn get_recovery(State(state): State<SharedState>, Path(id): Path<String>) -> ApiResult<RecoveryState> {
    let recoveries = state.lock(&state.recoveries)?;
    let rec = recoveries.get(&id).ok_or_else(|| ServiceError::NotFound(format!("recovery {id}")))?;
    Ok(Json(rec.clone()))
}

/// Any device holding the *current* owner key can cancel during the timelock.
async fn cancel(State(state): State<SharedState>, Path(id): Path<String>, Json(req): Json<CancelRecoveryRequest>) -> ApiResult<RecoveryState> {
    let mut recoveries = state.lock(&state.recoveries)?;
    let rec = recoveries.get_mut(&id).ok_or_else(|| ServiceError::NotFound(format!("recovery {id}")))?;
    if !matches!(rec.status, RecoveryStatus::Pending { .. }) {
        return Err(ServiceError::Conflict("recovery is not pending".into()));
    }
    let owner = state.chain()?.account(rec.address, state.now())?.owner;
    if !verify_owner(&owner, &rec.cancel_hash, &req.signature) {
        return Err(ServiceError::Unauthorized);
    }
    rec.status = RecoveryStatus::Cancelled { at: state.now() };
    tracing::warn!(%id, "recovery cancelled by existing device");
    Ok(Json(rec.clone()))
}

/// After the timelock, Swissquote authorises the key rotation on-chain.
async fn execute(State(state): State<SharedState>, Path(id): Path<String>) -> ApiResult<RecoveryState> {
    let mut recoveries = state.lock(&state.recoveries)?;
    let rec = recoveries.get_mut(&id).ok_or_else(|| ServiceError::NotFound(format!("recovery {id}")))?;
    let now = state.now();
    match rec.status {
        RecoveryStatus::Pending { unlock_at } if now >= unlock_at => {}
        RecoveryStatus::Pending { unlock_at } => {
            return Err(ServiceError::Conflict(format!("timelock active until {unlock_at}")));
        }
        _ => return Err(ServiceError::Conflict("recovery is not pending".into())),
    }
    let mut chain = state.chain()?;
    let nonce = chain.account(rec.address, now)?.nonce;
    let hash = chain.rotate_hash(rec.address, &rec.new_owner, nonce);
    let result = chain.rotate_owner(rec.address, rec.new_owner.clone(), &state.signer.cosign(&hash), now)?;
    rec.status = RecoveryStatus::Completed { at: now, tx_hash: result.tx_hash };
    tracing::warn!(%id, tx = %result.tx_hash, "recovery executed: owner rotated");
    Ok(Json(rec.clone()))
}
