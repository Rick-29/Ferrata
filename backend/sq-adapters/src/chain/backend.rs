//! The chain-agnostic seam. Services only ever talk to `dyn ChainBackend` through a
//! `ChainRegistry`; the wallet the user sees is the union of one account per registered backend.
//!
//! Adding a chain = one struct implementing this trait + one `register` call in `AppState::build`.
//! Nothing in `sq-services`, the policy engine, the log or the receipts changes.

use std::collections::BTreeMap;
use std::sync::{Mutex, MutexGuard};

use alloy_primitives::{Address, B256, Bytes, U256};
use wallet_core::{BalanceDelta, TxRequest};

use super::behaviour::{Intent, IntentOutcome, IntentOutcomeKind, WalletProfile, WalletSettings};
use super::features::SubmitMeta;
use super::model::DatasetRow;
use super::{
    AccountView, AddressReport, Block, BlockWithTxs, ChainError, ChainInfo, ChainTx, ChainVerification, EscapeStatus,
    ExternalRef, Flag, OwnerKey, OwnerSignature, PreparedOp, ReportedAddress, SignedUserOp, SubmitResult, Tamper,
};

/// Everything the Swissquote services need from a settlement layer.
///
/// `TxRequest` is the wire format for *all* backends: `to` is the counterparty or token contract,
/// `data` the chain-specific payload (empty for a plain transfer). A UTXO or Solana backend decodes
/// the same shape; only the signing hash, the account model and the fee logic differ.
pub trait ChainBackend: Send + Sync {
    // ----- identity -----
    fn chain_id(&self) -> u64;
    fn info(&self) -> ChainInfo;

    // ----- accounts -----
    fn address_for(&self, owner: &OwnerKey) -> Address;
    fn create_account(&mut self, owner: OwnerKey, now: u64) -> Result<Address, ChainError>;
    fn has_account(&self, address: Address) -> bool;
    fn account(&self, address: Address, now: u64) -> Result<AccountView, ChainError>;
    fn balances_of_view(&self, address: Address) -> Vec<super::AssetBalance>;
    fn fund(&mut self, to: Address, asset: Option<Address>, amount: U256, now: u64) -> Result<SubmitResult, ChainError>;

    // ----- user operations (owner + Swissquote 2-of-2) -----
    fn prepare(&self, tx: &TxRequest) -> Result<PreparedOp, ChainError>;
    /// The hash a submitted operation's signatures cover (nonce taken from the op, not the account).
    fn user_op_hash_for(&self, op: &SignedUserOp) -> B256;
    fn simulate(&self, tx: &TxRequest) -> Result<Vec<BalanceDelta>, ChainError>;
    fn submit(&mut self, op: &SignedUserOp, meta: &SubmitMeta, now: u64) -> Result<SubmitResult, ChainError>;
    /// Record an event seen on another network, attested by Swissquote.
    fn external_hash(&self, wallet: Address, ext: &ExternalRef) -> B256;
    fn ingest_external(&mut self, wallet: Address, ext: ExternalRef, counterparty: Option<Address>, incoming: bool, cosignature: &Bytes, now: u64) -> Result<SubmitResult, ChainError>;
    fn has_external(&self, network_name: &str, tx_id: &str) -> bool;

    // ----- escape hatch (owner only, timelocked) -----
    fn escape_hash(&self, address: Address, to: Address, nonce: u64) -> B256;
    fn escape_cancel_hash(&self, address: Address, nonce: u64) -> B256;
    fn start_escape_hatch(&mut self, address: Address, to: Address, sig: &OwnerSignature, now: u64) -> Result<(EscapeStatus, SubmitResult), ChainError>;
    fn cancel_escape_hatch(&mut self, address: Address, sig: &OwnerSignature, now: u64) -> Result<SubmitResult, ChainError>;

    // ----- recovery (Swissquote only, after its timelock) -----
    fn rotate_hash(&self, address: Address, new_owner: &OwnerKey, nonce: u64) -> B256;
    fn rotate_owner(&mut self, address: Address, new_owner: OwnerKey, cosignature: &Bytes, now: u64) -> Result<SubmitResult, ChainError>;

