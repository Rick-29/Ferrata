use std::collections::{BTreeMap, HashMap};

use alloy_primitives::{Address, B256, Bytes, U256, keccak256};
use ed25519_dalek::{Signature, VerifyingKey};
use wallet_core::{AbiTxDecoder, BalanceDelta, DecodedAction, TxDecoder, TxRequest};

use super::auth::{OwnerKey, OwnerSignature, verify_owner};
use super::{
    AccountView, AssetBalance, Block, ChainError, ChainInfo, ChainTx, EscapeStatus, PreparedOp, SignedUserOp,
    SubmitResult, TokenInfo, TxKind,
};
use crate::signer::cosign_payload;

const USEROP_DOMAIN: &[u8] = b"SQW-USEROP-v1";
const ESCAPE_DOMAIN: &[u8] = b"SQW-ESCAPE-v1";
const ESCAPE_CANCEL_DOMAIN: &[u8] = b"SQW-ESCAPE-CANCEL-v1";
const ROTATE_DOMAIN: &[u8] = b"SQW-ROTATE-v1";

#[derive(Debug, Clone)]
struct Escape {
    to: Address,
    started_at: u64,
    unlock_at: u64,
}

#[derive(Debug, Clone)]
struct Account {
    owner: OwnerKey,
    nonce: u64,
    escape: Option<Escape>,
    created_block: u64,
}

/// Balances exist for any address (accounts, EOAs, faucet recipients); accounts add signing rules.
#[derive(Debug, Clone, Default)]
struct Balances {
    native: U256,
    tokens: HashMap<Address, U256>,
}

pub struct MockChain {
    chain_id: u64,
    cosigner: VerifyingKey,
    escape_delay_secs: u64,
    decoder: AbiTxDecoder,
    tokens: BTreeMap<Address, TokenInfo>,
    accounts: HashMap<Address, Account>,
    balances: HashMap<Address, Balances>,
    /// `spender -> (owner, token) -> allowance`, recorded so approvals show up in simulation and history.
    allowances: HashMap<(Address, Address, Address), U256>,
    blocks: Vec<Block>,
    txs: HashMap<B256, ChainTx>,
}

impl MockChain {
    pub fn new(chain_id: u64, cosigner: VerifyingKey, escape_delay_secs: u64, genesis_time: u64) -> Self {
        let genesis = Block {
            number: 0,
            timestamp: genesis_time,
            hash: keccak256(b"SQW-GENESIS"),
            parent_hash: B256::ZERO,
            tx_hashes: vec![],
        };
        Self {
            chain_id,
            cosigner,
            escape_delay_secs,
            decoder: AbiTxDecoder::new(),
            tokens: BTreeMap::new(),
            accounts: HashMap::new(),
            balances: HashMap::new(),
            allowances: HashMap::new(),
            blocks: vec![genesis],
            txs: HashMap::new(),
        }
    }

    pub fn add_token(&mut self, info: TokenInfo) {
        self.tokens.insert(info.address, info);
    }

    pub fn chain_id(&self) -> u64 {
        self.chain_id
    }

    pub fn info(&self) -> ChainInfo {
        ChainInfo {
            chain_id: self.chain_id,
            latest_block: self.latest().number,
            cosigner: hex::encode(self.cosigner.as_bytes()),
            escape_delay_secs: self.escape_delay_secs,
            tokens: self.tokens.values().cloned().collect(),
        }
    }

    // ----- accounts -----

    /// Counterfactual address: last 20 bytes of keccak(owner key bytes).
    pub fn address_for(owner: &OwnerKey) -> Address {
        Address::from_slice(&keccak256(owner.bytes())[12..])
    }

    pub fn create_account(&mut self, owner: OwnerKey) -> Result<Address, ChainError> {
        owner.validate().map_err(|_| ChainError::BadOwnerSignature)?;
        let address = Self::address_for(&owner);
        if self.accounts.contains_key(&address) {
            return Err(ChainError::AccountExists(address));
        }
        let created_block = self.latest().number;
        self.accounts.insert(address, Account { owner, nonce: 0, escape: None, created_block });
        Ok(address)
    }

