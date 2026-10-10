use std::collections::BTreeMap;

use alloy_primitives::{Address, B256, Bytes, U256, keccak256};
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use wallet_core::{AbiTxDecoder, BalanceDelta, DecodedAction, TxDecoder, TxRequest};

use super::auth::{OwnerKey, OwnerSignature, verify_owner};
use super::store::{BlockStore, NullBlockStore};
use super::{
    AccountView, AssetBalance, BLOCK_VERSION, Block, BlockWithTxs, ChainError, ChainInfo, ChainTx, ChainVerification,
    EVENT_VERSION, EscapeStatus, Flag, PreparedOp, SignedUserOp, SubmitResult, TokenInfo, TxKind,
};
use crate::signer::cosign_payload;

const USEROP_DOMAIN: &[u8] = b"SQW-USEROP-v1";
const ESCAPE_DOMAIN: &[u8] = b"SQW-ESCAPE-v1";
const ESCAPE_CANCEL_DOMAIN: &[u8] = b"SQW-ESCAPE-CANCEL-v1";
const ROTATE_DOMAIN: &[u8] = b"SQW-ROTATE-v1";
const ANCHOR_DOMAIN: &[u8] = b"SQW-ANCHOR-v1";
const TX_DOMAIN: &[u8] = b"SQW-EVENT-v1";
const BLOCK_DOMAIN: &[u8] = b"SQW-BLOCK-v1";
const STATE_DOMAIN: &[u8] = b"SQW-STATE-v1";

#[derive(Debug, Clone)]
pub struct ChainConfig {
    pub chain_id: u64,
    pub cosigner: VerifyingKey,
    pub escape_delay_secs: u64,
    pub tokens: Vec<TokenInfo>,
    pub genesis_time: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Escape {
    to: Address,
    started_at: u64,
    unlock_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Account {
    owner: OwnerKey,
    nonce: u64,
    escape: Option<Escape>,
    created_block: u64,
}

/// Balances exist for any address (accounts, EOAs, faucet recipients); accounts add signing rules.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct Balances {
    native: U256,
    tokens: BTreeMap<Address, U256>,
}

/// Ways to corrupt the live state for integrity demos. Only reachable through `/dev/tamper`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum Tamper {
    /// Edit a mined transaction's value in place (hash no longer matches).
    TxValue {
        #[ts(type = "string")]
        hash: B256,
        #[ts(type = "string")]
        value: U256,
    },
    /// Edit a balance without any event (live state diverges from the replayed state).
    Balance {
        #[ts(type = "string")]
        address: Address,
        #[ts(type = "string | null")]
        asset: Option<Address>,
        #[ts(type = "string")]
        amount: U256,
    },
    /// Re-point a block at the wrong parent.
    BlockParent {
        #[ts(type = "number")]
        number: u64,
    },
}

pub struct MockChain {
    cfg: ChainConfig,
    validator: VerifyingKey,
    validator_key: Option<SigningKey>,
    decoder: AbiTxDecoder,
    tokens: BTreeMap<Address, TokenInfo>,
    accounts: BTreeMap<Address, Account>,
    balances: BTreeMap<Address, Balances>,
    /// `(spender, owner, token) -> allowance`
    allowances: BTreeMap<(Address, Address, Address), U256>,
    blocks: Vec<Block>,
    txs: BTreeMap<B256, ChainTx>,
    /// Tx hashes in chain order.
    order: Vec<B256>,
    /// Derived index: target event -> flags raised on it.
    flags: BTreeMap<B256, Vec<Flag>>,
    store: Box<dyn BlockStore>,
}

impl std::fmt::Debug for MockChain {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MockChain").field("chain_id", &self.cfg.chain_id).field("blocks", &self.blocks.len()).field("accounts", &self.accounts.len()).finish()
    }
}

impl MockChain {
    /// A signing chain. Loads and verifies any blocks already in `store`.
    pub fn new(cfg: ChainConfig, validator_key: SigningKey, store: Box<dyn BlockStore>) -> Result<Self, ChainError> {
        let existing = store.load()?;
        let mut chain = Self::empty(cfg, validator_key.verifying_key(), Some(validator_key), store);
        if existing.is_empty() {
            chain.push_genesis()?;
        } else {
            for b in &existing {
                chain.replay_block(b)?;
            }
        }
        Ok(chain)
    }

    /// Convenience for tests and single-process demos: no persistence.
    pub fn in_memory(cfg: ChainConfig, validator_key: SigningKey) -> Result<Self, ChainError> {
        Self::new(cfg, validator_key, Box::new(NullBlockStore))
    }

    /// A verify-only chain rebuilt from `blocks`. Fails at the first block that does not check out.
    pub fn replay(cfg: ChainConfig, validator: VerifyingKey, blocks: &[BlockWithTxs]) -> Result<Self, ChainError> {
        let mut chain = Self::empty(cfg, validator, None, Box::new(NullBlockStore));
        for b in blocks {
            chain.replay_block(b)?;
        }
        Ok(chain)
    }

    fn empty(cfg: ChainConfig, validator: VerifyingKey, validator_key: Option<SigningKey>, store: Box<dyn BlockStore>) -> Self {
        let tokens = cfg.tokens.iter().map(|t| (t.address, t.clone())).collect();
        Self {
            cfg,
            validator,
            validator_key,
            decoder: AbiTxDecoder::new(),
            tokens,
            accounts: BTreeMap::new(),
            balances: BTreeMap::new(),
            allowances: BTreeMap::new(),
            blocks: Vec::new(),
            txs: BTreeMap::new(),
            order: Vec::new(),
            flags: BTreeMap::new(),
            store,
        }
    }

    // ----- identity -----

    pub fn chain_id(&self) -> u64 {
        self.cfg.chain_id
    }

    pub fn validator(&self) -> VerifyingKey {
        self.validator
    }

    pub fn info(&self) -> ChainInfo {
        let head = self.latest();
        ChainInfo {
            chain_id: self.cfg.chain_id,
            latest_block: head.number,
            head: head.hash,
            state_root: head.state_root,
            cosigner: hex::encode(self.cfg.cosigner.as_bytes()),
            validator: hex::encode(self.validator.as_bytes()),
            escape_delay_secs: self.cfg.escape_delay_secs,
            tokens: self.tokens.values().cloned().collect(),
            persisted: self.store.is_persistent(),
        }
    }

    // ----- accounts -----

    /// Counterfactual address: last 20 bytes of keccak(owner key bytes).
    pub fn address_for(owner: &OwnerKey) -> Address {
        Address::from_slice(&keccak256(owner.bytes())[12..])
    }

    pub fn create_account(&mut self, owner: OwnerKey, now: u64) -> Result<Address, ChainError> {
        owner.validate().map_err(|_| ChainError::BadOwnerSignature)?;
        let address = Self::address_for(&owner);
        let mut extra = BTreeMap::new();
        extra.insert("owner".into(), serde_json::to_value(&owner).map_err(|e| ChainError::MalformedEvent(e.to_string()))?);
        let action = DecodedAction::ContractCall { target: address, selector: selector(b"createAccount(bytes)"), value: U256::ZERO };
        let tx = self.event(TxKind::AccountCreated, address, address, U256::ZERO, Bytes::new(), 0, B256::ZERO, action, now);
        self.commit(ChainTx { extra, ..tx })?;
        Ok(address)
    }

    pub fn has_account(&self, address: Address) -> bool {
        self.accounts.contains_key(&address)
    }

