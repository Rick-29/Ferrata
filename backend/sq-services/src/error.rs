use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use sq_adapters::ChainError;
use sq_adapters::log_store::StoreError;
use wallet_core::CoreError;

#[derive(Debug, thiserror::Error)]
pub enum ServiceError {
    #[error(transparent)]
    Core(#[from] CoreError),
    #[error(transparent)]
    Chain(#[from] ChainError),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("unauthorized")]
    Unauthorized,
    #[error("conflict: {0}")]
    Conflict(String),
    #[error("bad request: {0}")]
    BadRequest(String),
    #[error("upstream {provider}: {msg}")]
    Upstream { provider: &'static str, msg: String },
    #[error("internal: {0}")]
    Internal(String),
}

impl From<StoreError> for ServiceError {
    fn from(e: StoreError) -> Self {
        match e {
            StoreError::Core(c) => ServiceError::Core(c),
            other => ServiceError::Internal(other.to_string()),
        }
    }
}

impl ServiceError {
    pub fn code(&self) -> String {
        match self {
            ServiceError::Core(c) => format!("CORE_{}", c.code()),
            ServiceError::Chain(c) => c.code().to_string(),
            ServiceError::NotFound(_) => "NOT_FOUND".into(),
            ServiceError::Unauthorized => "UNAUTHORIZED".into(),
            ServiceError::Conflict(_) => "CONFLICT".into(),
            ServiceError::BadRequest(_) => "BAD_REQUEST".into(),
            ServiceError::Upstream { .. } => "UPSTREAM".into(),
            ServiceError::Internal(_) => "INTERNAL".into(),
        }
    }

    fn status(&self) -> StatusCode {
        match self {
            ServiceError::Core(CoreError::SeqGap { .. } | CoreError::ChainBroken(_)) => StatusCode::CONFLICT,
            ServiceError::Core(_) => StatusCode::UNPROCESSABLE_ENTITY,
            ServiceError::Chain(ChainError::UnknownAccount(_) | ChainError::UnknownTx(_) | ChainError::UnknownToken(_)) => StatusCode::NOT_FOUND,
            ServiceError::Chain(ChainError::BadNonce { .. } | ChainError::AccountExists(_)) => StatusCode::CONFLICT,
            ServiceError::Chain(ChainError::BadOwnerSignature | ChainError::BadCosignature | ChainError::MissingCosignature | ChainError::BadRecoverySignature) => StatusCode::UNAUTHORIZED,
            ServiceError::Chain(_) => StatusCode::UNPROCESSABLE_ENTITY,
            ServiceError::NotFound(_) => StatusCode::NOT_FOUND,
            ServiceError::Unauthorized => StatusCode::UNAUTHORIZED,
            ServiceError::Conflict(_) => StatusCode::CONFLICT,
            ServiceError::BadRequest(_) => StatusCode::BAD_REQUEST,
            ServiceError::Upstream { .. } => StatusCode::BAD_GATEWAY,
            ServiceError::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}

impl IntoResponse for ServiceError {
    fn into_response(self) -> Response {
        let status = self.status();
        if status.is_server_error() {
            tracing::error!(error = %self, "request failed");
        } else {
            tracing::debug!(error = %self, "request rejected");
        }
        let body = api_types::ApiError { code: self.code(), message: self.to_string(), details: None };
        (status, Json(body)).into_response()
    }
}

pub type ApiResult<T> = Result<Json<T>, ServiceError>;
