//! One error type for every command. Serialised as `{ code, message }` so the UI can branch on
//! `code` (offline, no file, not found, tampered…) and show `message` verbatim.

use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("no chain file is open")]
    NoChain,
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    BadRequest(String),
    #[error("{0}")]
    Io(String),
    #[error("{0}")]
    Chain(String),
    #[error("offline: {0}")]
    Offline(String),
    #[error("service: {0}")]
    Service(String),
    #[error("{0}")]
    Internal(String),
}

impl AppError {
    pub fn code(&self) -> &'static str {
        match self {
            AppError::NoChain => "NO_CHAIN",
            AppError::NotFound(_) => "NOT_FOUND",
            AppError::BadRequest(_) => "BAD_REQUEST",
            AppError::Io(_) => "IO",
            AppError::Chain(_) => "CHAIN",
            AppError::Offline(_) => "OFFLINE",
            AppError::Service(_) => "SERVICE",
            AppError::Internal(_) => "INTERNAL",
        }
    }
}

#[derive(Serialize)]
struct Wire<'a> {
    code: &'a str,
    message: String,
}

impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        Wire { code: self.code(), message: self.to_string() }.serialize(s)
    }
}

impl From<sq_adapters::chain::ChainError> for AppError {
    fn from(e: sq_adapters::chain::ChainError) -> Self {
        AppError::Chain(e.to_string())
    }
}

impl From<sq_connectors::ConnectorError> for AppError {
    fn from(e: sq_connectors::ConnectorError) -> Self {
        match e {
            sq_connectors::ConnectorError::UnknownNetwork(n) => AppError::BadRequest(format!("no connector for network {n}")),
            other => AppError::Offline(other.to_string()),
        }
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::Io(e.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        AppError::Internal(e.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
