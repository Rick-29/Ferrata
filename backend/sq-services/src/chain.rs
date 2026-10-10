//! HTTP surface of the settlement layers. Reads default to the default chain; `chain_id` in the
//! body or query selects another. User operations route by `tx.chain_id`.
//! Reads are public (explorer / visualiser); writes against an account need its owner's session.

use alloy_primitives::{Address, B256};
use api_types::{
    AccountView, BlockWithTxs, BlocksQuery, CancelEscapeRequest, ChainInfo, ChainQuery, ChainTx, ChainVerification,
    CreateAccountRequest, EscapeHashRequest, EscapeResponse, FaucetRequest, HashResponse, HistoryResponse, PreparedOp,
    SignedUserOp, SimulateRequest, SimulateResponse, StartEscapeRequest, SubmitResult,
};
use axum::extract::{Path, Query, State};
use axum::routing::{get, post};
use axum::{Json, Router};

use crate::auth::Caller;
use crate::error::{ApiResult, ServiceError};
use crate::state::SharedState;

/// Top-level, cross-chain routes.
pub fn wallet_routes() -> Router<SharedState> {
    Router::new().route("/chains", get(chains))
}

pub fn routes() -> Router<SharedState> {
    Router::new()
        .route("/info", get(info))
        .route("/verify", get(verify))
        .route("/accounts", post(create_account))
        .route("/accounts/{address}", get(account))
        .route("/faucet", post(faucet))
        .route("/prepare", post(prepare))
        .route("/simulate", post(simulate))
        .route("/submit", post(submit))
        .route("/escape/hash", post(escape_hash))
        .route("/escape/start", post(escape_start))
        .route("/escape/cancel", post(escape_cancel))
        .route("/history/{address}", get(history))
        .route("/blocks", get(blocks))
        .route("/blocks/{number}", get(block))
        .route("/tx/{hash}", get(tx))
}

async fn chains(State(state): State<SharedState>) -> ApiResult<Vec<ChainInfo>> {
    Ok(Json(state.chains.for_each(|c| Ok(c.info()))?))
}

async fn info(State(state): State<SharedState>, Query(q): Query<ChainQuery>) -> ApiResult<ChainInfo> {
    Ok(Json(state.chain_for(q.chain_id)?.info()))
}

/// Replays the whole chain and re-checks every hash, signature and state root.
async fn verify(State(state): State<SharedState>, Query(q): Query<ChainQuery>) -> ApiResult<ChainVerification> {
    let v = state.chain_for(q.chain_id)?.verify();
    if !v.ok {
        tracing::error!(block = ?v.first_bad_block, reason = ?v.reason, "chain integrity check FAILED");
    }
    Ok(Json(v))
}

async fn create_account(State(state): State<SharedState>, caller: Caller, Query(q): Query<ChainQuery>, Json(req): Json<CreateAccountRequest>) -> ApiResult<AccountView> {
    let now = state.now();
    let mut chain = state.chain_for(q.chain_id)?;
    let address = chain.create_account(req.owner, now)?;
    state.bind_owner(&caller, address)?;
    Ok(Json(chain.account(address, now)?))
}

async fn account(State(state): State<SharedState>, Query(q): Query<ChainQuery>, Path(address): Path<Address>) -> ApiResult<AccountView> {
    Ok(Json(state.chain_for(q.chain_id)?.account(address, state.now())?))
}

async fn faucet(State(state): State<SharedState>, Json(req): Json<FaucetRequest>) -> ApiResult<SubmitResult> {
    Ok(Json(state.chain_for(req.chain_id)?.fund(req.address, req.asset, req.amount, state.now())?))
}

async fn prepare(State(state): State<SharedState>, Json(req): Json<SimulateRequest>) -> ApiResult<PreparedOp> {
    Ok(Json(state.chain_for(Some(req.tx.chain_id))?.prepare(&req.tx)?))
}