    pub fn account(&self, address: Address, now: u64) -> Result<AccountView, ChainError> {
        let acc = self.accounts.get(&address).ok_or(ChainError::UnknownAccount(address))?;
        let flags = self
            .order
            .iter()
            .filter_map(|h| self.txs.get(h))
            .filter(|t| t.from == address || t.to == address)
            .flat_map(|t| self.flags.get(&t.hash).cloned().unwrap_or_default())
            .collect();
        Ok(AccountView {
            address,
            owner: acc.owner.clone(),
            cosigner: hex::encode(self.cfg.cosigner.as_bytes()),
            nonce: acc.nonce,
            balances: self.balances_of(address),
            escape: match &acc.escape {
                None => EscapeStatus::Inactive,
                Some(e) if now >= e.unlock_at => EscapeStatus::Unlocked { to: e.to, unlock_at: e.unlock_at },
                Some(e) => EscapeStatus::Pending { to: e.to, started_at: e.started_at, unlock_at: e.unlock_at },
            },
            created_block: acc.created_block,
            flags,
        })
    }

    pub fn balances_of(&self, address: Address) -> Vec<AssetBalance> {
        let b = self.balances.get(&address).cloned().unwrap_or_default();
        let mut out = vec![AssetBalance { asset: None, symbol: "ETH".into(), decimals: 18, amount: b.native }];
        for t in self.tokens.values() {
            out.push(AssetBalance {
                asset: Some(t.address),
                symbol: t.symbol.clone(),
                decimals: t.decimals,
                amount: b.tokens.get(&t.address).copied().unwrap_or(U256::ZERO),
            });
        }
        out
    }

    /// Faucet / demo seeding: credits without signatures and records a `Faucet` event.
    pub fn fund(&mut self, to: Address, asset: Option<Address>, amount: U256, now: u64) -> Result<SubmitResult, ChainError> {
        let (action, to_field, value, data) = match asset {
            None => (DecodedAction::NativeTransfer { to, amount }, to, amount, Bytes::new()),
            Some(token) => (
                DecodedAction::Erc20Transfer { token, to, amount },
                token,
                U256::ZERO,
                wallet_core::tx::encode_erc20_call(wallet_core::tx::SEL_TRANSFER, to, amount),
            ),
        };
        let tx = self.event(TxKind::Faucet, Address::ZERO, to_field, value, data, 0, B256::ZERO, action, now);
        self.commit(tx)
    }

    // ----- hashes the signers must cover -----

    pub fn user_op_hash(&self, tx: &TxRequest, nonce: u64) -> B256 {
        self.user_op_hash_parts(tx.from, tx.to, tx.value, &tx.data, nonce)
    }

    fn user_op_hash_parts(&self, from: Address, to: Address, value: U256, data: &[u8], nonce: u64) -> B256 {
        let mut buf = Vec::with_capacity(USEROP_DOMAIN.len() + 8 + 20 + 20 + 32 + 32 + 8);
        buf.extend_from_slice(USEROP_DOMAIN);
        buf.extend_from_slice(&self.cfg.chain_id.to_be_bytes());
        buf.extend_from_slice(from.as_slice());
        buf.extend_from_slice(to.as_slice());
        buf.extend_from_slice(&value.to_be_bytes::<32>());
        buf.extend_from_slice(keccak256(data).as_slice());
        buf.extend_from_slice(&nonce.to_be_bytes());
        keccak256(buf)
    }

    fn auth_hash(&self, domain: &[u8], address: Address, subject: &[u8], nonce: u64) -> B256 {
        let mut buf = Vec::new();
        buf.extend_from_slice(domain);
        buf.extend_from_slice(&self.cfg.chain_id.to_be_bytes());
        buf.extend_from_slice(address.as_slice());
        buf.extend_from_slice(subject);
        buf.extend_from_slice(&nonce.to_be_bytes());
        keccak256(buf)
    }

    pub fn escape_hash(&self, address: Address, to: Address, nonce: u64) -> B256 {
        self.auth_hash(ESCAPE_DOMAIN, address, to.as_slice(), nonce)
    }

    pub fn escape_cancel_hash(&self, address: Address, nonce: u64) -> B256 {
        self.auth_hash(ESCAPE_CANCEL_DOMAIN, address, &[], nonce)
    }

    pub fn rotate_hash(&self, address: Address, new_owner: &OwnerKey, nonce: u64) -> B256 {
        self.auth_hash(ROTATE_DOMAIN, address, new_owner.bytes(), nonce)
    }

    pub fn anchor_hash(&self, address: Address, head: B256) -> B256 {
        self.auth_hash(ANCHOR_DOMAIN, address, head.as_slice(), 0)
    }

    // ----- user operations -----

    /// Decodes and assigns the nonce; the result's `user_op_hash` is what the owner signs and Swissquote co-signs.
    pub fn prepare(&self, tx: &TxRequest) -> Result<PreparedOp, ChainError> {
        self.check_chain(tx.chain_id)?;
        let acc = self.accounts.get(&tx.from).ok_or(ChainError::UnknownAccount(tx.from))?;
        let action = self.decoder.decode(tx)?;
        Ok(PreparedOp { user_op_hash: self.user_op_hash(tx, acc.nonce), nonce: acc.nonce, action })
    }

    /// Balance deltas the transaction would cause for `tx.from`, without touching state.
    pub fn simulate(&self, tx: &TxRequest) -> Result<Vec<BalanceDelta>, ChainError> {
        self.check_chain(tx.chain_id)?;
        let action = self.decoder.decode(tx)?;
        let before = self.balances_of(tx.from);
        let mut after = before.clone();
        let (asset, out) = match &action {
            DecodedAction::NativeTransfer { amount, .. } => (None, *amount),
            DecodedAction::Erc20Transfer { token, amount, .. } => (Some(*token), *amount),
            DecodedAction::ContractCall { value, .. } => (None, *value),
            _ => (None, U256::ZERO),
        };
        if let Some(b) = after.iter_mut().find(|b| b.asset == asset) {
            b.amount = b.amount.saturating_sub(out);
        }
        Ok(before
            .into_iter()
            .zip(after)
            .map(|(b, a)| BalanceDelta { asset: b.asset, symbol: b.symbol, before: b.amount, after: a.amount })
            .collect())
    }

    /// Validates both signatures and executes. This is the 2-of-2 rule the real account enforces.
    pub fn submit(&mut self, op: &SignedUserOp, now: u64) -> Result<SubmitResult, ChainError> {
        self.check_chain(op.tx.chain_id)?;
        let action = self.decoder.decode(&op.tx)?;
        let hash = self.user_op_hash(&op.tx, op.nonce);
        let kind = if op.cosignature.is_some() { TxKind::Cosigned } else { TxKind::EscapeExit };
        let tx = ChainTx {
            owner_signature: Some(op.owner_signature.clone()),
            cosignature: op.cosignature.clone(),
            ..self.event(kind, op.tx.from, op.tx.to, op.tx.value, op.tx.data.clone(), op.nonce, hash, action, now)
        };
        self.commit(tx)
    }

    // ----- escape hatch -----

