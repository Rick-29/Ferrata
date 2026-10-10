//! Account review: walk an account's whole on-chain history, judge every event against the
//! policy (via the audit log), the external signals (sanctions, exposure) and the chain-versus-log
//! diff, write each finding back to the chain as an append-only `Flag` event, and return a verdict.
//! This is what a compliance officer runs before Swissquote keeps serving an account.

use std::collections::BTreeMap;

use alloy_primitives::Address;
use api_types::{ReviewReport, ReviewVerdict};
use axum::extract::{Path, State};
use axum::routing::post;
use axum::{Json, Router};
use sq_adapters::{ChainTx, Flag, FlagSource, TxKind};
use wallet_core::{DecodedAction, OutcomeKind, RiskBand, U256};

use crate::error::ApiResult;
use crate::reconcile::diff;
use crate::state::{AppState, SharedState};

pub fn routes() -> Router<SharedState> {
    Router::new().route("/review/{address}", post(review))
}

fn points(b: RiskBand) -> u32 {
    match b {
        RiskBand::Low => 10,
        RiskBand::Medium => 25,
        RiskBand::High => 50,
        RiskBand::Critical => 100,
    }
}

fn flag(tx: &ChainTx, source: FlagSource, severity: RiskBand, code: &str, message: impl Into<String>, at: u64) -> Flag {
    Flag { code: code.into(), severity, source, message: message.into(), at, target: tx.hash, data: BTreeMap::new() }
}

/// Findings for one event: policy reasons recorded at co-sign time, and the counterparty's standing now.
fn judge(state: &AppState, address: Address, tx: &ChainTx, now: u64) -> Vec<Flag> {
    let mut out = Vec::new();

    // 1. What the policy said when Swissquote co-signed it (from the audit log).
    if tx.kind == TxKind::Cosigned
        && let Ok(log) = state.log.load(address)
        && let Some(e) = log.entries().iter().rev().find(|e| e.entry.user_op_hash == tx.user_op_hash && e.entry.outcome == OutcomeKind::Cosigned)
        && !e.entry.assessment.reasons.is_empty()
    {
        let codes: Vec<String> = e.entry.assessment.reasons.iter().map(|r| format!("{:?}", r.code)).collect();
        let mut f = flag(tx, FlagSource::Policy, e.entry.assessment.band, "POLICY_REASONS", format!("co-signed with reasons: {}", codes.join(", ")), now);
        f.data.insert("score".into(), serde_json::json!(e.entry.assessment.score));
        f.data.insert("reasons".into(), serde_json::json!(codes));
        f.data.insert("step_up".into(), serde_json::json!(e.entry.step_up));
        out.push(f);
    }

    // 2. The counterparty's standing today: sanctions and mixer exposure, on both directions.
    let counterparty = if tx.from == address { tx.action.counterparty() } else { Some(tx.from) };
    if let Some(c) = counterparty
        && c != address
        && c != Address::ZERO
    {
        let probe = DecodedAction::NativeTransfer { to: c, amount: U256::ZERO };
        let signals = state.signals.signals(&probe, Vec::new());
        if signals.sanctions_hit {
            out.push(flag(tx, FlagSource::Review, RiskBand::Critical, "SANCTIONED_COUNTERPARTY", format!("{c} is on a sanctions list"), now));
        }
        if let Some(h) = signals.exposure_hops {
            out.push(flag(tx, FlagSource::Review, RiskBand::High, "MIXER_EXPOSURE", format!("{c} is {h} hop(s) from a flagged address"), now));
        }
    }
    out
}

pub fn review_account(state: &AppState, address: Address) -> Result<ReviewReport, ServiceError> {
    let now = state.now();
    let txs = state.chain()?.history(address);
    let log = state.log.load(address)?;
    let mut wanted: Vec<Flag> = txs.iter().flat_map(|tx| judge(state, address, tx, now)).collect();

    // 3. Chain-versus-log findings that point at a specific event.
    let (findings, _) = diff(address, &txs, &log);
    for f in findings {
        if let Some(h) = f.tx_hash
            && let Some(tx) = txs.iter().find(|t| t.hash == h)
        {
            wanted.push(flag(tx, FlagSource::Reconciliation, f.severity, &f.code, f.message, now));
        }
    }

    // 4. Integrity of the chain itself.
    let chain_check = state.chain()?.verify();
    if !chain_check.ok
        && let Some(last) = txs.last()
    {
        wanted.push(flag(last, FlagSource::Integrity, RiskBand::Critical, "CHAIN_TAMPERED", chain_check.reason.clone().unwrap_or_default(), now));
    }

    let mut new_flags = 0;
    {
        let mut chain = state.chain()?;
        for f in wanted {
            if chain.flag(f, now)?.is_some() {
                new_flags += 1;
            }
        }
    }

    let flags = state.chain()?.account(address, now)?.flags;
    let worst = flags.iter().map(|f| f.severity).max();
    let verdict = match worst {
        Some(RiskBand::Critical) => ReviewVerdict::Blocked,
        Some(RiskBand::High | RiskBand::Medium) => ReviewVerdict::Suspicious,
        _ => ReviewVerdict::Clean,
    };
    let score = flags.iter().map(|f| points(f.severity)).sum();
    tracing::info!(%address, ?verdict, score, new_flags, "account reviewed");
    Ok(ReviewReport { address, verdict, score, txs_reviewed: txs.len() as u64, new_flags, flags, chain: chain_check })
}

use crate::error::ServiceError;

async fn review(State(state): State<SharedState>, Path(address): Path<Address>) -> ApiResult<ReviewReport> {
    Ok(Json(review_account(&state, address)?))
}
