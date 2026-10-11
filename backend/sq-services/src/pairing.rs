//! Pairing relay for the recovery phone: the extension and the phone cannot talk to each other,
//! so the extension opens a pairing (shown as a QR), the phone drops its public key on it, and the
//! extension reads it back. The relay only carries a public key: nothing is registered until the
//! owner's passkey signs it (`POST /recovery-key/{address}`), after the user compared the short
//! fingerprint shown on both screens (so a key slipped into the relay is caught).

use alloy_primitives::{Address, keccak256};
use api_types::{OwnerKey, PairingKeyRequest, PairingState, StartPairingRequest};
use axum::extract::{Path, State};
use axum::routing::{get, post};
use axum::{Json, Router};

use crate::auth::Caller;
use crate::error::{ApiResult, ServiceError};
use crate::state::{AppState, SharedState};

const PAIRING_TTL_SECS: u64 = 10 * 60;

pub fn routes() -> Router<SharedState> {
    Router::new()
        .route("/pairing", post(start))
        .route("/pairing/{id}", get(get_pairing))
        .route("/pairing/{id}/key", post(offer_key))
}

/// Short, human-comparable fingerprint of a public key, e.g. `7F3A-91C2`.
pub fn fingerprint(key: &OwnerKey) -> String {
    let h = keccak256(serde_json::to_vec(key).unwrap_or_default());
    let hex = alloy_primitives::hex::encode_upper(&h[..4]);
    format!("{}-{}", &hex[..4], &hex[4..])
}

fn check_session(state: &AppState, caller: &Caller, address: Address) -> Result<(), ServiceError> {
    if state.config.require_auth && state.client_of(caller)?.is_none() {
        return Err(ServiceError::Unauthorized);
    }
    state.check_owner(caller, address)
}

async fn start(State(state): State<SharedState>, caller: Caller, Json(req): Json<StartPairingRequest>) -> ApiResult<PairingState> {
    check_session(&state, &caller, req.address)?;
    if !state.chain()?.has_account(req.address) {
        return Err(ServiceError::NotFound(format!("account {}", req.address)));
    }
    let now = state.now();
    let p = PairingState { id: AppState::new_id("pair"), address: req.address, expires_at: now + PAIRING_TTL_SECS, key: None, fingerprint: None, device_label: None };
    let mut pairings = state.lock(&state.pairings)?;
    pairings.retain(|_, p| p.expires_at > now);
    pairings.insert(p.id.clone(), p.clone());
    Ok(Json(p))
}

async fn get_pairing(State(state): State<SharedState>, caller: Caller, Path(id): Path<String>) -> ApiResult<PairingState> {
    let p = state.lock(&state.pairings)?.get(&id).cloned().ok_or_else(|| ServiceError::NotFound(format!("pairing {id}")))?;
    check_session(&state, &caller, p.address)?;
    if p.expires_at <= state.now() {
        return Err(ServiceError::Conflict("pairing expired".into()));
    }
    Ok(Json(p))
}

/// The phone (logged in as the same Swissquote client) offers its public key, once.
async fn offer_key(State(state): State<SharedState>, caller: Caller, Path(id): Path<String>, Json(req): Json<PairingKeyRequest>) -> ApiResult<PairingState> {
    req.key.validate().map_err(|e| ServiceError::BadRequest(format!("phone key: {e}")))?;
    let mut pairings = state.lock(&state.pairings)?;
    let p = pairings.get_mut(&id).ok_or_else(|| ServiceError::NotFound(format!("pairing {id}")))?;
    check_session(&state, &caller, p.address)?;
    if p.expires_at <= state.now() {
        return Err(ServiceError::Conflict("pairing expired".into()));
    }
    if p.key.is_some() {
        return Err(ServiceError::Conflict("a phone already answered this pairing".into()));
    }
    p.fingerprint = Some(fingerprint(&req.key));
    p.key = Some(req.key);
    p.device_label = req.device_label.map(|l| l.chars().take(40).collect());
    Ok(Json(p.clone()))
}

#[cfg(test)]
mod tests {
    use alloy_primitives::Bytes;

    use super::*;

    #[test]
    fn fingerprint_matches_the_extension() {
        // Same vector as frontend `background/recovery/fingerprint.test.ts`.
        let key = OwnerKey::Ed25519 { key: Bytes::from(vec![0x11u8; 32]) };
        assert_eq!(fingerprint(&key), "5FA8-122B");
    }
}
