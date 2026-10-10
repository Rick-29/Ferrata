//! The chain-agnostic seam. Services only ever talk to `dyn ChainBackend` through a
//! `ChainRegistry`; the wallet the user sees is the union of one account per registered backend.
//!
//! Adding a chain = one struct implementing this trait + one `register` call in `AppState::build`.
//! Nothing in `sq-services`, the policy engine, the log or the receipts changes.

use std::collections::BTreeMap;
use std::sync::{Mutex, MutexGuard};

use alloy_primitives::{Address, B256, Bytes, U256};
use wallet_core::{BalanceDelta, TxRequest};

use super::{
    AccountView, Block, BlockWithTxs, ChainError, ChainInfo, ChainTx, ChainVerification, EscapeStatus, Flag, OwnerKey,
    OwnerSignature, PreparedOp, SignedUserOp, SubmitResult, Tamper,
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
    fn fund(&mut self, to: Address, asset: Option<Address>, amount: U256, now: u64) -> Result<SubmitResult, ChainError>;

    // ----- user operations (owner + Swissquote 2-of-2) -----
    fn prepare(&self, tx: &TxRequest) -> Result<PreparedOp, ChainError>;
    fn simulate(&self, tx: &TxRequest) -> Result<Vec<BalanceDelta>, ChainError>;
    fn submit(&mut self, op: &SignedUserOp, now: u64) -> Result<SubmitResult, ChainError>;

    // ----- escape hatch (owner only, timelocked) -----
    fn escape_hash(&self, address: Address, to: Address, nonce: u64) -> B256;
    fn escape_cancel_hash(&self, address: Address, nonce: u64) -> B256;
    fn start_escape_hatch(&mut self, address: Address, to: Address, sig: &OwnerSignature, now: u64) -> Result<(EscapeStatus, SubmitResult), ChainError>;
    fn cancel_escape_hatch(&mut self, address: Address, sig: &OwnerSignature, now: u64) -> Result<SubmitResult, ChainError>;

    // ----- recovery (Swissquote only, after its timelock) -----
    fn rotate_hash(&self, address: Address, new_owner: &OwnerKey, nonce: u64) -> B256;
    fn rotate_owner(&mut self, address: Address, new_owner: OwnerKey, cosignature: &Bytes, now: u64) -> Result<SubmitResult, ChainError>;

    // ----- audit: anchoring, flags, integrity -----
    fn anchor_hash(&self, address: Address, head: B256) -> B256;
    fn anchor(&mut self, address: Address, head: B256, cosignature: &Bytes, now: u64) -> Result<SubmitResult, ChainError>;
    /// Append a flag event; `None` when an identical `(target, source, code)` flag already exists.
    fn flag(&mut self, flag: Flag, now: u64) -> Result<Option<SubmitResult>, ChainError>;
    fn verify(&self) -> ChainVerification;
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
    fn fund(&mut self, to: Address, asset: Option<Address>, amount: U256, now: u64) -> Result<SubmitResult, ChainError> {
        super::MockChain::fund(self, to, asset, amount, now)
    }
    fn prepare(&self, tx: &TxRequest) -> Result<PreparedOp, ChainError> {
        super::MockChain::prepare(self, tx)
    }
    fn simulate(&self, tx: &TxRequest) -> Result<Vec<BalanceDelta>, ChainError> {
        super::MockChain::simulate(self, tx)
    }
    fn submit(&mut self, op: &SignedUserOp, now: u64) -> Result<SubmitResult, ChainError> {
        super::MockChain::submit(self, op, now)
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
}