    pub fn start_escape_hatch(&mut self, address: Address, to: Address, sig: &OwnerSignature, now: u64) -> Result<(EscapeStatus, SubmitResult), ChainError> {
        let nonce = self.nonce_of(address)?;
        let hash = self.escape_hash(address, to, nonce);
        let action = DecodedAction::ContractCall { target: address, selector: selector(b"startEscapeHatch(address)"), value: U256::ZERO };
        let tx = ChainTx { owner_signature: Some(sig.clone()), ..self.event(TxKind::EscapeStart, address, to, U256::ZERO, Bytes::new(), nonce, hash, action, now) };
        let r = self.commit(tx)?;
        Ok((self.account(address, now)?.escape, r))
    }

    pub fn cancel_escape_hatch(&mut self, address: Address, sig: &OwnerSignature, now: u64) -> Result<SubmitResult, ChainError> {
        let nonce = self.nonce_of(address)?;
        let hash = self.escape_cancel_hash(address, nonce);
        let action = DecodedAction::ContractCall { target: address, selector: selector(b"cancelEscapeHatch()"), value: U256::ZERO };
        let tx = ChainTx { owner_signature: Some(sig.clone()), ..self.event(TxKind::EscapeCancel, address, address, U256::ZERO, Bytes::new(), nonce, hash, action, now) };
        self.commit(tx)
    }

    // ----- recovery -----

    /// Replaces the owner key. Only Swissquote may authorise this, after its off-chain timelock.
    pub fn rotate_owner(&mut self, address: Address, new_owner: OwnerKey, cosignature: &Bytes, now: u64) -> Result<SubmitResult, ChainError> {
        let nonce = self.nonce_of(address)?;
        let hash = self.rotate_hash(address, &new_owner, nonce);
        let mut extra = BTreeMap::new();
        extra.insert("new_owner".into(), serde_json::to_value(&new_owner).map_err(|e| ChainError::MalformedEvent(e.to_string()))?);
        let action = DecodedAction::ContractCall { target: address, selector: selector(b"rotateOwner(bytes)"), value: U256::ZERO };
        let tx = ChainTx {
            cosignature: Some(cosignature.clone()),
            extra,
            ..self.event(TxKind::OwnerRotation, address, address, U256::ZERO, Bytes::copy_from_slice(new_owner.bytes()), nonce, hash, action, now)
        };
        self.commit(tx)
    }

    // ----- anchoring and flags -----

    /// Swissquote anchors an audit-log head; `cosignature` is over `anchor_hash(address, head)`.
    pub fn anchor(&mut self, address: Address, head: B256, cosignature: &Bytes, now: u64) -> Result<SubmitResult, ChainError> {
        let action = DecodedAction::ContractCall { target: address, selector: selector(b"anchorLogHead(bytes32)"), value: U256::ZERO };
        let tx = ChainTx {
            cosignature: Some(cosignature.clone()),
            ..self.event(TxKind::Anchor, address, address, U256::ZERO, Bytes::copy_from_slice(head.as_slice()), 0, head, action, now)
        };
        self.commit(tx)
    }

    /// Attaches a flag to an existing event as a new event. Idempotent per `(target, source, code)`.
    pub fn flag(&mut self, flag: Flag, now: u64) -> Result<Option<SubmitResult>, ChainError> {
        let target_from = self.txs.get(&flag.target).map(|t| t.from).ok_or(ChainError::UnknownTx(flag.target))?;
        if self.flags.get(&flag.target).is_some_and(|fs| fs.iter().any(|f| f.code == flag.code && f.source == flag.source)) {
            return Ok(None);
        }
        let mut extra = BTreeMap::new();
        extra.insert("flag".into(), serde_json::to_value(&flag).map_err(|e| ChainError::MalformedEvent(e.to_string()))?);
        let action = DecodedAction::ContractCall { target: target_from, selector: selector(b"flag(bytes32,string)"), value: U256::ZERO };
        let tx = ChainTx { extra, ..self.event(TxKind::Flag, Address::ZERO, target_from, U256::ZERO, Bytes::copy_from_slice(flag.target.as_slice()), 0, flag.target, action, now) };
        self.commit(tx).map(Some)
    }

    // ----- reads -----

    pub fn latest(&self) -> Block {
        self.blocks.last().cloned().unwrap_or_else(|| self.genesis_block())
    }

    pub fn block(&self, number: u64) -> Option<BlockWithTxs> {
        let block = self.blocks.get(number as usize)?.clone();
        let txs = block.tx_hashes.iter().filter_map(|h| self.view_tx(*h)).collect();
        Some(BlockWithTxs { block, txs })
    }

    pub fn blocks(&self, from: u64, limit: usize) -> Vec<BlockWithTxs> {
        (from..).take(limit).map_while(|n| self.block(n)).collect()
    }

    pub fn tx(&self, hash: B256) -> Result<ChainTx, ChainError> {
        self.view_tx(hash).ok_or(ChainError::UnknownTx(hash))
    }

    /// Every event that touched `address`, oldest first.
    pub fn history(&self, address: Address) -> Vec<ChainTx> {
        self.order
            .iter()
            .filter_map(|h| self.view_tx(*h))
            .filter(|t| t.from == address || t.to == address || t.action.counterparty() == Some(address))
            .collect()
    }

    /// Replays the whole chain from its own blocks and checks every hash, signature and state root,
    /// then compares the replayed state with the live one.
    pub fn verify(&self) -> ChainVerification {
        let blocks: Vec<BlockWithTxs> = (0..self.blocks.len() as u64).filter_map(|n| self.stored_block(n)).collect();
        let txs_checked = blocks.iter().map(|b| b.txs.len() as u64).sum();
        let head = self.latest();
        let result = MockChain::replay(self.cfg.clone(), self.validator, &blocks).and_then(|replayed| {
            let live = self.state_root();
            if replayed.state_root() != live {
                return Err(ChainError::Tampered { block: head.number, reason: format!("live state root {live} differs from replayed {}", replayed.state_root()) });
            }
            Ok(())
        });
        match result {
            Ok(()) => ChainVerification { ok: true, blocks_checked: blocks.len() as u64, txs_checked, first_bad_block: None, reason: None, head: head.hash, state_root: head.state_root },
            Err(ChainError::Tampered { block, reason }) => {
                ChainVerification { ok: false, blocks_checked: block, txs_checked, first_bad_block: Some(block), reason: Some(reason), head: head.hash, state_root: head.state_root }
            }
            Err(e) => ChainVerification { ok: false, blocks_checked: 0, txs_checked, first_bad_block: Some(0), reason: Some(e.to_string()), head: head.hash, state_root: head.state_root },
        }
    }

    /// Corrupts live state for integrity demos. Not reachable through the normal API.
    #[doc(hidden)]
    pub fn tamper(&mut self, t: &Tamper) -> Result<(), ChainError> {
        match t {
            Tamper::TxValue { hash, value } => {
                let tx = self.txs.get_mut(hash).ok_or(ChainError::UnknownTx(*hash))?;
                tx.value = *value;
            }
            Tamper::Balance { address, asset, amount } => {
                let b = self.balances.entry(*address).or_default();
                match asset {
                    None => b.native = *amount,
                    Some(t) => {
                        b.tokens.insert(*t, *amount);
                    }
                }
            }
            Tamper::BlockParent { number } => {
                let b = self.blocks.get_mut(*number as usize).ok_or(ChainError::Tampered { block: *number, reason: "no such block".into() })?;
                b.parent_hash = keccak256(b.parent_hash);
            }
        }
        Ok(())
    }

    // ----- the event pipeline -----

