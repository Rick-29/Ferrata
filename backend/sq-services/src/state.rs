use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use alloy_primitives::B256;
use api_types::{HoldState, RecoveryState, Session};
use sq_adapters::chain::ChainGuard;
use sq_adapters::{
    ChainBackend, ChainRegistry, Clock, Ed25519Signer, FixtureSignalProvider, InMemoryLogStore, LogStore, MockChain,
    ReceiptSigner, SignalProvider, SystemClock,
};
use wallet_core::{AbiTxDecoder, RiskScorer, RuleBasedScorer, TxDecoder};

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
    pub dev_keys: DevKeyring,
}

impl AppState {
    pub fn build(config: Config) -> anyhow::Result<SharedState> {
        Self::build_with_clock(config, Arc::new(SystemClock))
    }

    pub fn build_with_clock(config: Config, clock: Arc<dyn Clock>) -> anyhow::Result<SharedState> {
        let signer = match config.signing_seed {
            Some(seed) => Ed25519Signer::from_seed(seed),
            None => Ed25519Signer::random(),
        };
        tracing::info!(
            swissquote_public_key = %hex::encode(signer.verifying_key().as_bytes()),
            dev_signer = config.dev_signer,
            require_auth = config.require_auth,
            "Swissquote signing identity ready"
        );
        if config.dev_signer {
            tracing::warn!("SQ_DEV_SIGNER enabled: /dev/passkeys issues mock passkeys held in server memory. Demo only.");
        }

        // Adding a chain: build its backend here and `.register(...)` it. Nothing else changes.
        let chains = ChainRegistry::new(config.seed.chain_id)
            .register(Self::make_mock_chain(&config, &signer, clock.now()));

        let signals = FixtureSignalProvider::load(&config.fixtures_dir, config.policy.max_exposure_hops)
            .map_err(|e| anyhow::anyhow!("loading signal fixtures: {e}"))?;

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
            dev_keys: DevKeyring::default(),
        }))
    }

    fn make_mock_chain(config: &Config, signer: &Ed25519Signer, now: u64) -> Box<dyn ChainBackend> {
        let mut chain = MockChain::new(config.seed.chain_id, signer.verifying_key(), config.seed.escape_delay_secs, now);
        for t in &config.seed.tokens {
            chain.add_token(t.clone());
        }
        Box::new(chain)
    }

    /// Fresh chains, empty logs, no holds or recoveries. Sessions and dev passkeys survive.
    pub fn reset(&self) -> Result<(), ServiceError> {
        let now = self.now();
        let signer = match self.config.signing_seed {
            Some(seed) => Ed25519Signer::from_seed(seed),
            None => return Err(ServiceError::Conflict("reset needs SQ_SIGNING_SEED so the co-signer key stays stable".into())),
        };
        self.chains.reset(|_| Self::make_mock_chain(&self.config, &signer, now))?;
        self.log.clear()?;
        self.lock(&self.holds)?.clear();
        self.lock(&self.recoveries)?.clear();
        self.lock(&self.challenges)?.clear();
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
