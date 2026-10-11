//! Solana `NetworkSource` over the public JSON-RPC: `getSignaturesForAddress` for the list
//! (newest first, `before` for paging), `getTransaction` with `jsonParsed` for each signature,
//! `getBalance` and `getTokenAccountsByOwner` for account info. Per-signature fetches run
//! concurrently (bounded) because each is one RPC call.
//!
//! An address's share of a transaction is its lamport delta (`postBalances − preBalances` at its
//! account index) and, for SPL tokens, the delta of its token balances by mint. The counterparty is
//! the account whose delta moved the other way by the most.

use std::collections::BTreeMap;

use async_trait::async_trait;
use futures::stream::{self, StreamExt};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use sq_adapters::{ChainFamily, ExternalRef, Network};
use sq_connectors::{AccountInfo, ConnectorError, NetworkSource, ObservedEvent, Page, TokenBalance, post_json};

const DEVNET: &str = "https://api.devnet.solana.com";
const MAINNET: &str = "https://api.mainnet-beta.solana.com";
/// Batches of `getTransaction` per HTTP call (JSON-RPC batch). The public RPC's free tier counts
/// every entry of the batch against a per-method limit of 10 per window and answers 429 with
/// `Retry-After: 10` beyond it, so a batch is never larger than that.
const BATCH: usize = 10;
const CONCURRENCY: usize = 2;
const MAX_LIMIT: u32 = 50;
/// On the public endpoints one fetch stays within one window: 10 signatures, one batch, no
/// 429 ladder. A keyed RPC (`SQ_SOLANA_RPC`) gets the full `limit`.
const PUBLIC_TXS_PER_FETCH: u32 = 10;
const TOKEN_PROGRAM: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

pub fn network(devnet: bool) -> Network {
    Network { family: ChainFamily::Solana, name: if devnet { "solana-devnet" } else { "solana" }.into(), chain_id: None }
}

/// Base58, 32 bytes.
pub fn validate(address: &str) -> Result<String, ConnectorError> {
    let trimmed = address.trim();
    let bytes = bs58::decode(trimmed).into_vec().map_err(|e| ConnectorError::InvalidAddress(format!("{trimmed:?}: {e}")))?;
    if bytes.len() != 32 {
        return Err(ConnectorError::InvalidAddress(format!("{trimmed:?}: expected 32 bytes, got {}", bytes.len())));
    }
    Ok(trimmed.to_owned())
}

pub struct SolanaSource {
    client: reqwest::Client,
    url: String,
    devnet: bool,
    /// The rate-limited public endpoint, not a keyed RPC of our own.
    public: bool,
}

impl SolanaSource {
    pub fn new(devnet: bool, rpc_url: Option<String>) -> Self {
        let url = rpc_url.filter(|u| !u.trim().is_empty()).unwrap_or_else(|| if devnet { DEVNET } else { MAINNET }.into());
        let public = url == DEVNET || url == MAINNET;
        Self { client: sq_connectors::http(), url, devnet, public }
    }

    pub fn from_env() -> Self {
        let devnet = std::env::var("SQ_SOLANA_NETWORK").map(|v| v != "mainnet").unwrap_or(true);
        Self::new(devnet, std::env::var("SQ_SOLANA_RPC").ok())
    }

    fn explorer(&self, sig: &str) -> String {
        format!("https://explorer.solana.com/tx/{sig}{}", if self.devnet { "?cluster=devnet" } else { "" })
    }

