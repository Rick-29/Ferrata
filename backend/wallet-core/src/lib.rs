//! Pure wallet domain: transaction decoding, risk policy, hash-chained audit log, receipts.
//! No I/O, no async, no clock. Everything external is passed in.

pub mod error;
pub mod log;
pub mod policy;
pub mod receipt;
pub mod tx;

pub use alloy_primitives::{Address, B256, Bytes, U256};
pub use error::CoreError;
pub use log::{AuditLog, LogEntry, OutcomeKind, SignedEntry};
pub use policy::{
    AccountContext, BalanceDelta, BandThresholds, EvalContext, ExternalSignals, PolicyConfig, Reason, ReasonCode, RiskAssessment,
    RiskBand, RiskScorer, Rule, RuleBasedScorer,
};
pub use receipt::{Ed25519ReceiptVerifier, Receipt, ReceiptVerifier};
pub use tx::{AbiTxDecoder, DecodedAction, TxDecoder, TxRequest};

/// 32-byte hash, hex-encoded on the wire.
pub type Hash32 = B256;
