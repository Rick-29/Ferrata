//! HTTP surface of the settlement layers. Reads default to the default chain; `chain_id` in the
//! body or query selects another. User operations route by `tx.chain_id`.
//! Reads are public (explorer / visualiser); writes against an account need its owner's session.

use alloy_primitives::{Address, B256};
use api_types::{
    AccountView, BlockWithTxs, BlocksQuery, CancelEscapeRequest, ChainInfo, ChainQuery, ChainTx, ChainVerification,
    CreateAccountRequest, DatasetRow, EscapeHashRequest, EscapeResponse, FaucetRequest, HashResponse, HistoryResponse,
    IngestRequest, ModelInfo, Network, PreparedOp, SignedUserOp, SimulateRequest, SimulateResponse, StartEscapeRequest,
    SubmitResult, SyncRequest, SyncResponse, ValidationStatus,
};
use axum::extract::{Path, Query, State};
use axum::routing::{get, post};
use axum::{Json, Router};

use crate::auth::Caller;
use crate::error::{ApiResult, ServiceError};
use crate::state::SharedState;

/// Top-level, cross-chain routes.
pub fn wallet_routes() -> Router<SharedState> {
    Router::new()
        .route("/chains", get(chains))
        .route("/model", get(model))
        .route("/networks", get(networks))
        .route("/networks/{name}/account/{address}", get(network_account))
}

/// What a connected network's indexer knows about an address: balance, tokens, labels, scam flag.
async fn network_account(State(state): State<SharedState>, Path((name, address)): Path<(String, String)>) -> ApiResult<sq_connectors::AccountInfo> {
    let source = state.sources.get(&name).map_err(|e| ServiceError::BadRequest(e.to_string()))?;
    let info = source.account_info(&address).await.map_err(|e| ServiceError::Upstream { provider: "connector", msg: e.to_string() })?;
    Ok(Json(info))
}

/// Networks the Ferra chain can pull history from.
async fn networks(State(state): State<SharedState>) -> ApiResult<Vec<Network>> {
    Ok(Json(state.sources.networks()))
}

async fn model(State(state): State<SharedState>) -> ApiResult<ModelInfo> {
    Ok(Json(state.model.describe()))
}

pub fn routes() -> Router<SharedState> {
    Router::new()
        .route("/info", get(info))
        .route("/verify", get(verify))
        .route("/validation", get(validation))
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
        .route("/ingest", post(ingest))
        .route("/sync", post(sync))
        .route("/dataset", get(dataset))
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

/// Share of validatable events with a validator verdict, and the next ones to look at.
async fn validation(State(state): State<SharedState>, Query(q): Query<ChainQuery>) -> ApiResult<ValidationStatus> {
    Ok(Json(state.chain_for(q.chain_id)?.validation(20)))
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
    let p = state.chain_for(Some(req.tx.chain_id))?.prepare(&req.tx)?;
    state.note_prepared(p.user_op_hash)?;
    Ok(Json(p))
}

async fn simulate(State(state): State<SharedState>, Json(req): Json<SimulateRequest>) -> ApiResult<SimulateResponse> {
    let chain = state.chain_for(Some(req.tx.chain_id))?;
    let action = state.decoder.decode(&req.tx)?;
    Ok(Json(SimulateResponse { action, deltas: chain.simulate(&req.tx)? }))
}

async fn submit(State(state): State<SharedState>, caller: Caller, Json(op): Json<SignedUserOp>) -> ApiResult<SubmitResult> {
    state.check_owner(&caller, op.tx.from)?;
    let user_op_hash = state.chain_for(Some(op.tx.chain_id))?.user_op_hash_for(&op);
    let meta = state.submit_meta(op.tx.from, user_op_hash)?;
    let r = state.chain_for(Some(op.tx.chain_id))?.submit(&op, &meta, state.now())?;
    crate::assess::record_intent_outcome(&state, op.tx.chain_id, op.tx.from, user_op_hash, api_types::IntentOutcomeKind::Submitted, Some(r.tx_hash))?;
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

/// Records an event Swissquote observed on another network (Ethereum, Bitcoin, Solana, TON, Sui, …)
/// on the Ferra chain, attested by its co-signature. This is how the wallet's cross-chain activity
/// becomes one reviewable, tamper-evident history.
async fn ingest(State(state): State<SharedState>, caller: Caller, Json(req): Json<IngestRequest>) -> ApiResult<SubmitResult> {
    state.check_owner(&caller, req.wallet)?;
    let now = state.now();
    let mut chain = state.chain_for(req.chain_id)?;
    let cosig = state.signer.cosign(&chain.external_hash(req.wallet, &req.event));
    let r = chain.ingest_external(req.wallet, req.event, req.counterparty, req.incoming, &cosig, now)?;
    tracing::info!(wallet = %req.wallet, tx = %r.tx_hash, "external event recorded on the Ferra chain");
    Ok(Json(r))
}

/// Pulls a page of the wallet's history on a connected network and records every event not yet
/// on the Ferra chain. Fetch happens before the chain lock is taken; idempotent per (network, tx id).
async fn sync(State(state): State<SharedState>, caller: Caller, Json(req): Json<SyncRequest>) -> ApiResult<SyncResponse> {
    state.check_owner(&caller, req.wallet)?;
    let source = state.sources.get(&req.network).map_err(|e| ServiceError::BadRequest(e.to_string()))?;
    let page = source
        .fetch(&req.address_raw, req.cursor.as_deref(), req.limit.unwrap_or(50))
        .await
        .map_err(|e| ServiceError::Upstream { provider: "connector", msg: e.to_string() })?;
    let network = source.network();
    let now = state.now();
    let fetched = page.events.len() as u64;
    let (mut recorded, mut skipped) = (0u64, 0u64);
    {
        let mut chain = state.chain()?;
        for ev in page.events {
            if chain.has_external(&ev.external.network.name, &ev.external.tx_id) {
                skipped += 1;
                continue;
            }
            let cosig = state.signer.cosign(&chain.external_hash(req.wallet, &ev.external));
            chain.ingest_external(req.wallet, ev.external, ev.counterparty, ev.incoming, &cosig, now)?;
            recorded += 1;
        }
    }
    tracing::info!(wallet = %req.wallet, network = %network.name, fetched, recorded, skipped, "network history synced");
    Ok(Json(SyncResponse { network, fetched, recorded, skipped_existing: skipped, next_cursor: page.next_cursor }))
}

/// Feature rows labelled by flags, for training the validator's model offline.
async fn dataset(State(state): State<SharedState>, Query(q): Query<BlocksQuery>) -> ApiResult<Vec<DatasetRow>> {
    let chain = state.chain_for(q.chain_id)?;
    let limit = q.limit.unwrap_or(1_000).clamp(1, 10_000) as usize;
    Ok(Json(chain.dataset(q.from.unwrap_or(0), limit)))
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
