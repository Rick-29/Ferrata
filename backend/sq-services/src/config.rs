use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use alloy_primitives::U256;
use anyhow::Context;
use serde::Deserialize;
use sq_adapters::TokenInfo;
use wallet_core::PolicyConfig;

#[derive(Debug, Clone, Deserialize)]
pub struct Client {
    pub username: String,
    pub password: String,
    pub client_id: String,
    pub display_name: String,
}

#[derive(Debug, Clone, Deserialize)]
struct AccountsFile {
    clients: Vec<Client>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct KycScript {
    pub id: String,
    pub outcome: String,
    pub label: String,
}

#[derive(Debug, Clone, Deserialize)]
struct KycFile {
    scripts: Vec<KycScript>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DemoSeed {
    pub chain_id: u64,
    pub tokens: Vec<TokenInfo>,
    pub escape_delay_secs: u64,
    pub recovery_delay_secs: u64,
    pub hold_ttl_secs: u64,
    #[serde(default)]
    pub faucet: BTreeMap<String, U256>,
}

#[derive(Debug, Clone)]
pub struct Config {
    pub port: u16,
    pub fixtures_dir: PathBuf,
    pub snapshot_path: Option<PathBuf>,
    /// 32-byte Ed25519 seed for Swissquote's receipt and co-signing key; random if unset.
    pub signing_seed: Option<[u8; 32]>,
    pub dev_signer: bool,
    pub policy: PolicyConfig,
    pub seed: DemoSeed,
    pub clients: Vec<Client>,
    pub kyc_scripts: Vec<KycScript>,
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let fixtures_dir = std::env::var("SQ_FIXTURES_DIR").map(PathBuf::from).unwrap_or_else(|_| default_fixtures_dir());
        let port = std::env::var("SQ_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(8787);
        let snapshot_path = std::env::var("SQ_LOG_SNAPSHOT").ok().map(PathBuf::from);
        let signing_seed = match std::env::var("SQ_SIGNING_SEED") {
            Ok(h) => Some(parse_seed(&h).context("SQ_SIGNING_SEED")?),
            Err(_) => None,
        };
        let dev_signer = std::env::var("SQ_DEV_SIGNER").map(|v| v != "0").unwrap_or(true);
        Self::load(fixtures_dir, port, snapshot_path, signing_seed, dev_signer)
    }

    pub fn load(fixtures_dir: PathBuf, port: u16, snapshot_path: Option<PathBuf>, signing_seed: Option<[u8; 32]>, dev_signer: bool) -> anyhow::Result<Self> {
        let policy: PolicyConfig = read_json(&fixtures_dir.join("policy.json"))?;
        policy.validate().map_err(|e| anyhow::anyhow!("policy.json: {e}"))?;
        let seed: DemoSeed = read_json(&fixtures_dir.join("demo-seed.json"))?;
        let accounts: AccountsFile = read_json(&fixtures_dir.join("accounts.json"))?;
        let kyc: KycFile = read_json(&fixtures_dir.join("kyc-scripts.json"))?;
        Ok(Self {
            port,
            fixtures_dir,
            snapshot_path,
            signing_seed,
            dev_signer,
            policy,
            seed,
            clients: accounts.clients,
            kyc_scripts: kyc.scripts,
        })
    }
}

fn default_fixtures_dir() -> PathBuf {
    // backend/sq-services -> repo root / fixtures
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures")
}

fn parse_seed(hex_str: &str) -> anyhow::Result<[u8; 32]> {
    let bytes = hex::decode(hex_str.trim_start_matches("0x")).context("not hex")?;
    bytes.try_into().map_err(|_| anyhow::anyhow!("seed must be 32 bytes"))
}

fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> anyhow::Result<T> {
    let bytes = std::fs::read(path).with_context(|| format!("reading {}", path.display()))?;
    serde_json::from_slice(&bytes).with_context(|| format!("parsing {}", path.display()))
}
