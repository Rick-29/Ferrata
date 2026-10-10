use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use alloy_primitives::{Address, B256, keccak256};
use api_types::{PolicySnapshot, SubmitMeta};
use api_types::{HoldState, RecoveryState, Session};
use ed25519_dalek::SigningKey;
use sq_adapters::chain::ChainGuard;
use sq_adapters::{
    BlockStore, ChainBackend, ChainConfig, ChainError, ChainRegistry, Clock, Ed25519Signer, FixtureSignalProvider,
    InMemoryLogStore, JsonlBlockStore, LinearModel, LogStore, MockChain, Network, NullBlockStore, ReceiptSigner, RiskModel,
    SignalProvider, SystemClock,
};
use wallet_core::{AbiTxDecoder, RiskScorer, RuleBasedScorer, TxDecoder};

use sq_connectors::SourceRegistry;

use crate::auth::Caller;
use crate::config::Config;
use crate::dev::DevKeyring;
use crate::error::ServiceError;

pub type SharedState = Arc<AppState>;

pub struct AppState {
    pub config: Config,
    /// Every settlement layer the wallet spans. Services never name a concrete chain type.
    pub chains: ChainRegistry,
    pub signer: Arc<dyn ReceiptSigner>,
    pub scorer: Arc<dyn RiskScorer>,
    pub decoder: Arc<dyn TxDecoder>,
    pub signals: Arc<dyn SignalProvider>,
    pub log: Arc<dyn LogStore>,
    pub clock: Arc<dyn Clock>,
    pub sessions: Mutex<HashMap<String, Session>>,
    pub challenges: Mutex<HashMap<B256, u64>>,
    pub holds: Mutex<HashMap<String, HoldState>>,
    pub recoveries: Mutex<HashMap<String, RecoveryState>>,
    /// Which Swissquote client registered each wallet address. A session may only act on its own.
    pub owners: Mutex<HashMap<Address, String>>,
    /// When each user-op hash was prepared, so the chain can record decision latency.
    pub prepared: Mutex<HashMap<B256, u64>>,
    /// The validator's risk model (`fixtures/model.json`).
    pub model: Arc<dyn RiskModel>,
    /// Connected networks the Ferra chain can pull history from.
    pub sources: SourceRegistry,
    pub dev_keys: DevKeyring,
    validator_seed: [u8; 32],
}

impl AppState {
    pub fn build(config: Config) -> anyhow::Result<SharedState> {
        Self::build_with_clock(config, Arc::new(SystemClock))
    }

    pub fn build_with_clock(config: Config, clock: Arc<dyn Clock>) -> anyhow::Result<SharedState> {
        let sources = Self::sources_from_env();
        Self::build_with(config, clock, sources)
    }

    /// Public testnet indexers; no keys needed. `SQ_TONCENTER_API_KEY` raises TON rate limits.
    fn sources_from_env() -> SourceRegistry {
        let ton_key = std::env::var("SQ_TONCENTER_API_KEY").ok();
        let ton_testnet = std::env::var("SQ_TON_NETWORK").map(|v| v != "mainnet").unwrap_or(true);
        SourceRegistry::new()
            .register(Box::new(sq_connectors::ton::TonCenterSource::new(ton_testnet, ton_key)))
            .register(Box::new(sq_connectors::bitcoin::EsploraSource::new(true)))
            .register(Box::new(sq_connectors::evm::BlockscoutSource::base_sepolia()))
    }