    #[allow(clippy::too_many_arguments)]
    fn event(&self, kind: TxKind, from: Address, to: Address, value: U256, data: Bytes, nonce: u64, user_op_hash: B256, action: DecodedAction, now: u64) -> ChainTx {
        let latest = self.latest();
        ChainTx {
            version: EVENT_VERSION,
            hash: B256::ZERO,
            block_number: latest.number + 1,
            timestamp: now.max(latest.timestamp),
            kind,
            from,
            to,
            value,
            data,
            nonce,
            user_op_hash,
            action,
            owner_signature: None,
            cosignature: None,
            extra: BTreeMap::new(),
            flags: Vec::new(),
        }
    }

    /// Authorise, execute, mine, persist. The single path every state change takes, live or replayed.
    fn commit(&mut self, mut tx: ChainTx) -> Result<SubmitResult, ChainError> {
        let key = self.validator_key.clone().ok_or(ChainError::ReadOnly)?;
        let parent = self.latest();
        tx.block_number = parent.number + 1;
        tx.timestamp = tx.timestamp.max(parent.timestamp);
        self.authorize(&tx)?;
        self.execute(&tx)?;
        tx.hash = self.tx_hash(&tx, parent.hash);
        let mut block = self.build_block(&parent, &tx);
        block.validator_signature = Bytes::copy_from_slice(&key.sign(&block_payload(&block.hash)).to_bytes());
        let stored = BlockWithTxs { block: block.clone(), txs: vec![tx.clone()] };
        self.store.append(&stored)?;
        self.push(block, tx)
    }

    fn replay_block(&mut self, b: &BlockWithTxs) -> Result<(), ChainError> {
        let number = b.block.number;
        let bad = |reason: String| ChainError::Tampered { block: number, reason };
        if number == 0 {
            if !self.blocks.is_empty() {
                return Err(bad("second genesis".into()));
            }
            // The stored genesis fixes the chain's birth time; the validator signature vouches for it.
            self.cfg.genesis_time = b.block.timestamp;
            let genesis = self.genesis_block();
            if b.block.hash != genesis.hash || b.block.state_root != genesis.state_root {
                return Err(bad("genesis does not match chain configuration".into()));
            }
            self.verify_block_signature(&b.block)?;
            self.blocks.push(b.block.clone());
            return Ok(());
        }
        let parent = self.blocks.last().cloned().ok_or_else(|| bad("missing genesis".into()))?;
        if number != parent.number + 1 {
            return Err(bad(format!("expected block {}", parent.number + 1)));
        }
        if b.block.parent_hash != parent.hash {
            return Err(bad("parent hash does not match previous block".into()));
        }
        let mut txs = Vec::with_capacity(b.txs.len());
        for tx in &b.txs {
            if tx.block_number != number {
                return Err(bad(format!("event {} claims block {}", tx.hash, tx.block_number)));
            }
            let expected = self.tx_hash(tx, parent.hash);
            if tx.hash != expected {
                return Err(bad(format!("event {} content does not match its hash", tx.hash)));
            }
            self.authorize(tx).map_err(|e| bad(format!("event {} not authorised: {e}", tx.hash)))?;
            self.execute(tx).map_err(|e| bad(format!("event {} cannot execute: {e}", tx.hash)))?;
            txs.push(tx.clone());
        }
        let first = txs.first().ok_or_else(|| bad("empty block".into()))?;
        let rebuilt = self.build_block(&parent, first);
        if rebuilt.txs_root != b.block.txs_root {
            return Err(bad("txs root mismatch".into()));
        }
        if rebuilt.state_root != b.block.state_root {
            return Err(bad(format!("state root mismatch: stored {}, replayed {}", b.block.state_root, rebuilt.state_root)));
        }
        if rebuilt.hash != b.block.hash {
            return Err(bad("block hash mismatch".into()));
        }
        self.verify_block_signature(&b.block)?;
        let block = b.block.clone();
        for tx in txs {
            self.push_tx(tx);
        }
        self.blocks.push(block);
        Ok(())
    }

    fn push(&mut self, block: Block, tx: ChainTx) -> Result<SubmitResult, ChainError> {
        let r = SubmitResult { tx_hash: tx.hash, block_number: block.number, kind: tx.kind };
        self.push_tx(tx);
        self.blocks.push(block);
        Ok(r)
    }

    fn push_tx(&mut self, tx: ChainTx) {
        self.order.push(tx.hash);
        self.txs.insert(tx.hash, tx);
    }

    fn push_genesis(&mut self) -> Result<(), ChainError> {
        let key = self.validator_key.clone().ok_or(ChainError::ReadOnly)?;
        let mut g = self.genesis_block();
        g.validator_signature = Bytes::copy_from_slice(&key.sign(&block_payload(&g.hash)).to_bytes());
        self.store.append(&BlockWithTxs { block: g.clone(), txs: vec![] })?;
        self.blocks.push(g);
        Ok(())
    }

    fn genesis_block(&self) -> Block {
        let state_root = state_root_of(&BTreeMap::new(), &BTreeMap::new(), &BTreeMap::new());
        let mut b = Block {
            version: BLOCK_VERSION,
            number: 0,
            timestamp: self.cfg.genesis_time,
            hash: B256::ZERO,
            parent_hash: B256::ZERO,
            tx_hashes: vec![],
            txs_root: keccak256([]),
            state_root,
            validator_signature: Bytes::new(),
        };
        b.hash = block_hash(&b, self.cfg.chain_id);
        b
    }

    fn build_block(&self, parent: &Block, tx: &ChainTx) -> Block {
        let mut b = Block {
            version: BLOCK_VERSION,
            number: parent.number + 1,
            timestamp: tx.timestamp,
            hash: B256::ZERO,
            parent_hash: parent.hash,
            tx_hashes: vec![tx.hash],
            txs_root: keccak256(tx.hash.as_slice()),
            state_root: self.state_root(),
            validator_signature: Bytes::new(),
        };
        b.hash = block_hash(&b, self.cfg.chain_id);
        b
    }

    fn verify_block_signature(&self, b: &Block) -> Result<(), ChainError> {
        let sig: [u8; 64] = b.validator_signature.as_ref().try_into().map_err(|_| ChainError::Tampered { block: b.number, reason: "validator signature malformed".into() })?;
        self.validator
            .verify_strict(&block_payload(&b.hash), &Signature::from_bytes(&sig))
            .map_err(|_| ChainError::Tampered { block: b.number, reason: "validator signature invalid".into() })
    }

    fn stored_block(&self, n: u64) -> Option<BlockWithTxs> {
        let block = self.blocks.get(n as usize)?.clone();
        let txs = block.tx_hashes.iter().filter_map(|h| self.txs.get(h).cloned()).collect();
        Some(BlockWithTxs { block, txs })
    }

    fn view_tx(&self, hash: B256) -> Option<ChainTx> {
        let mut tx = self.txs.get(&hash)?.clone();
        tx.flags = self.flags.get(&hash).cloned().unwrap_or_default();
        Some(tx)
    }

