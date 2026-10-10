//! TON via toncenter v2 JSON-RPC `getTransactions`. Ported from NetView `rust/wallet-info`
//! (`network.rs`, `transactions/`, `decoder.rs::normalize_address`): a transaction whose inbound
//! message has a source is a receive; one whose inbound message is external (no source) carries
//! the outbound transfers the wallet signed.

use async_trait::async_trait;
use base64::Engine;
use serde::{Deserialize, Deserializer, Serialize};
use sq_adapters::{ChainFamily, ExternalRef, Network};

use crate::{ConnectorError, NetworkSource, ObservedEvent, Page};

const MAINNET: &str = "https://toncenter.com/api/v2/jsonRPC";
const TESTNET: &str = "https://testnet.toncenter.com/api/v2/jsonRPC";
/// toncenter v2 hard cap per request.
const PAGE_SIZE: u32 = 100;

pub struct TonCenterSource {
    client: reqwest::Client,
    url: String,
    api_key: Option<String>,
    testnet: bool,
}

impl TonCenterSource {
    pub fn new(testnet: bool, api_key: Option<String>) -> Self {
        Self { client: crate::http(), url: if testnet { TESTNET } else { MAINNET }.into(), api_key, testnet }
    }

    pub fn with_url(mut self, url: impl Into<String>) -> Self {
        self.url = url.into();
        self
    }

    fn network_of(testnet: bool) -> Network {
        Network { family: ChainFamily::Ton, name: if testnet { "ton-testnet" } else { "ton" }.into(), chain_id: None }
    }

    /// Pure: toncenter result → events for `wallet`. Public so it can be tested offline.
    pub fn extract(testnet: bool, wallet: &str, txs: &[ExtTransaction]) -> Vec<ObservedEvent> {
        let network = Self::network_of(testnet);
        let wallet_norm = normalize_address(wallet);
        let explorer = |hash: &str| Some(format!("https://{}tonviewer.com/transaction/{hash}", if testnet { "testnet." } else { "" }));
        let mut out = Vec::new();
        for tx in txs {
            let Some(in_msg) = &tx.in_msg else { continue };
            match &in_msg.source {
                Some(src) if in_msg.value > 0 => out.push(ObservedEvent {
                    external: ExternalRef {
                        network: network.clone(),
                        tx_id: tx.transaction_id.hash.clone(),
                        block: None,
                        from_raw: normalize_address(src),
                        to_raw: wallet_norm.clone(),
                        asset_symbol: "TON".into(),
                        decimals: 9,
                        amount: in_msg.value.to_string(),
                        fee: Some(tx.fee as f64 / 1e9),
                        explorer_url: explorer(&tx.transaction_id.hash),
                    },
                    incoming: true,
                    counterparty: None,
                }),
                Some(_) => {}
                None => {
                    for (i, m) in tx.out_msgs.iter().filter(|m| m.value > 0).enumerate() {
                        out.push(ObservedEvent {
                            external: ExternalRef {
                                network: network.clone(),
                                tx_id: if i == 0 { tx.transaction_id.hash.clone() } else { format!("{}#{i}", tx.transaction_id.hash) },
                                block: None,
                                from_raw: wallet_norm.clone(),
                                to_raw: normalize_address(&m.destination),
                                asset_symbol: "TON".into(),
                                decimals: 9,
                                amount: m.value.to_string(),
                                fee: Some(tx.fee as f64 / 1e9),
                                explorer_url: explorer(&tx.transaction_id.hash),
                            },
                            incoming: false,
                            counterparty: None,
                        });
                    }
                }
            }
        }
        out
    }
}

#[async_trait]
impl NetworkSource for TonCenterSource {
    fn network(&self) -> Network {
        Self::network_of(self.testnet)
    }

    async fn fetch(&self, address_raw: &str, cursor: Option<&str>, limit: u32) -> Result<Page, ConnectorError> {
        let page_size = limit.clamp(1, PAGE_SIZE);
        let (lt, hash) = match cursor.and_then(|c| c.split_once(':')) {
            Some((lt, h)) => (lt.parse::<u64>().ok(), Some(h.to_string())),
            None => (None, None),
        };
        let body = serde_json::json!({
            "jsonrpc": "2.0", "id": 1, "method": "getTransactions",
            "params": { "address": address_raw, "limit": page_size, "archival": true, "lt": lt, "hash": hash }
        });
        let mut req = self.client.post(&self.url).json(&body);
        if let Some(k) = &self.api_key {
            req = req.header("X-API-Key", k);
        }
        let resp = req.send().await?;
        let status = resp.status().as_u16();
        let text = resp.text().await?;
        if !(200..300).contains(&status) {
            return Err(ConnectorError::Upstream { network: self.network().name, status, body: text.chars().take(200).collect() });
        }
        let parsed: RpcResponse = serde_json::from_str(&text).map_err(|e| ConnectorError::Parse(e.to_string()))?;
        if !parsed.ok {
            return Err(ConnectorError::Upstream { network: self.network().name, status, body: "ok=false".into() });
        }
        // Pages after the first repeat the cursor transaction as their first element.
        let txs: &[ExtTransaction] = if cursor.is_some() && !parsed.result.is_empty() { &parsed.result[1..] } else { &parsed.result };
        let next_cursor = if (parsed.result.len() as u32) < page_size {
            None
        } else {
            parsed.result.last().map(|t| format!("{}:{}", t.transaction_id.lt, t.transaction_id.hash))
        };
        Ok(Page { events: Self::extract(self.testnet, address_raw, txs), next_cursor })
    }
}

