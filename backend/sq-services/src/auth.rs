//! Mock Swissquote login (`fixtures/accounts.json`) and the bearer-token gate.

use axum::extract::{Request, State};
use axum::http::header;
use axum::middleware::Next;
use axum::response::Response;
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
    tracing::info!(client = %session.client_id, "session issued");
    Ok(Json(session))
}

/// Routes reachable without a session: login itself, public chain reads, dev helpers.
fn is_public(path: &str) -> bool {
    path == "/auth/session" || path == "/chains" || path == "/chain/info" || path.starts_with("/dev/")
}

/// Rejects any non-public request without a valid `Authorization: Bearer <token>`.
pub async fn require_session(State(state): State<SharedState>, req: Request, next: Next) -> Result<Response, ServiceError> {
    if !state.config.require_auth || is_public(req.uri().path()) || req.method() == axum::http::Method::OPTIONS {
        return Ok(next.run(req).await);
    }
    let token = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::trim)
        .ok_or(ServiceError::Unauthorized)?;
    if !state.lock(&state.sessions)?.contains_key(token) {
        return Err(ServiceError::Unauthorized);
    }
    Ok(next.run(req).await)
}