    async fn rpc<T: serde::de::DeserializeOwned>(&self, method: &str, params: serde_json::Value) -> Result<T, ConnectorError> {
        let body = serde_json::json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params });
        let text = post_json(&self.client, &network(self.devnet).name, &self.url, &body, &[]).await?;
        let resp: RpcEnvelope<T> = serde_json::from_str(&text).map_err(|e| ConnectorError::Parse(format!("{method}: {e}")))?;
        if let Some(err) = resp.error {
            return Err(ConnectorError::Upstream { network: network(self.devnet).name, status: 200, body: format!("{method}: {} ({})", err.message, err.code) });
        }
        resp.result.ok_or_else(|| ConnectorError::Parse(format!("{method}: empty result")))
    }

    pub async fn signatures(&self, address: &str, before: Option<&str>, limit: u32) -> Result<Vec<SignatureInfo>, ConnectorError> {
        let mut opts = serde_json::json!({ "limit": limit.clamp(1, MAX_LIMIT), "commitment": "confirmed" });
        if let Some(b) = before {
            opts["before"] = serde_json::Value::String(b.into());
        }
        self.rpc("getSignaturesForAddress", serde_json::json!([address, opts])).await
    }

    pub async fn transaction(&self, signature: &str) -> Result<Option<ParsedTransaction>, ConnectorError> {
        self.rpc("getTransaction", serde_json::json!([signature, { "encoding": "jsonParsed", "maxSupportedTransactionVersion": 0, "commitment": "confirmed" }])).await
    }

    /// One HTTP call, many `getTransaction`s. Missing or failed entries come back as `None`.
    pub async fn transactions(&self, signatures: &[String]) -> Result<Vec<Option<ParsedTransaction>>, ConnectorError> {
        let body: Vec<serde_json::Value> = signatures
            .iter()
            .enumerate()
            .map(|(i, s)| serde_json::json!({ "jsonrpc": "2.0", "id": i, "method": "getTransaction", "params": [s, { "encoding": "jsonParsed", "maxSupportedTransactionVersion": 0, "commitment": "confirmed" }] }))
            .collect();
        let text = post_json(&self.client, &network(self.devnet).name, &self.url, &serde_json::Value::Array(body), &[]).await?;
        let envelopes: Vec<RpcEnvelopeId<ParsedTransaction>> = serde_json::from_str(&text).map_err(|e| ConnectorError::Parse(format!("getTransaction batch: {e}")))?;
        let mut out: Vec<Option<ParsedTransaction>> = vec![None; signatures.len()];
        for env in envelopes {
            if let Some(slot) = out.get_mut(env.id) {
                *slot = env.result;
            }
        }
        Ok(out)
    }

    fn parse<T: DeserializeOwned>(text: &str, what: &str) -> Result<T, ConnectorError> {
        serde_json::from_str(text).map_err(|e| ConnectorError::Parse(format!("{what}: {e}")))
    }

    /// Pure: one parsed transaction → the events for `wallet` (one per asset that moved).
    pub fn extract(network: &Network, explorer: &str, wallet: &str, sig: &SignatureInfo, tx: &ParsedTransaction) -> Vec<ObservedEvent> {
        let keys: Vec<&str> = tx.transaction.message.account_keys.iter().map(|k| k.pubkey.as_str()).collect();
        let Some(idx) = keys.iter().position(|k| *k == wallet) else { return Vec::new() };
        let failed = tx.meta.err.is_some();
        let fee_paid = idx == 0;
        let mut out = Vec::new();

        // Native SOL: lamport delta, excluding the fee when this wallet paid it.
        let pre = tx.meta.pre_balances.get(idx).copied().unwrap_or(0) as i128;
        let post = tx.meta.post_balances.get(idx).copied().unwrap_or(0) as i128;
        let mut delta = post - pre;
        if fee_paid {
            delta += tx.meta.fee as i128;
        }
        if delta != 0 && !failed {
            // counterparty: the account whose lamports moved the other way by the most
            let mut best: Option<(&str, i128)> = None;
            for (i, k) in keys.iter().enumerate() {
                if i == idx {
                    continue;
                }
                let d = tx.meta.post_balances.get(i).copied().unwrap_or(0) as i128 - tx.meta.pre_balances.get(i).copied().unwrap_or(0) as i128;
                let opposite = (delta > 0 && d < 0) || (delta < 0 && d > 0);
                if opposite && best.is_none_or(|(_, b)| d.abs() > b.abs()) {
                    best = Some((k, d));
                }
            }
            let other = best.map(|(k, _)| k.to_owned()).unwrap_or_else(|| "unknown".into());
            let incoming = delta > 0;
            let (from_raw, to_raw) = if incoming { (other, wallet.to_owned()) } else { (wallet.to_owned(), other) };
            out.push(ObservedEvent {
                external: ExternalRef {
                    network: network.clone(),
                    tx_id: sig.signature.clone(),
                    block: Some(sig.slot),
                    from_raw,
                    to_raw,
                    asset_symbol: "SOL".into(),
                    decimals: 9,
                    amount: delta.unsigned_abs().to_string(),
                    fee: fee_paid.then_some(tx.meta.fee as f64 / 1e9),
                    explorer_url: Some(explorer.replace("{sig}", &sig.signature)),
                    timestamp: sig.block_time,
                    asset_address: None,
                },
                incoming,
                counterparty: None,
                counterparty_label: None,
                scam_flag: false,
            });
        }

        // SPL tokens: per-mint delta of this owner's token balances.
        let mut by_mint: BTreeMap<String, (i128, u8)> = BTreeMap::new();
        for (sign, list) in [(-1i128, &tx.meta.pre_token_balances), (1i128, &tx.meta.post_token_balances)] {
            for b in list.iter().filter(|b| b.owner.as_deref() == Some(wallet)) {
                let amt: i128 = b.ui_token_amount.amount.parse().unwrap_or(0);
                let e = by_mint.entry(b.mint.clone()).or_insert((0, b.ui_token_amount.decimals));
                e.0 += sign * amt;
            }
        }
        for (i, (mint, (d, decimals))) in by_mint.iter().enumerate() {
            if *d == 0 || failed {
                continue;
            }
            let incoming = *d > 0;
            // counterparty: another owner whose balance of this mint moved the other way
            let mut others: BTreeMap<String, i128> = BTreeMap::new();
            for (sign, list) in [(-1i128, &tx.meta.pre_token_balances), (1i128, &tx.meta.post_token_balances)] {
                for b in list.iter().filter(|b| &b.mint == mint && b.owner.as_deref() != Some(wallet)) {
                    if let Some(o) = &b.owner {
                        *others.entry(o.clone()).or_insert(0) += sign * b.ui_token_amount.amount.parse::<i128>().unwrap_or(0);
                    }
                }
            }
            let other = others.into_iter().filter(|(_, od)| (incoming && *od < 0) || (!incoming && *od > 0)).max_by_key(|(_, od)| od.abs()).map(|(o, _)| o).unwrap_or_else(|| "unknown".into());
            let (from_raw, to_raw) = if incoming { (other, wallet.to_owned()) } else { (wallet.to_owned(), other) };
            out.push(ObservedEvent {
                external: ExternalRef {
                    network: network.clone(),
                    tx_id: format!("{}#{i}", sig.signature),
                    block: Some(sig.slot),
                    from_raw,
                    to_raw,
                    asset_symbol: mint.chars().take(6).collect::<String>(),
                    decimals: *decimals,
                    amount: d.unsigned_abs().to_string(),
                    fee: None,
                    explorer_url: Some(explorer.replace("{sig}", &sig.signature)),
                    timestamp: sig.block_time,
                    asset_address: Some(mint.clone()),
                },
                incoming,
                counterparty: None,
                counterparty_label: None,
                scam_flag: false,
            });
        }
        out
    }
}

