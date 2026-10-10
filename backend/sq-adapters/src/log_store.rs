use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use alloy_primitives::Address;
use wallet_core::{AuditLog, CoreError, SignedEntry};

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error(transparent)]
    Core(#[from] CoreError),
    #[error("store lock poisoned")]
    Poisoned,
    #[error("snapshot: {0}")]
    Snapshot(String),
}

pub trait LogStore: Send + Sync {
    fn load(&self, address: Address) -> Result<AuditLog, StoreError>;
    fn append(&self, address: Address, entry: SignedEntry) -> Result<AuditLog, StoreError>;
    /// Drops every log (demo reset).
    fn clear(&self) -> Result<(), StoreError>;
}

/// Per-account logs in memory, optionally mirrored to one JSON file after every append.
pub struct InMemoryLogStore {
    logs: Mutex<HashMap<Address, AuditLog>>,
    snapshot: Option<PathBuf>,
}

impl InMemoryLogStore {
    pub fn new() -> Self {
        Self { logs: Mutex::new(HashMap::new()), snapshot: None }
    }

    /// Loads an existing snapshot if present; later appends rewrite it.
    pub fn with_snapshot(path: PathBuf) -> Result<Self, StoreError> {
        let logs = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| StoreError::Snapshot(e.to_string()))?,
            Err(_) => HashMap::new(),
        };
        Ok(Self { logs: Mutex::new(logs), snapshot: Some(path) })
    }

    fn persist(&self, logs: &HashMap<Address, AuditLog>) -> Result<(), StoreError> {
        if let Some(path) = &self.snapshot {
            let bytes = serde_json::to_vec_pretty(logs).map_err(|e| StoreError::Snapshot(e.to_string()))?;
            std::fs::write(path, bytes).map_err(|e| StoreError::Snapshot(e.to_string()))?;
        }
        Ok(())
    }
}

impl Default for InMemoryLogStore {
    fn default() -> Self {
        Self::new()
    }
}

impl LogStore for InMemoryLogStore {
    fn load(&self, address: Address) -> Result<AuditLog, StoreError> {
        let logs = self.logs.lock().map_err(|_| StoreError::Poisoned)?;
        Ok(logs.get(&address).cloned().unwrap_or_default())
    }

    fn append(&self, address: Address, entry: SignedEntry) -> Result<AuditLog, StoreError> {
        let mut logs = self.logs.lock().map_err(|_| StoreError::Poisoned)?;
        let log = logs.entry(address).or_default();
        log.append(entry)?;
        let out = log.clone();
        self.persist(&logs)?;
        Ok(out)
    }

    fn clear(&self) -> Result<(), StoreError> {
        let mut logs = self.logs.lock().map_err(|_| StoreError::Poisoned)?;
        logs.clear();
        self.persist(&logs)
    }
}
