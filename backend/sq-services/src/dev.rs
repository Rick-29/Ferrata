//! Mock passkeys for development only (`SQ_DEV_SIGNER=1`, the default). Lets the UI run the full
//! flow before WebAuthn is wired. Keys live in server memory and never leave it; the real flow
//! uses the browser's passkey and the `webauthn` owner signature instead.

use std::collections::HashMap;
use std::sync::Mutex;

use alloy_primitives::Bytes;
use api_types::{DevPasskey, DevPasskeyRequest, DevSignRequest, OwnerKey, OwnerSignature};
use axum::extract::{Path, State};
use axum::routing::post;
use axum::{Json, Router};
use ed25519_dalek::{Signer, SigningKey};
use sq_adapters::MockChain;

use crate::error::{ApiResult, ServiceError};
use crate::state::SharedState;

#[derive(Default)]
pub struct DevKeyring {
    keys: Mutex<HashMap<String, SigningKey>>,
}

impl DevKeyring {
    fn describe(name: &str, key: &SigningKey) -> DevPasskey {
        let owner = OwnerKey::Ed25519 { key: Bytes::copy_from_slice(key.verifying_key().as_bytes()) };
        DevPasskey { name: name.to_string(), address: MockChain::address_for(&owner), owner }
    }
}

pub fn routes() -> Router<SharedState> {
    Router::new()
        .route("/passkeys", post(create).get(list))
        .route("/passkeys/{name}/sign", post(sign))
}

/// Creates (or returns) a named mock passkey. Deterministic per name so the demo is repeatable.
async fn create(State(state): State<SharedState>, Json(req): Json<DevPasskeyRequest>) -> ApiResult<DevPasskey> {
    let mut keys = state.lock(&state.dev_keys.keys)?;
    let key = keys.entry(req.name.clone()).or_insert_with(|| {
        let seed: [u8; 32] = alloy_primitives::keccak256(format!("sqw-dev-passkey:{}", req.name)).0;
        SigningKey::from_bytes(&seed)
    });
    Ok(Json(DevKeyring::describe(&req.name, key)))
}

async fn list(State(state): State<SharedState>) -> ApiResult<Vec<DevPasskey>> {
    let keys = state.lock(&state.dev_keys.keys)?;
    Ok(Json(keys.iter().map(|(n, k)| DevKeyring::describe(n, k)).collect()))
}

async fn sign(State(state): State<SharedState>, Path(name): Path<String>, Json(req): Json<DevSignRequest>) -> ApiResult<OwnerSignature> {
    let keys = state.lock(&state.dev_keys.keys)?;
    let key = keys.get(&name).ok_or_else(|| ServiceError::NotFound(format!("dev passkey {name}")))?;
    let sig = key.sign(req.hash.as_slice());
    Ok(Json(OwnerSignature::Ed25519 { signature: Bytes::copy_from_slice(&sig.to_bytes()) }))
}
