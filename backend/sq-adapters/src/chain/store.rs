//! Append-only block persistence. One JSON line per block (`{ block, txs }`), never rewritten.
//! A chain rebuilt from this file re-checks every signature, hash and state root on the way.

use std::io::{BufRead, Write};
use std::path::PathBuf;

use super::{BlockWithTxs, ChainError};

pub trait BlockStore: Send + Sync {
    fn append(&mut self, block: &BlockWithTxs) -> Result<(), ChainError>;
    fn load(&self) -> Result<Vec<BlockWithTxs>, ChainError>;
    fn is_persistent(&self) -> bool;
    /// Demo reset: forget every block. The only non-append operation, and only `/dev/reset` calls it.
    fn clear(&mut self) -> Result<(), ChainError>;
}

/// Keeps nothing. The chain lives only in memory.
#[derive(Debug, Default)]
pub struct NullBlockStore;

impl BlockStore for NullBlockStore {
    fn append(&mut self, _: &BlockWithTxs) -> Result<(), ChainError> {
        Ok(())
    }
    fn load(&self) -> Result<Vec<BlockWithTxs>, ChainError> {
        Ok(Vec::new())
    }
    fn is_persistent(&self) -> bool {
        false
    }
    fn clear(&mut self) -> Result<(), ChainError> {
        Ok(())
    }
}

#[derive(Debug)]
pub struct JsonlBlockStore {
    path: PathBuf,
}

impl JsonlBlockStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    pub fn path(&self) -> &PathBuf {
        &self.path
    }
}

impl BlockStore for JsonlBlockStore {
    fn append(&mut self, block: &BlockWithTxs) -> Result<(), ChainError> {
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .map_err(|e| ChainError::Storage(format!("{}: {e}", self.path.display())))?;
        let line = serde_json::to_string(block).map_err(|e| ChainError::Storage(e.to_string()))?;
        writeln!(f, "{line}").map_err(|e| ChainError::Storage(e.to_string()))?;
        f.flush().map_err(|e| ChainError::Storage(e.to_string()))
    }

    fn load(&self) -> Result<Vec<BlockWithTxs>, ChainError> {
        let f = match std::fs::File::open(&self.path) {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(ChainError::Storage(format!("{}: {e}", self.path.display()))),
        };
        let mut out = Vec::new();
        for (i, line) in std::io::BufReader::new(f).lines().enumerate() {
            let line = line.map_err(|e| ChainError::Storage(e.to_string()))?;
            if line.trim().is_empty() {
                continue;
            }
            let b: BlockWithTxs = serde_json::from_str(&line).map_err(|e| ChainError::Storage(format!("line {}: {e}", i + 1)))?;
            out.push(b);
        }
        Ok(out)
    }

    fn is_persistent(&self) -> bool {
        true
    }
    fn clear(&mut self) -> Result<(), ChainError> {
        match std::fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(ChainError::Storage(format!("{}: {e}", self.path.display()))),
        }
    }
}
