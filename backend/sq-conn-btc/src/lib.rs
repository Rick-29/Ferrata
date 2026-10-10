//! Bitcoin `NetworkSource` over an Esplora HTTP API (mempool.space, blockstream.info, or a
//! self-hosted electrs). Three parts, one job each:
//!
//! - `BitcoinAddressValidator`: parse, checksum, network check, canonical form. No I/O.
//! - `EsploraClient`: HTTP and status mapping. No business logic.
//! - `EsploraBitcoinSource`: `NetworkSource` (mempool-then-chain pagination, mapping to events).
//!
//! An address's share of a transaction is `sum(vout to it) − sum(vin from it)`; the sign gives the
//! direction and the first other address the counterparty. Page one lists unconfirmed
//! transactions first, then confirmed history; the cursor records where the previous page stopped.

use std::collections::BTreeMap;

use async_trait::async_trait;
use bitcoin::address::{Address, NetworkUnchecked};
use serde::Deserialize;
use sq_adapters::{ChainFamily, ExternalRef, Network};
use sq_connectors::{AccountInfo, ConnectorError, NetworkSource, ObservedEvent, Page, get_text};

/// Esplora returns at most this many confirmed transactions per `/txs/chain` call.
const ESPLORA_CHAIN_PAGE: usize = 25;
const MAX_LIMIT: u32 = 100;
const MAX_CHAIN_PAGES_PER_CALL: usize = (MAX_LIMIT as usize).div_ceil(ESPLORA_CHAIN_PAGE);

// ============================================================================
// Address validation (pure)
// ============================================================================

/// Validates Bitcoin addresses for one network kind. Testnet, testnet4 and signet share
/// prefixes, so a testnet validator accepts signet addresses too: a property of Bitcoin, not of this code.
#[derive(Debug, Clone, Copy)]
pub struct BitcoinAddressValidator {
    network: bitcoin::Network,
}

impl BitcoinAddressValidator {
    pub const fn new(network: bitcoin::Network) -> Self {
        Self { network }
    }

    /// Parses, verifies the checksum and the network. P2PKH, P2SH, P2WPKH, P2WSH, P2TR.
    pub fn validate(&self, raw: &str) -> Result<Address, ConnectorError> {
        let trimmed = raw.trim();
        let unchecked: Address<NetworkUnchecked> = trimmed.parse().map_err(|e| ConnectorError::InvalidAddress(format!("{trimmed:?}: {e}")))?;
        unchecked.require_network(self.network).map_err(|e| ConnectorError::InvalidAddress(format!("{trimmed:?}: {e}")))
    }

    /// Canonical string: bech32 lowercased, base58 unchanged (it is case-sensitive).
    pub fn canonical(&self, raw: &str) -> Result<String, ConnectorError> {
        self.validate(raw).map(|a| a.to_string())
    }
}

// ============================================================================
// Cursor
// ============================================================================

#[derive(Debug, Clone, PartialEq, Eq)]
enum Cursor {
    /// Still inside the mempool list; `skip` entries were already returned.
    Mempool { skip: usize },
    /// In confirmed history; continue after `after_txid` (`None` = from the newest).
    Chain { after_txid: Option<String> },
}

impl Cursor {
    fn encode(&self) -> String {
        match self {
            Self::Mempool { skip } => format!("m:{skip}"),
            Self::Chain { after_txid: None } => "c:".to_owned(),
            Self::Chain { after_txid: Some(txid) } => format!("c:{txid}"),
        }
    }

    /// Strict: the txid ends up in a URL path, so it must be exactly 64 hex characters.
    fn decode(raw: &str) -> Result<Self, ConnectorError> {
        let invalid = || ConnectorError::InvalidCursor(raw.chars().take(80).collect());
        match raw.split_once(':') {
            Some(("m", skip)) => skip.parse::<usize>().map(|skip| Self::Mempool { skip }).map_err(|_| invalid()),
            Some(("c", "")) => Ok(Self::Chain { after_txid: None }),
            Some(("c", txid)) if is_txid(txid) => Ok(Self::Chain { after_txid: Some(txid.to_ascii_lowercase()) }),
            _ => Err(invalid()),
        }
    }
}