    /// Event hash: every field a signer or auditor cares about, bound to the parent block.
    fn tx_hash(&self, tx: &ChainTx, parent_hash: B256) -> B256 {
        let mut buf = Vec::new();
        buf.extend_from_slice(TX_DOMAIN);
        buf.extend_from_slice(&tx.version.to_be_bytes());
        buf.extend_from_slice(&self.cfg.chain_id.to_be_bytes());
        buf.extend_from_slice(parent_hash.as_slice());
        buf.extend_from_slice(&tx.block_number.to_be_bytes());
        buf.extend_from_slice(&tx.timestamp.to_be_bytes());
        buf.extend_from_slice(kind_tag(tx.kind));
        buf.extend_from_slice(tx.from.as_slice());
        buf.extend_from_slice(tx.to.as_slice());
        buf.extend_from_slice(&tx.value.to_be_bytes::<32>());
        buf.extend_from_slice(keccak256(&tx.data).as_slice());
        buf.extend_from_slice(&tx.nonce.to_be_bytes());
        buf.extend_from_slice(tx.user_op_hash.as_slice());
        buf.extend_from_slice(keccak256(json_bytes(&tx.owner_signature)).as_slice());
        buf.extend_from_slice(keccak256(tx.cosignature.as_ref().map(|c| c.as_ref()).unwrap_or(&[])).as_slice());
        buf.extend_from_slice(keccak256(json_bytes(&tx.extra)).as_slice());
        keccak256(buf)
    }

    fn state_root(&self) -> B256 {
        state_root_of(&self.accounts, &self.balances, &self.allowances)
    }

    // ----- authorisation (same code for live submissions and replay) -----

    fn authorize(&self, tx: &ChainTx) -> Result<(), ChainError> {
        match tx.kind {
            TxKind::AccountCreated => {
                let owner: OwnerKey = extra_field(tx, "owner")?;
                owner.validate().map_err(|_| ChainError::BadOwnerSignature)?;
                if Self::address_for(&owner) != tx.from {
                    return Err(ChainError::MalformedEvent("account address does not derive from owner key".into()));
                }
                if self.accounts.contains_key(&tx.from) {
                    return Err(ChainError::AccountExists(tx.from));
                }
                Ok(())
            }
            TxKind::Faucet => match tx.action.asset() {
                Some(t) if !self.tokens.contains_key(&t) => Err(ChainError::UnknownToken(t)),
                _ => Ok(()),
            },
            TxKind::Cosigned | TxKind::EscapeExit => {
                let acc = self.account_for(tx)?;
                let hash = self.user_op_hash_parts(tx.from, tx.to, tx.value, &tx.data, tx.nonce);
                self.check_hash_and_owner(tx, acc, hash)?;
                match (&tx.kind, &tx.cosignature) {
                    (TxKind::Cosigned, Some(sig)) => self.verify_cosignature(&hash, sig),
                    (TxKind::Cosigned, None) => Err(ChainError::MissingCosignature),
                    (_, _) => {
                        let escape = acc.escape.as_ref().ok_or(ChainError::EscapeNotStarted)?;
                        if tx.timestamp < escape.unlock_at {
                            return Err(ChainError::EscapeLocked { unlock_at: escape.unlock_at });
                        }
                        if tx.action.counterparty() != Some(escape.to) || matches!(tx.action, DecodedAction::Erc20Approve { .. }) {
                            return Err(ChainError::EscapeWrongRecipient(escape.to));
                        }
                        Ok(())
                    }
                }
            }
            TxKind::EscapeStart => {
                let acc = self.account_for(tx)?;
                self.check_hash_and_owner(tx, acc, self.escape_hash(tx.from, tx.to, tx.nonce))
            }
            TxKind::EscapeCancel => {
                let acc = self.account_for(tx)?;
                if acc.escape.is_none() {
                    return Err(ChainError::EscapeNotStarted);
                }
                self.check_hash_and_owner(tx, acc, self.escape_cancel_hash(tx.from, tx.nonce))
            }
            TxKind::OwnerRotation => {
                let acc = self.account_for(tx)?;
                let new_owner: OwnerKey = extra_field(tx, "new_owner")?;
                new_owner.validate().map_err(|_| ChainError::BadOwnerSignature)?;
                if tx.nonce != acc.nonce {
                    return Err(ChainError::BadNonce { expected: acc.nonce, got: tx.nonce });
                }
                let hash = self.rotate_hash(tx.from, &new_owner, tx.nonce);
                if tx.user_op_hash != hash {
                    return Err(ChainError::MalformedEvent("rotation hash mismatch".into()));
                }
                let sig = tx.cosignature.as_ref().ok_or(ChainError::MissingCosignature)?;
                self.verify_cosignature(&hash, sig)
            }
            TxKind::Anchor => {
                if !self.accounts.contains_key(&tx.from) {
                    return Err(ChainError::UnknownAccount(tx.from));
                }
                let sig = tx.cosignature.as_ref().ok_or(ChainError::MissingCosignature)?;
                self.verify_cosignature(&self.anchor_hash(tx.from, tx.user_op_hash), sig)
            }
            TxKind::Flag => {
                let flag: Flag = extra_field(tx, "flag")?;
                if !self.txs.contains_key(&flag.target) {
                    return Err(ChainError::UnknownTx(flag.target));
                }
                Ok(())
            }
        }
    }

    fn account_for(&self, tx: &ChainTx) -> Result<&Account, ChainError> {
        self.accounts.get(&tx.from).ok_or(ChainError::UnknownAccount(tx.from))
    }

    fn check_hash_and_owner(&self, tx: &ChainTx, acc: &Account, expected: B256) -> Result<(), ChainError> {
        if tx.nonce != acc.nonce {
            return Err(ChainError::BadNonce { expected: acc.nonce, got: tx.nonce });
        }
        if tx.user_op_hash != expected {
            return Err(ChainError::MalformedEvent("signed hash does not match event".into()));
        }
        let sig = tx.owner_signature.as_ref().ok_or(ChainError::BadOwnerSignature)?;
        if !verify_owner(&acc.owner, &expected, sig) {
            return Err(ChainError::BadOwnerSignature);
        }
        Ok(())
    }

    fn verify_cosignature(&self, hash: &B256, sig: &Bytes) -> Result<(), ChainError> {
        let arr: [u8; 64] = sig.as_ref().try_into().map_err(|_| ChainError::BadCosignature)?;
        self.cfg.cosigner.verify_strict(&cosign_payload(hash), &Signature::from_bytes(&arr)).map_err(|_| ChainError::BadCosignature)
    }

    // ----- execution -----

    fn execute(&mut self, tx: &ChainTx) -> Result<(), ChainError> {
        match tx.kind {
            TxKind::AccountCreated => {
                let owner: OwnerKey = extra_field(tx, "owner")?;
                self.accounts.insert(tx.from, Account { owner, nonce: 0, escape: None, created_block: tx.block_number });
            }
            TxKind::Faucet => {
                self.credit(tx.action.counterparty().unwrap_or(tx.to), tx.action.asset(), tx.action.amount());
            }
            TxKind::Cosigned | TxKind::EscapeExit => {
                self.apply(tx.from, &tx.action)?;
                self.bump_nonce(tx.from);
            }
            TxKind::EscapeStart => {
                let unlock_at = tx.timestamp + self.cfg.escape_delay_secs;
                if let Some(a) = self.accounts.get_mut(&tx.from) {
                    a.escape = Some(Escape { to: tx.to, started_at: tx.timestamp, unlock_at });
                }
                self.bump_nonce(tx.from);
            }
            TxKind::EscapeCancel => {
                if let Some(a) = self.accounts.get_mut(&tx.from) {
                    a.escape = None;
                }
                self.bump_nonce(tx.from);
            }
            TxKind::OwnerRotation => {
                let new_owner: OwnerKey = extra_field(tx, "new_owner")?;
                if let Some(a) = self.accounts.get_mut(&tx.from) {
                    a.owner = new_owner;
                    a.escape = None;
                }
                self.bump_nonce(tx.from);
            }
            TxKind::Anchor => {}
            TxKind::Flag => {
                let flag: Flag = extra_field(tx, "flag")?;
                self.flags.entry(flag.target).or_default().push(flag);
            }
        }
        Ok(())
    }

