//! Mock Swissquote login. Credentials come from `fixtures/accounts.json`.

use axum::extract::State;
use axum::routing::post;
use axum::{Json, Router};

use crate::error::{ApiResult, ServiceError};
use crate::state::{AppState, SharedState};

pub fn routes() -> Router<SharedState> {
    Router::new().route("/auth/session", post(login))
}

async fn login(State(state): State<SharedState>, Json(req): Json<api_types::LoginRequest>) -> ApiResult<api_types::Session> {
    let client = state
        .config
        .clients
        .iter()
        .find(|c| c.username == req.username && c.password == req.password)
        .ok_or(ServiceError::Unauthorized)?;
    let session = api_types::Session {
        token: AppState::new_id("sess"),
        client_id: client.client_id.clone(),
        display_name: client.display_name.clone(),
    };
    state.lock(&state.sessions)?.insert(session.token.clone(), session.clone());
    Ok(Json(session))
}