async fn simulate(State(state): State<SharedState>, Json(req): Json<SimulateRequest>) -> ApiResult<SimulateResponse> {
    let chain = state.chain_for(Some(req.tx.chain_id))?;
    let action = state.decoder.decode(&req.tx)?;
    Ok(Json(SimulateResponse { action, deltas: chain.simulate(&req.tx)? }))
}

async fn submit(State(state): State<SharedState>, caller: Caller, Json(op): Json<SignedUserOp>) -> ApiResult<SubmitResult> {
    state.check_owner(&caller, op.tx.from)?;
    let r = state.chain_for(Some(op.tx.chain_id))?.submit(&op, state.now())?;
    tracing::info!(chain = op.tx.chain_id, tx = %r.tx_hash, block = r.block_number, kind = ?r.kind, "transaction mined");
    Ok(Json(r))
}

/// Hash the owner must sign to start (`to` set) or cancel (`to` null) the escape hatch.
async fn escape_hash(State(state): State<SharedState>, Json(req): Json<EscapeHashRequest>) -> ApiResult<HashResponse> {
    let chain = state.chain_for(req.chain_id)?;
    let nonce = chain.account(req.address, state.now())?.nonce;
    let hash = match req.to {
        Some(to) => chain.escape_hash(req.address, to, nonce),
        None => chain.escape_cancel_hash(req.address, nonce),
    };
    Ok(Json(HashResponse { hash, nonce }))
}

async fn escape_start(State(state): State<SharedState>, caller: Caller, Json(req): Json<StartEscapeRequest>) -> ApiResult<EscapeResponse> {
    state.check_owner(&caller, req.address)?;
    let (escape, tx) = state.chain_for(req.chain_id)?.start_escape_hatch(req.address, req.to, &req.signature, state.now())?;
    tracing::warn!(address = %req.address, to = %req.to, "escape hatch started");
    Ok(Json(EscapeResponse { escape, tx }))
}

async fn escape_cancel(State(state): State<SharedState>, caller: Caller, Json(req): Json<CancelEscapeRequest>) -> ApiResult<EscapeResponse> {
    state.check_owner(&caller, req.address)?;
    let now = state.now();
    let mut chain = state.chain_for(req.chain_id)?;
    let tx = chain.cancel_escape_hatch(req.address, &req.signature, now)?;
    Ok(Json(EscapeResponse { escape: chain.account(req.address, now)?.escape, tx }))
}

async fn history(State(state): State<SharedState>, Query(q): Query<ChainQuery>, Path(address): Path<Address>) -> ApiResult<HistoryResponse> {
    Ok(Json(HistoryResponse { address, txs: state.chain_for(q.chain_id)?.history(address) }))
}

/// A page of blocks with their events. Without `from`, the newest `limit` blocks.
async fn blocks(State(state): State<SharedState>, Query(q): Query<BlocksQuery>) -> ApiResult<Vec<BlockWithTxs>> {
    let chain = state.chain_for(q.chain_id)?;
    let limit = q.limit.unwrap_or(50).clamp(1, 500) as usize;
    let latest = chain.latest_block().number;
    let from = q.from.unwrap_or_else(|| latest.saturating_sub(limit as u64 - 1));
    Ok(Json(chain.blocks(from, limit)))
}

async fn block(State(state): State<SharedState>, Query(q): Query<ChainQuery>, Path(number): Path<u64>) -> ApiResult<BlockWithTxs> {
    let chain = state.chain_for(q.chain_id)?;
    let b = chain.block(number).ok_or_else(|| ServiceError::NotFound(format!("block {number}")))?;
    Ok(Json(b))
}

async fn tx(State(state): State<SharedState>, Query(q): Query<ChainQuery>, Path(hash): Path<B256>) -> ApiResult<ChainTx> {
    Ok(Json(state.chain_for(q.chain_id)?.tx(hash)?))
}
