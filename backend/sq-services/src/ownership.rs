//! Proof of wallet ownership (FINMA-style): Swissquote issues a challenge, the passkey signs it,
//! and the pseudo-chain account is created for that key.

use alloy_primitives::B256;
use axum::extract::State;
use axum::routing::{get, post};
use axum::{Json, Router};
use sq_adapters::MockChain;
use sq_adapters::chain::auth::verify_owner;

use crate::error::{ApiResult, ServiceError};
use crate::state::SharedState;

const CHALLENGE_TTL_SECS: u64 = 300;

pub fn routes() -> Router<SharedState> {
    Router::new().route("/ownership/challenge", get(challenge)).route("/wallet/register", post(register))
}

async fn challenge(State(state): State<SharedState>) -> ApiResult<api_types::ChallengeResponse> {
    let mut bytes = [0u8; 32];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut bytes);
    let challenge = B256::from(bytes);
    let expires_at = state.now() + CHALLENGE_TTL_SECS;
    let mut challenges = state.lock(&state.challenges)?;
    let now = state.now();
    challenges.retain(|_, exp| *exp > now);
    challenges.insert(challenge, expires_at);
    Ok(Json(api_types::ChallengeResponse { challenge, expires_at }))
}

async fn register(State(state): State<SharedState>, Json(req): Json<api_types::RegisterWalletRequest>) -> ApiResult<api_types::RegisterWalletResponse> {
    let now = state.now();
    {
        let mut challenges = state.lock(&state.challenges)?;
        match challenges.remove(&req.challenge) {
            Some(exp) if exp > now => {}
            _ => return Err(ServiceError::BadRequest("unknown or expired challenge".into())),
        }
    }
    req.owner.validate().map_err(|e| ServiceError::BadRequest(format!("owner key: {e}")))?;
    if !verify_owner(&req.owner, &req.challenge, &req.signature) {
        return Err(ServiceError::Unauthorized);
    }
    let address = MockChain::address_for(&req.owner);
    let mut chain = state.chain()?;
    if !chain.has_account(address) {
        chain.create_account(req.owner.clone())?;
    }
    let account = chain.account(address, now)?;
    tracing::info!(%address, "wallet registered with ownership proof");
    Ok(Json(api_types::RegisterWalletResponse { address, account }))
}