    pub fn build_with(config: Config, clock: Arc<dyn Clock>, sources: SourceRegistry) -> anyhow::Result<SharedState> {
        let signer = match config.signing_seed {
            Some(seed) => Ed25519Signer::from_seed(seed),
            None => Ed25519Signer::random(),
        };
        let validator_seed = match (config.validator_seed, config.signing_seed) {
            (Some(v), _) => v,
            (None, Some(s)) => keccak256([s.as_slice(), b"validator"].concat()).0,
            (None, None) => {
                let mut seed = [0u8; 32];
                rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut seed);
                seed
            }
        };
        tracing::info!(
            swissquote_public_key = %hex::encode(signer.verifying_key().as_bytes()),
            validator_public_key = %hex::encode(SigningKey::from_bytes(&validator_seed).verifying_key().as_bytes()),
            dev_signer = config.dev_signer,
            require_auth = config.require_auth,
            chain_file = ?config.chain_file,
            "Swissquote signing identity ready"
        );
        if config.dev_signer {
            tracing::warn!("SQ_DEV_SIGNER enabled: /dev/passkeys issues mock passkeys held in server memory. Demo only.");
        }

        // Adding a chain: build its backend here and `.register(...)` it. Nothing else changes.
        let mock = Self::make_mock_chain(&config, &signer, validator_seed, clock.now())?;
        let chains = ChainRegistry::new(config.seed.chain_id).register(mock);

        let signals = FixtureSignalProvider::load(&config.fixtures_dir, config.policy.max_exposure_hops)
            .map_err(|e| anyhow::anyhow!("loading signal fixtures: {e}"))?;

        let model = LinearModel::load(&config.fixtures_dir.join("model.json")).map_err(|e| anyhow::anyhow!("loading model: {e}"))?;
        tracing::info!(model = model.name, features = model.weights.len(), "risk model loaded");

        let log: Arc<dyn LogStore> = match &config.snapshot_path {
            Some(p) => Arc::new(InMemoryLogStore::with_snapshot(p.clone()).map_err(|e| anyhow::anyhow!("log snapshot: {e}"))?),
            None => Arc::new(InMemoryLogStore::new()),
        };