#[async_trait]
impl NetworkSource for SolanaSource {
    fn network(&self) -> Network {
        network(self.devnet)
    }

    fn canonical(&self, address_raw: &str) -> String {
        address_raw.trim().to_owned()
    }

    async fn fetch(&self, address_raw: &str, cursor: Option<&str>, limit: u32) -> Result<Page, ConnectorError> {
        let wallet = validate(address_raw)?;
        let limit = if self.public { limit.min(PUBLIC_TXS_PER_FETCH) } else { limit };
        let sigs = self.signatures(&wallet, cursor, limit).await?;
        let next_cursor = (sigs.len() as u32 >= limit.clamp(1, MAX_LIMIT)).then(|| sigs.last().map(|s| s.signature.clone())).flatten();
        let net = self.network();
        let explorer = self.explorer("{sig}");
        let chunks: Vec<Vec<SignatureInfo>> = sigs.chunks(BATCH).map(|c| c.to_vec()).collect();
        let fetched: Vec<Vec<ObservedEvent>> = stream::iter(chunks)
            .map(|chunk: Vec<SignatureInfo>| {
                let net = net.clone();
                let explorer = explorer.clone();
                let wallet = wallet.clone();
                async move {
                    let ids: Vec<String> = chunk.iter().map(|s| s.signature.clone()).collect();
                    match self.transactions(&ids).await {
                        Ok(txs) => chunk.iter().zip(txs).filter_map(|(sig, tx)| tx.map(|t| Self::extract(&net, &explorer, &wallet, sig, &t))).flatten().collect(),
                        Err(e) => {
                            tracing::debug!(error = %e, "getTransaction batch failed");
                            Vec::new()
                        }
                    }
                }
            })
            .buffered(if self.public { 1 } else { CONCURRENCY })
            .collect()
            .await;
        let _ = Self::parse::<serde_json::Value>; // keep the helper available for callers
        Ok(Page { events: fetched.into_iter().flatten().collect(), next_cursor })
    }

