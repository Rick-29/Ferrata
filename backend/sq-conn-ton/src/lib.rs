//! TON connector. Two indexers, one source:
//!
//! - **tonapi.io** (primary): `/v2/accounts/{id}/events` gives typed actions (TON transfers,
//!   jetton transfers, swaps, NFT moves) with counterparty names and scam flags;
//!   `/v2/accounts/{id}` and `/jettons` give balance, status, interfaces, jetton holdings.
//!   NetView's `wallet-scraper` and `wallet-connection` use the same endpoints.
//! - **toncenter** (fallback): `getTransactions` JSON-RPC, raw messages, no jettons.
//!   NetView's `wallet-info` client, ported in `toncenter.rs`.
//!
//! Addresses: tonapi returns raw `0:hex`; users type friendly `EQ…`/`UQ…`/`0Q…`/`kQ…`. Everything is
//! compared in raw form (`address::to_raw`).

pub mod address;
pub mod tonapi;
pub mod toncenter;

use async_trait::async_trait;
use sq_adapters::{ChainFamily, Network};
use sq_connectors::{AccountInfo, ConnectorError, NetworkSource, Page};

pub use tonapi::TonApi;
pub use toncenter::TonCenterSource;

pub fn network(testnet: bool) -> Network {
    Network { family: ChainFamily::Ton, name: if testnet { "ton-testnet" } else { "ton" }.into(), chain_id: None }
}

/// The source the registry sees: tonapi first, toncenter when tonapi is unavailable.
pub struct TonSource {
    testnet: bool,
    tonapi: TonApi,
    toncenter: TonCenterSource,
}

impl TonSource {
    pub fn new(testnet: bool, tonapi_key: Option<String>, toncenter_key: Option<String>) -> Self {
        Self { testnet, tonapi: TonApi::new(testnet, tonapi_key), toncenter: TonCenterSource::new(testnet, toncenter_key) }
    }

    pub fn from_env() -> Self {
        let testnet = std::env::var("SQ_TON_NETWORK").map(|v| v != "mainnet").unwrap_or(true);
        Self::new(testnet, std::env::var("SQ_TONAPI_KEY").ok(), std::env::var("SQ_TONCENTER_API_KEY").ok())
    }

    pub fn tonapi(&self) -> &TonApi {
        &self.tonapi
    }
}

#[async_trait]
impl NetworkSource for TonSource {
    fn network(&self) -> Network {
        network(self.testnet)
    }

    fn canonical(&self, address_raw: &str) -> String {
        address::to_raw(address_raw).unwrap_or_else(|| address_raw.to_string())
    }

    async fn fetch(&self, address_raw: &str, cursor: Option<&str>, limit: u32) -> Result<Page, ConnectorError> {
        // Cursors are prefixed so a page started on one indexer continues on it.
        if let Some(c) = cursor.and_then(|c| c.strip_prefix("tc:")) {
            return self.toncenter.fetch(address_raw, Some(c), limit).await;
        }
        let tonapi_cursor = cursor.and_then(|c| c.strip_prefix("tonapi:"));
        match self.tonapi.fetch(address_raw, tonapi_cursor, limit).await {
            Ok(mut page) => {
                page.next_cursor = page.next_cursor.map(|c| format!("tonapi:{c}"));
                Ok(page)
            }
            Err(e) if cursor.is_none() => {
                tracing::warn!(error = %e, "tonapi unavailable, falling back to toncenter");
                let mut page = self.toncenter.fetch(address_raw, None, limit).await?;
                page.next_cursor = page.next_cursor.map(|c| format!("tc:{c}"));
                Ok(page)
            }
            Err(e) => Err(e),
        }
    }

    async fn account_info(&self, address_raw: &str) -> Result<AccountInfo, ConnectorError> {
        self.tonapi.account_info(address_raw).await
    }
}
