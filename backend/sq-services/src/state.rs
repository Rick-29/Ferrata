use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use alloy_primitives::B256;
use api_types::{HoldState, RecoveryState, Session};
use sq_adapters::{
    Clock, Ed25519Signer, FixtureSignalProvider, InMemoryLogStore, LogStore, MockChain, ReceiptSigner, SignalProvider,
    SystemClock,
};
use wallet_core::{AbiTxDecoder, RiskScorer, RuleBasedScorer, TxDecoder};

use crate::config::Config;
use crate::dev::DevKeyring;
use crate::error::ServiceError;

pub type SharedState = Arc<AppState>;

pub struct AppState {
    pub config: Config,
    pub chain: Mutex<MockChain>,
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
            "Swissquote signing identity ready"
        );
        if config.dev_signer {
            tracing::warn!("SQ_DEV_SIGNER enabled: /dev/passkeys issues mock passkeys held in server memory. Demo only.");
        }

        let mut chain = MockChain::new(config.seed.chain_id, signer.verifying_key(), config.seed.escape_delay_secs, clock.now());
        for t in &config.seed.tokens {
            chain.add_token(t.clone());
        }

        let signals = FixtureSignalProvider::load(&config.fixtures_dir, config.policy.max_exposure_hops)
            .map_err(|e| anyhow::anyhow!("loading signal fixtures: {e}"))?;

        let log: Arc<dyn LogStore> = match &config.snapshot_path {
            Some(p) => Arc::new(InMemoryLogStore::with_snapshot(p.clone()).map_err(|e| anyhow::anyhow!("log snapshot: {e}"))?),
            None => Arc::new(InMemoryLogStore::new()),
        };

        Ok(Arc::new(Self {
            config,
            chain: Mutex::new(chain),
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

    pub fn chain(&self) -> Result<MutexGuard<'_, MockChain>, ServiceError> {
        self.chain.lock().map_err(|_| ServiceError::Internal("chain lock poisoned".into()))
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
