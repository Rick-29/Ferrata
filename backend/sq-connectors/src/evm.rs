//! EVM chains via a Blockscout-compatible explorer API (Base Sepolia, Ethereum Sepolia, …):
//! `?module=account&action=txlist` for native transfers and `action=tokentx` for ERC-20 moves.
//! Counterparties are real 20-byte addresses, so the Ferra chain can link them to its own accounts.

use alloy_primitives::Address;
use async_trait::async_trait;
use serde::Deserialize;
use sq_adapters::{ChainFamily, ExternalRef, Network};

use crate::{ConnectorError, NetworkSource, ObservedEvent, Page};

pub struct BlockscoutSource {
    client: reqwest::Client,
    base: String,
    network: Network,
    explorer: String,
}

impl BlockscoutSource {
    /// `base` like `https://base-sepolia.blockscout.com/api`.
    pub fn new(name: &str, chain_id: u64, base: impl Into<String>) -> Self {
        let base = base.into();
        let explorer = base.trim_end_matches("/api").to_string();
        Self { client: crate::http(), base, network: Network { family: ChainFamily::Evm, name: name.into(), chain_id: Some(chain_id) }, explorer }
    }

    pub fn base_sepolia() -> Self {
        Self::new("base-sepolia", 84532, "https://base-sepolia.blockscout.com/api")
    }

    /// Pure: explorer rows → events for `wallet`.
    pub fn extract(network: &Network, explorer: &str, wallet: &str, rows: &[TxRow]) -> Vec<ObservedEvent> {
        let w = wallet.to_lowercase();
        rows.iter()
            .filter(|r| r.value != "0" && (r.from.eq_ignore_ascii_case(&w) || r.to.eq_ignore_ascii_case(&w)))
            .map(|r| {
                let incoming = r.to.eq_ignore_ascii_case(&w);
                let other = if incoming { &r.from } else { &r.to };
                let is_token = r.token_symbol.is_some();
                let fee = match (r.gas_used.as_deref().and_then(|g| g.parse::<f64>().ok()), r.gas_price.as_deref().and_then(|g| g.parse::<f64>().ok())) {
                    (Some(g), Some(p)) => Some(g * p / 1e18),
                    _ => None,
                };
                ObservedEvent {
                    external: ExternalRef {
                        network: network.clone(),
                        tx_id: if is_token { format!("{}#{}", r.hash, r.log_index.clone().unwrap_or_default()) } else { r.hash.clone() },
                        block: r.block_number.parse().ok(),
                        from_raw: r.from.clone(),
                        to_raw: r.to.clone(),
                        asset_symbol: r.token_symbol.clone().unwrap_or_else(|| "ETH".into()),
                        decimals: r.token_decimal.as_deref().and_then(|d| d.parse().ok()).unwrap_or(18),
                        amount: r.value.clone(),
                        fee,
                        explorer_url: Some(format!("{explorer}/tx/{}", r.hash)),
                    },
                    incoming,
                    counterparty: other.parse::<Address>().ok(),
                }
            })
            .collect()
    }

    async fn get(&self, action: &str, address: &str, page: u32) -> Result<Vec<TxRow>, ConnectorError> {
        let url = format!("{}?module=account&action={action}&address={address}&sort=desc&page={page}&offset=50", self.base);
        let resp = self.client.get(&url).send().await?;
        let status = resp.status().as_u16();
        let text = resp.text().await?;
        if !(200..300).contains(&status) {
            return Err(ConnectorError::Upstream { network: self.network.name.clone(), status, body: text.chars().take(200).collect() });
        }
        let parsed: ApiResponse = serde_json::from_str(&text).map_err(|e| ConnectorError::Parse(e.to_string()))?;
        Ok(parsed.result.unwrap_or_default())
    }
}

#[async_trait]
impl NetworkSource for BlockscoutSource {
    fn network(&self) -> Network {
        self.network.clone()
    }

    async fn fetch(&self, address_raw: &str, cursor: Option<&str>, _limit: u32) -> Result<Page, ConnectorError> {
        let page: u32 = cursor.and_then(|c| c.parse().ok()).unwrap_or(1);
        let mut rows = self.get("txlist", address_raw, page).await?;
        rows.extend(self.get("tokentx", address_raw, page).await?);
        rows.sort_by(|a, b| b.block_number.len().cmp(&a.block_number.len()).then(b.block_number.cmp(&a.block_number)));
        let next_cursor = if rows.len() >= 50 { Some((page + 1).to_string()) } else { None };
        Ok(Page { events: Self::extract(&self.network, &self.explorer, address_raw, &rows), next_cursor })
    }
}

#[derive(Debug, Deserialize)]
struct ApiResponse {
    #[serde(default, deserialize_with = "rows_or_message")]
    result: Option<Vec<TxRow>>,
}

/// Blockscout returns a string in `result` when there is nothing ("No transactions found").
fn rows_or_message<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Vec<TxRow>>, D::Error> {
    let v: serde_json::Value = serde::Deserialize::deserialize(d)?;
    Ok(match v {
        serde_json::Value::Array(_) => serde_json::from_value(v).ok(),
        _ => None,
    })
}

#[derive(Debug, Clone, Deserialize)]
pub struct TxRow {
    pub hash: String,
    #[serde(rename = "blockNumber")]
    pub block_number: String,
    pub from: String,
    #[serde(default)]
    pub to: String,
    pub value: String,
    #[serde(rename = "gasUsed")]
    pub gas_used: Option<String>,
    #[serde(rename = "gasPrice")]
    pub gas_price: Option<String>,
    #[serde(rename = "tokenSymbol")]
    pub token_symbol: Option<String>,
    #[serde(rename = "tokenDecimal")]
    pub token_decimal: Option<String>,
    #[serde(rename = "logIndex")]
    pub log_index: Option<String>,
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"[
      {"hash":"0xh1","blockNumber":"100","from":"0x00000000000000000000000000000000000000aa","to":"0x1111111111111111111111111111111111111111","value":"1000000000000000","gasUsed":"21000","gasPrice":"1000000000"},
      {"hash":"0xh2","blockNumber":"101","from":"0x1111111111111111111111111111111111111111","to":"0x2222222222222222222222222222222222222222","value":"5000000","tokenSymbol":"USDC","tokenDecimal":"6","logIndex":"3"},
      {"hash":"0xh3","blockNumber":"102","from":"0x1111111111111111111111111111111111111111","to":"0x3333333333333333333333333333333333333333","value":"0"}
    ]"#;

    #[test]
    fn maps_native_and_token_rows_with_real_counterparties() {
        let rows: Vec<TxRow> = serde_json::from_str(SAMPLE).unwrap();
        let net = Network { family: ChainFamily::Evm, name: "base-sepolia".into(), chain_id: Some(84532) };
        let ev = BlockscoutSource::extract(&net, "https://x", "0x1111111111111111111111111111111111111111", &rows);
        assert_eq!(ev.len(), 2, "zero-value call skipped");
        assert!(ev[0].incoming);
        assert_eq!(ev[0].external.asset_symbol, "ETH");
        assert!((ev[0].external.fee.unwrap() - 0.000021).abs() < 1e-12);
        assert_eq!(ev[0].counterparty, Some(Address::with_last_byte(0xaa)));
        assert!(!ev[1].incoming);
        assert_eq!(ev[1].external.asset_symbol, "USDC");
        assert_eq!(ev[1].external.decimals, 6);
        assert_eq!(ev[1].external.tx_id, "0xh2#3");
    }
}
