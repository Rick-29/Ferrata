//! Bitcoin via an Esplora-compatible API (mempool.space, blockstream.info).
//! `GET /address/{addr}/txs` (newest 25, unconfirmed first), `GET /address/{addr}/txs/chain/{last_txid}` to page.
//! An address's share of a transaction is `sum(vout to addr) - sum(vin from addr)`.

use async_trait::async_trait;
use serde::Deserialize;
use sq_adapters::{ChainFamily, ExternalRef, Network};

use crate::{ConnectorError, NetworkSource, ObservedEvent, Page};

pub struct EsploraSource {
    client: reqwest::Client,
    base: String,
    testnet: bool,
}

impl EsploraSource {
    pub fn new(testnet: bool) -> Self {
        let base = if testnet { "https://mempool.space/testnet/api" } else { "https://mempool.space/api" };
        Self { client: crate::http(), base: base.into(), testnet }
    }

    pub fn with_base(mut self, base: impl Into<String>) -> Self {
        self.base = base.into();
        self
    }

    fn network_of(testnet: bool) -> Network {
        Network { family: ChainFamily::Bitcoin, name: if testnet { "bitcoin-testnet" } else { "bitcoin" }.into(), chain_id: None }
    }

    /// Pure: Esplora transactions → events for `wallet`.
    pub fn extract(testnet: bool, wallet: &str, txs: &[EsploraTx]) -> Vec<ObservedEvent> {
        let network = Self::network_of(testnet);
        let mut out = Vec::new();
        for tx in txs {
            let received: u64 = tx.vout.iter().filter(|o| o.scriptpubkey_address.as_deref() == Some(wallet)).map(|o| o.value).sum();
            let spent: u64 = tx.vin.iter().filter_map(|i| i.prevout.as_ref()).filter(|p| p.scriptpubkey_address.as_deref() == Some(wallet)).map(|p| p.value).sum();
            if received == spent {
                continue;
            }
            let incoming = received > spent;
            let amount = received.abs_diff(spent);
            let other = if incoming {
                tx.vin.iter().filter_map(|i| i.prevout.as_ref()).filter_map(|p| p.scriptpubkey_address.clone()).find(|a| a != wallet)
            } else {
                tx.vout.iter().filter_map(|o| o.scriptpubkey_address.clone()).find(|a| a != wallet)
            }
            .unwrap_or_else(|| "unknown".into());
            let (from_raw, to_raw) = if incoming { (other, wallet.to_string()) } else { (wallet.to_string(), other) };
            out.push(ObservedEvent {
                external: ExternalRef {
                    network: network.clone(),
                    tx_id: tx.txid.clone(),
                    block: tx.status.block_height,
                    from_raw,
                    to_raw,
                    asset_symbol: "BTC".into(),
                    decimals: 8,
                    amount: amount.to_string(),
                    fee: Some(tx.fee as f64 / 1e8),
                    explorer_url: Some(format!("https://mempool.space/{}tx/{}", if testnet { "testnet/" } else { "" }, tx.txid)),
                },
                incoming,
                counterparty: None,
            });
        }
        out
    }
}

#[async_trait]
impl NetworkSource for EsploraSource {
    fn network(&self) -> Network {
        Self::network_of(self.testnet)
    }

    async fn fetch(&self, address_raw: &str, cursor: Option<&str>, _limit: u32) -> Result<Page, ConnectorError> {
        let url = match cursor {
            Some(last) => format!("{}/address/{address_raw}/txs/chain/{last}", self.base),
            None => format!("{}/address/{address_raw}/txs", self.base),
        };
        let resp = self.client.get(&url).send().await?;
        let status = resp.status().as_u16();
        let text = resp.text().await?;
        if !(200..300).contains(&status) {
            return Err(ConnectorError::Upstream { network: self.network().name, status, body: text.chars().take(200).collect() });
        }
        let txs: Vec<EsploraTx> = serde_json::from_str(&text).map_err(|e| ConnectorError::Parse(e.to_string()))?;
        let next_cursor = if txs.len() >= 25 { txs.last().map(|t| t.txid.clone()) } else { None };
        Ok(Page { events: Self::extract(self.testnet, address_raw, &txs), next_cursor })
    }
}

#[derive(Debug, Deserialize)]
pub struct EsploraTx {
    pub txid: String,
    #[serde(default)]
    pub fee: u64,
    pub vin: Vec<Vin>,
    pub vout: Vec<Vout>,
    pub status: Status,
}

#[derive(Debug, Deserialize)]
pub struct Vin {
    pub prevout: Option<Vout>,
}

#[derive(Debug, Deserialize)]
pub struct Vout {
    pub scriptpubkey_address: Option<String>,
    pub value: u64,
}

#[derive(Debug, Deserialize)]
pub struct Status {
    pub confirmed: bool,
    pub block_height: Option<u64>,
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"[
      {"txid":"t1","fee":300,"status":{"confirmed":true,"block_height":10},
       "vin":[{"prevout":{"scriptpubkey_address":"tb1qalice","value":100000}}],
       "vout":[{"scriptpubkey_address":"tb1qwallet","value":60000},{"scriptpubkey_address":"tb1qalice","value":39700}]},
      {"txid":"t2","fee":200,"status":{"confirmed":true,"block_height":11},
       "vin":[{"prevout":{"scriptpubkey_address":"tb1qwallet","value":60000}}],
       "vout":[{"scriptpubkey_address":"tb1qbob","value":25000},{"scriptpubkey_address":"tb1qwallet","value":34800}]}
    ]"#;

    #[test]
    fn nets_inputs_and_outputs_per_address() {
        let txs: Vec<EsploraTx> = serde_json::from_str(SAMPLE).unwrap();
        let ev = EsploraSource::extract(true, "tb1qwallet", &txs);
        assert_eq!(ev.len(), 2);
        assert!(ev[0].incoming);
        assert_eq!(ev[0].external.amount, "60000");
        assert_eq!(ev[0].external.from_raw, "tb1qalice");
        assert!(!ev[1].incoming);
        assert_eq!(ev[1].external.amount, "25200", "spent minus change");
        assert_eq!(ev[1].external.to_raw, "tb1qbob");
        assert_eq!(ev[1].external.block, Some(11));
    }
}
