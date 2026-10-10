//! Proof of wallet ownership (FINMA-style): Swissquote issues a challenge, the passkey signs it,
//! and an account for that key is created on every registered chain. One owner key, one wallet,
//! bound to the Swissquote client whose session registered it.

use alloy_primitives::B256;
use api_types::{WalletOverview, WalletOverviewRequest};
use axum::extract::State;
use axum::routing::{get, post};
use axum::{Json, Router};
use sq_adapters::chain::auth::verify_owner;

use crate::auth::Caller;
use crate::error::{ApiResult, ServiceError};
use crate::state::SharedState;

const CHALLENGE_TTL_SECS: u64 = 300;

pub fn routes() -> Router<SharedState> {
    Router::new()
        .route("/ownership/challenge", get(challenge))
        .route("/wallet/register", post(register))
        .route("/wallet/overview", post(overview))
}

async fn challenge(State(state): State<SharedState>) -> ApiResult<api_types::ChallengeResponse> {
    let mut bytes = [0u8; 32];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut bytes);
    let challenge = B256::from(bytes);
    let now = state.now();
    let expires_at = now + CHALLENGE_TTL_SECS;
    let mut challenges = state.lock(&state.challenges)?;
    challenges.retain(|_, exp| *exp > now);
    challenges.insert(challenge, expires_at);
    Ok(Json(api_types::ChallengeResponse { challenge, expires_at }))
}

async fn register(State(state): State<SharedState>, caller: Caller, Json(req): Json<api_types::RegisterWalletRequest>) -> ApiResult<api_types::RegisterWalletResponse> {
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

    let accounts = state.chains.for_each(|chain| {
        let address = chain.address_for(&req.owner);
        if !chain.has_account(address) {
            chain.create_account(req.owner.clone(), now)?;
        }
        chain.account(address, now)
    })?;
    for a in &accounts {
        state.check_owner(&caller, a.address)?;
        state.bind_owner(&caller, a.address)?;
    }
    let account = {
        let chain = state.chain()?;
        chain.account(chain.address_for(&req.owner), now)?
    };
    tracing::info!(address = %account.address, chains = accounts.len(), client = ?state.client_of(&caller)?, "wallet registered with ownership proof");
    Ok(Json(api_types::RegisterWalletResponse { address: account.address, account, accounts }))
}

/// The wallet as the user sees it: every chain account behind one owner key.
async fn overview(State(state): State<SharedState>, caller: Caller, Json(req): Json<WalletOverviewRequest>) -> ApiResult<WalletOverview> {
    let now = state.now();
    let accounts: Vec<_> = state
        .chains
        .for_each(|chain| {
            let address = chain.address_for(&req.owner);
            Ok(if chain.has_account(address) { Some(chain.account(address, now)?) } else { None })
        })?
        .into_iter()
        .flatten()
        .collect();
    for a in &accounts {
        state.check_owner(&caller, a.address)?;
    }
    Ok(Json(WalletOverview { owner: req.owner, accounts }))
}
