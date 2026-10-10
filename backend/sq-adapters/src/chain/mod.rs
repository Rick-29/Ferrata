//! The pseudo-blockchain: an in-memory ledger that enforces the same rules the real
//! smart account enforces on Base Sepolia. Every account is 2-of-2: the owner's passkey
//! plus Swissquote's co-signature, except through the timelocked escape hatch.
//!
//! It is deterministic, instant (one block per transaction), and has no I/O. Services wrap
//! it in a mutex and expose it over HTTP so the UI can treat it as its RPC.

pub mod auth;
mod ledger;

pub use auth::{OwnerKey, OwnerSignature};
pub use ledger::MockChain;

use alloy_primitives::{Address, B256, Bytes, U256};
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use wallet_core::{CoreError, DecodedAction, TxRequest};

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ChainError {
    #[error("wrong chain id: expected {expected}, got {got}")]
    WrongChain { expected: u64, got: u64 },
    #[error("no account at {0}")]
    UnknownAccount(Address),
    #[error("account already exists at {0}")]
    AccountExists(Address),
    #[error("bad nonce: expected {expected}, got {got}")]
    BadNonce { expected: u64, got: u64 },
    #[error("owner signature invalid")]
    BadOwnerSignature,
    #[error("co-signature missing: account requires Swissquote approval")]
    MissingCosignature,
    #[error("co-signature invalid")]
    BadCosignature,
    #[error("insufficient {symbol} balance: have {have}, need {need}")]
    InsufficientBalance { symbol: String, have: U256, need: U256 },
    #[error("escape hatch not started")]
    EscapeNotStarted,
    #[error("escape hatch locked until {unlock_at}")]
    EscapeLocked { unlock_at: u64 },
    #[error("escape hatch only allows transfers to {0}")]
    EscapeWrongRecipient(Address),
    #[error("unknown token {0}")]
    UnknownToken(Address),
    #[error("unknown transaction {0}")]
    UnknownTx(B256),
    #[error(transparent)]
    Decode(#[from] CoreError),
}

impl ChainError {
    pub fn code(&self) -> &'static str {
        match self {
            ChainError::WrongChain { .. } => "CHAIN_WRONG_ID",
            ChainError::UnknownAccount(_) => "CHAIN_UNKNOWN_ACCOUNT",
            ChainError::AccountExists(_) => "CHAIN_ACCOUNT_EXISTS",
            ChainError::BadNonce { .. } => "CHAIN_BAD_NONCE",
            ChainError::BadOwnerSignature => "CHAIN_BAD_OWNER_SIGNATURE",
            ChainError::MissingCosignature => "CHAIN_MISSING_COSIGNATURE",
            ChainError::BadCosignature => "CHAIN_BAD_COSIGNATURE",
            ChainError::InsufficientBalance { .. } => "CHAIN_INSUFFICIENT_BALANCE",
            ChainError::EscapeNotStarted => "CHAIN_ESCAPE_NOT_STARTED",
            ChainError::EscapeLocked { .. } => "CHAIN_ESCAPE_LOCKED",
            ChainError::EscapeWrongRecipient(_) => "CHAIN_ESCAPE_WRONG_RECIPIENT",
            ChainError::UnknownToken(_) => "CHAIN_UNKNOWN_TOKEN",
            ChainError::UnknownTx(_) => "CHAIN_UNKNOWN_TX",
            ChainError::Decode(_) => "CHAIN_DECODE",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct TokenInfo {
    #[ts(type = "string")]
    pub address: Address,
    pub symbol: String,
    pub decimals: u8,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AssetBalance {
    /// `None` is the native asset.
    #[ts(type = "string | null")]
    pub asset: Option<Address>,
    pub symbol: String,
    pub decimals: u8,
    #[ts(type = "string")]
    pub amount: U256,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "state", rename_all = "snake_case")]
#[ts(export)]
pub enum EscapeStatus {
    Inactive,
    Pending {
        #[ts(type = "string")]
        to: Address,
        #[ts(type = "number")]
        started_at: u64,
        #[ts(type = "number")]
        unlock_at: u64,
    },
    Unlocked {
        #[ts(type = "string")]
        to: Address,
        #[ts(type = "number")]
        unlock_at: u64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AccountView {
    #[ts(type = "string")]
    pub address: Address,
    pub owner: OwnerKey,
    /// Swissquote's Ed25519 public key this account requires as second signer, hex.
    pub cosigner: String,
    #[ts(type = "number")]
    pub nonce: u64,
    pub balances: Vec<AssetBalance>,
    pub escape: EscapeStatus,
    #[ts(type = "number")]
    pub created_block: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum TxKind {
    /// Owner + Swissquote co-signature.
    Cosigned,
    /// Faucet / demo seeding, no signatures.
    Faucet,
    EscapeStart,
    EscapeCancel,
    /// Left through the escape hatch: owner signature only, no Swissquote involvement.
    EscapeExit,
    /// Owner key rotated after a recovery timelock.
    OwnerRotation,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ChainTx {
    #[ts(type = "string")]
    pub hash: B256,
    #[ts(type = "number")]
    pub block_number: u64,
    #[ts(type = "number")]
    pub timestamp: u64,
    #[ts(type = "string")]
    pub from: Address,
    #[ts(type = "string")]
    pub to: Address,
    #[ts(type = "string")]
    pub value: U256,
    #[ts(type = "string")]
    pub data: Bytes,
    #[ts(type = "number")]
    pub nonce: u64,
    /// Hash the signatures covered; zero for faucet transactions.
    #[ts(type = "string")]
    pub user_op_hash: B256,
    pub action: DecodedAction,
    pub kind: TxKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Block {
    #[ts(type = "number")]
    pub number: u64,
    #[ts(type = "number")]
    pub timestamp: u64,
    #[ts(type = "string")]
    pub hash: B256,
    #[ts(type = "string")]
    pub parent_hash: B256,
    #[ts(type = "string[]")]
    pub tx_hashes: Vec<B256>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ChainInfo {
    #[ts(type = "number")]
    pub chain_id: u64,
    #[ts(type = "number")]
    pub latest_block: u64,
    pub cosigner: String,
    #[ts(type = "number")]
    pub escape_delay_secs: u64,
    pub tokens: Vec<TokenInfo>,
}

/// What the account must sign before submitting.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PreparedOp {
    #[ts(type = "string")]
    pub user_op_hash: B256,
    #[ts(type = "number")]
    pub nonce: u64,
    pub action: DecodedAction,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SignedUserOp {
    pub tx: TxRequest,
    #[ts(type = "number")]
    pub nonce: u64,
    pub owner_signature: OwnerSignature,
    /// Swissquote's co-signature from `/cosign`; may be omitted only for an unlocked escape-hatch exit.
    #[ts(type = "string | null")]
    pub cosignature: Option<Bytes>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SubmitResult {
    #[ts(type = "string")]
    pub tx_hash: B256,
    #[ts(type = "number")]
    pub block_number: u64,
    pub kind: TxKind,
}
