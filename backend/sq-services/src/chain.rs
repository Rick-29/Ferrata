//! HTTP surface of the pseudo-blockchain. The UI treats this as its RPC until Base Sepolia is wired.

use alloy_primitives::{Address, B256};
use api_types::{
    AccountView, Block, CancelEscapeRequest, ChainInfo, ChainTx, CreateAccountRequest, EscapeHashRequest, EscapeResponse,
    FaucetRequest, HashResponse, HistoryResponse, PreparedOp, SignedUserOp, SimulateRequest, SimulateResponse,
    StartEscapeRequest, SubmitResult,
};
use axum::extract::{Path, State};
use axum::routing::{get, post};
use axum::{Json, Router};

use crate::error::{ApiResult, ServiceError};
use crate::state::SharedState;

pub fn routes() -> Router<SharedState> {
    Router::new()
        .route("/info", get(info))
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
        .route("/blocks/{number}", get(block))
        .route("/tx/{hash}", get(tx))
}

async fn info(State(state): State<SharedState>) -> ApiResult<ChainInfo> {
    Ok(Json(state.chain()?.info()))
}

async fn create_account(State(state): State<SharedState>, Json(req): Json<CreateAccountRequest>) -> ApiResult<AccountView> {
    let now = state.now();
    let mut chain = state.chain()?;
    let address = chain.create_account(req.owner)?;
    Ok(Json(chain.account(address, now)?))
}

async fn account(State(state): State<SharedState>, Path(address): Path<Address>) -> ApiResult<AccountView> {
    Ok(Json(state.chain()?.account(address, state.now())?))
}

async fn faucet(State(state): State<SharedState>, Json(req): Json<FaucetRequest>) -> ApiResult<SubmitResult> {
    Ok(Json(state.chain()?.fund(req.address, req.asset, req.amount, state.now())?))
}

async fn prepare(State(state): State<SharedState>, Json(req): Json<SimulateRequest>) -> ApiResult<PreparedOp> {
    Ok(Json(state.chain()?.prepare(&req.tx)?))
}

async fn simulate(State(state): State<SharedState>, Json(req): Json<SimulateRequest>) -> ApiResult<SimulateResponse> {
    let chain = state.chain()?;
    let action = state.decoder.decode(&req.tx)?;
    Ok(Json(SimulateResponse { action, deltas: chain.simulate(&req.tx)? }))
}

async fn submit(State(state): State<SharedState>, Json(op): Json<SignedUserOp>) -> ApiResult<SubmitResult> {
    let r = state.chain()?.submit(&op, state.now())?;
    tracing::info!(tx = %r.tx_hash, block = r.block_number, kind = ?r.kind, "transaction mined");
    Ok(Json(r))
}

/// Hash the owner must sign to start (`to` set) or cancel (`to` null) the escape hatch.
async fn escape_hash(State(state): State<SharedState>, Json(req): Json<EscapeHashRequest>) -> ApiResult<HashResponse> {
    let chain = state.chain()?;
    let nonce = chain.account(req.address, state.now())?.nonce;
    let hash = match req.to {
        Some(to) => chain.escape_hash(req.address, to, nonce),
        None => chain.escape_cancel_hash(req.address, nonce),
    };
    Ok(Json(HashResponse { hash, nonce }))
}

async fn escape_start(State(state): State<SharedState>, Json(req): Json<StartEscapeRequest>) -> ApiResult<EscapeResponse> {
    let (escape, tx) = state.chain()?.start_escape_hatch(req.address, req.to, &req.signature, state.now())?;
    tracing::warn!(address = %req.address, to = %req.to, "escape hatch started");
    Ok(Json(EscapeResponse { escape, tx }))
}

async fn escape_cancel(State(state): State<SharedState>, Json(req): Json<CancelEscapeRequest>) -> ApiResult<EscapeResponse> {
    let now = state.now();
    let mut chain = state.chain()?;
    let tx = chain.cancel_escape_hatch(req.address, &req.signature, now)?;
    Ok(Json(EscapeResponse { escape: chain.account(req.address, now)?.escape, tx }))
}

async fn history(State(state): State<SharedState>, Path(address): Path<Address>) -> ApiResult<HistoryResponse> {
    Ok(Json(HistoryResponse { address, txs: state.chain()?.history(address) }))
}

async fn block(State(state): State<SharedState>, Path(number): Path<u64>) -> ApiResult<Block> {
    let chain = state.chain()?;
    let b = chain.block(number).ok_or_else(|| ServiceError::NotFound(format!("block {number}")))?;
    Ok(Json(b.clone()))
}

async fn tx(State(state): State<SharedState>, Path(hash): Path<B256>) -> ApiResult<ChainTx> {
    Ok(Json(state.chain()?.tx(hash)?.clone()))
}