    pub fn account(&self, address: Address, now: u64) -> Result<AccountView, ChainError> {
        let acc = self.accounts.get(&address).ok_or(ChainError::UnknownAccount(address))?;
        Ok(AccountView {
            address,
            owner: acc.owner.clone(),
            cosigner: hex::encode(self.cosigner.as_bytes()),
            nonce: acc.nonce,
            balances: self.balances_of(address),
            escape: match &acc.escape {
                None => EscapeStatus::Inactive,
                Some(e) if now >= e.unlock_at => EscapeStatus::Unlocked { to: e.to, unlock_at: e.unlock_at },
                Some(e) => EscapeStatus::Pending { to: e.to, started_at: e.started_at, unlock_at: e.unlock_at },
            },
            created_block: acc.created_block,
        })
    }

    pub fn has_account(&self, address: Address) -> bool {
        self.accounts.contains_key(&address)
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

    /// Faucet / demo seeding: credits without signatures and records a `Faucet` tx.
    pub fn fund(&mut self, to: Address, asset: Option<Address>, amount: U256, now: u64) -> Result<SubmitResult, ChainError> {
        if let Some(t) = asset
            && !self.tokens.contains_key(&t)
        {
            return Err(ChainError::UnknownToken(t));
        }
        self.credit(to, asset, amount);
        let (action, to_field, value, data) = match asset {
            None => (DecodedAction::NativeTransfer { to, amount }, to, amount, Bytes::new()),
            Some(token) => (
                DecodedAction::Erc20Transfer { token, to, amount },
                token,
                U256::ZERO,
                wallet_core::tx::encode_erc20_call(wallet_core::tx::SEL_TRANSFER, to, amount),
            ),
        };
        Ok(self.mine(Address::ZERO, to_field, value, data, 0, B256::ZERO, action, TxKind::Faucet, now))
    }

    // ----- user operations -----

    pub fn user_op_hash(&self, tx: &TxRequest, nonce: u64) -> B256 {
        let mut buf = Vec::with_capacity(USEROP_DOMAIN.len() + 8 + 20 + 20 + 32 + 32 + 8);
        buf.extend_from_slice(USEROP_DOMAIN);
        buf.extend_from_slice(&self.chain_id.to_be_bytes());
        buf.extend_from_slice(tx.from.as_slice());
        buf.extend_from_slice(tx.to.as_slice());
        buf.extend_from_slice(&tx.value.to_be_bytes::<32>());
        buf.extend_from_slice(keccak256(&tx.data).as_slice());
        buf.extend_from_slice(&nonce.to_be_bytes());
        keccak256(buf)
    }

    fn auth_hash(&self, domain: &[u8], address: Address, subject: &[u8], nonce: u64) -> B256 {
        let mut buf = Vec::new();
        buf.extend_from_slice(domain);
        buf.extend_from_slice(&self.chain_id.to_be_bytes());
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
        let acc = self.accounts.get(&op.tx.from).ok_or(ChainError::UnknownAccount(op.tx.from))?.clone();
        if op.nonce != acc.nonce {
            return Err(ChainError::BadNonce { expected: acc.nonce, got: op.nonce });
        }
        let hash = self.user_op_hash(&op.tx, op.nonce);
        if !verify_owner(&acc.owner, &hash, &op.owner_signature) {
            return Err(ChainError::BadOwnerSignature);
        }
        let action = self.decoder.decode(&op.tx)?;

        let kind = match &op.cosignature {
            Some(sig) => {
                self.verify_cosignature(&hash, sig)?;
                TxKind::Cosigned
            }
            None => {
                let escape = acc.escape.as_ref().ok_or(ChainError::EscapeNotStarted)?;
                if now < escape.unlock_at {
                    return Err(ChainError::EscapeLocked { unlock_at: escape.unlock_at });
                }
                if action.counterparty() != Some(escape.to) || matches!(action, DecodedAction::Erc20Approve { .. }) {
                    return Err(ChainError::EscapeWrongRecipient(escape.to));
                }
                TxKind::EscapeExit
            }
        };

        self.apply(op.tx.from, &action)?;
        if let Some(a) = self.accounts.get_mut(&op.tx.from) {
            a.nonce += 1;
        }
        let tx = self.mine(op.tx.from, op.tx.to, op.tx.value, op.tx.data.clone(), op.nonce, hash, action, kind, now);
        Ok(tx)
    }

    // ----- escape hatch -----

    pub fn start_escape_hatch(&mut self, address: Address, to: Address, sig: &OwnerSignature, now: u64) -> Result<(EscapeStatus, SubmitResult), ChainError> {
        let acc = self.accounts.get(&address).ok_or(ChainError::UnknownAccount(address))?.clone();
        let hash = self.escape_hash(address, to, acc.nonce);
        if !verify_owner(&acc.owner, &hash, sig) {
            return Err(ChainError::BadOwnerSignature);
        }
        let unlock_at = now + self.escape_delay_secs;
        if let Some(a) = self.accounts.get_mut(&address) {
            a.escape = Some(Escape { to, started_at: now, unlock_at });
            a.nonce += 1;
        }
        let action = DecodedAction::ContractCall { target: address, selector: Bytes::copy_from_slice(&keccak256(b"startEscapeHatch(address)")[..4]), value: U256::ZERO };
        let r = self.mine(address, address, U256::ZERO, Bytes::copy_from_slice(to.as_slice()), acc.nonce, hash, action, TxKind::EscapeStart, now);
        Ok((EscapeStatus::Pending { to, started_at: now, unlock_at }, r))
    }

    pub fn cancel_escape_hatch(&mut self, address: Address, sig: &OwnerSignature, now: u64) -> Result<SubmitResult, ChainError> {
        let acc = self.accounts.get(&address).ok_or(ChainError::UnknownAccount(address))?.clone();
        if acc.escape.is_none() {
            return Err(ChainError::EscapeNotStarted);
        }
        let hash = self.escape_cancel_hash(address, acc.nonce);
        if !verify_owner(&acc.owner, &hash, sig) {
            return Err(ChainError::BadOwnerSignature);
        }
        if let Some(a) = self.accounts.get_mut(&address) {
            a.escape = None;
            a.nonce += 1;
        }
        let action = DecodedAction::ContractCall { target: address, selector: Bytes::copy_from_slice(&keccak256(b"cancelEscapeHatch()")[..4]), value: U256::ZERO };
        Ok(self.mine(address, address, U256::ZERO, Bytes::new(), acc.nonce, hash, action, TxKind::EscapeCancel, now))
    }

    // ----- recovery -----

    /// Replaces the owner key. Only Swissquote may authorise this, after its off-chain timelock.
    pub fn rotate_owner(&mut self, address: Address, new_owner: OwnerKey, cosignature: &Bytes, now: u64) -> Result<SubmitResult, ChainError> {
        new_owner.validate().map_err(|_| ChainError::BadOwnerSignature)?;
        let acc = self.accounts.get(&address).ok_or(ChainError::UnknownAccount(address))?.clone();
        let hash = self.rotate_hash(address, &new_owner, acc.nonce);
        self.verify_cosignature(&hash, cosignature)?;
        let data = Bytes::copy_from_slice(new_owner.bytes());
        if let Some(a) = self.accounts.get_mut(&address) {
            a.owner = new_owner;
            a.nonce += 1;
            a.escape = None;
        }
        let action = DecodedAction::ContractCall { target: address, selector: Bytes::copy_from_slice(&keccak256(b"rotateOwner(bytes)")[..4]), value: U256::ZERO };
        Ok(self.mine(address, address, U256::ZERO, data, acc.nonce, hash, action, TxKind::OwnerRotation, now))
    }

    // ----- reads -----

    pub fn latest(&self) -> &Block {
        self.blocks.last().unwrap_or_else(|| unreachable_genesis())
    }

    pub fn block(&self, number: u64) -> Option<&Block> {
        self.blocks.get(number as usize)
    }

    pub fn tx(&self, hash: B256) -> Result<&ChainTx, ChainError> {
        self.txs.get(&hash).ok_or(ChainError::UnknownTx(hash))
    }

    /// Every transaction that touched `address`, oldest first.
    pub fn history(&self, address: Address) -> Vec<ChainTx> {
        let mut out: Vec<ChainTx> = self
            .txs
            .values()
            .filter(|t| t.from == address || t.to == address || t.action.counterparty() == Some(address))
            .cloned()
            .collect();
        out.sort_by_key(|t| (t.block_number, t.nonce));
        out
    }

    // ----- internals -----

    fn check_chain(&self, chain_id: u64) -> Result<(), ChainError> {
        if chain_id != self.chain_id {
            return Err(ChainError::WrongChain { expected: self.chain_id, got: chain_id });
        }
        Ok(())
    }

    fn verify_cosignature(&self, hash: &B256, sig: &Bytes) -> Result<(), ChainError> {
        let arr: [u8; 64] = sig.as_ref().try_into().map_err(|_| ChainError::BadCosignature)?;
        self.cosigner
            .verify_strict(&cosign_payload(hash), &Signature::from_bytes(&arr))
            .map_err(|_| ChainError::BadCosignature)
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

    #[allow(clippy::too_many_arguments)]
    fn mine(&mut self, from: Address, to: Address, value: U256, data: Bytes, nonce: u64, user_op_hash: B256, action: DecodedAction, kind: TxKind, now: u64) -> SubmitResult {
        let parent = self.latest();
        let number = parent.number + 1;
        let parent_hash = parent.hash;
        let mut pre = Vec::new();
        pre.extend_from_slice(parent_hash.as_slice());
        pre.extend_from_slice(&number.to_be_bytes());
        pre.extend_from_slice(from.as_slice());
        pre.extend_from_slice(to.as_slice());
        pre.extend_from_slice(&nonce.to_be_bytes());
        pre.extend_from_slice(&data);
        let tx_hash = keccak256(&pre);
        let block_hash = keccak256([parent_hash.as_slice(), tx_hash.as_slice()].concat());
        let timestamp = now.max(parent.timestamp);
        self.txs.insert(tx_hash, ChainTx { hash: tx_hash, block_number: number, timestamp, from, to, value, data, nonce, user_op_hash, action, kind });
        self.blocks.push(Block { number, timestamp, hash: block_hash, parent_hash, tx_hashes: vec![tx_hash] });
        SubmitResult { tx_hash, block_number: number, kind }
    }
}

/// The genesis block is pushed in `new`, so `blocks` is never empty.
fn unreachable_genesis() -> &'static Block {
    static GENESIS: std::sync::OnceLock<Block> = std::sync::OnceLock::new();
    GENESIS.get_or_init(|| Block { number: 0, timestamp: 0, hash: B256::ZERO, parent_hash: B256::ZERO, tx_hashes: vec![] })
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use crate::signer::{Ed25519Signer, ReceiptSigner};
    use ed25519_dalek::{Signer as _, SigningKey};
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

    fn setup() -> (MockChain, Ed25519Signer, Owner, Address) {
        let sq = Ed25519Signer::from_seed([42u8; 32]);
        let mut chain = MockChain::new(CHAIN, sq.verifying_key(), 600, 1_000);
        chain.add_token(TokenInfo { address: usdc(), symbol: "USDC".into(), decimals: 6 });
        let owner = Owner::new(1);
        let addr = chain.create_account(owner.key()).unwrap();
        chain.fund(addr, None, U256::from(10u64.pow(18)), 1_001).unwrap();
        chain.fund(addr, Some(usdc()), U256::from(500_000_000u64), 1_002).unwrap();
        (chain, sq, owner, addr)
    }

    fn usdc_tx(from: Address, to: Address, amount: u64) -> TxRequest {
        TxRequest { chain_id: CHAIN, from, to: usdc(), value: U256::ZERO, data: encode_erc20_call(SEL_TRANSFER, to, U256::from(amount)), origin: None }
    }

    #[test]
    fn cosigned_transfer_moves_funds_and_mines_block() {
        let (mut chain, sq, owner, addr) = setup();
        let to = Address::repeat_byte(0x22);
        let tx = usdc_tx(addr, to, 100_000_000);
        let prep = chain.prepare(&tx).unwrap();
        let op = SignedUserOp { tx, nonce: prep.nonce, owner_signature: owner.sign(&prep.user_op_hash), cosignature: Some(sq.cosign(&prep.user_op_hash)) };
        let r = chain.submit(&op, 1_010).unwrap();
        assert_eq!(r.kind, TxKind::Cosigned);
        assert_eq!(r.block_number, 3);
        assert_eq!(chain.balances_of(to)[1].amount, U256::from(100_000_000u64));
        assert_eq!(chain.account(addr, 1_010).unwrap().nonce, 1);
        assert_eq!(chain.history(addr).len(), 3);
    }

    #[test]
    fn rejects_missing_or_forged_cosignature_and_bad_owner() {
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
    }

    #[test]
    fn insufficient_balance_is_rejected_without_state_change() {
        let (mut chain, sq, owner, addr) = setup();
        let tx = usdc_tx(addr, Address::repeat_byte(0x22), 999_000_000_000);
        let prep = chain.prepare(&tx).unwrap();
        let op = SignedUserOp { tx, nonce: 0, owner_signature: owner.sign(&prep.user_op_hash), cosignature: Some(sq.cosign(&prep.user_op_hash)) };
        assert!(matches!(chain.submit(&op, 1_010).unwrap_err(), ChainError::InsufficientBalance { .. }));
        assert_eq!(chain.account(addr, 1_010).unwrap().nonce, 0);
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
}
