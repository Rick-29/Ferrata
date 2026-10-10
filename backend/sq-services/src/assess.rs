//! Risk preview (`/assess`) and the co-sign decision (`/cosign`). The server always re-scores;
//! it never trusts an assessment, a recipient list, or a step-up flag sent by the extension.

use std::collections::BTreeSet;

use alloy_primitives::{Address, B256, keccak256};
use api_types::{AssessRequest, AssessResponse, CosignOutcome, CosignRequest, HoldState, HoldStatus};
use axum::extract::State;
use axum::routing::post;
use axum::{Json, Router};
use sq_adapters::chain::auth::verify_owner;
use sq_adapters::{Intent, IntentOutcome, IntentOutcomeKind, TxKind};
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
fn known_recipients(state: &AppState, chain_id: u64, address: Address, client: &AccountContext, action: &DecodedAction) -> Result<AccountContext, ServiceError> {
    let mut seen: BTreeSet<Address> = client.known_recipients.iter().copied().collect();
    for e in state.log.load(address)?.entries() {
        if e.entry.outcome == OutcomeKind::Cosigned
            && let Some(c) = e.entry.action.counterparty()
        {
            seen.insert(c);
        }
    }
    let chain = state.chain_for(Some(chain_id))?;
    let mut own_per_tx_limit = None;
    if chain.has_account(address) {
        for t in chain.history(address) {
            if t.from == address
                && t.kind == TxKind::Cosigned
                && let Some(c) = t.action.counterparty()
            {
                seen.insert(c);
            }
        }
        // The owner's own ceiling from their on-chain settings, as a share of the balance being moved.
        let settings = chain.settings_of(address);
        if settings.per_tx_limit_pct > 0
            && let Some(b) = chain.balances_of_view(address).into_iter().find(|b| b.asset == action.asset())
        {
            own_per_tx_limit = Some(b.amount * wallet_core::U256::from(settings.per_tx_limit_pct) / wallet_core::U256::from(100u64));
        }
        for a in settings.allowlist {
            seen.insert(a);
        }
    }
    Ok(AccountContext { known_recipients: seen.into_iter().collect(), own_per_tx_limit })
}

/// Decode, simulate, gather signals, score. Shared by preview and co-sign.
pub fn score(state: &AppState, tx: &TxRequest, client_account: &AccountContext) -> Result<Scored, ServiceError> {
    let action = state.decoder.decode(tx)?;
    let account = known_recipients(state, tx.chain_id, tx.from, client_account, &action)?;
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
    if let Some(p) = &prepared {
        state.note_prepared(p.user_op_hash)?;
    }
    // Record what the user composed, before anything is signed.
    let intent_id = match &prepared {
        Some(p) => {
            let id = AppState::new_id("int");
            let intent = Intent {
                id: id.clone(),
                to: scored.action.counterparty().unwrap_or(req.tx.to),
                asset: scored.action.asset(),
                amount: scored.action.amount(),
                origin: req.tx.origin.clone(),
                band: Some(scored.assessment.band),
                score: Some(scored.assessment.score),
                user_op_hash: p.user_op_hash,
            };
            let mut chain = state.chain_for(Some(req.tx.chain_id))?;
            let cosig = state.signer.cosign(&chain.intent_hash(req.tx.from, &id));
            chain.record_intent(req.tx.from, intent, &cosig, state.now())?;
            Some(id)
        }
        None => None,
    };
    let log = state.log.load(req.tx.from)?;
    Ok(Json(AssessResponse {
        intent_id,
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
    let intent_outcome = match outcome {
        OutcomeKind::StepUp => Some(IntentOutcomeKind::StepUpRequired),
        OutcomeKind::Held => Some(IntentOutcomeKind::Held),
        OutcomeKind::Refused => Some(IntentOutcomeKind::Refused),
        OutcomeKind::Cosigned => None,
    };
    if let Some(k) = intent_outcome {
        record_intent_outcome(&state, req.tx.chain_id, address, req.user_op_hash, k, None)?;
    }

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

/// Writes the outcome of the open intent behind `user_op_hash`, if there is one.
pub fn record_intent_outcome(state: &AppState, chain_id: u64, address: Address, user_op_hash: B256, outcome: IntentOutcomeKind, tx_hash: Option<B256>) -> Result<(), ServiceError> {
    let mut chain = state.chain_for(Some(chain_id))?;
    let is_final = matches!(outcome, IntentOutcomeKind::Submitted | IntentOutcomeKind::Cancelled | IntentOutcomeKind::Refused);
    // A final outcome closes every open composition of the same hash; a provisional one marks only the latest.
    let mut guard = 0;
    while let Some(intent) = chain.open_intent_for(address, user_op_hash) {
        let o = IntentOutcome { intent_id: intent.id.clone(), outcome, tx_hash };
        let cosig = state.signer.cosign(&chain.intent_hash(address, &format!("{}:{:?}", intent.id, outcome)));
        chain.record_intent_outcome(address, o, &cosig, state.now())?;
        guard += 1;
        if !is_final || guard > 50 {
            break;
        }
    }
    Ok(())
}