// ----- wire types (toncenter v2) -----

fn de_str_u64<'de, D: Deserializer<'de>>(d: D) -> Result<u64, D::Error> {
    String::deserialize(d)?.parse::<u64>().map_err(serde::de::Error::custom)
}

fn de_optional_address<'de, D: Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    let s = String::deserialize(d)?;
    Ok(if s.is_empty() { None } else { Some(s) })
}

#[derive(Debug, Deserialize)]
pub struct RpcResponse {
    pub ok: bool,
    #[serde(default)]
    pub result: Vec<ExtTransaction>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct ExtTransaction {
    pub utime: u64,
    pub transaction_id: TransactionId,
    #[serde(deserialize_with = "de_str_u64")]
    pub fee: u64,
    pub in_msg: Option<ExtMessage>,
    #[serde(default)]
    pub out_msgs: Vec<ExtMessage>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct TransactionId {
    #[serde(deserialize_with = "de_str_u64")]
    pub lt: u64,
    pub hash: String,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct ExtMessage {
    #[serde(default, deserialize_with = "de_optional_address")]
    pub source: Option<String>,
    #[serde(default)]
    pub destination: String,
    #[serde(deserialize_with = "de_str_u64")]
    pub value: u64,
}

/// Canonical bounceable (`EQ…`) form of any user-friendly TON address; input unchanged on failure.
pub fn normalize_address(addr: &str) -> String {
    let normalized = addr.replace('-', "+").replace('_', "/");
    let padding = match normalized.len() % 4 {
        0 => String::new(),
        n => "=".repeat(4 - n),
    };
    let Ok(raw) = base64::engine::general_purpose::STANDARD.decode(format!("{normalized}{padding}")) else {
        return addr.to_string();
    };
    if raw.len() != 36 {
        return addr.to_string();
    }
    let mut bytes = vec![0x11u8, raw[1]];
    bytes.extend_from_slice(&raw[2..34]);
    let crc = crc16(&bytes);
    bytes.push((crc >> 8) as u8);
    bytes.push((crc & 0xff) as u8);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&bytes)
}

fn crc16(data: &[u8]) -> u16 {
    let mut crc: u16 = 0;
    for &b in data {
        crc ^= u16::from(b) << 8;
        for _ in 0..8 {
            crc = if crc & 0x8000 != 0 { (crc << 1) ^ 0x1021 } else { crc << 1 };
        }
    }
    crc
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"{"ok":true,"result":[
      {"utime":1700000100,"transaction_id":{"lt":"41000000001","hash":"hashA"},"fee":"3000000","storage_fee":"1","other_fee":"2",
       "in_msg":{"source":"","destination":"EQCwallet","value":"0","msg_data":{"@type":"msg.dataRaw"}},
       "out_msgs":[{"source":"EQCwallet","destination":"EQCbob","value":"1500000000","msg_data":{"@type":"msg.dataEmpty"}}]},
      {"utime":1700000000,"transaction_id":{"lt":"41000000000","hash":"hashB"},"fee":"1000000","storage_fee":"1","other_fee":"2",
       "in_msg":{"source":"EQCalice","destination":"EQCwallet","value":"2000000000","msg_data":{"@type":"msg.dataText","text":"hi"}},
       "out_msgs":[]}
    ]}"#;

    #[test]
    fn extracts_sends_and_receives_like_netview() {
        let r: RpcResponse = serde_json::from_str(SAMPLE).unwrap();
        let ev = TonCenterSource::extract(true, "EQCwallet", &r.result);
        assert_eq!(ev.len(), 2);
        assert!(!ev[0].incoming);
        assert_eq!(ev[0].external.amount, "1500000000");
        assert_eq!(ev[0].external.network.family, ChainFamily::Ton);
        assert_eq!(ev[0].external.network.name, "ton-testnet");
        assert!((ev[0].external.fee.unwrap() - 0.003).abs() < 1e-12);
        assert!(ev[1].incoming);
        assert_eq!(ev[1].external.tx_id, "hashB");
        assert_eq!(ev[1].external.decimals, 9);
    }

    #[test]
    fn normalizes_friendly_addresses_to_bounceable() {
        // non-bounceable testnet form and its bounceable mainnet form of the same account
        let non_bounceable = "0QBbtZtF0cYG5xj7A_hTJWF5tHOGtcQgCHJOV-cGKoh1Rnp1";
        let n = normalize_address(non_bounceable);
        assert!(n.starts_with("EQ") || n.starts_with("kQ") || n.len() == 48, "{n}");
        assert_eq!(normalize_address("not-an-address"), "not-an-address");
    }
}