    // ----- the owner's settings and intentions -----
    fn settings_hash(&self, address: Address, nonce: u64, settings: &WalletSettings) -> B256;
    fn settings_of(&self, address: Address) -> WalletSettings;
    fn set_settings(&mut self, address: Address, settings: WalletSettings, sig: &OwnerSignature, now: u64) -> Result<SubmitResult, ChainError>;
    fn intent_hash(&self, address: Address, id: &str) -> B256;
    fn record_intent(&mut self, address: Address, intent: Intent, cosignature: &Bytes, now: u64) -> Result<SubmitResult, ChainError>;
    fn record_intent_outcome(&mut self, address: Address, outcome: IntentOutcome, cosignature: &Bytes, now: u64) -> Result<SubmitResult, ChainError>;
    fn open_intent_for(&self, address: Address, user_op_hash: B256) -> Option<Intent>;
    fn intent_by_id(&self, address: Address, id: &str) -> Option<(Intent, Option<IntentOutcomeKind>)>;
    fn profile(&self, address: Address, now: u64) -> WalletProfile;
    fn behaviour_findings(&self, address: Address, now: u64) -> Vec<Flag>;

    // ----- audit: anchoring, flags, integrity -----
    fn anchor_hash(&self, address: Address, head: B256) -> B256;
    fn anchor(&mut self, address: Address, head: B256, cosignature: &Bytes, now: u64) -> Result<SubmitResult, ChainError>;
    /// Append a flag event; `None` when an identical `(target, source, code)` flag already exists.
    fn flag(&mut self, flag: Flag, now: u64) -> Result<Option<SubmitResult>, ChainError>;
    fn verify(&self) -> ChainVerification;
    fn validation(&self, next_limit: usize) -> super::ValidationStatus;

    // ----- community / compliance reports about addresses on any network -----
    fn report_hash(&self, report: &AddressReport) -> B256;
    fn report_address(&mut self, report: AddressReport, cosignature: &Bytes, now: u64) -> Result<SubmitResult, ChainError>;
    fn reports_of(&self, network: &str, address: &str) -> Vec<AddressReport>;
    fn reported_addresses(&self) -> Vec<ReportedAddress>;
    /// Validatable events whose counterparty is `address` on `network`.
    fn events_involving(&self, network: &str, address: &str) -> Vec<ChainTx>;
    /// Demo-only corruption of live state. Backends that cannot be tampered return `ReadOnly`.
    fn tamper(&mut self, _t: &Tamper) -> Result<(), ChainError> {
        Err(ChainError::ReadOnly)
    }

    // ----- reads -----
    fn latest_block(&self) -> Block;
    fn block(&self, number: u64) -> Option<BlockWithTxs>;
    fn blocks(&self, from: u64, limit: usize) -> Vec<BlockWithTxs>;
    fn tx(&self, hash: B256) -> Result<ChainTx, ChainError>;
    fn history(&self, address: Address) -> Vec<ChainTx>;
    /// Feature rows with flag-derived labels, for training the validator's model.
    fn dataset(&self, from: u64, limit: usize) -> Vec<DatasetRow>;
}

pub type ChainGuard<'a> = MutexGuard<'a, Box<dyn ChainBackend>>;

/// All settlement layers the wallet spans, keyed by chain id. The "one wallet" the user sees.
pub struct ChainRegistry {
    chains: BTreeMap<u64, Mutex<Box<dyn ChainBackend>>>,
    default_chain: u64,
}

impl ChainRegistry {
    pub fn new(default_chain: u64) -> Self {
        Self { chains: BTreeMap::new(), default_chain }
    }

    pub fn register(mut self, backend: Box<dyn ChainBackend>) -> Self {
        self.chains.insert(backend.chain_id(), Mutex::new(backend));
        self
    }

    pub fn default_chain(&self) -> u64 {
        self.default_chain
    }

    pub fn chain_ids(&self) -> Vec<u64> {
        self.chains.keys().copied().collect()
    }

