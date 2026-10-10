//! Request and response DTOs for the Swissquote service. `cargo test -p api-types` writes the
//! TypeScript versions to `frontend/packages/types/src` (see `backend/.cargo/config.toml`).
//! Domain types (`TxRequest`, `RiskAssessment`, `SignedEntry`, …) are re-exported from `wallet-core`;
//! pseudo-chain types from `sq-adapters`.

use alloy_primitives::{Address, B256, Bytes, U256};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub use sq_adapters::chain::{
    AccountView, AssetBalance, Block, BlockWithTxs, ChainInfo, ChainTx, ChainVerification, EscapeStatus, Flag, FlagSource,
    OwnerKey, OwnerSignature, PreparedOp, SignedUserOp, SubmitResult, Tamper, TokenInfo, TxKind,
};

/// Page of blocks for explorers: `?from=0&limit=50` (newest first when `from` is omitted).
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct BlocksQuery {
    #[ts(type = "number | null")]
    pub chain_id: Option<u64>,
    #[ts(type = "number | null")]
    pub from: Option<u64>,
    #[ts(type = "number | null")]
    pub limit: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct TamperRequest {
    #[ts(type = "number | null")]
    pub chain_id: Option<u64>,
    pub tamper: Tamper,
}

// ---------- account review ----------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ReviewVerdict {
    /// Nothing above Low. The account can be served normally.
    Clean,
    /// Medium or High findings: a human should look before Swissquote keeps co-signing.
    Suspicious,
    /// At least one Critical finding (sanctions, escape exit, tampering, unlogged tx).
    Blocked,
}

/// Outcome of walking an account's whole on-chain history against the policy, the audit log and
/// the external signals, with every finding written back to the chain as a `Flag` event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ReviewReport {
    #[ts(type = "string")]
    pub address: Address,
    pub verdict: ReviewVerdict,
    #[ts(type = "number")]
    pub score: u32,
    #[ts(type = "number")]
    pub txs_reviewed: u64,
    #[ts(type = "number")]
    pub new_flags: u64,
    /// Every flag on the account after this review, oldest first.
    pub flags: Vec<Flag>,
    pub chain: ChainVerification,
}

/// Optional chain selector for `/chain/*` reads; defaults to the registry's default chain.
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ChainQuery {
    #[ts(type = "number | null")]
    pub chain_id: Option<u64>,
}

/// One wallet, many settlement layers: one account per registered chain for the same owner key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct WalletOverviewRequest {
    pub owner: OwnerKey,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct WalletOverview {
    pub owner: OwnerKey,
    pub accounts: Vec<AccountView>,
}
pub use wallet_core::{
    AccountContext, AuditLog, BalanceDelta, DecodedAction, ExternalSignals, LogEntry, OutcomeKind, PolicyConfig,
    Receipt, Reason, ReasonCode, RiskAssessment, RiskBand, SignedEntry, TxRequest,
};

// ---------- errors ----------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ApiError {
    pub code: String,
    pub message: String,
    #[ts(type = "unknown | null")]
    pub details: Option<serde_json::Value>,
}

// ---------- auth / ownership ----------

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Session {
    pub token: String,
    pub client_id: String,
    pub display_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ChallengeResponse {
    #[ts(type = "string")]
    pub challenge: B256,
    #[ts(type = "number")]
    pub expires_at: u64,
}

/// Proves the client controls the passkey behind `address`; creates the pseudo-chain account if needed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RegisterWalletRequest {
    pub owner: OwnerKey,
    #[ts(type = "string")]
    pub challenge: B256,
    pub signature: OwnerSignature,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RegisterWalletResponse {
    /// Address on the default chain.
    #[ts(type = "string")]
    pub address: Address,
    pub account: AccountView,
    /// One account per registered chain, all created for this owner key.
    pub accounts: Vec<AccountView>,
}

// ---------- assess / cosign ----------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AssessRequest {
    pub tx: TxRequest,
    /// Known recipients etc. The extension keeps this; the server has nothing else to go on.
    pub account: Option<AccountContext>,
}

