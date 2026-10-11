//! EVM chains via a Blockscout instance's v2 API (Base Sepolia, Ethereum Sepolia, Ethereum, …).
//!
//! Endpoints: `/addresses/{hash}/transactions` (native transfers, contract calls),
//! `/addresses/{hash}/token-transfers` (ERC-20 moves), `/addresses/{hash}`, `/token-balances` and
//! `/counters` (account info). Counterparties are real 20-byte addresses, so the Ferra chain can
//! link them to its own accounts. The legacy `?module=account` API is rate-limited much harder on
//! public instances; v2 is what the explorer front-end itself uses.

use std::collections::BTreeMap;

use alloy_primitives::Address;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use sq_adapters::{ChainFamily, ExternalRef, Network};
use sq_connectors::{AccountInfo, ConnectorError, NetworkSource, ObservedEvent, Page, TokenBalance, get_text};

/// Blockscout's placeholder "token" for the native coin in token-transfer lists.
pub const NATIVE_PSEUDO_TOKEN: &str = "0xfffffffffffffffffffffffffffffffffffffffe";

pub struct BlockscoutSource {
    client: reqwest::Client,
    base: String,
    network: Network,
    explorer: String,
}

/// Pagination state for the two v2 streams; serialized into the opaque cursor.
#[derive(Debug, Default, Serialize, Deserialize)]
struct Cursor {
    /// `next_page_params` of `/transactions`; `None` once exhausted; `Some(empty)` means "start".
    tx: Option<BTreeMap<String, serde_json::Value>>,
    tt: Option<BTreeMap<String, serde_json::Value>>,
}

impl BlockscoutSource {
    /// `base` like `https://base-sepolia.blockscout.com/api`.
    pub fn new(name: &str, chain_id: u64, base: impl Into<String>) -> Self {
        let base = base.into();
        let explorer = base.trim_end_matches("/api").to_string();
        Self { client: sq_connectors::http(), base, network: Network { family: ChainFamily::Evm, name: name.into(), chain_id: Some(chain_id) }, explorer }
    }

    pub fn base_sepolia() -> Self {
        Self::new("base-sepolia", 84532, "https://base-sepolia.blockscout.com/api")
    }

    fn v2(&self) -> String {
        format!("{}/v2", self.base)
    }