    async fn account_info(&self, address_raw: &str) -> Result<AccountInfo, ConnectorError> {
        let wallet = validate(address_raw)?;
        let bal: RpcValue<u64> = self.rpc("getBalance", serde_json::json!([&wallet, { "commitment": "confirmed" }])).await?;
        let toks: RpcValue<Vec<TokenAccount>> = self
            .rpc("getTokenAccountsByOwner", serde_json::json!([&wallet, { "programId": TOKEN_PROGRAM }, { "encoding": "jsonParsed", "commitment": "confirmed" }]))
            .await
            .unwrap_or(RpcValue { value: Vec::new() });
        let tokens = toks
            .value
            .iter()
            .map(|t| {
                let info = &t.account.data.parsed.info;
                TokenBalance {
                    symbol: info.mint.chars().take(6).collect(),
                    name: None,
                    address: info.mint.clone(),
                    decimals: info.token_amount.decimals,
                    amount: info.token_amount.amount.clone(),
                    usd_value: None,
                    verified: None,
                }
            })
            .collect();
        let recent = self.signatures(&wallet, None, 1).await.unwrap_or_default();
        Ok(AccountInfo {
            network: self.network(),
            address: wallet,
            native_symbol: "SOL".into(),
            native_decimals: 9,
            balance: Some(bal.value.to_string()),
            tokens,
            tx_count: None,
            first_seen: None,
            last_active: recent.first().and_then(|s| s.block_time),
            name: None,
            labels: vec![],
            is_contract: false,
            is_scam: false,
            is_active: !recent.is_empty(),
            extra: BTreeMap::new(),
        })
    }
}

// ----- wire types -----

#[derive(Debug, Deserialize)]
struct RpcEnvelope<T> {
    result: Option<T>,
    error: Option<RpcError>,
}

#[derive(Debug, Deserialize)]
struct RpcEnvelopeId<T> {
    #[serde(default)]
    id: usize,
    result: Option<T>,
}

#[derive(Debug, Deserialize)]
struct RpcError {
    code: i64,
    message: String,
}

