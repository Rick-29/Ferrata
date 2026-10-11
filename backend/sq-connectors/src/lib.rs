//! Chain-agnostic connectors: each `NetworkSource` turns one network's view of an address into
//! `ObservedEvent`s the Ferra chain records through `/chain/ingest` or `/chain/sync`, and into an
//! `AccountInfo` the provenance check and the wallet overview read. The validator and the
//! visualiser never talk to a network directly; they read the Ferra chain.
//!
//! This crate holds the traits, the registry, the exposure tracer, the provenance judge, the
//! transfer report and the risk scorer. Network families live in their own crates (`sq-conn-ton`,
//! `sq-conn-evm`, `sq-conn-btc`, `sq-conn-sol`) so each carries its own wire types and tests.
//!
//! The TON work follows NetView (<https://github.com/TheMillionaresClub/NetView>): its
//! `wallet-info` (toncenter transactions), `wallet-scraper` (tonapi account, jettons, labels) and
//! `wallet-connection` (event graph traversal) crates, re-done on a server-side HTTP stack.

pub mod preview;
pub mod provenance;
pub mod report;
pub mod risk;
pub mod tracing;

use std::collections::BTreeMap;

use alloy_primitives::Address;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use sq_adapters::{ExternalRef, Network};
use ts_rs::TS;

