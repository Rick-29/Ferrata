//! Chain-agnostic connectors: each `NetworkSource` turns one network's view of an address into
//! `ObservedEvent`s the Ferra chain records through `/chain/ingest`. The validator and the
//! visualiser never talk to a network directly; they read the Ferra chain.
//!
//! Sources are thin HTTP clients over public indexers; no keys are required for testnets.
//! Parsing is separated from fetching so every source is unit-tested offline.
//!
//! The TON source is a port of the toncenter client in NetView
//! (<https://github.com/TheMillionaresClub/NetView>, `rust/wallet-info`): same wire types and
//! send/receive extraction, without the wasm-only HTTP stack.

pub mod bitcoin;
pub mod evm;
pub mod provenance;
pub mod ton;

use std::collections::BTreeMap;

use alloy_primitives::Address;
use async_trait::async_trait;
use sq_adapters::{ExternalRef, Network};

#[derive(Debug, thiserror::Error)]
pub enum ConnectorError {
    #[error("http: {0}")]
    Http(String),
    #[error("{network}: upstream answered {status}: {body}")]
    Upstream { network: String, status: u16, body: String },
    #[error("parse: {0}")]
    Parse(String),
    #[error("unknown network {0}")]
    UnknownNetwork(String),
}

impl From<reqwest::Error> for ConnectorError {
    fn from(e: reqwest::Error) -> Self {
        ConnectorError::Http(e.to_string())
    }
}

/// One thing that happened to the watched address on a network, ready for the Ferra chain.
#[derive(Debug, Clone, PartialEq)]
pub struct ObservedEvent {
    pub external: ExternalRef,
    pub incoming: bool,
    /// The counterparty as a 20-byte address when the network has one.
    pub counterparty: Option<Address>,
}

#[derive(Debug, Clone, Default)]
pub struct Page {
    pub events: Vec<ObservedEvent>,
    /// Opaque cursor for the next (older) page; `None` when exhausted.
    pub next_cursor: Option<String>,
}

#[async_trait]
pub trait NetworkSource: Send + Sync {
    fn network(&self) -> Network;
    /// Newest first. `cursor` continues a previous page.
    async fn fetch(&self, address_raw: &str, cursor: Option<&str>, limit: u32) -> Result<Page, ConnectorError>;
}

/// All configured sources, keyed by `Network.name`.
#[derive(Default)]
pub struct SourceRegistry {
    sources: BTreeMap<String, Box<dyn NetworkSource>>,
}

impl SourceRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(mut self, source: Box<dyn NetworkSource>) -> Self {
        self.sources.insert(source.network().name.clone(), source);
        self
    }

    pub fn get(&self, name: &str) -> Result<&dyn NetworkSource, ConnectorError> {
        self.sources.get(name).map(|s| s.as_ref()).ok_or_else(|| ConnectorError::UnknownNetwork(name.to_string()))
    }

    pub fn networks(&self) -> Vec<Network> {
        self.sources.values().map(|s| s.network()).collect()
    }

    pub fn is_empty(&self) -> bool {
        self.sources.is_empty()
    }
}

pub(crate) fn http() -> reqwest::Client {
    reqwest::Client::builder().user_agent("ferra-chain-connectors/0.1").build().unwrap_or_default()
}
