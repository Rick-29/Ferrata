//! Log-versus-chain diff. Anything on-chain without a co-signed log entry is the signal that
//! something bypassed Swissquote; with 2-of-2 enforced, only the escape hatch can do that.

use alloy_primitives::Address;
use api_types::{Finding, ReconcileResponse};
use axum::extract::{Path, State};
use axum::routing::post;
use axum::{Json, Router};
use sq_adapters::TxKind;
use wallet_core::{OutcomeKind, RiskBand};

use crate::error::ApiResult;
use crate::state::SharedState;

pub fn routes() -> Router<SharedState> {
    Router::new().route("/reconcile/{address}", post(reconcile))
}

async fn reconcile(State(state): State<SharedState>, Path(address): Path<Address>) -> ApiResult<ReconcileResponse> {
    let txs = state.chain()?.history(address);
    let log = state.log.load(address)?;
    let mut findings = Vec::new();

    for tx in txs.iter().filter(|t| t.from == address) {
        match tx.kind {
            TxKind::Cosigned => {
                let logged = log
                    .entries()
                    .iter()
                    .any(|e| e.entry.user_op_hash == tx.user_op_hash && e.entry.outcome == OutcomeKind::Cosigned);
                if !logged {
                    findings.push(Finding {
                        severity: RiskBand::Critical,
                        code: "UNLOGGED_COSIGNED_TX".into(),
                        message: "transaction carries a Swissquote co-signature but has no co-signed log entry".into(),
                        tx_hash: Some(tx.hash),
                        user_op_hash: Some(tx.user_op_hash),
                    });
                }
            }
            TxKind::EscapeExit => findings.push(Finding {
                severity: RiskBand::Critical,
                code: "ESCAPE_HATCH_EXIT".into(),
                message: "funds left through the escape hatch without Swissquote co-signing".into(),
                tx_hash: Some(tx.hash),
                user_op_hash: Some(tx.user_op_hash),
            }),
            TxKind::EscapeStart => findings.push(Finding {
                severity: RiskBand::High,
                code: "ESCAPE_HATCH_STARTED".into(),
                message: "escape hatch timer was started on-chain".into(),
                tx_hash: Some(tx.hash),
                user_op_hash: None,
            }),
            TxKind::OwnerRotation => findings.push(Finding {
                severity: RiskBand::Medium,
                code: "OWNER_ROTATED".into(),
                message: "owner key was rotated through recovery".into(),
                tx_hash: Some(tx.hash),
                user_op_hash: None,
            }),
            TxKind::Faucet | TxKind::EscapeCancel => {}
        }
    }

    for e in log.entries().iter().filter(|e| e.entry.outcome == OutcomeKind::Cosigned) {
        if !txs.iter().any(|t| t.user_op_hash == e.entry.user_op_hash) {
            findings.push(Finding {
                severity: RiskBand::Low,
                code: "COSIGNED_NOT_SUBMITTED".into(),
                message: format!("entry {} was co-signed but never landed on-chain", e.entry.seq),
                tx_hash: None,
                user_op_hash: Some(e.entry.user_op_hash),
            });
        }
    }

    Ok(Json(ReconcileResponse { address, chain_txs: txs.len() as u64, log_entries: log.len() as u64, findings }))
}