    fn bump_nonce(&mut self, address: Address) {
        if let Some(a) = self.accounts.get_mut(&address) {
            a.nonce += 1;
        }
    }

    fn nonce_of(&self, address: Address) -> Result<u64, ChainError> {
        self.accounts.get(&address).map(|a| a.nonce).ok_or(ChainError::UnknownAccount(address))
    }

    fn check_chain(&self, chain_id: u64) -> Result<(), ChainError> {
        if chain_id != self.cfg.chain_id {
            return Err(ChainError::WrongChain { expected: self.cfg.chain_id, got: chain_id });
        }
        Ok(())
    }

    fn symbol(&self, asset: Option<Address>) -> String {
        asset.and_then(|a| self.tokens.get(&a).map(|t| t.symbol.clone())).unwrap_or_else(|| "ETH".into())
    }

    fn credit(&mut self, to: Address, asset: Option<Address>, amount: U256) {
        let b = self.balances.entry(to).or_default();
        match asset {
            None => b.native = b.native.saturating_add(amount),
            Some(t) => {
                let e = b.tokens.entry(t).or_insert(U256::ZERO);
                *e = e.saturating_add(amount);
            }
        }
    }

    fn debit(&mut self, from: Address, asset: Option<Address>, amount: U256) -> Result<(), ChainError> {
        let have = {
            let b = self.balances.get(&from).cloned().unwrap_or_default();
            match asset {
                None => b.native,
                Some(t) => b.tokens.get(&t).copied().unwrap_or(U256::ZERO),
            }
        };
        if have < amount {
            return Err(ChainError::InsufficientBalance { symbol: self.symbol(asset), have, need: amount });
        }
        let b = self.balances.entry(from).or_default();
        match asset {
            None => b.native -= amount,
            Some(t) => {
                if let Some(e) = b.tokens.get_mut(&t) {
                    *e -= amount;
                }
            }
        }
        Ok(())
    }

    fn apply(&mut self, from: Address, action: &DecodedAction) -> Result<(), ChainError> {
        match action {
            DecodedAction::NativeTransfer { to, amount } => {
                self.debit(from, None, *amount)?;
                self.credit(*to, None, *amount);
            }
            DecodedAction::Erc20Transfer { token, to, amount } => {
                if !self.tokens.contains_key(token) {
                    return Err(ChainError::UnknownToken(*token));
                }
                self.debit(from, Some(*token), *amount)?;
                self.credit(*to, Some(*token), *amount);
            }
            DecodedAction::Erc20Approve { token, spender, amount, .. } => {
                if !self.tokens.contains_key(token) {
                    return Err(ChainError::UnknownToken(*token));
                }
                self.allowances.insert((*spender, from, *token), *amount);
            }
            DecodedAction::ContractCall { target, value, .. } => {
                if *value > U256::ZERO {
                    self.debit(from, None, *value)?;
                    self.credit(*target, None, *value);
                }
            }
            DecodedAction::TypedData { .. } => {}
        }
        Ok(())
    }
}

// ----- free helpers -----

fn selector(sig: &[u8]) -> Bytes {
    Bytes::copy_from_slice(&keccak256(sig)[..4])
}

fn kind_tag(k: TxKind) -> &'static [u8] {
    match k {
        TxKind::AccountCreated => b"account_created",
        TxKind::Faucet => b"faucet",
        TxKind::Cosigned => b"cosigned",
        TxKind::EscapeStart => b"escape_start",
        TxKind::EscapeCancel => b"escape_cancel",
        TxKind::EscapeExit => b"escape_exit",
        TxKind::OwnerRotation => b"owner_rotation",
        TxKind::Anchor => b"anchor",
        TxKind::Flag => b"flag",
    }
}

fn json_bytes<T: serde::Serialize>(v: &T) -> Vec<u8> {
    serde_json::to_vec(v).unwrap_or_default()
}

fn extra_field<T: serde::de::DeserializeOwned>(tx: &ChainTx, key: &str) -> Result<T, ChainError> {
    let v = tx.extra.get(key).ok_or_else(|| ChainError::MalformedEvent(format!("missing extra.{key}")))?;
    serde_json::from_value(v.clone()).map_err(|e| ChainError::MalformedEvent(format!("extra.{key}: {e}")))
}

fn block_payload(hash: &B256) -> Vec<u8> {
    [BLOCK_DOMAIN, hash.as_slice()].concat()
}

fn block_hash(b: &Block, chain_id: u64) -> B256 {
    let mut buf = Vec::new();
    buf.extend_from_slice(BLOCK_DOMAIN);
    buf.extend_from_slice(&b.version.to_be_bytes());
    buf.extend_from_slice(&chain_id.to_be_bytes());
    buf.extend_from_slice(&b.number.to_be_bytes());
    buf.extend_from_slice(&b.timestamp.to_be_bytes());
    buf.extend_from_slice(b.parent_hash.as_slice());
    buf.extend_from_slice(b.txs_root.as_slice());
    buf.extend_from_slice(b.state_root.as_slice());
    keccak256(buf)
}

