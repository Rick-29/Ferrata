//! Log-versus-chain diff. Anything on-chain without a co-signed log entry is the signal that
//! something bypassed Swissquote; with 2-of-2 enforced, only the escape hatch can do that.
//! Anchors are checked too: an anchored head that is not in the log means the log was rewritten.

use alloy_primitives::{Address, B256};
use api_types::{Finding, ReconcileResponse};
use axum::extract::{Path, State};
use axum::routing::post;
use axum::{Json, Router};
use sq_adapters::{ChainTx, TxKind};
use wallet_core::{AuditLog, OutcomeKind, RiskBand};

use crate::error::{ApiResult, ServiceError};
use crate::state::{AppState, SharedState};

pub fn routes() -> Router<SharedState> {
    Router::new().route("/reconcile/{address}", post(reconcile))
}

fn finding(severity: RiskBand, code: &str, message: impl Into<String>, tx_hash: Option<B256>, user_op_hash: Option<B256>) -> Finding {
    Finding { severity, code: code.into(), message: message.into(), tx_hash, user_op_hash }
}

/// Pure diff between an account's chain events and its audit log. Shared with the review.
pub fn diff(address: Address, txs: &[ChainTx], log: &AuditLog) -> (Vec<Finding>, u64) {
    let mut findings = Vec::new();
    let mut anchors_checked = 0;

    for tx in txs.iter().filter(|t| t.from == address) {
        match tx.kind {
            TxKind::Cosigned => {
                let logged = log
                    .entries()
                    .iter()
                    .any(|e| e.entry.user_op_hash == tx.user_op_hash && e.entry.outcome == OutcomeKind::Cosigned);
                if !logged {
                    findings.push(finding(
                        RiskBand::Critical,
                        "UNLOGGED_COSIGNED_TX",
                        "transaction carries a Swissquote co-signature but has no co-signed log entry",
                        Some(tx.hash),
                        Some(tx.user_op_hash),
                    ));
                }
            }
            TxKind::EscapeExit => findings.push(finding(
                RiskBand::Critical,
                "ESCAPE_HATCH_EXIT",
                "funds left through the escape hatch without Swissquote co-signing",
                Some(tx.hash),
                Some(tx.user_op_hash),
            )),
            TxKind::EscapeStart => findings.push(finding(RiskBand::High, "ESCAPE_HATCH_STARTED", "escape hatch timer was started on-chain", Some(tx.hash), None)),
            TxKind::OwnerRotation => findings.push(finding(RiskBand::Medium, "OWNER_ROTATED", "owner key was rotated through recovery", Some(tx.hash), None)),
            TxKind::Anchor => {
                anchors_checked += 1;
                let anchored = tx.user_op_hash;
                if !log.entries().iter().any(|e| e.entry_hash == anchored) {
                    findings.push(finding(
                        RiskBand::Critical,
                        "ANCHOR_MISMATCH",
                        "an on-chain anchored log head is not in the current log: the log was rewritten",
                        Some(tx.hash),
                        Some(anchored),
                    ));
                }
            }
            TxKind::AccountCreated | TxKind::Faucet | TxKind::EscapeCancel | TxKind::Flag => {}
        }
    }

    for e in log.entries().iter().filter(|e| e.entry.outcome == OutcomeKind::Cosigned) {
        if !txs.iter().any(|t| t.user_op_hash == e.entry.user_op_hash) {
            findings.push(finding(
                RiskBand::Low,
                "COSIGNED_NOT_SUBMITTED",
                format!("entry {} was co-signed but never landed on-chain", e.entry.seq),
                None,
                Some(e.entry.user_op_hash),
            ));
        }
    }
    (findings, anchors_checked)
}

pub fn reconcile_account(state: &AppState, address: Address) -> Result<ReconcileResponse, ServiceError> {
    // Every chain the wallet spans; a tx on any of them must be explained by the log.
    let txs: Vec<ChainTx> = state.chains.for_each(|c| Ok(c.history(address)))?.into_iter().flatten().collect();
    let log = state.log.load(address)?;
    let (findings, anchors_checked) = diff(address, &txs, &log);
    Ok(ReconcileResponse { address, chain_txs: txs.len() as u64, log_entries: log.len() as u64, anchors_checked, findings })
}

async fn reconcile(State(state): State<SharedState>, Path(address): Path<Address>) -> ApiResult<ReconcileResponse> {
    Ok(Json(reconcile_account(&state, address)?))
}