    /// Pure: v2 transactions + token transfers → events for `wallet`. Public for offline tests.
    pub fn extract(network: &Network, explorer: &str, wallet: &str, txs: &[V2Tx], transfers: &[V2TokenTransfer]) -> Vec<ObservedEvent> {
        let w = wallet.to_lowercase();
        let mut out = Vec::new();
        for t in txs.iter().filter(|t| t.block_number.is_some()) {
            let from = t.from.hash.to_lowercase();
            let to = t.to.as_ref().map(|a| a.hash.to_lowercase()).unwrap_or_default();
            if from != w && to != w {
                continue;
            }
            let incoming = to == w && from != w;
            let other = if incoming { &t.from } else { t.to.as_ref().unwrap_or(&t.from) };
            let is_call = t.value == "0";
            out.push(ObservedEvent {
                external: ExternalRef {
                    network: network.clone(),
                    tx_id: t.hash.clone(),
                    block: t.block_number,
                    from_raw: from.clone(),
                    to_raw: to.clone(),
                    asset_symbol: "ETH".into(),
                    decimals: 18,
                    amount: t.value.clone(),
                    fee: t.fee.as_ref().and_then(|f| f.value.parse::<f64>().ok()).map(|v| v / 1e18),
                    explorer_url: Some(format!("{explorer}/tx/{}", t.hash)),
                    timestamp: t.timestamp.as_deref().and_then(parse_iso8601),
                    asset_address: None,
                },
                incoming,
                counterparty: other.hash.parse::<Address>().ok(),
                counterparty_label: if is_call { Some(t.method.clone().map(|m| format!("call: {m}")).unwrap_or_else(|| "contract call".into())) } else { other.name.clone() },
                scam_flag: other.is_scam,
            });
        }
        for tr in transfers {
            let from = tr.from.hash.to_lowercase();
            let to = tr.to.hash.to_lowercase();
            if from != w && to != w {
                continue;
            }
            let incoming = to == w && from != w;
            let other = if incoming { &tr.from } else { &tr.to };
            // Blockscout lists native coin movements as a pseudo-token at 0xffff...fffe.
            let token_addr = tr.token.address.to_lowercase();
            let native = token_addr == NATIVE_PSEUDO_TOKEN;
            let decimals = if native { 18 } else { tr.total.decimals.as_deref().or(tr.token.decimals.as_deref()).and_then(|d| d.parse().ok()).unwrap_or(18) };
            out.push(ObservedEvent {
                external: ExternalRef {
                    network: network.clone(),
                    tx_id: if native { tr.transaction_hash.clone() } else { format!("{}#{}", tr.transaction_hash, tr.log_index.unwrap_or(0)) },
                    block: tr.block_number,
                    from_raw: from,
                    to_raw: to,
                    asset_symbol: if native { "ETH".into() } else { tr.token.symbol.clone().unwrap_or_else(|| "TOKEN".into()) },
                    decimals,
                    amount: tr.total.value.clone().unwrap_or_else(|| "0".into()),
                    fee: None,
                    explorer_url: Some(format!("{explorer}/tx/{}", tr.transaction_hash)),
                    timestamp: tr.timestamp.as_deref().and_then(parse_iso8601),
                    asset_address: if native { None } else { Some(token_addr) },
                },
                incoming,
                counterparty: other.hash.parse::<Address>().ok(),
                counterparty_label: other.name.clone(),
                scam_flag: other.is_scam,
            });
        }
        // The same native movement can appear in both lists: keep one per (tx id, direction, amount).
        let mut seen = std::collections::BTreeSet::new();
        out.retain(|e| seen.insert(format!("{}|{}|{}|{}", e.external.tx_id, e.incoming, e.external.amount, e.external.asset_symbol)));
        out.sort_by_key(|e| std::cmp::Reverse((e.external.block, e.external.timestamp)));
        out
    }

    /// Pure: Blockscout v2 address + token balances + counters → `AccountInfo`.
    pub fn account_info_from(network: &Network, a: &V2Address, tokens: &[V2TokenBalance], counters: Option<&V2Counters>) -> AccountInfo {
        let mut labels: Vec<String> = a.public_tags.iter().chain(a.private_tags.iter()).map(|t| t.display_name.clone()).collect();
        if a.is_contract {
            labels.push("contract".into());
            if a.is_verified {
                labels.push("verified_contract".into());
            }
        }
        if let Some(t) = &a.token {
            labels.push(format!("token:{}", t.symbol.clone().unwrap_or_default()));
        }
        let mut extra = BTreeMap::new();
        if let Some(r) = &a.exchange_rate {
            extra.insert("native_usd_rate".into(), serde_json::json!(r));
        }
        AccountInfo {
            network: network.clone(),
            address: a.hash.to_lowercase(),
            native_symbol: "ETH".into(),
            native_decimals: 18,
            balance: a.coin_balance.clone(),
            tokens: tokens
                .iter()
                .map(|t| TokenBalance {
                    symbol: t.token.symbol.clone().unwrap_or_default(),
                    name: t.token.name.clone(),
                    address: t.token.address.to_lowercase(),
                    decimals: t.token.decimals.as_deref().and_then(|d| d.parse().ok()).unwrap_or(18),
                    amount: t.value.clone(),
                    usd_value: None,
                    verified: None,
                })
                .collect(),
            tx_count: counters.and_then(|c| c.transactions_count.parse().ok()),
            first_seen: None,
            last_active: None,
            name: a.ens_domain_name.clone().or_else(|| a.name.clone()),
            labels,
            is_contract: a.is_contract,
            is_scam: a.is_scam,
            is_active: true,
            extra,
        }
    }

    async fn list<T: serde::de::DeserializeOwned>(&self, path: &str, params: &BTreeMap<String, serde_json::Value>) -> Result<V2List<T>, ConnectorError> {
        let mut url = format!("{}/addresses/{path}", self.v2());
        if !params.is_empty() {
            let qs: Vec<String> = params.iter().map(|(k, v)| format!("{k}={}", v.as_str().map(String::from).unwrap_or_else(|| v.to_string()))).collect();
            url.push('?');
            url.push_str(&qs.join("&"));
        }
        let text = get_text(&self.client, &self.network.name, &url, &[]).await?;
        serde_json::from_str(&text).map_err(|e| ConnectorError::Parse(format!("{path}: {e}")))
    }
}

