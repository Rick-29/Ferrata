use alloy_primitives::Address;
use api_types::LogResponse;
use axum::extract::{Path, State};
use axum::routing::get;
use axum::{Json, Router};

use crate::error::ApiResult;
use crate::state::SharedState;

pub fn routes() -> Router<SharedState> {
    Router::new().route("/log/{address}", get(get_log))
}

async fn get_log(State(state): State<SharedState>, Path(address): Path<Address>) -> ApiResult<LogResponse> {
    let log = state.log.load(address)?;
    Ok(Json(LogResponse { address, head: log.head(), next_seq: log.next_seq(), entries: log.entries().to_vec() }))
}
