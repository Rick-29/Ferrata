//! The pseudo-blockchain: an in-memory, tamper-evident ledger that enforces the same rules the
//! real smart account enforces. Every account is 2-of-2: the owner's passkey plus Swissquote's
//! co-signature, except through the timelocked escape hatch.
//!
//! Tamper evidence: every state change is an *event* (`ChainTx`) that carries the signatures that
//! authorised it; events are grouped in blocks that commit to a state root and are signed by the
//! chain's validator key; the whole chain can be rebuilt from its events alone and every hash,
//! signature and state root re-checked (`MockChain::replay`, `MockChain::verify`).

pub mod auth;
pub mod backend;
pub mod behaviour;
pub mod features;
mod ledger;
pub mod model;
mod store;

pub use auth::{OwnerKey, OwnerSignature};
pub use backend::{ChainBackend, ChainGuard, ChainRegistry};
pub use behaviour::{ActivityLevel, Archetype, Intent, IntentOutcome, IntentOutcomeKind, WalletProfile, WalletSettings};
pub use features::{PolicySnapshot, SubmitMeta, TxFeatures};
pub use ledger::{ChainConfig, MockChain, Tamper};
pub use model::{DatasetRow, LinearModel, ModelInfo, RiskModel};
pub use store::{BlockStore, CHAIN_FORMAT, CHAIN_FORMAT_VERSION, ChainHeader, ChainRecord, JsonlBlockStore, LoadedChain, NullBlockStore};

use std::collections::BTreeMap;

use alloy_primitives::{Address, B256, Bytes, U256};
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use wallet_core::{CoreError, DecodedAction, RiskBand, TxRequest};

/// Bump when an event's hashed fields change. Readers accept older versions.
pub const EVENT_VERSION: u32 = 1;
pub const BLOCK_VERSION: u32 = 1;

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
    #[error("unknown chain {0}")]
    UnknownChain(u64),
    #[error("chain lock poisoned")]
    Poisoned,
    #[error("malformed event: {0}")]
    MalformedEvent(String),
    #[error("tampering detected at block {block}: {reason}")]
    Tampered { block: u64, reason: String },
    #[error("chain is read-only (no validator key)")]
    ReadOnly,
    #[error("storage: {0}")]
    Storage(String),
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
            ChainError::UnknownChain(_) => "CHAIN_UNKNOWN_CHAIN",
            ChainError::Poisoned => "CHAIN_INTERNAL",
            ChainError::MalformedEvent(_) => "CHAIN_MALFORMED_EVENT",
            ChainError::Tampered { .. } => "CHAIN_TAMPERED",
            ChainError::ReadOnly => "CHAIN_READ_ONLY",
            ChainError::Storage(_) => "CHAIN_STORAGE",
            ChainError::Decode(_) => "CHAIN_DECODE",
        }
    }
}

/// Which settlement layer an event belongs to. The Ferra chain records its own events and
/// mirrors of events observed on other networks (`TxKind::External`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ChainFamily {
    Ferra,
    Evm,
    Bitcoin,
    Solana,
    Ton,
    Sui,
    Other,
}

