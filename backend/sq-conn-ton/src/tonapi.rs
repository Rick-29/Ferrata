//! tonapi.io v2 client. Endpoints (as NetView's `wallet-connection` and `wallet-scraper` use them):
//! `GET /accounts/{id}/events?limit=&before_lt=` → typed actions; `GET /accounts/{id}` → account;
//! `GET /accounts/{id}/jettons?currencies=usd` → jetton balances.

use std::collections::BTreeMap;

use async_trait::async_trait;
use serde::Deserialize;
use sq_adapters::{ExternalRef, Network};
use sq_connectors::{AccountInfo, ConnectorError, NetworkSource, ObservedEvent, Page, TokenBalance, get_text};

use crate::address;

const MAINNET: &str = "https://tonapi.io/v2";
const TESTNET: &str = "https://testnet.tonapi.io/v2";

pub struct TonApi {
    client: reqwest::Client,
    base: String,
    api_key: Option<String>,
    testnet: bool,
}

impl TonApi {
    pub fn new(testnet: bool, api_key: Option<String>) -> Self {
        Self { client: sq_connectors::http(), base: if testnet { TESTNET } else { MAINNET }.into(), api_key, testnet }
    }

    pub fn with_base(mut self, base: impl Into<String>) -> Self {
        self.base = base.into();
        self
    }

    fn headers(&self) -> Vec<(&'static str, String)> {
        self.api_key.iter().map(|k| ("Authorization", format!("Bearer {k}"))).collect()
    }

    fn net(&self) -> Network {
        crate::network(self.testnet)
    }

    /// Pure: tonapi events → observed events for `wallet` (raw form). Public for offline tests.
    pub fn extract(network: &Network, testnet: bool, wallet_raw: &str, events: &[AccountEvent]) -> Vec<ObservedEvent> {
        let mut out = Vec::new();
        for ev in events {
            if ev.in_progress {
                continue;
            }
            let fee = if ev.extra < 0 { Some(-(ev.extra as f64) / 1e9) } else { None };
            for (i, action) in ev.actions.iter().enumerate() {
                if action.status != "ok" {
                    continue;
                }
                let (from, to, amount, symbol, decimals, token) = match (&action.ton_transfer, &action.jetton_transfer) {
                    (Some(t), _) => (t.sender.clone(), t.recipient.clone(), t.amount.to_string(), "TON".to_string(), 9u8, None),
                    (None, Some(j)) => match (&j.sender, &j.recipient) {
                        (Some(s), Some(r)) => (s.clone(), r.clone(), j.amount.clone(), j.jetton.symbol.clone(), j.jetton.decimals, Some(j.jetton.clone())),
                        _ => continue,
                    },
                    _ => continue,
                };
                let from_raw = address::to_raw(&from.address).unwrap_or(from.address.clone());
                let to_raw = address::to_raw(&to.address).unwrap_or(to.address.clone());
                let incoming = to_raw == wallet_raw;
                if !incoming && from_raw != wallet_raw {
                    continue;
                }
                let other = if incoming { &from } else { &to };
                let explorer = format!("https://{}tonviewer.com/transaction/{}", if testnet { "testnet." } else { "" }, ev.event_id);
                let mut ext = ExternalRef {
                    network: network.clone(),
                    tx_id: if i == 0 { ev.event_id.clone() } else { format!("{}#{i}", ev.event_id) },
                    block: None,
                    from_raw,
                    to_raw,
                    asset_symbol: symbol,
                    decimals,
                    amount,
                    fee: if i == 0 { fee } else { None },
                    explorer_url: Some(explorer),
                    timestamp: Some(ev.timestamp),
                    asset_address: token.as_ref().map(|j| address::to_raw(&j.address).unwrap_or(j.address.clone())),
                };
                if let Some(j) = token
                    && j.verification.as_deref() == Some("blacklist")
                {
                    ext.asset_symbol = format!("{} (blacklisted)", ext.asset_symbol);
                }
                out.push(ObservedEvent {
                    external: ext,
                    incoming,
                    counterparty: None,
                    counterparty_label: other.name.clone(),
                    // tonapi flags spam airdrops *received* by a wallet; those say nothing about the wallet.
                    scam_flag: other.is_scam || (ev.is_scam && !incoming),
                });
            }
        }
        out
    }

