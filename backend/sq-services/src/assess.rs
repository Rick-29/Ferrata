//! Risk preview (`/assess`) and the co-sign decision (`/cosign`). The server always re-scores;
//! it never trusts an assessment, a recipient list, or a step-up flag sent by the extension.

use std::collections::BTreeSet;

use alloy_primitives::{Address, B256, keccak256};
use api_types::{AssessRequest, AssessResponse, CosignOutcome, CosignRequest, HoldState, HoldStatus};
use axum::extract::State;
use axum::routing::post;
use axum::{Json, Router};
use sq_adapters::TxKind;
use sq_adapters::chain::auth::verify_owner;
use wallet_core::{
    AccountContext, DecodedAction, EvalContext, ExternalSignals, LogEntry, OutcomeKind, RiskAssessment, RiskBand,
    SignedEntry, TxRequest,
};

use crate::auth::Caller;
use crate::error::{ApiResult, ServiceError};
use crate::state::{AppState, SharedState};

pub fn routes() -> Router<SharedState> {
    Router::new().route("/assess", post(assess)).route("/cosign", post(cosign))
}

/// What a Medium-band user signs to prove they re-authenticated.
pub fn step_up_hash(user_op_hash: &B256) -> B256 {
    keccak256([b"SQW-STEPUP-v1".as_slice(), user_op_hash.as_slice()].concat())
}

pub struct Scored {
    pub action: DecodedAction,
    pub signals: ExternalSignals,
    pub assessment: RiskAssessment,
}

/// Recipients Swissquote itself has seen this account pay: co-signed log entries and on-chain
/// co-signed transactions. Merged with whatever the client sends, so the client can only add, never hide.
fn known_recipients(state: &AppState, chain_id: u64, address: Address, client: &AccountContext) -> Result<AccountContext, ServiceError> {
    let mut seen: BTreeSet<Address> = client.known_recipients.iter().copied().collect();
    for e in state.log.load(address)?.entries() {
        if e.entry.outcome == OutcomeKind::Cosigned
            && let Some(c) = e.entry.action.counterparty()
        {
            seen.insert(c);
        }
    }
    let chain = state.chain_for(Some(chain_id))?;
    if chain.has_account(address) {
        for t in chain.history(address) {
            if t.from == address
                && t.kind == TxKind::Cosigned
                && let Some(c) = t.action.counterparty()
            {
                seen.insert(c);
            }
        }
    }
    Ok(AccountContext { known_recipients: seen.into_iter().collect() })
}

/// Decode, simulate, gather signals, score. Shared by preview and co-sign.
pub fn score(state: &AppState, tx: &TxRequest, client_account: &AccountContext) -> Result<Scored, ServiceError> {
    let action = state.decoder.decode(tx)?;
    let account = known_recipients(state, tx.chain_id, tx.from, client_account)?;
    let simulation = {
        let chain = state.chain_for(Some(tx.chain_id))?;
        if chain.has_account(tx.from) { chain.simulate(tx)? } else { Vec::new() }
    };
    let signals = state.signals.signals(&action, simulation);
    let ctx = EvalContext { action: &action, origin: tx.origin.as_deref(), account: &account, signals: &signals, config: &state.config.policy };
    let assessment = state.scorer.assess(&ctx)?;
    Ok(Scored { action, signals, assessment })
}

async fn assess(State(state): State<SharedState>, caller: Caller, Json(req): Json<AssessRequest>) -> ApiResult<AssessResponse> {
    state.check_owner(&caller, req.tx.from)?;
    let account = req.account.unwrap_or_default();
    let scored = score(&state, &req.tx, &account)?;
    let prepared = {
        let chain = state.chain_for(Some(req.tx.chain_id))?;
        if chain.has_account(req.tx.from) { Some(chain.prepare(&req.tx)?) } else { None }
    };
    let log = state.log.load(req.tx.from)?;
    Ok(Json(AssessResponse {
        action: scored.action,
        assessment: scored.assessment,
        signals: scored.signals,
        prepared,
        next_seq: log.next_seq(),
        head: log.head(),
    }))
}

/// Builds, receipts and appends one entry; returns it. Used by co-sign, holds and recovery.
pub fn record(state: &AppState, address: Address, mut entry: LogEntry) -> Result<SignedEntry, ServiceError> {
    let log = state.log.load(address)?;
    entry.timestamp = state.now();
    let entry_hash = log.check_extends(&entry)?;
    let receipt = state.signer.sign_receipt(&entry, entry_hash);
    let signed = SignedEntry { entry, entry_hash, receipt };
    state.log.append(address, signed.clone())?;
    Ok(signed)
}

async fn cosign(State(state): State<SharedState>, caller: Caller, Json(req): Json<CosignRequest>) -> ApiResult<CosignOutcome> {
    let address = req.tx.from;
    state.check_owner(&caller, address)?;
    let (prepared, owner) = {
        let chain = state.chain_for(Some(req.tx.chain_id))?;
        (chain.prepare(&req.tx)?, chain.account(address, state.now())?.owner)
    };
    if prepared.user_op_hash != req.user_op_hash {
        return Err(ServiceError::Conflict(format!(
            "user_op_hash mismatch: chain expects {} for nonce {}",
            prepared.user_op_hash, prepared.nonce
        )));
    }
    let stepped_up = match &req.step_up {
        Some(sig) => {
            if !verify_owner(&owner, &step_up_hash(&req.user_op_hash), sig) {
                return Err(ServiceError::Unauthorized);
            }
            true
        }
        None => false,
    };

    let account = req.account.unwrap_or_default();
    let scored = score(&state, &req.tx, &account)?;
    let band = scored.assessment.band;

    let outcome = match band {
        RiskBand::Low => OutcomeKind::Cosigned,
        RiskBand::Medium if stepped_up => OutcomeKind::Cosigned,
        RiskBand::Medium => OutcomeKind::StepUp,
        RiskBand::High => OutcomeKind::Held,
        RiskBand::Critical => OutcomeKind::Refused,
    };
    let mut warnings = Vec::new();
    if band == RiskBand::Medium && stepped_up {
        warnings.push("approved after passkey step-up".to_string());
    }
    let entry = LogEntry {
        seq: req.seq,
        prev_head: req.prev_head,
        user_op_hash: req.user_op_hash,
        action: scored.action,
        assessment: scored.assessment.clone(),
        outcome,
        step_up: stepped_up,
        warnings,
        timestamp: 0,
    };
    let signed = record(&state, address, entry)?;
    tracing::info!(%address, seq = req.seq, ?band, ?outcome, "co-sign decision");

    let result = match outcome {
        OutcomeKind::Cosigned => CosignOutcome::Cosigned { cosignature: state.signer.cosign(&req.user_op_hash), entry: signed },
        OutcomeKind::StepUp => CosignOutcome::StepUp { entry: signed, step_up_hash: step_up_hash(&req.user_op_hash) },
        OutcomeKind::Refused => CosignOutcome::Refused { entry: signed },
        OutcomeKind::Held => {
            let now = state.now();
            let hold = HoldState {
                id: AppState::new_id("hold"),
                address,
                status: HoldStatus::Pending,
                created_at: now,
                expires_at: now + state.config.seed.hold_ttl_secs,
                user_op_hash: req.user_op_hash,
                assessment: scored.assessment,
                justification: None,
                cosignature: None,
                release_entry: None,
            };
            state.lock(&state.holds)?.insert(hold.id.clone(), hold.clone());
            CosignOutcome::Held { entry: signed, hold_id: hold.id, expires_at: hold.expires_at }
        }
    };
    Ok(Json(result))
}
