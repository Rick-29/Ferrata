//! Risk preview (`/assess`) and the co-sign decision (`/cosign`). The server always re-scores;
//! it never trusts an assessment sent by the extension.

use alloy_primitives::B256;
use api_types::{AssessRequest, AssessResponse, CosignOutcome, CosignRequest, HoldState, HoldStatus};
use axum::extract::State;
use axum::routing::post;
use axum::{Json, Router};
use wallet_core::{
    AccountContext, DecodedAction, EvalContext, ExternalSignals, LogEntry, OutcomeKind, RiskAssessment, RiskBand,
    SignedEntry, TxRequest,
};

use crate::error::{ApiResult, ServiceError};
use crate::state::{AppState, SharedState};

pub fn routes() -> Router<SharedState> {
    Router::new().route("/assess", post(assess)).route("/cosign", post(cosign))
}

pub struct Scored {
    pub action: DecodedAction,
    pub signals: ExternalSignals,
    pub assessment: RiskAssessment,
}

/// Decode, simulate, gather signals, score. Shared by preview and co-sign.
pub fn score(state: &AppState, tx: &TxRequest, account: &AccountContext) -> Result<Scored, ServiceError> {
    let action = state.decoder.decode(tx)?;
    let simulation = {
        let chain = state.chain()?;
        if chain.has_account(tx.from) { chain.simulate(tx)? } else { Vec::new() }
    };
    let signals = state.signals.signals(&action, simulation);
    let ctx = EvalContext { action: &action, origin: tx.origin.as_deref(), account, signals: &signals, config: &state.config.policy };
    let assessment = state.scorer.assess(&ctx)?;
    Ok(Scored { action, signals, assessment })
}

async fn assess(State(state): State<SharedState>, Json(req): Json<AssessRequest>) -> ApiResult<AssessResponse> {
    let account = req.account.unwrap_or_default();
    let scored = score(&state, &req.tx, &account)?;
    let prepared = {
        let chain = state.chain()?;
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
pub fn record(state: &AppState, address: alloy_primitives::Address, mut entry: LogEntry) -> Result<SignedEntry, ServiceError> {
    let log = state.log.load(address)?;
    entry.timestamp = state.now();
    let entry_hash = log.check_extends(&entry)?;
    let receipt = state.signer.sign_receipt(&entry, entry_hash);
    let signed = SignedEntry { entry, entry_hash, receipt };
    state.log.append(address, signed.clone())?;
    Ok(signed)
}

async fn cosign(State(state): State<SharedState>, Json(req): Json<CosignRequest>) -> ApiResult<CosignOutcome> {
    let address = req.tx.from;
    let prepared = state.chain()?.prepare(&req.tx)?;
    if prepared.user_op_hash != req.user_op_hash {
        return Err(ServiceError::Conflict(format!(
            "user_op_hash mismatch: chain expects {} for nonce {}",
            prepared.user_op_hash, prepared.nonce
        )));
    }
    let account = req.account.unwrap_or_default();
    let scored = score(&state, &req.tx, &account)?;
    let band = scored.assessment.band;

    let outcome = match band {
        RiskBand::Low => OutcomeKind::Cosigned,
        RiskBand::Medium if req.step_up => OutcomeKind::Cosigned,
        RiskBand::Medium => OutcomeKind::StepUp,
        RiskBand::High => OutcomeKind::Held,
        RiskBand::Critical => OutcomeKind::Refused,
    };
    let mut warnings = Vec::new();
    if band == RiskBand::Medium && req.step_up {
        warnings.push("approved after step-up".to_string());
    }
    let entry = LogEntry {
        seq: req.seq,
        prev_head: req.prev_head,
        user_op_hash: req.user_op_hash,
        action: scored.action,
        assessment: scored.assessment.clone(),
        outcome,
        step_up: req.step_up,
        warnings,
        timestamp: 0,
    };
    let signed = record(&state, address, entry)?;
    tracing::info!(%address, seq = req.seq, ?band, ?outcome, "co-sign decision");

    let result = match outcome {
        OutcomeKind::Cosigned => CosignOutcome::Cosigned { cosignature: state.signer.cosign(&req.user_op_hash), entry: signed },
        OutcomeKind::StepUp => CosignOutcome::StepUp { entry: signed },
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

/// Zero hash helper for callers that build entries without a user operation.
pub fn no_user_op() -> B256 {
    B256::ZERO
}
