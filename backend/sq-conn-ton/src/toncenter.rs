//! TON via toncenter v2 JSON-RPC `getTransactions`. Ported from NetView `rust/wallet-info`
//! (`network.rs`, `transactions/`, `decoder.rs::normalize_address`): a transaction whose inbound
//! message has a source is a receive; one whose inbound message is external (no source) carries
//! the outbound transfers the wallet signed.

use async_trait::async_trait;
use serde::{Deserialize, Deserializer, Serialize};
use sq_adapters::{ExternalRef, Network};
use sq_connectors::{ConnectorError, NetworkSource, ObservedEvent, Page, post_json};

use crate::address::{normalize, to_raw};

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
        Self { client: sq_connectors::http(), url: if testnet { TESTNET } else { MAINNET }.into(), api_key, testnet }
    }

    pub fn with_url(mut self, url: impl Into<String>) -> Self {
        self.url = url.into();
        self
    }

    fn network_of(testnet: bool) -> Network {
        crate::network(testnet)
    }

    /// Pure: toncenter result → events for `wallet`. Public so it can be tested offline.
    pub fn extract(testnet: bool, wallet: &str, txs: &[ExtTransaction]) -> Vec<ObservedEvent> {
        let network = Self::network_of(testnet);
        let wallet_norm = to_raw(wallet).unwrap_or_else(|| normalize(wallet));
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
                        from_raw: to_raw(src).unwrap_or_else(|| normalize(src)),
                        to_raw: wallet_norm.clone(),
                        asset_symbol: "TON".into(),
                        decimals: 9,
                        amount: in_msg.value.to_string(),
                        fee: Some(tx.fee as f64 / 1e9),
                        explorer_url: explorer(&tx.transaction_id.hash),
                        timestamp: Some(tx.utime),
                        asset_address: None,
                    },
                    incoming: true,
                    counterparty: None,
                    counterparty_label: None,
                    scam_flag: false,
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
                                to_raw: to_raw(&m.destination).unwrap_or_else(|| normalize(&m.destination)),
                                asset_symbol: "TON".into(),
                                decimals: 9,
                                amount: m.value.to_string(),
                                fee: Some(tx.fee as f64 / 1e9),
                                explorer_url: explorer(&tx.transaction_id.hash),
                                timestamp: Some(tx.utime),
                                asset_address: None,
                            },
                            incoming: false,
                            counterparty: None,
                            counterparty_label: None,
                            scam_flag: false,
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

    fn canonical(&self, address_raw: &str) -> String {
        to_raw(address_raw).unwrap_or_else(|| address_raw.to_string())
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
        let headers: Vec<(&str, String)> = self.api_key.iter().map(|k| ("X-API-Key", k.clone())).collect();
        let text = post_json(&self.client, &self.network().name, &self.url, &body, &headers).await?;
        let parsed: RpcResponse = serde_json::from_str(&text).map_err(|e| ConnectorError::Parse(e.to_string()))?;
        if !parsed.ok {
            return Err(ConnectorError::Upstream { network: self.network().name, status: 200, body: "ok=false".into() });
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
        assert_eq!(ev[0].external.network.family, sq_adapters::ChainFamily::Ton);
        assert_eq!(ev[0].external.network.name, "ton-testnet");
        assert!((ev[0].external.fee.unwrap() - 0.003).abs() < 1e-12);
        assert!(ev[1].incoming);
        assert_eq!(ev[1].external.tx_id, "hashB");
        assert_eq!(ev[1].external.decimals, 9);
    }

}