/// Everything the confirm screen needs in one call.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AssessResponse {
    pub action: DecodedAction,
    pub assessment: RiskAssessment,
    pub signals: ExternalSignals,
    /// Present when `tx.from` is a pseudo-chain account: the hash to sign and the nonce.
    pub prepared: Option<PreparedOp>,
    /// Seq and head the next log entry must use.
    #[ts(type = "number")]
    pub next_seq: u64,
    #[ts(type = "string")]
    pub head: B256,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CosignRequest {
    pub tx: TxRequest,
    #[ts(type = "string")]
    pub user_op_hash: B256,
    #[ts(type = "number")]
    pub seq: u64,
    #[ts(type = "string")]
    pub prev_head: B256,
    /// Medium band only: a fresh owner signature over `step_up_hash` from the `step_up` outcome.
    /// Proves the user re-authenticated; the server verifies it against the account's owner key.
    pub step_up: Option<OwnerSignature>,
    pub account: Option<AccountContext>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum CosignOutcome {
    Cosigned {
        entry: SignedEntry,
        #[ts(type = "string")]
        cosignature: Bytes,
    },
    StepUp {
        entry: SignedEntry,
        /// Sign this with the passkey and resend `/cosign` with it in `step_up`.
        #[ts(type = "string")]
        step_up_hash: B256,
    },
    Held {
        entry: SignedEntry,
        hold_id: String,
        #[ts(type = "number")]
        expires_at: u64,
    },
    Refused {
        entry: SignedEntry,
    },
}

// ---------- holds ----------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum HoldStatus {
    Pending,
    Released,
    Rejected,
    Expired,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct HoldState {
    pub id: String,
    #[ts(type = "string")]
    pub address: Address,
    pub status: HoldStatus,
    #[ts(type = "number")]
    pub created_at: u64,
    #[ts(type = "number")]
    pub expires_at: u64,
    #[ts(type = "string")]
    pub user_op_hash: B256,
    pub assessment: RiskAssessment,
    pub justification: Option<String>,
    /// Filled when released: the co-signature plus the new `Cosigned` log entry to append.
    #[ts(type = "string | null")]
    pub cosignature: Option<Bytes>,
    pub release_entry: Option<SignedEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct JustifyRequest {
    pub text: String,
}

// ---------- log ----------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct LogResponse {
    #[ts(type = "string")]
    pub address: Address,
    #[ts(type = "string")]
    pub head: B256,
    #[ts(type = "number")]
    pub next_seq: u64,
    pub entries: Vec<SignedEntry>,
}

// ---------- recovery ----------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct KycAttestation {
    /// One of the ids in `fixtures/kyc-scripts.json` ("Simulated video identification").
    pub script_id: String,
    pub full_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct StartRecoveryRequest {
    #[ts(type = "string")]
    pub address: Address,
    pub new_owner: OwnerKey,
    pub kyc: KycAttestation,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "state", rename_all = "snake_case")]
#[ts(export)]
pub enum RecoveryStatus {
    Pending {
        #[ts(type = "number")]
        unlock_at: u64,
    },
    Cancelled {
        #[ts(type = "number")]
        at: u64,
    },
    Completed {
        #[ts(type = "number")]
        at: u64,
        #[ts(type = "string")]
        tx_hash: B256,
    },
    Rejected { reason: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RecoveryState {
    pub id: String,
    #[ts(type = "string")]
    pub address: Address,
    pub new_owner: OwnerKey,
    pub status: RecoveryStatus,
    #[ts(type = "number")]
    pub started_at: u64,
    pub kyc_passed: bool,
    /// What an existing device must sign to cancel.
    #[ts(type = "string")]
    pub cancel_hash: B256,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CancelRecoveryRequest {
    pub signature: OwnerSignature,
}

// ---------- chain ----------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CreateAccountRequest {
    pub owner: OwnerKey,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct FaucetRequest {
    #[ts(type = "number | null")]
    pub chain_id: Option<u64>,
    #[ts(type = "string")]
    pub address: Address,
    #[ts(type = "string | null")]
    pub asset: Option<Address>,
    #[ts(type = "string")]
    pub amount: U256,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SimulateRequest {
    pub tx: TxRequest,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SimulateResponse {
    pub action: DecodedAction,
    pub deltas: Vec<BalanceDelta>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct StartEscapeRequest {
    #[ts(type = "number | null")]
    pub chain_id: Option<u64>,
    #[ts(type = "string")]
    pub address: Address,
    #[ts(type = "string")]
    pub to: Address,
    pub signature: OwnerSignature,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct EscapeHashRequest {
    #[ts(type = "number | null")]
    pub chain_id: Option<u64>,
    #[ts(type = "string")]
    pub address: Address,
    #[ts(type = "string | null")]
    pub to: Option<Address>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct HashResponse {
    #[ts(type = "string")]
    pub hash: B256,
    #[ts(type = "number")]
    pub nonce: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CancelEscapeRequest {
    #[ts(type = "number | null")]
    pub chain_id: Option<u64>,
    #[ts(type = "string")]
    pub address: Address,
    pub signature: OwnerSignature,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct EscapeResponse {
    pub escape: EscapeStatus,
    pub tx: SubmitResult,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct HistoryResponse {
    #[ts(type = "string")]
    pub address: Address,
    pub txs: Vec<ChainTx>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AnchorResponse {
    #[ts(type = "string")]
    pub address: Address,
    #[ts(type = "string")]
    pub head: B256,
    #[ts(type = "number")]
    pub seq_anchored: u64,
    pub tx: Option<SubmitResult>,
}

// ---------- reconciliation ----------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Finding {
    pub severity: RiskBand,
    pub code: String,
    pub message: String,
    #[ts(type = "string | null")]
    pub tx_hash: Option<B256>,
    #[ts(type = "string | null")]
    pub user_op_hash: Option<B256>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ReconcileResponse {
    #[ts(type = "string")]
    pub address: Address,
    #[ts(type = "number")]
    pub chain_txs: u64,
    #[ts(type = "number")]
    pub log_entries: u64,
    #[ts(type = "number")]
    pub anchors_checked: u64,
    pub findings: Vec<Finding>,
}

// ---------- dev helpers (mock passkeys, only when SQ_DEV_SIGNER=1) ----------

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct DevPasskeyRequest {
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct DevPasskey {
    pub name: String,
    pub owner: OwnerKey,
    #[ts(type = "string")]
    pub address: Address,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct DevSignRequest {
    #[ts(type = "string")]
    pub hash: B256,
}