    pub fn get(&self, chain_id: u64) -> Result<ChainGuard<'_>, ChainError> {
        let m = self.chains.get(&chain_id).ok_or(ChainError::UnknownChain(chain_id))?;
        m.lock().map_err(|_| ChainError::Poisoned)
    }

    pub fn default(&self) -> Result<ChainGuard<'_>, ChainError> {
        self.get(self.default_chain)
    }

    /// Runs `f` on every backend, in chain-id order.
    pub fn for_each<T>(&self, mut f: impl FnMut(&mut dyn ChainBackend) -> Result<T, ChainError>) -> Result<Vec<T>, ChainError> {
        let mut out = Vec::with_capacity(self.chains.len());
        for m in self.chains.values() {
            let mut guard = m.lock().map_err(|_| ChainError::Poisoned)?;
            out.push(f(guard.as_mut())?);
        }
        Ok(out)
    }

    /// Swaps every backend for a fresh one built by `make`. Used by `/dev/reset`.
    pub fn reset(&self, mut make: impl FnMut(u64) -> Result<Box<dyn ChainBackend>, ChainError>) -> Result<(), ChainError> {
        for (id, m) in &self.chains {
            let mut guard = m.lock().map_err(|_| ChainError::Poisoned)?;
            *guard = make(*id)?;
        }
        Ok(())
    }
}