#[async_trait]
impl NetworkSource for BlockscoutSource {
    fn network(&self) -> Network {
        self.network.clone()
    }

    fn canonical(&self, address_raw: &str) -> String {
        address_raw.trim().to_lowercase()
    }

    async fn account_info(&self, address_raw: &str) -> Result<AccountInfo, ConnectorError> {
        let addr = self.canonical(address_raw);
        let text = get_text(&self.client, &self.network.name, &format!("{}/addresses/{addr}", self.v2()), &[]).await?;
        let a: V2Address = serde_json::from_str(&text).map_err(|e| ConnectorError::Parse(format!("address: {e}")))?;
        let tokens: Vec<V2TokenBalance> = match get_text(&self.client, &self.network.name, &format!("{}/addresses/{addr}/token-balances", self.v2()), &[]).await {
            Ok(t) => serde_json::from_str(&t).unwrap_or_default(),
            Err(_) => Vec::new(),
        };
        let counters: Option<V2Counters> = get_text(&self.client, &self.network.name, &format!("{}/addresses/{addr}/counters", self.v2()), &[]).await.ok().and_then(|t| serde_json::from_str(&t).ok());
        Ok(Self::account_info_from(&self.network, &a, &tokens, counters.as_ref()))
    }

    async fn fetch(&self, address_raw: &str, cursor: Option<&str>, _limit: u32) -> Result<Page, ConnectorError> {
        let addr = self.canonical(address_raw);
        let cur: Cursor = match cursor {
            Some(c) => serde_json::from_str(c).map_err(|e| ConnectorError::Parse(format!("cursor: {e}")))?,
            None => Cursor { tx: Some(BTreeMap::new()), tt: Some(BTreeMap::new()) },
        };
        // The native-transaction page and the token-transfer page are independent: one round
        // trip instead of two.
        let (tx_page, tt_page) = tokio::join!(
            async {
                match &cur.tx {
                    Some(p) => self.list::<V2Tx>(&format!("{addr}/transactions"), p).await.map(Some),
                    None => Ok(None),
                }
            },
            async {
                match &cur.tt {
                    Some(p) => match self.list::<V2TokenTransfer>(&format!("{addr}/token-transfers"), p).await {
                        Ok(l) => Ok(Some(l)),
                        Err(ConnectorError::Upstream { status: 404, .. }) => Ok(None),
                        Err(e) => Err(e),
                    },
                    None => Ok(None),
                }
            }
        );
        let (txs, next_tx) = match tx_page? {
            Some(l) => (l.items, l.next_page_params),
            None => (Vec::new(), None),
        };
        let (transfers, next_tt) = match tt_page? {
            Some(l) => (l.items, l.next_page_params),
            None => (Vec::new(), None),
        };
        let next = Cursor { tx: next_tx, tt: next_tt };
        let next_cursor = (next.tx.is_some() || next.tt.is_some()).then(|| serde_json::to_string(&next).unwrap_or_default());
        Ok(Page { events: Self::extract(&self.network, &self.explorer, &addr, &txs, &transfers), next_cursor })
    }
}

/// `YYYY-MM-DDTHH:MM:SS[.fff]Z` → seconds since the epoch.
pub fn parse_iso8601(s: &str) -> Option<u64> {
    let (date, time) = s.split_once('T')?;
    let mut d = date.split('-');
    let (y, m, day): (i64, i64, i64) = (d.next()?.parse().ok()?, d.next()?.parse().ok()?, d.next()?.parse().ok()?);
    let time = time.trim_end_matches('Z');
    let time = time.split('.').next()?;
    let mut t = time.split(':');
    let (hh, mm, ss): (u64, u64, u64) = (t.next()?.parse().ok()?, t.next()?.parse().ok()?, t.next()?.parse().ok()?);
    // days-from-civil (Howard Hinnant)
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    u64::try_from(days).ok().map(|dd| dd * 86_400 + hh * 3600 + mm * 60 + ss)
}

