//! Mock Swissquote login (`fixtures/accounts.json`), the bearer-token gate, and the `Caller`
//! extractor handlers use to bind wallets to the client that registered them.

use axum::extract::{FromRequestParts, Request, State};
use axum::http::header;
use axum::http::request::Parts;
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

/// The bearer token on a request, if any. Resolved to a client through `AppState::client_of`.
#[derive(Debug, Clone, Default)]
pub struct Caller {
    pub token: Option<String>,
}

fn bearer(parts: &Parts) -> Option<String> {
    parts
        .headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|t| t.trim().to_string())
}

impl<S: Send + Sync> FromRequestParts<S> for Caller {
    type Rejection = ServiceError;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        Ok(Caller { token: bearer(parts) })
    }
}

/// Routes reachable without a session: login itself, public chain reads, dev helpers.
fn is_public(path: &str) -> bool {
    path == "/auth/session" || path == "/chains" || path.starts_with("/networks") || path == "/model" || path.starts_with("/chain/") || path.starts_with("/dev/")
}

/// Rejects any non-public request without a valid `Authorization: Bearer <token>`.
pub async fn require_session(State(state): State<SharedState>, req: Request, next: Next) -> Result<Response, ServiceError> {
    if !state.config.require_auth || is_public(req.uri().path()) || req.method() == axum::http::Method::OPTIONS {
        return Ok(next.run(req).await);
    }
    let (mut parts, body) = req.into_parts();
    let token = bearer(&parts).ok_or(ServiceError::Unauthorized)?;
    if !state.lock(&state.sessions)?.contains_key(&token) {
        return Err(ServiceError::Unauthorized);
    }
    parts.extensions.insert(Caller { token: Some(token) });
    Ok(next.run(Request::from_parts(parts, body)).await)
}