#[derive(Debug, Deserialize)]
pub struct RpcValue<T> {
    pub value: T,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SignatureInfo {
    pub signature: String,
    pub slot: u64,
    #[serde(rename = "blockTime")]
    pub block_time: Option<u64>,
    pub err: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ParsedTransaction {
    pub meta: Meta,
    pub transaction: Tx,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Meta {
    pub err: Option<serde_json::Value>,
    #[serde(default)]
    pub fee: u64,
    #[serde(rename = "preBalances", default)]
    pub pre_balances: Vec<u64>,
    #[serde(rename = "postBalances", default)]
    pub post_balances: Vec<u64>,
    #[serde(rename = "preTokenBalances", default)]
    pub pre_token_balances: Vec<TokenBalanceEntry>,
    #[serde(rename = "postTokenBalances", default)]
    pub post_token_balances: Vec<TokenBalanceEntry>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TokenBalanceEntry {
    pub mint: String,
    pub owner: Option<String>,
    #[serde(rename = "uiTokenAmount")]
    pub ui_token_amount: UiTokenAmount,
}

#[derive(Debug, Clone, Deserialize)]
pub struct UiTokenAmount {
    pub amount: String,
    pub decimals: u8,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Tx {
    pub message: Message,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Message {
    #[serde(rename = "accountKeys", default)]
    pub account_keys: Vec<AccountKey>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AccountKey {
    pub pubkey: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TokenAccount {
    pub account: TokenAccountData,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TokenAccountData {
    pub data: TokenData,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TokenData {
    pub parsed: TokenParsed,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TokenParsed {
    pub info: TokenInfo,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TokenInfo {
    pub mint: String,
    #[serde(rename = "tokenAmount")]
    pub token_amount: UiTokenAmount,
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    const WALLET: &str = "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9";
    const OTHER: &str = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
    const TX: &str = r#"{"meta":{"err":null,"fee":5000,
      "preBalances":[1000000000,500000000,1],"postBalances":[899995000,600000000,1],
      "preTokenBalances":[{"accountIndex":3,"mint":"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v","owner":"5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9","uiTokenAmount":{"amount":"1000000","decimals":6}},
                          {"accountIndex":4,"mint":"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v","owner":"9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin","uiTokenAmount":{"amount":"0","decimals":6}}],
      "postTokenBalances":[{"accountIndex":3,"mint":"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v","owner":"5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9","uiTokenAmount":{"amount":"250000","decimals":6}},
                           {"accountIndex":4,"mint":"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v","owner":"9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin","uiTokenAmount":{"amount":"750000","decimals":6}}]},
      "transaction":{"message":{"accountKeys":[{"pubkey":"5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9"},{"pubkey":"9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"},{"pubkey":"11111111111111111111111111111111"}]}}}"#;

    #[test]
    fn validates_base58_pubkeys() {
        assert_eq!(validate(WALLET).unwrap(), WALLET);
        assert!(matches!(validate("nope"), Err(ConnectorError::InvalidAddress(_))));
        assert!(matches!(validate("0x1111111111111111111111111111111111111111"), Err(ConnectorError::InvalidAddress(_))));
    }

    #[test]
    fn extracts_sol_and_spl_deltas_with_counterparties() {
        let tx: ParsedTransaction = serde_json::from_str(TX).unwrap();
        let sig = SignatureInfo { signature: "sig1".into(), slot: 42, block_time: Some(1_700_000_000), err: None };
        let net = network(true);
        let ev = SolanaSource::extract(&net, "https://x/{sig}", WALLET, &sig, &tx);
        assert_eq!(ev.len(), 2, "{ev:?}");
        let sol = &ev[0];
        assert!(!sol.incoming);
        assert_eq!(sol.external.amount, "100000000", "0.1 SOL moved, fee excluded");
        assert_eq!(sol.external.to_raw, OTHER);
        assert!((sol.external.fee.unwrap() - 0.000005).abs() < 1e-12);
        assert_eq!(sol.external.block, Some(42));
        let usdc = &ev[1];
        assert!(!usdc.incoming);
        assert_eq!(usdc.external.amount, "750000");
        assert_eq!(usdc.external.decimals, 6);
        assert_eq!(usdc.external.to_raw, OTHER);
        assert_eq!(usdc.external.asset_address.as_deref(), Some("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"));
        // from the other side, the same transaction is incoming
        let ev2 = SolanaSource::extract(&net, "https://x/{sig}", OTHER, &sig, &tx);
        assert!(ev2.iter().all(|e| e.incoming));
        assert_eq!(ev2[0].external.from_raw, WALLET);
    }

    /// `SQ_LIVE=1 cargo test -p sq-conn-sol -- --ignored`: public mainnet RPC, no key.
    #[tokio::test]
    #[ignore]
    async fn live_mainnet_history() {
        if std::env::var("SQ_LIVE").is_err() {
            return;
        }
        let s = SolanaSource::new(false, None);
        let info = s.account_info(WALLET).await.unwrap();
        assert!(info.balance.is_some());
        let page = s.fetch(WALLET, None, 5).await.unwrap();
        assert!(!page.events.is_empty(), "{page:?}");
    }
}