impl ChainFamily {
    pub fn tag(self) -> &'static str {
        match self {
            ChainFamily::Ferra => "ferra",
            ChainFamily::Evm => "evm",
            ChainFamily::Bitcoin => "bitcoin",
            ChainFamily::Solana => "solana",
            ChainFamily::Ton => "ton",
            ChainFamily::Sui => "sui",
            ChainFamily::Other => "other",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Network {
    pub family: ChainFamily,
    /// Human name: `"ferra"`, `"base-sepolia"`, `"bitcoin-testnet"`, `"solana-devnet"`, …
    pub name: String,
    /// EVM chain id when the family is `evm` (or the Ferra id).
    #[ts(type = "number | null")]
    pub chain_id: Option<u64>,
}

impl Network {
    pub fn ferra(chain_id: u64) -> Self {
        Self { family: ChainFamily::Ferra, name: "ferra".into(), chain_id: Some(chain_id) }
    }
}

/// Where an `External` event came from. Addresses are kept raw because only EVM ones fit `Address`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ExternalRef {
    pub network: Network,
    pub tx_id: String,
    #[ts(type = "number | null")]
    pub block: Option<u64>,
    pub from_raw: String,
    pub to_raw: String,
    pub asset_symbol: String,
    pub decimals: u8,
    /// Amount in base units of that network's asset, as a decimal string.
    pub amount: String,
    pub fee: Option<f64>,
    pub explorer_url: Option<String>,
    /// When it happened on the origin network (the Ferra block timestamp is when it was recorded).
    #[serde(default)]
    #[ts(type = "number | null")]
    pub timestamp: Option<u64>,
    /// Token contract / jetton master / mint, when the asset is not the network's native coin.
    #[serde(default)]
    pub asset_address: Option<String>,
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
    /// Flags raised on any of this account's transactions, oldest first.
    #[serde(default)]
    pub flags: Vec<Flag>,
}

/// What kind of event this is. New kinds may be added; readers must treat unknown ones as opaque.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum TxKind {
    /// Account registered with its owner key (`extra.owner`).
    AccountCreated,
    /// Faucet / demo seeding, no signatures.
    Faucet,
    /// Owner + Swissquote co-signature.
    Cosigned,
    EscapeStart,
    EscapeCancel,
    /// Left through the escape hatch: owner signature only, no Swissquote involvement.
    EscapeExit,
    /// Owner key rotated after a recovery timelock (`extra.new_owner`), Swissquote co-signed.
    OwnerRotation,
    /// Audit-log head anchored by Swissquote (`user_op_hash` = anchored head), co-signed.
    Anchor,
    /// A flag attached to an earlier event (`extra.flag`). Append-only: history is never edited.
    Flag,
    /// An event observed on another network and attested by Swissquote (`extra.external`).
    External,
    /// The owner changed their own settings (`extra.settings`), owner-signed.
    SettingsChanged,
    /// A transaction composed in the wallet before signing (`extra.intent`), Swissquote-attested.
    Intent,
    /// What became of an intent (`extra.outcome`), Swissquote-attested.
    IntentOutcome,
    /// Someone reported an address (on any network) as a scam / fraud; Swissquote-attested
    /// (`extra.report`). Reports are append-only evidence, never a verdict by themselves.
    AddressReport,
}

/// One report about an address. Who reported is a client id or a free label, never a wallet key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AddressReport {
    /// Network name as registered (`ferra`, `ton`, `bitcoin`, `solana`, `ethereum`, …).
    pub network: String,
    /// Canonical address string for that network (lower-cased 0x… for EVM / Ferra).
    pub address: String,
    /// `scam`, `phishing`, `hack`, `mixer`, `other`.
    pub category: String,
    pub reason: String,
    pub reporter: String,
    #[ts(type = "number")]
    pub at: u64,
}

/// Aggregate view: every address that has at least one report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ReportedAddress {
    pub network: String,
    pub address: String,
    #[ts(type = "number")]
    pub count: u64,
    pub categories: Vec<String>,
    #[ts(type = "number")]
    pub first_at: u64,
    #[ts(type = "number")]
    pub last_at: u64,
}

/// Key under which reports are indexed: network + address, case-insensitive.
pub fn report_key(network: &str, address: &str) -> String {
    format!("{}:{}", network.trim().to_ascii_lowercase(), address.trim().to_ascii_lowercase())
}

/// Who raised a flag.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum FlagSource {
    /// The risk policy at co-sign time.
    Policy,
    /// Log-versus-chain reconciliation.
    Reconciliation,
    /// The account review (`/review/{address}`).
    Review,
    /// A chain integrity check (`/chain/verify`).
    Integrity,
    /// The validator's risk model.
    Model,
    /// Deviation from the user's own profile (intents, settings, habits).
    Behaviour,
    /// Where the money came from on the origin network.
    Provenance,
    /// A human.
    Manual,
    /// A report filed by a user or by compliance about an address (`AddressReport` events).
    /// Evidence, not a verdict: it does not count as validation.
    Report,
}

/// A finding about one event. Extensible: unknown `data` keys are kept, new fields default.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Flag {
    pub code: String,
    pub severity: RiskBand,
    pub source: FlagSource,
    pub message: String,
    #[ts(type = "number")]
    pub at: u64,
    /// The event this flag is about.
    #[ts(type = "string")]
    pub target: B256,
    #[serde(default)]
    #[ts(type = "Record<string, unknown>")]
    pub data: BTreeMap<String, serde_json::Value>,
}