#[derive(Debug, thiserror::Error)]
pub enum ConnectorError {
    #[error("http: {0}")]
    Http(String),
    #[error("{network}: upstream answered {status}: {body}")]
    Upstream { network: String, status: u16, body: String },
    #[error("{network}: rate limited")]
    RateLimited { network: String },
    #[error("parse: {0}")]
    Parse(String),
    #[error("unknown network {0}")]
    UnknownNetwork(String),
    #[error("{0} is not supported by this source")]
    Unsupported(&'static str),
    #[error("invalid address: {0}")]
    InvalidAddress(String),
    #[error("invalid cursor: {0}")]
    InvalidCursor(String),
}

impl From<reqwest::Error> for ConnectorError {
    fn from(e: reqwest::Error) -> Self {
        // reqwest's Display stops at "error sending request"; the cause (timed out, connection
        // refused, TLS) sits in the source chain and is what a reader needs.
        let mut text = e.to_string();
        let mut src = std::error::Error::source(&e);
        while let Some(cause) = src {
            let c = cause.to_string();
            if !text.contains(&c) {
                text.push_str(": ");
                text.push_str(&c);
            }
            src = cause.source();
        }
        ConnectorError::Http(text)
    }
}

/// One thing that happened to the watched address on a network, ready for the Ferra chain.
#[derive(Debug, Clone, PartialEq)]
pub struct ObservedEvent {
    pub external: ExternalRef,
    pub incoming: bool,
    /// The counterparty as a 20-byte address when the network has one.
    pub counterparty: Option<Address>,
    /// What the indexer knows about the counterparty, when it says anything.
    pub counterparty_label: Option<String>,
    /// The indexer itself marks this event or its counterparty as a scam.
    pub scam_flag: bool,
}

#[derive(Debug, Clone, Default)]
pub struct Page {
    pub events: Vec<ObservedEvent>,
    /// Opaque cursor for the next (older) page; `None` when exhausted.
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct TokenBalance {
    pub symbol: String,
    pub name: Option<String>,
    /// Token contract / jetton master / mint, in the network's own format.
    pub address: String,
    pub decimals: u8,
    /// Base units, decimal string.
    pub amount: String,
    pub usd_value: Option<f64>,
    /// The indexer vouches for the token (not a spoof).
    pub verified: Option<bool>,
}

/// What a network's indexer knows about one address. Every field optional: sources differ.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AccountInfo {
    pub network: Network,
    /// Canonical form for this network (TON raw `0:hex`, EVM checksummed, BTC as given).
    pub address: String,
    pub native_symbol: String,
    pub native_decimals: u8,
    /// Base units, decimal string.
    pub balance: Option<String>,
    #[serde(default)]
    pub tokens: Vec<TokenBalance>,
    #[ts(type = "number | null")]
    pub tx_count: Option<u64>,
    #[ts(type = "number | null")]
    pub first_seen: Option<u64>,
    #[ts(type = "number | null")]
    pub last_active: Option<u64>,
    /// Human name the indexer resolves (TON DNS, Telegram username, ENS, explorer tag).
    pub name: Option<String>,
    /// Explorer labels: `exchange`, `bridge`, `contract`, `wallet_v4r2`, …
    #[serde(default)]
    pub labels: Vec<String>,
    pub is_contract: bool,
    pub is_scam: bool,
    pub is_active: bool,
    /// Anything else the source returned that may help a model.
    #[serde(default)]
    #[ts(type = "Record<string, unknown>")]
    pub extra: BTreeMap<String, serde_json::Value>,
}

#[async_trait]
pub trait NetworkSource: Send + Sync {
    fn network(&self) -> Network;
    /// Newest first. `cursor` continues a previous page.
    async fn fetch(&self, address_raw: &str, cursor: Option<&str>, limit: u32) -> Result<Page, ConnectorError>;
    /// Balance, tokens, activity, labels. Default: unsupported.
    async fn account_info(&self, _address_raw: &str) -> Result<AccountInfo, ConnectorError> {
        Err(ConnectorError::Unsupported("account_info"))
    }
    /// Canonical form used to compare addresses on this network. Default: as given.
    fn canonical(&self, address_raw: &str) -> String {
        address_raw.to_string()
    }
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

/// Shared HTTP client: one user agent, rustls, sane timeout.
pub fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("ferra-chain-connectors/0.2")
        // A handshake that stalls (route trouble, an overloaded indexer) fails in seconds instead
        // of holding the request for the whole response timeout, so retries start sooner.
        .connect_timeout(std::time::Duration::from_secs(8))
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .unwrap_or_default()
}

/// At most this many requests in flight per network, so concurrent reports do not burst a public
/// indexer into rate-limiting us. Permits are taken inside `get_text` / `post_json`. The public
/// Blockscout and Solana endpoints answer 429 from a handful of parallel requests, so they get a
/// smaller buffer; `SQ_CONCURRENCY_<NETWORK>` (e.g. `SQ_CONCURRENCY_ETHEREUM=6` with an API key,
/// `SQ_CONCURRENCY_SOLANA_DEVNET=1`) overrides any of them.
pub fn concurrency_for(network: &str) -> usize {
    let key = format!("SQ_CONCURRENCY_{}", network.to_ascii_uppercase().replace('-', "_"));
    if let Some(n) = std::env::var(key).ok().and_then(|v| v.parse::<usize>().ok()) {
        return n.max(1);
    }
    let n = network.to_ascii_lowercase();
    let touchy = n.starts_with("sol") || n == "ethereum" || n.ends_with("sepolia") || n.starts_with("base");
    if touchy {
        2
    } else if n.starts_with("bitcoin") {
        3
    } else {
        4
    }
}

/// How long to wait after a 429: the indexer's `Retry-After` when it sends one (capped), else
/// the ladder 1 s, 2 s, 4 s, 8 s. Public indexers recover within a second or two, so a long
/// first wait only throws away time.
fn retry_after(resp: &reqwest::Response, attempt: u32) -> std::time::Duration {
    let header = resp.headers().get(reqwest::header::RETRY_AFTER).and_then(|v| v.to_str().ok()).and_then(|v| v.trim().parse::<u64>().ok());
    let wait = match header {
        Some(secs) => std::time::Duration::from_secs(secs.clamp(1, 10)),
        None => std::time::Duration::from_secs(1 << attempt.min(3)),
    };
    ::tracing::debug!(url = %resp.url(), attempt, retry_after = header, wait_secs = wait.as_secs(), "rate limited, waiting");
    wait
}

fn permit_for(network: &str) -> std::sync::Arc<tokio::sync::Semaphore> {
    use std::sync::{Arc, Mutex, OnceLock};
    static LIMITS: OnceLock<Mutex<BTreeMap<String, Arc<tokio::sync::Semaphore>>>> = OnceLock::new();
    let map = LIMITS.get_or_init(|| Mutex::new(BTreeMap::new()));
    let mut guard = match map.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    guard.entry(network.to_owned()).or_insert_with(|| Arc::new(tokio::sync::Semaphore::new(concurrency_for(network)))).clone()
}

/// GET with up to four tries on 429 (`Retry-After` or 1/2/4 s), bounded concurrency per network.
/// Returns the body text on 2xx.
pub async fn get_text(client: &reqwest::Client, network: &str, url: &str, headers: &[(&str, String)]) -> Result<String, ConnectorError> {
    let sem = permit_for(network);
    let _permit = sem.acquire().await.map_err(|_| ConnectorError::Http("limiter closed".into()))?;
    for attempt in 0..4u32 {
        let mut req = client.get(url);
        for (k, v) in headers {
            req = req.header(*k, v);
        }
        let resp = match req.send().await {
            Ok(r) => r,
            // A refused or reset connection gets one quick second try. A timeout does not: an
            // indexer that usually answers in a second and now stalls is tarpitting us, and the
            // caller (fallback host, next pass) handles that better than another 15 s wait.
            Err(e) if attempt == 0 && !e.is_timeout() && (e.is_connect() || e.is_request()) => {
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                continue;
            }
            Err(e) => return Err(e.into()),
        };
        let status = resp.status().as_u16();
        if status == 429 {
            if attempt < 3 {
                tokio::time::sleep(retry_after(&resp, attempt)).await;
                continue;
            }
            return Err(ConnectorError::RateLimited { network: network.into() });
        }
        let text = resp.text().await?;
        if !(200..300).contains(&status) {
            return Err(ConnectorError::Upstream { network: network.into(), status, body: text.chars().take(200).collect() });
        }
        return Ok(text);
    }
    Err(ConnectorError::RateLimited { network: network.into() })
}

/// POST JSON with the same retry policy.
pub async fn post_json(client: &reqwest::Client, network: &str, url: &str, body: &serde_json::Value, headers: &[(&str, String)]) -> Result<String, ConnectorError> {
    let sem = permit_for(network);
    let _permit = sem.acquire().await.map_err(|_| ConnectorError::Http("limiter closed".into()))?;
    for attempt in 0..4u32 {
        let mut req = client.post(url).json(body);
        for (k, v) in headers {
            req = req.header(*k, v);
        }
        let resp = match req.send().await {
            Ok(r) => r,
            Err(e) if attempt == 0 && !e.is_timeout() && (e.is_connect() || e.is_request()) => {
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                continue;
            }
            Err(e) => return Err(e.into()),
        };
        let status = resp.status().as_u16();
        if status == 429 {
            if attempt < 3 {
                tokio::time::sleep(retry_after(&resp, attempt)).await;
                continue;
            }
            return Err(ConnectorError::RateLimited { network: network.into() });
        }
        let text = resp.text().await?;
        if !(200..300).contains(&status) {
            return Err(ConnectorError::Upstream { network: network.into(), status, body: text.chars().take(200).collect() });
        }
        return Ok(text);
    }
    Err(ConnectorError::RateLimited { network: network.into() })
}
