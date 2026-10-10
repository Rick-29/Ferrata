//! Audit log reads and anchoring: Swissquote co-signs the log head onto the chain so a rewritten
//! log would disagree with a record it cannot edit.

use alloy_primitives::Address;
use api_types::{AnchorResponse, LogResponse};
use axum::extract::{Path, State};
use axum::routing::{get, post};
use axum::{Json, Router};

use crate::auth::Caller;
use crate::error::{ApiResult, ServiceError};
use crate::state::SharedState;

pub fn routes() -> Router<SharedState> {
    Router::new().route("/log/{address}", get(get_log)).route("/log/{address}/anchor", post(anchor))
}

async fn get_log(State(state): State<SharedState>, caller: Caller, Path(address): Path<Address>) -> ApiResult<LogResponse> {
    state.check_owner(&caller, address)?;
    let log = state.log.load(address)?;
    Ok(Json(LogResponse { address, head: log.head(), next_seq: log.next_seq(), entries: log.entries().to_vec() }))
}

async fn anchor(State(state): State<SharedState>, caller: Caller, Path(address): Path<Address>) -> ApiResult<AnchorResponse> {
    state.check_owner(&caller, address)?;
    let log = state.log.load(address)?;
    if log.is_empty() {
        return Err(ServiceError::Conflict("nothing to anchor: log is empty".into()));
    }
    let head = log.head();
    let tx = {
        let mut chain = state.chain()?;
        let cosig = state.signer.cosign(&chain.anchor_hash(address, head));
        Some(chain.anchor(address, head, &cosig, state.now())?)
    };
    tracing::info!(%address, %head, "log head anchored on-chain");
    Ok(Json(AnchorResponse { address, head, seq_anchored: log.next_seq() - 1, tx }))
}