fn is_txid(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

// ============================================================================
// Esplora client
// ============================================================================

#[derive(Debug, Clone)]
pub struct EsploraClient {
    http: reqwest::Client,
    base: String,
    network_name: String,
}

impl EsploraClient {
    pub fn new(base: impl Into<String>, network_name: impl Into<String>) -> Self {
        Self { http: sq_connectors::http(), base: base.into().trim_end_matches('/').to_owned(), network_name: network_name.into() }
    }

    /// `path` must only contain validated components (address, txid).
    async fn get_json<T: serde::de::DeserializeOwned>(&self, path: &str) -> Result<T, ConnectorError> {
        let text = get_text(&self.http, &self.network_name, &format!("{}{path}", self.base), &[]).await?;
        serde_json::from_str(&text).map_err(|e| ConnectorError::Parse(format!("{path}: {e}")))
    }

    pub async fn mempool_txs(&self, address: &str) -> Result<Vec<EsploraTx>, ConnectorError> {
        self.get_json(&format!("/address/{address}/txs/mempool")).await
    }

    pub async fn chain_txs(&self, address: &str, after_txid: Option<&str>) -> Result<Vec<EsploraTx>, ConnectorError> {
        match after_txid {
            Some(txid) => self.get_json(&format!("/address/{address}/txs/chain/{txid}")).await,
            None => self.get_json(&format!("/address/{address}/txs/chain")).await,
        }
    }

    pub async fn address_stats(&self, address: &str) -> Result<EsploraAddressStats, ConnectorError> {
        self.get_json(&format!("/address/{address}")).await
    }
}

// ---- wire types ----

#[derive(Debug, Clone, Deserialize)]
pub struct EsploraTx {
    pub txid: String,
    pub status: EsploraStatus,
    pub vin: Vec<EsploraVin>,
    pub vout: Vec<EsploraOutput>,
    pub fee: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct EsploraStatus {
    pub confirmed: bool,
    pub block_height: Option<u64>,
    pub block_time: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct EsploraVin {
    /// `None` for coinbase inputs.
    pub prevout: Option<EsploraOutput>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct EsploraOutput {
    /// `None` for non-standard scripts (e.g. OP_RETURN).
    pub scriptpubkey_address: Option<String>,
    pub value: u64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct EsploraAddressStats {
    pub chain_stats: EsploraStats,
    pub mempool_stats: EsploraStats,
}

#[derive(Debug, Clone, Deserialize)]
pub struct EsploraStats {
    pub funded_txo_sum: u64,
    pub spent_txo_sum: u64,
    pub tx_count: u64,
}

// ============================================================================
// NetworkSource
// ============================================================================

pub struct EsploraBitcoinSource {
    network: Network,
    validator: BitcoinAddressValidator,
    client: EsploraClient,
    explorer: String,
}

impl EsploraBitcoinSource {
    pub fn new(network: Network, btc_network: bitcoin::Network, base: impl Into<String>, explorer: impl Into<String>) -> Self {
        let base = base.into();
        Self { client: EsploraClient::new(&base, network.name.clone()), network, validator: BitcoinAddressValidator::new(btc_network), explorer: explorer.into() }
    }

    pub fn testnet() -> Self {
        Self::new(Network { family: ChainFamily::Bitcoin, name: "bitcoin-testnet".into(), chain_id: None }, bitcoin::Network::Testnet, "https://mempool.space/testnet/api", "https://mempool.space/testnet")
    }

    pub fn mainnet() -> Self {
        Self::new(Network { family: ChainFamily::Bitcoin, name: "bitcoin".into(), chain_id: None }, bitcoin::Network::Bitcoin, "https://mempool.space/api", "https://mempool.space")
    }

    pub fn validator(&self) -> &BitcoinAddressValidator {
        &self.validator
    }

    /// Pure: one Esplora transaction → the event for `address`, or `None` when it nets to zero.
    pub fn to_event(network: &Network, explorer: &str, address: &str, tx: &EsploraTx) -> Result<Option<ObservedEvent>, ConnectorError> {
        if !is_txid(&tx.txid) {
            return Err(ConnectorError::Parse("malformed txid from upstream".into()));
        }
        let ours = |o: &&EsploraOutput| o.scriptpubkey_address.as_deref() == Some(address);
        let received: u128 = tx.vout.iter().filter(ours).map(|o| u128::from(o.value)).sum();
        let spent: u128 = tx.vin.iter().filter_map(|i| i.prevout.as_ref()).filter(ours).map(|o| u128::from(o.value)).sum();
        if received == spent {
            return Ok(None);
        }
        let incoming = received > spent;
        let amount = received.abs_diff(spent);
        let other = if incoming {
            tx.vin.iter().filter_map(|i| i.prevout.as_ref()).filter_map(|p| p.scriptpubkey_address.clone()).find(|a| a != address)
        } else {
            tx.vout.iter().filter_map(|o| o.scriptpubkey_address.clone()).find(|a| a != address)
        }
        .unwrap_or_else(|| if tx.vin.iter().any(|i| i.prevout.is_none()) { "coinbase".into() } else { "unknown".into() });
        let (from_raw, to_raw) = if incoming { (other, address.to_owned()) } else { (address.to_owned(), other) };
        let txid = tx.txid.to_ascii_lowercase();
        Ok(Some(ObservedEvent {
            external: ExternalRef {
                network: network.clone(),
                tx_id: txid.clone(),
                block: tx.status.block_height,
                from_raw,
                to_raw,
                asset_symbol: "BTC".into(),
                decimals: 8,
                amount: amount.to_string(),
                fee: tx.fee.map(|f| f as f64 / 1e8),
                explorer_url: Some(format!("{explorer}/tx/{txid}")),
                timestamp: tx.status.block_time,
                asset_address: None,
            },
            incoming,
            counterparty: None,
            counterparty_label: (!tx.status.confirmed).then(|| "unconfirmed".to_owned()),
            scam_flag: false,
        }))
    }
}

#[async_trait]
impl NetworkSource for EsploraBitcoinSource {
    fn network(&self) -> Network {
        self.network.clone()
    }

    /// Falls back to the trimmed input when it does not parse; callers wanting a guarantee use `validator()`.
    fn canonical(&self, address_raw: &str) -> String {
        self.validator.canonical(address_raw).unwrap_or_else(|_| address_raw.trim().to_owned())
    }

    /// Newest first: unconfirmed transactions, then confirmed history. `limit` is clamped to 1..=100.
    async fn fetch(&self, address_raw: &str, cursor: Option<&str>, limit: u32) -> Result<Page, ConnectorError> {
        let address = self.validator.canonical(address_raw)?;
        let limit = limit.clamp(1, MAX_LIMIT) as usize;
        let state = match cursor {
            Some(raw) => Cursor::decode(raw)?,
            None => Cursor::Mempool { skip: 0 },
        };
        let mut events: Vec<ObservedEvent> = Vec::with_capacity(limit);

        let mut after_txid = match state {
            Cursor::Mempool { skip } => {
                let mempool = self.client.mempool_txs(&address).await?;
                let total = mempool.len();
                let mut consumed = skip;
                for tx in mempool.iter().skip(skip).take(limit) {
                    consumed += 1;
                    if let Some(ev) = Self::to_event(&self.network, &self.explorer, &address, tx)? {
                        events.push(ev);
                    }
                }
                if consumed < total {
                    return Ok(Page { events, next_cursor: Some(Cursor::Mempool { skip: consumed }.encode()) });
                }
                None
            }
            Cursor::Chain { after_txid } => after_txid,
        };

        for _ in 0..MAX_CHAIN_PAGES_PER_CALL {
            let room = limit.saturating_sub(events.len());
            if room == 0 {
                break;
            }
            let page = self.client.chain_txs(&address, after_txid.as_deref()).await?;
            let page_len = page.len();
            let mut taken = 0usize;
            for tx in page.iter().take(room) {
                if let Some(ev) = Self::to_event(&self.network, &self.explorer, &address, tx)? {
                    events.push(ev);
                }
                after_txid = Some(tx.txid.to_ascii_lowercase());
                taken += 1;
            }
            if page_len < ESPLORA_CHAIN_PAGE && taken == page_len {
                return Ok(Page { events, next_cursor: None });
            }
        }
        Ok(Page { events, next_cursor: Some(Cursor::Chain { after_txid }.encode()) })
    }

    async fn account_info(&self, address_raw: &str) -> Result<AccountInfo, ConnectorError> {
        let address = self.validator.canonical(address_raw)?;
        let stats = self.client.address_stats(&address).await?;
        let confirmed = i128::from(stats.chain_stats.funded_txo_sum) - i128::from(stats.chain_stats.spent_txo_sum);
        let pending = i128::from(stats.mempool_stats.funded_txo_sum) - i128::from(stats.mempool_stats.spent_txo_sum);
        let mut extra = BTreeMap::new();
        extra.insert("pending_delta_sats".into(), serde_json::json!(pending));
        extra.insert("mempool_tx_count".into(), serde_json::json!(stats.mempool_stats.tx_count));
        Ok(AccountInfo {
            network: self.network.clone(),
            address,
            native_symbol: "BTC".into(),
            native_decimals: 8,
            balance: Some(confirmed.max(0).to_string()),
            tokens: vec![],
            tx_count: Some(stats.chain_stats.tx_count.saturating_add(stats.mempool_stats.tx_count)),
            first_seen: None,
            last_active: None,
            name: None,
            labels: vec![],
            is_contract: false,
            is_scam: false,
            is_active: stats.chain_stats.tx_count + stats.mempool_stats.tx_count > 0,
            extra,
        })
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    const MAINNET: BitcoinAddressValidator = BitcoinAddressValidator::new(bitcoin::Network::Bitcoin);
    const TESTNET: BitcoinAddressValidator = BitcoinAddressValidator::new(bitcoin::Network::Testnet);
    const P2WPKH_MAIN_UPPER: &str = "BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4";
    const P2WPKH_MAIN_LOWER: &str = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
    const P2WPKH_TEST: &str = "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx";
    const P2PKH_MAIN: &str = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";

    #[test]
    fn address_validation_and_canonical_form() {
        assert_eq!(MAINNET.canonical(P2WPKH_MAIN_UPPER).unwrap(), P2WPKH_MAIN_LOWER);
        assert_eq!(MAINNET.canonical(&format!("  {P2WPKH_MAIN_LOWER}\n")).unwrap(), P2WPKH_MAIN_LOWER);
        assert_eq!(MAINNET.canonical(P2PKH_MAIN).unwrap(), P2PKH_MAIN);
        assert!(matches!(MAINNET.validate(P2WPKH_TEST), Err(ConnectorError::InvalidAddress(_))));
        assert!(matches!(TESTNET.validate(P2WPKH_MAIN_LOWER), Err(ConnectorError::InvalidAddress(_))));
        assert!(matches!(MAINNET.validate("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5"), Err(ConnectorError::InvalidAddress(_))), "bad checksum");
        assert!(matches!(MAINNET.validate("bc1QW508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"), Err(ConnectorError::InvalidAddress(_))), "mixed case");
        for input in ["", "hello", "../../admin", "bc1q/../../x"] {
            assert!(matches!(MAINNET.validate(input), Err(ConnectorError::InvalidAddress(_))), "{input}");
        }
    }

    #[test]
    fn cursor_round_trips_and_rejects_garbage() {
        let txid = "a".repeat(64);
        for c in [Cursor::Mempool { skip: 7 }, Cursor::Chain { after_txid: None }, Cursor::Chain { after_txid: Some(txid) }] {
            assert_eq!(Cursor::decode(&c.encode()).unwrap(), c);
        }
        let too_short = format!("c:{}", "a".repeat(63));
        for raw in ["", "x:1", "m:-1", "m:abc", too_short.as_str(), "c:../x"] {
            assert!(matches!(Cursor::decode(raw), Err(ConnectorError::InvalidCursor(_))), "{raw}");
        }
    }

    const SAMPLE: &str = r#"[
      {"txid":"1111111111111111111111111111111111111111111111111111111111111111","fee":300,"status":{"confirmed":true,"block_height":10,"block_time":1700000000},
       "vin":[{"prevout":{"scriptpubkey_address":"tb1qalice","value":100000}}],
       "vout":[{"scriptpubkey_address":"tb1qwallet","value":60000},{"scriptpubkey_address":"tb1qalice","value":39700}]},
      {"txid":"2222222222222222222222222222222222222222222222222222222222222222","fee":200,"status":{"confirmed":false,"block_height":null,"block_time":null},
       "vin":[{"prevout":{"scriptpubkey_address":"tb1qwallet","value":60000}}],
       "vout":[{"scriptpubkey_address":"tb1qbob","value":25000},{"scriptpubkey_address":"tb1qwallet","value":34800}]},
      {"txid":"3333333333333333333333333333333333333333333333333333333333333333","fee":null,"status":{"confirmed":true,"block_height":1,"block_time":1},
       "vin":[{"prevout":null}],"vout":[{"scriptpubkey_address":"tb1qwallet","value":5000000000}]}
    ]"#;

    #[test]
    fn nets_inputs_and_outputs_per_address() {
        let txs: Vec<EsploraTx> = serde_json::from_str(SAMPLE).unwrap();
        let net = Network { family: ChainFamily::Bitcoin, name: "bitcoin-testnet".into(), chain_id: None };
        let ev: Vec<ObservedEvent> = txs.iter().filter_map(|t| EsploraBitcoinSource::to_event(&net, "https://x", "tb1qwallet", t).unwrap()).collect();
        assert_eq!(ev.len(), 3);
        assert!(ev[0].incoming && ev[0].external.amount == "60000" && ev[0].external.from_raw == "tb1qalice");
        assert_eq!(ev[0].external.timestamp, Some(1700000000));
        assert!(!ev[1].incoming && ev[1].external.amount == "25200" && ev[1].external.to_raw == "tb1qbob", "spent minus change");
        assert_eq!(ev[1].counterparty_label.as_deref(), Some("unconfirmed"));
        assert_eq!(ev[2].external.from_raw, "coinbase");
    }

    /// `SQ_LIVE=1 cargo test -p sq-conn-btc -- --ignored`: mempool.space testnet, no key.
    #[tokio::test]
    #[ignore]
    async fn live_testnet_history_and_stats() {
        if std::env::var("SQ_LIVE").is_err() {
            return;
        }
        let s = EsploraBitcoinSource::testnet();
        let info = s.account_info(P2WPKH_TEST).await.unwrap();
        assert!(info.tx_count.unwrap_or(0) > 0, "{info:?}");
        let page = s.fetch(P2WPKH_TEST, None, 30).await.unwrap();
        assert!(!page.events.is_empty());
        if let Some(c) = page.next_cursor {
            let page2 = s.fetch(P2WPKH_TEST, Some(&c), 30).await.unwrap();
            assert!(!page2.events.is_empty());
        }
    }
}