impl ChainBackend for super::MockChain {
    fn chain_id(&self) -> u64 {
        super::MockChain::chain_id(self)
    }
    fn info(&self) -> ChainInfo {
        super::MockChain::info(self)
    }
    fn address_for(&self, owner: &OwnerKey) -> Address {
        super::MockChain::address_for(owner)
    }
    fn create_account(&mut self, owner: OwnerKey, now: u64) -> Result<Address, ChainError> {
        super::MockChain::create_account(self, owner, now)
    }
    fn has_account(&self, address: Address) -> bool {
        super::MockChain::has_account(self, address)
    }
    fn account(&self, address: Address, now: u64) -> Result<AccountView, ChainError> {
        super::MockChain::account(self, address, now)
    }
    fn balances_of_view(&self, address: Address) -> Vec<super::AssetBalance> {
        super::MockChain::balances_of(self, address)
    }
    fn fund(&mut self, to: Address, asset: Option<Address>, amount: U256, now: u64) -> Result<SubmitResult, ChainError> {
        super::MockChain::fund(self, to, asset, amount, now)
    }
    fn prepare(&self, tx: &TxRequest) -> Result<PreparedOp, ChainError> {
        super::MockChain::prepare(self, tx)
    }
    fn user_op_hash_for(&self, op: &SignedUserOp) -> B256 {
        super::MockChain::user_op_hash(self, &op.tx, op.nonce)
    }
    fn simulate(&self, tx: &TxRequest) -> Result<Vec<BalanceDelta>, ChainError> {
        super::MockChain::simulate(self, tx)
    }
    fn submit(&mut self, op: &SignedUserOp, meta: &SubmitMeta, now: u64) -> Result<SubmitResult, ChainError> {
        super::MockChain::submit(self, op, meta, now)
    }
    fn external_hash(&self, wallet: Address, ext: &ExternalRef) -> B256 {
        super::MockChain::external_hash(self, wallet, ext)
    }
    fn ingest_external(&mut self, wallet: Address, ext: ExternalRef, counterparty: Option<Address>, incoming: bool, cosignature: &Bytes, now: u64) -> Result<SubmitResult, ChainError> {
        super::MockChain::ingest_external(self, wallet, ext, counterparty, incoming, cosignature, now)
    }
    fn has_external(&self, network_name: &str, tx_id: &str) -> bool {
        super::MockChain::has_external(self, network_name, tx_id)
    }
    fn escape_hash(&self, address: Address, to: Address, nonce: u64) -> B256 {
        super::MockChain::escape_hash(self, address, to, nonce)
    }
    fn escape_cancel_hash(&self, address: Address, nonce: u64) -> B256 {
        super::MockChain::escape_cancel_hash(self, address, nonce)
    }
    fn start_escape_hatch(&mut self, address: Address, to: Address, sig: &OwnerSignature, now: u64) -> Result<(EscapeStatus, SubmitResult), ChainError> {
        super::MockChain::start_escape_hatch(self, address, to, sig, now)
    }
    fn cancel_escape_hatch(&mut self, address: Address, sig: &OwnerSignature, now: u64) -> Result<SubmitResult, ChainError> {
        super::MockChain::cancel_escape_hatch(self, address, sig, now)
    }
    fn rotate_hash(&self, address: Address, new_owner: &OwnerKey, nonce: u64) -> B256 {
        super::MockChain::rotate_hash(self, address, new_owner, nonce)
    }
    fn rotate_owner(&mut self, address: Address, new_owner: OwnerKey, cosignature: &Bytes, now: u64) -> Result<SubmitResult, ChainError> {
        super::MockChain::rotate_owner(self, address, new_owner, cosignature, now)
    }
    fn settings_hash(&self, address: Address, nonce: u64, settings: &WalletSettings) -> B256 {
        super::MockChain::settings_hash(self, address, nonce, settings)
    }
    fn settings_of(&self, address: Address) -> WalletSettings {
        super::MockChain::settings_of(self, address)
    }
    fn set_settings(&mut self, address: Address, settings: WalletSettings, sig: &OwnerSignature, now: u64) -> Result<SubmitResult, ChainError> {
        super::MockChain::set_settings(self, address, settings, sig, now)
    }
    fn intent_hash(&self, address: Address, id: &str) -> B256 {
        super::MockChain::intent_hash(self, address, id)
    }
    fn record_intent(&mut self, address: Address, intent: Intent, cosignature: &Bytes, now: u64) -> Result<SubmitResult, ChainError> {
        super::MockChain::record_intent(self, address, intent, cosignature, now)
    }
    fn record_intent_outcome(&mut self, address: Address, outcome: IntentOutcome, cosignature: &Bytes, now: u64) -> Result<SubmitResult, ChainError> {
        super::MockChain::record_intent_outcome(self, address, outcome, cosignature, now)
    }
    fn open_intent_for(&self, address: Address, user_op_hash: B256) -> Option<Intent> {
        super::MockChain::open_intent_for(self, address, user_op_hash)
    }
    fn intent_by_id(&self, address: Address, id: &str) -> Option<(Intent, Option<IntentOutcomeKind>)> {
        super::MockChain::intent_by_id(self, address, id)
    }
    fn profile(&self, address: Address, now: u64) -> WalletProfile {
        super::MockChain::profile(self, address, now)
    }
    fn behaviour_findings(&self, address: Address, now: u64) -> Vec<Flag> {
        super::MockChain::behaviour_findings(self, address, now)
    }
    fn anchor_hash(&self, address: Address, head: B256) -> B256 {
        super::MockChain::anchor_hash(self, address, head)
    }
    fn anchor(&mut self, address: Address, head: B256, cosignature: &Bytes, now: u64) -> Result<SubmitResult, ChainError> {
        super::MockChain::anchor(self, address, head, cosignature, now)
    }
    fn flag(&mut self, flag: Flag, now: u64) -> Result<Option<SubmitResult>, ChainError> {
        super::MockChain::flag(self, flag, now)
    }
    fn verify(&self) -> ChainVerification {
        super::MockChain::verify(self)
    }
    fn validation(&self, next_limit: usize) -> super::ValidationStatus {
        super::MockChain::validation(self, next_limit)
    }
    fn report_hash(&self, report: &AddressReport) -> B256 {
        super::MockChain::report_hash(self, report)
    }
    fn report_address(&mut self, report: AddressReport, cosignature: &Bytes, now: u64) -> Result<SubmitResult, ChainError> {
        super::MockChain::report_address(self, report, cosignature, now)
    }
    fn reports_of(&self, network: &str, address: &str) -> Vec<AddressReport> {
        super::MockChain::reports_of(self, network, address)
    }
    fn reported_addresses(&self) -> Vec<ReportedAddress> {
        super::MockChain::reported_addresses(self)
    }
    fn events_involving(&self, network: &str, address: &str) -> Vec<ChainTx> {
        super::MockChain::events_involving(self, network, address)
    }
    fn tamper(&mut self, t: &Tamper) -> Result<(), ChainError> {
        super::MockChain::tamper(self, t)
    }
    fn latest_block(&self) -> Block {
        super::MockChain::latest(self)
    }
    fn block(&self, number: u64) -> Option<BlockWithTxs> {
        super::MockChain::block(self, number)
    }
    fn blocks(&self, from: u64, limit: usize) -> Vec<BlockWithTxs> {
        super::MockChain::blocks(self, from, limit)
    }
    fn tx(&self, hash: B256) -> Result<ChainTx, ChainError> {
        super::MockChain::tx(self, hash)
    }
    fn history(&self, address: Address) -> Vec<ChainTx> {
        super::MockChain::history(self, address)
    }
    fn dataset(&self, from: u64, limit: usize) -> Vec<DatasetRow> {
        super::MockChain::dataset(self, from, limit)
    }
}