    pub async fn events(&self, address_raw: &str, before_lt: Option<u64>, limit: u32) -> Result<EventsResponse, ConnectorError> {
        let mut url = format!("{}/accounts/{}/events?limit={}", self.base, address_raw, limit.clamp(1, 100));
        if let Some(lt) = before_lt {
            url.push_str(&format!("&before_lt={lt}"));
        }
        let text = get_text(&self.client, &self.net().name, &url, &self.headers()).await?;
        serde_json::from_str(&text).map_err(|e| ConnectorError::Parse(format!("events: {e}")))
    }

    pub async fn account(&self, address_raw: &str) -> Result<AccountResponse, ConnectorError> {
        let url = format!("{}/accounts/{}", self.base, address_raw);
        let text = get_text(&self.client, &self.net().name, &url, &self.headers()).await?;
        serde_json::from_str(&text).map_err(|e| ConnectorError::Parse(format!("account: {e}")))
    }

    pub async fn jettons(&self, address_raw: &str) -> Result<JettonsResponse, ConnectorError> {
        let url = format!("{}/accounts/{}/jettons?currencies=usd", self.base, address_raw);
        let text = get_text(&self.client, &self.net().name, &url, &self.headers()).await?;
        serde_json::from_str(&text).map_err(|e| ConnectorError::Parse(format!("jettons: {e}")))
    }

    /// Pure: account + jettons → `AccountInfo`.
    pub fn account_info_from(network: &Network, acc: &AccountResponse, jettons: Option<&JettonsResponse>) -> AccountInfo {
        let raw = address::to_raw(&acc.address).unwrap_or(acc.address.clone());
        let mut labels: Vec<String> = acc.interfaces.clone();
        if acc.is_scam {
            labels.push("scam".into());
        }
        if acc.is_wallet {
            labels.push("wallet".into());
        }
        let tokens = jettons
            .map(|j| {
                j.balances
                    .iter()
                    .map(|b| TokenBalance {
                        symbol: b.jetton.symbol.clone(),
                        name: Some(b.jetton.name.clone()),
                        address: address::to_raw(&b.jetton.address).unwrap_or(b.jetton.address.clone()),
                        decimals: b.jetton.decimals,
                        amount: b.balance.clone(),
                        usd_value: b.price.as_ref().and_then(|p| p.prices.get("USD")).and_then(|usd| {
                            let units = b.balance.parse::<f64>().ok()? / 10f64.powi(i32::from(b.jetton.decimals));
                            Some(units * usd)
                        }),
                        verified: b.jetton.verification.as_deref().map(|v| v == "whitelist"),
                    })
                    .collect()
            })
            .unwrap_or_default();
        let mut extra = BTreeMap::new();
        extra.insert("status".into(), serde_json::json!(acc.status));
        extra.insert("get_methods".into(), serde_json::json!(acc.get_methods));
        if let Some(icon) = &acc.icon {
            extra.insert("icon".into(), serde_json::json!(icon));
        }
        AccountInfo {
            network: network.clone(),
            address: raw,
            native_symbol: "TON".into(),
            native_decimals: 9,
            balance: Some(acc.balance.max(0).to_string()),
            tokens,
            tx_count: None,
            first_seen: None,
            last_active: (acc.last_activity > 0).then_some(acc.last_activity),
            name: acc.name.clone(),
            labels,
            is_contract: !acc.is_wallet && acc.status == "active",
            is_scam: acc.is_scam,
            is_active: acc.status == "active",
            extra,
        }
    }
}

#[async_trait]
impl NetworkSource for TonApi {
    fn network(&self) -> Network {
        self.net()
    }

    fn canonical(&self, address_raw: &str) -> String {
        address::to_raw(address_raw).unwrap_or_else(|| address_raw.to_string())
    }

