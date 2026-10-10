mod decoder;

pub use decoder::{AbiTxDecoder, SEL_APPROVE, SEL_TRANSFER, encode_erc20_call};

use alloy_primitives::{Address, Bytes, U256};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::CoreError;

/// What the user asked to do, as it arrives from the UI or a dApp.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct TxRequest {
    #[ts(type = "number")]
    pub chain_id: u64,
    #[ts(type = "string")]
    pub from: Address,
    #[ts(type = "string")]
    pub to: Address,
    #[ts(type = "string")]
    pub value: U256,
    #[ts(type = "string")]
    pub data: Bytes,
    /// dApp origin (`https://...`) when the request came through the provider, `None` for the popup.
    pub origin: Option<String>,
}

/// EIP-712 domain, kept minimal for the demo.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Eip712Domain {
    pub name: String,
    #[ts(type = "number")]
    pub chain_id: u64,
    #[ts(type = "string")]
    pub verifying_contract: Address,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct TypedDataSummary {
    #[ts(type = "string | null")]
    pub spender: Option<Address>,
    #[ts(type = "string | null")]
    pub amount: Option<U256>,
    #[ts(type = "number | null")]
    pub deadline: Option<u64>,
}

/// The decoded meaning of a `TxRequest`; what the policy engine and the UI reason about.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum DecodedAction {
    NativeTransfer {
        #[ts(type = "string")]
        to: Address,
        #[ts(type = "string")]
        amount: U256,
    },
    Erc20Transfer {
        #[ts(type = "string")]
        token: Address,
        #[ts(type = "string")]
        to: Address,
        #[ts(type = "string")]
        amount: U256,
    },
    Erc20Approve {
        #[ts(type = "string")]
        token: Address,
        #[ts(type = "string")]
        spender: Address,
        #[ts(type = "string")]
        amount: U256,
        unlimited: bool,
    },
    TypedData {
        domain: Eip712Domain,
        primary_type: String,
        summary: TypedDataSummary,
    },
    ContractCall {
        #[ts(type = "string")]
        target: Address,
        #[ts(type = "string")]
        selector: Bytes,
        #[ts(type = "string")]
        value: U256,
    },
}

impl DecodedAction {
    /// Counterparty that receives value or permission, if any.
    pub fn counterparty(&self) -> Option<Address> {
        match self {
            DecodedAction::NativeTransfer { to, .. } | DecodedAction::Erc20Transfer { to, .. } => Some(*to),
            DecodedAction::Erc20Approve { spender, .. } => Some(*spender),
            DecodedAction::TypedData { summary, .. } => summary.spender,
            DecodedAction::ContractCall { target, .. } => Some(*target),
        }
    }

    /// Asset moved or approved: `None` means the native asset.
    pub fn asset(&self) -> Option<Address> {
        match self {
            DecodedAction::Erc20Transfer { token, .. } | DecodedAction::Erc20Approve { token, .. } => Some(*token),
            DecodedAction::TypedData { domain, .. } => Some(domain.verifying_contract),
            _ => None,
        }
    }

    pub fn amount(&self) -> U256 {
        match self {
            DecodedAction::NativeTransfer { amount, .. }
            | DecodedAction::Erc20Transfer { amount, .. }
            | DecodedAction::Erc20Approve { amount, .. } => *amount,
            DecodedAction::TypedData { summary, .. } => summary.amount.unwrap_or(U256::ZERO),
            DecodedAction::ContractCall { value, .. } => *value,
        }
    }
}

pub trait TxDecoder: Send + Sync {
    fn decode(&self, req: &TxRequest) -> Result<DecodedAction, CoreError>;
}