/// One event on the chain. The hashed fields are fixed per `version`; `flags` is derived from
/// later `Flag` events and `extra` carries kind-specific data (owner keys, flag payloads, …).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ChainTx {
    #[serde(default = "default_version")]
    #[ts(type = "number")]
    pub version: u32,
    #[ts(type = "string")]
    pub hash: B256,
    #[ts(type = "number")]
    pub block_number: u64,
    #[ts(type = "number")]
    pub timestamp: u64,
    pub kind: TxKind,
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
    /// The hash the signatures below cover; zero for unsigned kinds.
    #[ts(type = "string")]
    pub user_op_hash: B256,
    pub action: DecodedAction,
    /// Risk band the wallet / co-signer computed when this happened. Hashed: part of the record.
    #[serde(default)]
    pub risk_level: Option<RiskBand>,
    /// Risk the validator tools assign afterwards: the highest flag severity. Derived, not hashed.
    #[serde(default)]
    pub reviewed_risk: Option<RiskBand>,
    #[serde(default)]
    pub owner_signature: Option<OwnerSignature>,
    #[serde(default)]
    #[ts(type = "string | null")]
    pub cosignature: Option<Bytes>,
    /// Kind-specific payload. Forward compatible: readers ignore keys they do not know.
    #[serde(default)]
    #[ts(type = "Record<string, unknown>")]
    pub extra: BTreeMap<String, serde_json::Value>,
    /// Derived from later `Flag` events; not part of the hash.
    #[serde(default)]
    pub flags: Vec<Flag>,
    /// Network the event settled on. Ferra for native events, the origin network for `External`.
    #[serde(default = "default_network")]
    pub network: Network,
    /// Feature vector computed at commit from the pre-state; stored, versioned, not hashed.
    #[serde(default)]
    pub features: Option<features::TxFeatures>,
}

fn default_network() -> Network {
    Network { family: ChainFamily::Ferra, name: "ferra".into(), chain_id: None }
}

fn default_version() -> u32 {
    1
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Block {
    #[serde(default = "default_version")]
    #[ts(type = "number")]
    pub version: u32,
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
    /// keccak over the ordered tx hashes.
    #[serde(default)]
    #[ts(type = "string")]
    pub txs_root: B256,
    /// Commitment to every account (owner, nonce, escape, balances, allowances) after this block.
    #[serde(default)]
    #[ts(type = "string")]
    pub state_root: B256,
    /// Ed25519 signature of the validator over `hash`.
    #[serde(default)]
    #[ts(type = "string")]
    pub validator_signature: Bytes,
}

/// A block with its events, as the explorer / visualiser wants it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct BlockWithTxs {
    pub block: Block,
    pub txs: Vec<ChainTx>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ChainInfo {
    #[ts(type = "number")]
    pub chain_id: u64,
    pub network: Network,
    #[ts(type = "number")]
    pub latest_block: u64,
    #[ts(type = "string")]
    pub head: B256,
    #[ts(type = "string")]
    pub state_root: B256,
    /// Swissquote's co-signing public key, hex.
    pub cosigner: String,
    /// The chain's block-signing public key, hex. Distinct from the co-signer.
    pub validator: String,
    #[ts(type = "number")]
    pub escape_delay_secs: u64,
    pub tokens: Vec<TokenInfo>,
    pub persisted: bool,
}

/// Result of a full replay-and-check of the chain.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ChainVerification {
    pub ok: bool,
    #[ts(type = "number")]
    pub blocks_checked: u64,
    #[ts(type = "number")]
    pub txs_checked: u64,
    /// First block that failed, with the reason; `None` when `ok`.
    #[ts(type = "number | null")]
    pub first_bad_block: Option<u64>,
    pub reason: Option<String>,
    #[ts(type = "string")]
    pub head: B256,
    #[ts(type = "string")]
    pub state_root: B256,
}

/// How much of the chain the validator tools have looked at.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ValidationStatus {
    /// Events that call for a verdict: co-signed, escape exits, external.
    #[ts(type = "number")]
    pub validatable: u64,
    /// Of those, events carrying at least one flag from a validator source (review, provenance, model, behaviour).
    #[ts(type = "number")]
    pub validated: u64,
    pub percent: f64,
    #[ts(type = "number")]
    pub pending: u64,
    /// Hashes of the oldest unvalidated events, for a worker to pick up.
    #[ts(type = "string[]")]
    pub next: Vec<B256>,
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
