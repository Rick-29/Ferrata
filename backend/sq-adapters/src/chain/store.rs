//! Append-only block persistence. NDJSON: the first line is a `header` record that makes the file
//! self-describing (chain id, network, co-signer and validator public keys, tokens), every later
//! line is a `block` record with its events. Never rewritten. A chain rebuilt from this file
//! re-checks every signature, hash and state root on the way, and any tool with the file alone
//! can do the same (`ferra-verify`).

use std::io::{BufRead, Write};
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::{BlockWithTxs, ChainError, Network, TokenInfo};

pub const CHAIN_FORMAT: &str = "ferra-chain";
pub const CHAIN_FORMAT_VERSION: u32 = 1;

/// Record zero of a chain file. Everything a verifier needs besides the blocks.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ChainHeader {
    pub format: String,
    #[ts(type = "number")]
    pub format_version: u32,
    #[ts(type = "number")]
    pub chain_id: u64,
    pub network: Network,
    /// Swissquote's co-signing public key, hex.
    pub cosigner: String,
    /// The chain's block-signing public key, hex.
    pub validator: String,
    pub tokens: Vec<TokenInfo>,
    #[ts(type = "number")]
    pub escape_delay_secs: u64,
    #[ts(type = "number")]
    pub genesis_time: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "record", rename_all = "snake_case")]
pub enum ChainRecord {
    Header(ChainHeader),
    Block(BlockWithTxs),
}

pub struct LoadedChain {
    pub header: Option<ChainHeader>,
    pub blocks: Vec<BlockWithTxs>,
}

pub trait BlockStore: Send + Sync {
    fn write_header(&mut self, header: &ChainHeader) -> Result<(), ChainError>;
    fn append(&mut self, block: &BlockWithTxs) -> Result<(), ChainError>;
    fn load(&self) -> Result<LoadedChain, ChainError>;
    fn is_persistent(&self) -> bool;
    /// Demo reset: forget every block. The only non-append operation, and only `/dev/reset` calls it.
    fn clear(&mut self) -> Result<(), ChainError>;
}

/// Keeps nothing. The chain lives only in memory.
#[derive(Debug, Default)]
pub struct NullBlockStore;

impl BlockStore for NullBlockStore {
    fn write_header(&mut self, _: &ChainHeader) -> Result<(), ChainError> {
        Ok(())
    }
    fn append(&mut self, _: &BlockWithTxs) -> Result<(), ChainError> {
        Ok(())
    }
    fn load(&self) -> Result<LoadedChain, ChainError> {
        Ok(LoadedChain { header: None, blocks: Vec::new() })
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

    fn append_record(&self, record: &ChainRecord) -> Result<(), ChainError> {
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .map_err(|e| ChainError::Storage(format!("{}: {e}", self.path.display())))?;
        let line = serde_json::to_string(record).map_err(|e| ChainError::Storage(e.to_string()))?;
        writeln!(f, "{line}").map_err(|e| ChainError::Storage(e.to_string()))?;
        f.flush().map_err(|e| ChainError::Storage(e.to_string()))
    }

    /// Parses a chain file without touching the filesystem path config: for external tools.
    pub fn parse(reader: impl BufRead) -> Result<LoadedChain, ChainError> {
        let mut header = None;
        let mut blocks = Vec::new();
        for (i, line) in reader.lines().enumerate() {
            let line = line.map_err(|e| ChainError::Storage(e.to_string()))?;
            if line.trim().is_empty() {
                continue;
            }
            let rec: ChainRecord = serde_json::from_str(&line).map_err(|e| ChainError::Storage(format!("line {}: {e}", i + 1)))?;
            match rec {
                ChainRecord::Header(h) => {
                    if h.format != CHAIN_FORMAT {
                        return Err(ChainError::Storage(format!("line {}: not a {CHAIN_FORMAT} file", i + 1)));
                    }
                    header = Some(h);
                }
                ChainRecord::Block(b) => blocks.push(b),
            }
        }
        Ok(LoadedChain { header, blocks })
    }
}

impl BlockStore for JsonlBlockStore {
    fn write_header(&mut self, header: &ChainHeader) -> Result<(), ChainError> {
        self.append_record(&ChainRecord::Header(header.clone()))
    }

    fn append(&mut self, block: &BlockWithTxs) -> Result<(), ChainError> {
        self.append_record(&ChainRecord::Block(block.clone()))
    }

    fn load(&self) -> Result<LoadedChain, ChainError> {
        let f = match std::fs::File::open(&self.path) {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(LoadedChain { header: None, blocks: Vec::new() }),
            Err(e) => return Err(ChainError::Storage(format!("{}: {e}", self.path.display()))),
        };
        Self::parse(std::io::BufReader::new(f))
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