// ----- v2 wire types -----

#[derive(Debug, Clone, Deserialize)]
pub struct V2List<T> {
    #[serde(default = "Vec::new")]
    pub items: Vec<T>,
    pub next_page_params: Option<BTreeMap<String, serde_json::Value>>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct V2Party {
    #[serde(default)]
    pub hash: String,
    pub name: Option<String>,
    #[serde(default)]
    pub is_contract: bool,
    #[serde(default)]
    pub is_scam: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct V2Fee {
    #[serde(default)]
    pub value: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct V2Tx {
    pub hash: String,
    pub timestamp: Option<String>,
    pub block_number: Option<u64>,
    pub from: V2Party,
    pub to: Option<V2Party>,
    #[serde(default)]
    pub value: String,
    pub fee: Option<V2Fee>,
    pub method: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct V2Total {
    pub value: Option<String>,
    pub decimals: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct V2TokenMeta {
    /// Newer Blockscout sends `address_hash`, older `address`.
    #[serde(default, alias = "address_hash")]
    pub address: String,
    pub symbol: Option<String>,
    pub name: Option<String>,
    pub decimals: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct V2TokenTransfer {
    pub transaction_hash: String,
    pub timestamp: Option<String>,
    pub block_number: Option<u64>,
    pub log_index: Option<u64>,
    pub from: V2Party,
    pub to: V2Party,
    #[serde(default)]
    pub total: V2Total,
    #[serde(default)]
    pub token: V2TokenMeta,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct V2Tag {
    #[serde(default)]
    pub display_name: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct V2Address {
    #[serde(default)]
    pub hash: String,
    #[serde(default)]
    pub is_contract: bool,
    #[serde(default)]
    pub is_verified: bool,
    #[serde(default)]
    pub is_scam: bool,
    pub name: Option<String>,
    pub ens_domain_name: Option<String>,
    pub coin_balance: Option<String>,
    pub exchange_rate: Option<String>,
    #[serde(default)]
    pub public_tags: Vec<V2Tag>,
    #[serde(default)]
    pub private_tags: Vec<V2Tag>,
    pub token: Option<V2TokenMeta>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct V2TokenBalance {
    #[serde(default)]
    pub token: V2TokenMeta,
    #[serde(default)]
    pub value: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct V2Counters {
    #[serde(default)]
    pub transactions_count: String,
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    const TXS: &str = r#"{"items":[
      {"hash":"0xh1","timestamp":"2026-10-10T15:21:23.000000Z","block_number":100,"from":{"hash":"0x00000000000000000000000000000000000000aa"},"to":{"hash":"0x1111111111111111111111111111111111111111"},"value":"1000000000000000","fee":{"value":"21000000000000"},"method":null},
      {"hash":"0xh3","timestamp":"2026-10-10T15:22:00Z","block_number":102,"from":{"hash":"0x1111111111111111111111111111111111111111"},"to":{"hash":"0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48","name":"USDC","is_contract":true},"value":"0","fee":{"value":"5000"},"method":"transfer"}
    ],"next_page_params":{"block_number":99,"index":3,"items_count":50}}"#;
    const TRANSFERS: &str = r#"{"items":[
      {"transaction_hash":"0xh3","timestamp":"2026-10-10T15:22:00Z","block_number":102,"log_index":3,"from":{"hash":"0x1111111111111111111111111111111111111111"},"to":{"hash":"0x2222222222222222222222222222222222222222"},"total":{"value":"5000000","decimals":"6"},"token":{"address_hash":"0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48","symbol":"USDC","decimals":"6"}},
      {"transaction_hash":"0xh1","timestamp":"2026-10-10T15:21:23Z","block_number":100,"log_index":0,"from":{"hash":"0x00000000000000000000000000000000000000aa"},"to":{"hash":"0x1111111111111111111111111111111111111111"},"total":{"value":"1000000000000000","decimals":"18"},"token":{"address_hash":"0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE","symbol":null,"decimals":null}}
    ],"next_page_params":null}"#;

    #[test]
    fn maps_v2_transactions_and_token_transfers() {
        let txs: V2List<V2Tx> = serde_json::from_str(TXS).unwrap();
        let tt: V2List<V2TokenTransfer> = serde_json::from_str(TRANSFERS).unwrap();
        let net = Network { family: ChainFamily::Evm, name: "ethereum".into(), chain_id: Some(1) };
        let ev = BlockscoutSource::extract(&net, "https://x", "0x1111111111111111111111111111111111111111", &txs.items, &tt.items);
        assert_eq!(ev.len(), 3, "the native pseudo-token row merges with the native transaction");
        // newest first: the USDC call (block 102) and its token transfer, then the inbound ETH
        let call = ev.iter().find(|e| e.external.tx_id == "0xh3").unwrap();
        assert_eq!(call.counterparty_label.as_deref(), Some("call: transfer"));
        assert_eq!(call.external.amount, "0");
        let token = ev.iter().find(|e| e.external.tx_id == "0xh3#3").unwrap();
        assert_eq!(token.external.asset_symbol, "USDC");
        assert_eq!(token.external.decimals, 6);
        assert_eq!(token.external.asset_address.as_deref(), Some("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"));
        assert!(!token.incoming);
        let eth = ev.iter().find(|e| e.external.tx_id == "0xh1").unwrap();
        assert!(eth.incoming);
        assert_eq!(eth.counterparty, Some(Address::with_last_byte(0xaa)));
        assert!((eth.external.fee.unwrap() - 0.000021).abs() < 1e-12);
        assert_eq!(eth.external.timestamp, Some(parse_iso8601("2026-10-10T15:21:23Z").unwrap()));
        assert!(txs.next_page_params.is_some());
    }

    #[test]
    fn iso8601_parses() {
        assert_eq!(parse_iso8601("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_iso8601("2023-11-14T22:13:20.123456Z"), Some(1_700_000_000));
        assert_eq!(parse_iso8601("garbage"), None);
    }

    #[test]
    fn builds_account_info_from_v2_payloads() {
        let a: V2Address = serde_json::from_str(r#"{"hash":"0xABCDEF0000000000000000000000000000000001","is_contract":true,"is_verified":true,"coin_balance":"1000","exchange_rate":"2500.5","public_tags":[{"display_name":"Uniswap V3: Router"}],"private_tags":[],"ens_domain_name":null}"#).unwrap();
        let t: Vec<V2TokenBalance> = serde_json::from_str(r#"[{"token":{"address":"0xToken","symbol":"USDC","name":"USD Coin","decimals":"6","type":"ERC-20"},"value":"5000000"}]"#).unwrap();
        let c: V2Counters = serde_json::from_str(r#"{"transactions_count":"42","token_transfers_count":"7"}"#).unwrap();
        let net = Network { family: ChainFamily::Evm, name: "eth-sepolia".into(), chain_id: Some(11155111) };
        let info = BlockscoutSource::account_info_from(&net, &a, &t, Some(&c));
        assert_eq!(info.address, "0xabcdef0000000000000000000000000000000001");
        assert!(info.is_contract && info.labels.iter().any(|l| l.contains("Uniswap")) && info.labels.contains(&"verified_contract".to_string()));
        assert_eq!(info.tx_count, Some(42));
        assert_eq!(info.tokens[0].symbol, "USDC");
        assert_eq!(info.tokens[0].decimals, 6);
    }

    /// `SQ_LIVE=1 cargo test -p sq-conn-evm -- --ignored`: Sepolia Blockscout without a key.
    #[tokio::test]
    #[ignore]
    async fn live_sepolia_account_and_history() {
        if std::env::var("SQ_LIVE").is_err() {
            return;
        }
        let s = BlockscoutSource::new("eth-sepolia", 11_155_111, "https://eth-sepolia.blockscout.com/api");
        let info = s.account_info("0x56E2269d4B304790aaCB97d5FB55aED39bf03DDD").await.unwrap();
        assert_eq!(info.network.name, "eth-sepolia");
        let page = s.fetch("0x56E2269d4B304790aaCB97d5FB55aED39bf03DDD", None, 50).await.unwrap();
        assert!(!page.events.is_empty());
        assert!(page.events[0].external.timestamp.is_some());
    }
}