/// Sequential commitment over the whole state in canonical (sorted) order. A Merkle tree would
/// allow proofs per account; this is enough to detect any change.
fn state_root_of(accounts: &BTreeMap<Address, Account>, balances: &BTreeMap<Address, Balances>, allowances: &BTreeMap<(Address, Address, Address), U256>) -> B256 {
    let mut buf = Vec::new();
    buf.extend_from_slice(STATE_DOMAIN);
    for (addr, a) in accounts {
        buf.extend_from_slice(addr.as_slice());
        buf.extend_from_slice(&a.nonce.to_be_bytes());
        buf.extend_from_slice(&a.created_block.to_be_bytes());
        buf.extend_from_slice(keccak256(json_bytes(&a.owner)).as_slice());
        match &a.escape {
            None => buf.push(0),
            Some(e) => {
                buf.push(1);
                buf.extend_from_slice(e.to.as_slice());
                buf.extend_from_slice(&e.started_at.to_be_bytes());
                buf.extend_from_slice(&e.unlock_at.to_be_bytes());
            }
        }
    }
    for (addr, b) in balances {
        buf.extend_from_slice(addr.as_slice());
        buf.extend_from_slice(&b.native.to_be_bytes::<32>());
        for (t, amt) in &b.tokens {
            buf.extend_from_slice(t.as_slice());
            buf.extend_from_slice(&amt.to_be_bytes::<32>());
        }
    }
    for ((s, o, t), amt) in allowances {
        buf.extend_from_slice(s.as_slice());
        buf.extend_from_slice(o.as_slice());
        buf.extend_from_slice(t.as_slice());
        buf.extend_from_slice(&amt.to_be_bytes::<32>());
    }
    keccak256(buf)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use crate::chain::JsonlBlockStore;
    use crate::signer::{Ed25519Signer, ReceiptSigner};
    use wallet_core::RiskBand;
    use wallet_core::tx::{SEL_TRANSFER, encode_erc20_call};

    const CHAIN: u64 = 84532;

    struct Owner(SigningKey);
    impl Owner {
        fn new(seed: u8) -> Self {
            Self(SigningKey::from_bytes(&[seed; 32]))
        }
        fn key(&self) -> OwnerKey {
            OwnerKey::Ed25519 { key: Bytes::copy_from_slice(self.0.verifying_key().as_bytes()) }
        }
        fn sign(&self, h: &B256) -> OwnerSignature {
            OwnerSignature::Ed25519 { signature: Bytes::copy_from_slice(&self.0.sign(h.as_slice()).to_bytes()) }
        }
    }

    fn usdc() -> Address {
        Address::repeat_byte(0xAA)
    }

    fn cfg(sq: &Ed25519Signer) -> ChainConfig {
        ChainConfig {
            chain_id: CHAIN,
            cosigner: sq.verifying_key(),
            escape_delay_secs: 600,
            tokens: vec![TokenInfo { address: usdc(), symbol: "USDC".into(), decimals: 6 }],
            genesis_time: 1_000,
        }
    }

    fn validator() -> SigningKey {
        SigningKey::from_bytes(&[99u8; 32])
    }

    fn setup() -> (MockChain, Ed25519Signer, Owner, Address) {
        let sq = Ed25519Signer::from_seed([42u8; 32]);
        let mut chain = MockChain::in_memory(cfg(&sq), validator()).unwrap();
        let owner = Owner::new(1);
        let addr = chain.create_account(owner.key(), 1_000).unwrap();
        chain.fund(addr, None, U256::from(10u64.pow(18)), 1_001).unwrap();
        chain.fund(addr, Some(usdc()), U256::from(500_000_000u64), 1_002).unwrap();
        (chain, sq, owner, addr)
    }

    fn usdc_tx(from: Address, to: Address, amount: u64) -> TxRequest {
        TxRequest { chain_id: CHAIN, from, to: usdc(), value: U256::ZERO, data: encode_erc20_call(SEL_TRANSFER, to, U256::from(amount)), origin: None }
    }

    fn cosigned(chain: &MockChain, sq: &Ed25519Signer, owner: &Owner, tx: TxRequest) -> SignedUserOp {
        let prep = chain.prepare(&tx).unwrap();
        SignedUserOp { tx, nonce: prep.nonce, owner_signature: owner.sign(&prep.user_op_hash), cosignature: Some(sq.cosign(&prep.user_op_hash)) }
    }

    #[test]
    fn cosigned_transfer_moves_funds_and_mines_signed_block() {
        let (mut chain, sq, owner, addr) = setup();
        let to = Address::repeat_byte(0x22);
        let op = cosigned(&chain, &sq, &owner, usdc_tx(addr, to, 100_000_000));
        let r = chain.submit(&op, 1_010).unwrap();
        assert_eq!(r.kind, TxKind::Cosigned);
        assert_eq!(r.block_number, 4); // genesis, account, 2 faucets, then this
        assert_eq!(chain.balances_of(to)[1].amount, U256::from(100_000_000u64));
        assert_eq!(chain.account(addr, 1_010).unwrap().nonce, 1);
        assert_eq!(chain.history(addr).len(), 4);
        let v = chain.verify();
        assert!(v.ok, "{v:?}");
        assert_eq!(v.blocks_checked, 5);
        assert_eq!(chain.latest().validator_signature.len(), 64);
    }

    #[test]
    fn rejects_missing_or_forged_cosignature_and_bad_owner_and_nonce() {
        let (mut chain, sq, owner, addr) = setup();
        let tx = usdc_tx(addr, Address::repeat_byte(0x22), 1);
        let prep = chain.prepare(&tx).unwrap();
        let good_owner = owner.sign(&prep.user_op_hash);

        let no_cosig = SignedUserOp { tx: tx.clone(), nonce: 0, owner_signature: good_owner.clone(), cosignature: None };
        assert_eq!(chain.submit(&no_cosig, 1_010).unwrap_err(), ChainError::EscapeNotStarted);

        let other = Ed25519Signer::from_seed([9u8; 32]);
        let forged = SignedUserOp { tx: tx.clone(), nonce: 0, owner_signature: good_owner.clone(), cosignature: Some(other.cosign(&prep.user_op_hash)) };
        assert_eq!(chain.submit(&forged, 1_010).unwrap_err(), ChainError::BadCosignature);

        let wrong_owner = SignedUserOp { tx: tx.clone(), nonce: 0, owner_signature: Owner::new(2).sign(&prep.user_op_hash), cosignature: Some(sq.cosign(&prep.user_op_hash)) };
        assert_eq!(chain.submit(&wrong_owner, 1_010).unwrap_err(), ChainError::BadOwnerSignature);

        let bad_nonce = SignedUserOp { tx, nonce: 3, owner_signature: good_owner, cosignature: Some(sq.cosign(&prep.user_op_hash)) };
        assert_eq!(chain.submit(&bad_nonce, 1_010).unwrap_err(), ChainError::BadNonce { expected: 0, got: 3 });
        assert_eq!(chain.latest().number, 3, "rejected submissions mine nothing");
    }

    #[test]
    fn insufficient_balance_is_rejected_without_state_change() {
        let (mut chain, sq, owner, addr) = setup();
        let op = cosigned(&chain, &sq, &owner, usdc_tx(addr, Address::repeat_byte(0x22), 999_000_000_000));
        assert!(matches!(chain.submit(&op, 1_010).unwrap_err(), ChainError::InsufficientBalance { .. }));
        assert_eq!(chain.account(addr, 1_010).unwrap().nonce, 0);
        assert!(chain.verify().ok);
    }

    #[test]
    fn escape_hatch_respects_timelock_then_exits_without_swissquote() {
        let (mut chain, _sq, owner, addr) = setup();
        let exit_to = Address::repeat_byte(0x33);
        let h = chain.escape_hash(addr, exit_to, 0);
        let (status, _) = chain.start_escape_hatch(addr, exit_to, &owner.sign(&h), 2_000).unwrap();
        assert!(matches!(status, EscapeStatus::Pending { unlock_at: 2_600, .. }));

        let tx = usdc_tx(addr, exit_to, 500_000_000);
        let prep = chain.prepare(&tx).unwrap();
        assert_eq!(prep.nonce, 1);
        let op = SignedUserOp { tx: tx.clone(), nonce: 1, owner_signature: owner.sign(&prep.user_op_hash), cosignature: None };
        assert_eq!(chain.submit(&op, 2_100).unwrap_err(), ChainError::EscapeLocked { unlock_at: 2_600 });

        let wrong = usdc_tx(addr, Address::repeat_byte(0x44), 1);
        let p2 = chain.prepare(&wrong).unwrap();
        let op2 = SignedUserOp { tx: wrong, nonce: 1, owner_signature: owner.sign(&p2.user_op_hash), cosignature: None };
        assert_eq!(chain.submit(&op2, 2_700).unwrap_err(), ChainError::EscapeWrongRecipient(exit_to));

        let r = chain.submit(&op, 2_700).unwrap();
        assert_eq!(r.kind, TxKind::EscapeExit);
        assert_eq!(chain.balances_of(exit_to)[1].amount, U256::from(500_000_000u64));
        assert!(chain.verify().ok);
    }

    #[test]
    fn escape_cancel_requires_owner_and_clears_state() {
        let (mut chain, _sq, owner, addr) = setup();
        let h = chain.escape_hash(addr, Address::repeat_byte(0x33), 0);
        chain.start_escape_hatch(addr, Address::repeat_byte(0x33), &owner.sign(&h), 2_000).unwrap();
        let c = chain.escape_cancel_hash(addr, 1);
        assert_eq!(chain.cancel_escape_hatch(addr, &Owner::new(2).sign(&c), 2_001).unwrap_err(), ChainError::BadOwnerSignature);
        chain.cancel_escape_hatch(addr, &owner.sign(&c), 2_001).unwrap();
        assert_eq!(chain.account(addr, 9_999).unwrap().escape, EscapeStatus::Inactive);
    }

    #[test]
    fn owner_rotation_needs_swissquote_and_old_owner_stops_working() {
        let (mut chain, sq, owner, addr) = setup();
        let new_owner = Owner::new(5);
        let h = chain.rotate_hash(addr, &new_owner.key(), 0);
        assert_eq!(chain.rotate_owner(addr, new_owner.key(), &Bytes::from(vec![0u8; 64]), 3_000).unwrap_err(), ChainError::BadCosignature);
        chain.rotate_owner(addr, new_owner.key(), &sq.cosign(&h), 3_000).unwrap();

        let tx = usdc_tx(addr, Address::repeat_byte(0x22), 1);
        let prep = chain.prepare(&tx).unwrap();
        let old = SignedUserOp { tx: tx.clone(), nonce: prep.nonce, owner_signature: owner.sign(&prep.user_op_hash), cosignature: Some(sq.cosign(&prep.user_op_hash)) };
        assert_eq!(chain.submit(&old, 3_001).unwrap_err(), ChainError::BadOwnerSignature);
        let fresh = SignedUserOp { tx, nonce: prep.nonce, owner_signature: new_owner.sign(&prep.user_op_hash), cosignature: Some(sq.cosign(&prep.user_op_hash)) };
        chain.submit(&fresh, 3_001).unwrap();
        assert!(chain.verify().ok);
    }

    #[test]
    fn simulate_shows_delta_without_mutating() {
        let (chain, _, _, addr) = setup();
        let deltas = chain.simulate(&usdc_tx(addr, Address::repeat_byte(0x22), 100_000_000)).unwrap();
        let usdc_delta = deltas.iter().find(|d| d.asset == Some(usdc())).unwrap();
        assert_eq!(usdc_delta.before, U256::from(500_000_000u64));
        assert_eq!(usdc_delta.after, U256::from(400_000_000u64));
        assert_eq!(chain.balances_of(addr)[1].amount, U256::from(500_000_000u64));
    }

    #[test]
    fn anchor_requires_cosignature_and_flags_are_append_only_and_deduped() {
        let (mut chain, sq, owner, addr) = setup();
        let head = B256::repeat_byte(0x77);
        assert_eq!(chain.anchor(addr, head, &Bytes::from(vec![0u8; 64]), 1_500).unwrap_err(), ChainError::BadCosignature);
        let h = chain.anchor_hash(addr, head);
        chain.anchor(addr, head, &sq.cosign(&h), 1_500).unwrap();

        let op = cosigned(&chain, &sq, &owner, usdc_tx(addr, Address::repeat_byte(0x22), 5));
        let r = chain.submit(&op, 1_600).unwrap();
        let flag = Flag { code: "TEST".into(), severity: RiskBand::High, source: super::super::FlagSource::Review, message: "m".into(), at: 1_700, target: r.tx_hash, data: BTreeMap::new() };
        assert!(chain.flag(flag.clone(), 1_700).unwrap().is_some());
        assert!(chain.flag(flag.clone(), 1_701).unwrap().is_none(), "same code+source is deduped");
        assert_eq!(chain.tx(r.tx_hash).unwrap().flags, vec![flag.clone()]);
        assert_eq!(chain.account(addr, 1_800).unwrap().flags.len(), 1);
        let v = chain.verify();
        assert!(v.ok, "{v:?}");
        assert_eq!(chain.flag(Flag { target: B256::repeat_byte(1), ..flag }, 1_702).unwrap_err(), ChainError::UnknownTx(B256::repeat_byte(1)));
    }

    #[test]
    fn tampering_is_detected_in_every_form() {
        let (mut chain, sq, owner, addr) = setup();
        let op = cosigned(&chain, &sq, &owner, usdc_tx(addr, Address::repeat_byte(0x22), 5));
        let r = chain.submit(&op, 1_600).unwrap();
        assert!(chain.verify().ok);

        let snapshot_root = chain.state_root();
        chain.tamper(&Tamper::Balance { address: addr, asset: Some(usdc()), amount: U256::from(1u64) }).unwrap();
        let v = chain.verify();
        assert!(!v.ok);
        assert!(v.reason.unwrap().contains("live state root"));
        chain.tamper(&Tamper::Balance { address: addr, asset: Some(usdc()), amount: U256::from(499_999_995u64) }).unwrap();
        assert_eq!(chain.state_root(), snapshot_root);
        assert!(chain.verify().ok);

        chain.tamper(&Tamper::TxValue { hash: r.tx_hash, value: U256::from(1u64) }).unwrap();
        let v = chain.verify();
        assert_eq!(v.first_bad_block, Some(4));
        assert!(v.reason.unwrap().contains("does not match its hash"));
        chain.tamper(&Tamper::TxValue { hash: r.tx_hash, value: U256::ZERO }).unwrap();
        assert!(chain.verify().ok);

        chain.tamper(&Tamper::BlockParent { number: 2 }).unwrap();
        let v = chain.verify();
        assert_eq!(v.first_bad_block, Some(2));
    }

    #[test]
    fn persisted_chain_replays_identically_and_rejects_an_edited_file() {
        let dir = std::env::temp_dir().join(format!("sqw-chain-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("chain.jsonl");
        let _ = std::fs::remove_file(&path);
        let sq = Ed25519Signer::from_seed([42u8; 32]);
        let owner = Owner::new(1);
        let (head, addr) = {
            let mut chain = MockChain::new(cfg(&sq), validator(), Box::new(JsonlBlockStore::new(path.clone()))).unwrap();
            let addr = chain.create_account(owner.key(), 1_000).unwrap();
            chain.fund(addr, Some(usdc()), U256::from(500_000_000u64), 1_002).unwrap();
            let op = cosigned(&chain, &sq, &owner, usdc_tx(addr, Address::repeat_byte(0x22), 5));
            chain.submit(&op, 1_600).unwrap();
            (chain.latest(), addr)
        };
        // a later process has a different clock: the stored genesis wins
        let mut later = cfg(&sq);
        later.genesis_time = 99_999;
        let reopened = MockChain::new(later, validator(), Box::new(JsonlBlockStore::new(path.clone()))).unwrap();
        assert_eq!(reopened.latest(), head);
        assert_eq!(reopened.account(addr, 2_000).unwrap().nonce, 1);
        assert!(reopened.verify().ok);

        // wrong validator: every block signature fails
        let err = MockChain::new(cfg(&sq), SigningKey::from_bytes(&[1u8; 32]), Box::new(JsonlBlockStore::new(path.clone()))).unwrap_err();
        assert!(matches!(err, ChainError::Tampered { block: 0, .. }), "{err}");

        // edit one amount in the file: detected at that block
        let text = std::fs::read_to_string(&path).unwrap();
        let edited = text.replacen("\"amount\":\"0x5\"", "\"amount\":\"0x500\"", 1);
        assert_ne!(text, edited);
        std::fs::write(&path, edited).unwrap();
        let err = MockChain::new(cfg(&sq), validator(), Box::new(JsonlBlockStore::new(path.clone()))).unwrap_err();
        assert!(matches!(err, ChainError::Tampered { block: 3, .. }), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