        Ok(Arc::new(Self {
            config,
            chains,
            signer: Arc::new(signer),
            scorer: Arc::new(RuleBasedScorer::standard()),
            decoder: Arc::new(AbiTxDecoder::new()),
            signals: Arc::new(signals),
            log,
            clock,
            sessions: Mutex::new(HashMap::new()),
            challenges: Mutex::new(HashMap::new()),
            holds: Mutex::new(HashMap::new()),
            recoveries: Mutex::new(HashMap::new()),
            owners: Mutex::new(HashMap::new()),
            prepared: Mutex::new(HashMap::new()),
            model: Arc::new(model),
            sources,
            dev_keys: DevKeyring::default(),
            validator_seed,
        }))
    }

    fn make_mock_chain(config: &Config, signer: &Ed25519Signer, validator_seed: [u8; 32], now: u64) -> Result<Box<dyn ChainBackend>, ChainError> {
        let cfg = ChainConfig {
            chain_id: config.seed.chain_id,
            network: Network::ferra(config.seed.chain_id),
            cosigner: signer.verifying_key(),
            escape_delay_secs: config.seed.escape_delay_secs,
            tokens: config.seed.tokens.clone(),
            genesis_time: now,
        };
        let store: Box<dyn BlockStore> = match &config.chain_file {
            Some(p) => Box::new(JsonlBlockStore::new(p.clone())),
            None => Box::new(NullBlockStore),
        };
        let chain = MockChain::new(cfg, SigningKey::from_bytes(&validator_seed), store)?;
        tracing::info!(chain_id = chain.chain_id(), blocks = chain.latest().number + 1, "pseudo-chain ready and verified");
        Ok(Box::new(chain))
    }

    /// Fresh chains, empty logs, no holds or recoveries. Sessions and dev passkeys survive.
    pub fn reset(&self) -> Result<(), ServiceError> {
        let now = self.now();
        let signer = match self.config.signing_seed {
            Some(seed) => Ed25519Signer::from_seed(seed),
            None => return Err(ServiceError::Conflict("reset needs SQ_SIGNING_SEED so the co-signer key stays stable".into())),
        };
        if let Some(p) = &self.config.chain_file {
            JsonlBlockStore::new(p.clone()).clear()?;
        }
        self.chains.reset(|_| Self::make_mock_chain(&self.config, &signer, self.validator_seed, now))?;
        self.log.clear()?;
        self.lock(&self.holds)?.clear();
        self.lock(&self.recoveries)?.clear();
        self.lock(&self.challenges)?.clear();
        self.lock(&self.owners)?.clear();
        self.lock(&self.prepared)?.clear();
        tracing::warn!("demo state reset");
        Ok(())
    }

    /// The default chain (the one `chain_id` in `demo-seed.json` names).
    pub fn chain(&self) -> Result<ChainGuard<'_>, ServiceError> {
        Ok(self.chains.default()?)
    }

    /// A specific chain, or the default when `None`.
    pub fn chain_for(&self, chain_id: Option<u64>) -> Result<ChainGuard<'_>, ServiceError> {
        Ok(self.chains.get(chain_id.unwrap_or(self.chains.default_chain()))?)
    }

    /// Client id behind a bearer token, if the session exists.
    pub fn client_of(&self, caller: &Caller) -> Result<Option<String>, ServiceError> {
        let Some(token) = &caller.token else { return Ok(None) };
        Ok(self.lock(&self.sessions)?.get(token).map(|s| s.client_id.clone()))
    }

    /// Binds `address` to the caller's client at registration.
    pub fn bind_owner(&self, caller: &Caller, address: Address) -> Result<(), ServiceError> {
        if let Some(client) = self.client_of(caller)? {
            self.lock(&self.owners)?.insert(address, client);
        }
        Ok(())
    }

    /// A session may act only on wallets its client registered. Unbound addresses (dev-created) are open.
    pub fn check_owner(&self, caller: &Caller, address: Address) -> Result<(), ServiceError> {
        if !self.config.require_auth {
            return Ok(());
        }
        let owner = self.lock(&self.owners)?.get(&address).cloned();
        match (owner, self.client_of(caller)?) {
            (None, _) => Ok(()),
            (Some(o), Some(c)) if o == c => Ok(()),
            _ => Err(ServiceError::Unauthorized),
        }
    }

    /// Remember when a hash was prepared (assess / prepare) so the chain can record decision latency.
    pub fn note_prepared(&self, user_op_hash: B256) -> Result<(), ServiceError> {
        let now = self.now();
        let mut m = self.lock(&self.prepared)?;
        m.entry(user_op_hash).or_insert(now);
        if m.len() > 10_000 {
            m.retain(|_, t| now.saturating_sub(*t) < 86_400);
        }
        Ok(())
    }

    /// What the chain should record alongside a submission: latency and the policy outcome from the audit log.
    pub fn submit_meta(&self, address: Address, user_op_hash: B256) -> Result<SubmitMeta, ServiceError> {
        let prepared_at = self.lock(&self.prepared)?.get(&user_op_hash).copied();
        let log = self.log.load(address)?;
        let entry = log.entries().iter().rev().find(|e| e.entry.user_op_hash == user_op_hash);
        let policy = entry.map(|e| PolicySnapshot {
            score: Some(e.entry.assessment.score),
            band: Some(e.entry.assessment.band),
            reasons: e.entry.assessment.reasons.iter().map(|r| format!("{:?}", r.code)).collect(),
            sanctions_hit: None,
            exposure_hops: None,
        });
        Ok(SubmitMeta { prepared_at, step_up: entry.is_some_and(|e| e.entry.step_up), policy, fee: None })
    }

    pub fn lock<'a, T>(&self, m: &'a Mutex<T>) -> Result<MutexGuard<'a, T>, ServiceError> {
        m.lock().map_err(|_| ServiceError::Internal("lock poisoned".into()))
    }

    pub fn now(&self) -> u64 {
        self.clock.now()
    }

    pub fn new_id(prefix: &str) -> String {
        let mut b = [0u8; 8];
        rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut b);
        format!("{prefix}_{}", hex::encode(b))
    }
}