    async fn fetch(&self, address_raw: &str, cursor: Option<&str>, limit: u32) -> Result<Page, ConnectorError> {
        let wallet = self.canonical(address_raw);
        let before_lt = cursor.and_then(|c| c.parse::<u64>().ok());
        let resp = self.events(&wallet, before_lt, limit).await?;
        let next_cursor = (resp.next_from > 0 && !resp.events.is_empty()).then(|| resp.next_from.to_string());
        Ok(Page { events: Self::extract(&self.net(), self.testnet, &wallet, &resp.events), next_cursor })
    }

    async fn account_info(&self, address_raw: &str) -> Result<AccountInfo, ConnectorError> {
        let wallet = self.canonical(address_raw);
        let acc = self.account(&wallet).await?;
        let jettons = self.jettons(&wallet).await.ok();
        Ok(Self::account_info_from(&self.net(), &acc, jettons.as_ref()))
    }
}

// ----- wire types -----

#[derive(Debug, Clone, Deserialize)]
pub struct EventsResponse {
    #[serde(default)]
    pub events: Vec<AccountEvent>,
    #[serde(default)]
    pub next_from: u64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AccountEvent {
    pub event_id: String,
    pub timestamp: u64,
    #[serde(default)]
    pub actions: Vec<Action>,
    #[serde(default)]
    pub lt: u64,
    #[serde(default)]
    pub is_scam: bool,
    #[serde(default)]
    pub in_progress: bool,
    /// Net nanoton effect on the account; negative = fees paid.
    #[serde(default)]
    pub extra: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Action {
    #[serde(rename = "type")]
    pub action_type: String,
    #[serde(default = "ok")]
    pub status: String,
    #[serde(rename = "TonTransfer")]
    pub ton_transfer: Option<TonTransferAction>,
    #[serde(rename = "JettonTransfer")]
    pub jetton_transfer: Option<JettonTransferAction>,
}

fn ok() -> String {
    "ok".into()
}

#[derive(Debug, Clone, Deserialize)]
pub struct TonTransferAction {
    pub sender: AccountAddress,
    pub recipient: AccountAddress,
    #[serde(default)]
    pub amount: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct JettonTransferAction {
    pub sender: Option<AccountAddress>,
    pub recipient: Option<AccountAddress>,
    #[serde(default)]
    pub amount: String,
    pub jetton: JettonPreview,
}

#[derive(Debug, Clone, Deserialize)]
pub struct JettonPreview {
    pub address: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub symbol: String,
    #[serde(default)]
    pub decimals: u8,
    pub verification: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AccountAddress {
    pub address: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub is_scam: bool,
    #[serde(default)]
    pub is_wallet: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AccountResponse {
    pub address: String,
    #[serde(default)]
    pub balance: i64,
    #[serde(default)]
    pub last_activity: u64,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub interfaces: Vec<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub is_scam: bool,
    #[serde(default)]
    pub is_wallet: bool,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub get_methods: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct JettonsResponse {
    #[serde(default)]
    pub balances: Vec<JettonBalanceEntry>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct JettonBalanceEntry {
    pub balance: String,
    pub jetton: JettonPreview,
    pub price: Option<JettonPrice>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct JettonPrice {
    #[serde(default)]
    pub prices: BTreeMap<String, f64>,
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    const WALLET: &str = "0:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const OTHER: &str = "0:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const EVENTS: &str = r#"{"events":[
      {"event_id":"e1","timestamp":1700000100,"lt":5,"is_scam":false,"in_progress":false,"extra":-2500000,
       "actions":[{"type":"TonTransfer","status":"ok","TonTransfer":{"sender":{"address":"0:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","is_wallet":true},"recipient":{"address":"0:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","name":"shop.ton","is_wallet":true},"amount":1500000000}}]},
      {"event_id":"e2","timestamp":1700000000,"lt":4,"is_scam":true,"in_progress":false,"extra":0,
       "actions":[{"type":"JettonTransfer","status":"ok","JettonTransfer":{"sender":{"address":"0:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","is_scam":true},"recipient":{"address":"0:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"amount":"5000000","jetton":{"address":"0:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","name":"Tether USD","symbol":"USD₮","decimals":6,"verification":"whitelist"}}}]},
      {"event_id":"e3","timestamp":1699999000,"lt":3,"is_scam":false,"in_progress":false,"extra":0,
       "actions":[{"type":"SmartContractExec","status":"ok"},{"type":"TonTransfer","status":"failed","TonTransfer":{"sender":{"address":"0:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},"recipient":{"address":"0:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"amount":1}}]}
    ],"next_from":2}"#;

    #[test]
    fn extracts_ton_and_jetton_actions_with_labels_and_scam_flags() {
        let r: EventsResponse = serde_json::from_str(EVENTS).unwrap();
        let net = crate::network(true);
        let ev = TonApi::extract(&net, true, WALLET, &r.events);
        assert_eq!(ev.len(), 2, "failed and non-transfer actions are skipped");
        assert!(!ev[0].incoming);
        assert_eq!(ev[0].external.to_raw, OTHER);
        assert_eq!(ev[0].external.amount, "1500000000");
        assert_eq!(ev[0].counterparty_label.as_deref(), Some("shop.ton"));
        assert!((ev[0].external.fee.unwrap() - 0.0025).abs() < 1e-12);
        assert!(ev[1].incoming);
        assert_eq!(ev[1].external.asset_symbol, "USD₮");
        assert_eq!(ev[1].external.decimals, 6);
        assert!(ev[1].scam_flag, "the sender of the jetton is marked scam");
        assert_eq!(r.next_from, 2);
    }

    #[test]
    fn builds_account_info_from_account_and_jettons() {
        let acc: AccountResponse = serde_json::from_str(r#"{"address":"0:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","balance":123456789,"last_activity":1700000000,"status":"active","interfaces":["wallet_v4r2"],"name":"shop.ton","is_scam":false,"is_wallet":true,"get_methods":["seqno"]}"#).unwrap();
        let jet: JettonsResponse = serde_json::from_str(r#"{"balances":[{"balance":"2500000","jetton":{"address":"0:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","name":"Tether USD","symbol":"USD₮","decimals":6,"verification":"whitelist"},"price":{"prices":{"USD":1.0}}}]}"#).unwrap();
        let info = TonApi::account_info_from(&crate::network(false), &acc, Some(&jet));
        assert_eq!(info.balance.as_deref(), Some("123456789"));
        assert_eq!(info.name.as_deref(), Some("shop.ton"));
        assert!(info.labels.contains(&"wallet_v4r2".to_string()) && info.labels.contains(&"wallet".to_string()));
        assert!(!info.is_contract && info.is_active && !info.is_scam);
        assert_eq!(info.tokens.len(), 1);
        assert!((info.tokens[0].usd_value.unwrap() - 2.5).abs() < 1e-9);
        assert_eq!(info.tokens[0].verified, Some(true));
    }

    /// `SQ_LIVE=1 cargo test -p sq-conn-ton -- --ignored` hits tonapi mainnet without a key.
    #[tokio::test]
    #[ignore]
    async fn live_mainnet_account_and_events() {
        if std::env::var("SQ_LIVE").is_err() {
            return;
        }
        // STON.fi DEX router: always busy, labelled, a contract.
        const ROUTER: &str = "EQB3ncyBUTjZUA5EnFKR5_EnOMI9V1tTEAAPaiU71gc4TiUt";
        let api = TonApi::new(false, std::env::var("SQ_TONAPI_KEY").ok());
        let info = api.account_info(ROUTER).await.unwrap();
        assert!(info.address.starts_with("0:"));
        assert!(info.is_active, "{info:?}");
        let page = api.fetch(ROUTER, None, 10).await.unwrap();
        assert!(!page.events.is_empty(), "{page:?}");
        assert!(page.next_cursor.is_some());
    }
}
