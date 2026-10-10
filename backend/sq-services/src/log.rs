//! Audit log reads and anchoring: Swissquote periodically writes the log head on-chain so a
//! rewritten log would disagree with an immutable record.

use alloy_primitives::Address;
use api_types::{AnchorResponse, LogResponse};
use axum::extract::{Path, State};
use axum::routing::{get, post};
use axum::{Json, Router};

use crate::error::{ApiResult, ServiceError};
use crate::state::SharedState;

pub fn routes() -> Router<SharedState> {
    Router::new().route("/log/{address}", get(get_log)).route("/log/{address}/anchor", post(anchor))
}

async fn get_log(State(state): State<SharedState>, Path(address): Path<Address>) -> ApiResult<LogResponse> {
    let log = state.log.load(address)?;
    Ok(Json(LogResponse { address, head: log.head(), next_seq: log.next_seq(), entries: log.entries().to_vec() }))
}

async fn anchor(State(state): State<SharedState>, Path(address): Path<Address>) -> ApiResult<AnchorResponse> {
    let log = state.log.load(address)?;
    if log.is_empty() {
        return Err(ServiceError::Conflict("nothing to anchor: log is empty".into()));
    }
    let head = log.head();
    let tx = state.chain()?.anchor(address, head, state.now())?;
    tracing::info!(%address, %head, anchored = tx.is_some(), "log head anchored");
    Ok(Json(AnchorResponse { address, head, seq_anchored: log.next_seq() - 1, tx }))
}
