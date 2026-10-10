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
    AccountView, Block, ChainError, ChainInfo, ChainTx, EscapeStatus, OwnerKey, OwnerSignature, PreparedOp, SignedUserOp,
    SubmitResult,
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
    fn create_account(&mut self, owner: OwnerKey) -> Result<Address, ChainError>;
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

    // ----- reads -----
    fn latest_block(&self) -> Block;
    fn block(&self, number: u64) -> Option<Block>;
    fn tx(&self, hash: B256) -> Result<ChainTx, ChainError>;
    fn history(&self, address: Address) -> Vec<ChainTx>;
    /// Hash of the current log head, if this backend supports anchoring (see timeline).
    fn anchor(&mut self, _address: Address, _head: B256, _now: u64) -> Result<Option<SubmitResult>, ChainError> {
        Ok(None)
    }
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
    pub fn reset(&self, mut make: impl FnMut(u64) -> Box<dyn ChainBackend>) -> Result<(), ChainError> {
        for (id, m) in &self.chains {
            let mut guard = m.lock().map_err(|_| ChainError::Poisoned)?;
            *guard = make(*id);
        }
        Ok(())
    }
}
