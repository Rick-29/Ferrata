//! High-band transactions wait for a justification. The mock compliance reviewer releases any
//! hold with a non-trivial justification; release appends a `Cosigned` entry and returns the co-signature.

use api_types::{HoldState, HoldStatus, JustifyRequest};
use axum::extract::{Path, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use wallet_core::{LogEntry, OutcomeKind};

use crate::assess::record;
use crate::error::{ApiResult, ServiceError};
use crate::state::SharedState;

pub fn routes() -> Router<SharedState> {
    Router::new().route("/holds/{id}", get(get_hold)).route("/holds/{id}/justify", post(justify))
}

fn refresh(state: &SharedState, hold: &mut HoldState) {
    if hold.status == HoldStatus::Pending && state.now() >= hold.expires_at {
        hold.status = HoldStatus::Expired;
    }
}

async fn get_hold(State(state): State<SharedState>, Path(id): Path<String>) -> ApiResult<HoldState> {
    let mut holds = state.lock(&state.holds)?;
    let hold = holds.get_mut(&id).ok_or_else(|| ServiceError::NotFound(format!("hold {id}")))?;
    refresh(&state, hold);
    Ok(Json(hold.clone()))
}

async fn justify(State(state): State<SharedState>, Path(id): Path<String>, Json(req): Json<JustifyRequest>) -> ApiResult<HoldState> {
    let mut hold = {
        let mut holds = state.lock(&state.holds)?;
        let h = holds.get_mut(&id).ok_or_else(|| ServiceError::NotFound(format!("hold {id}")))?;
        refresh(&state, h);
        if h.status != HoldStatus::Pending {
            return Err(ServiceError::Conflict(format!("hold is {:?}", h.status)));
        }
        h.clone()
    };

    let text = req.text.trim();
    if text.len() < 10 {
        return Err(ServiceError::BadRequest("justification must be at least 10 characters".into()));
    }
    hold.justification = Some(text.to_string());

    // Mock compliance: a justification mentioning "fraud" or "urgent" is rejected, everything else released.
    let lower = text.to_lowercase();
    if lower.contains("fraud") || lower.contains("urgent") {
        hold.status = HoldStatus::Rejected;
    } else {
        let log = state.log.load(hold.address)?;
        let entry = LogEntry {
            seq: log.next_seq(),
            prev_head: log.head(),
            user_op_hash: hold.user_op_hash,
            action: log
                .entries()
                .iter()
                .rev()
                .find(|e| e.entry.user_op_hash == hold.user_op_hash)
                .map(|e| e.entry.action.clone())
                .ok_or_else(|| ServiceError::Internal("held entry missing from log".into()))?,
            assessment: hold.assessment.clone(),
            outcome: OutcomeKind::Cosigned,
            step_up: false,
            warnings: vec![format!("released from hold {} after justification", hold.id)],
            timestamp: 0,
        };
        hold.release_entry = Some(record(&state, hold.address, entry)?);
        hold.cosignature = Some(state.signer.cosign(&hold.user_op_hash));
        hold.status = HoldStatus::Released;
    }
    tracing::info!(hold = %hold.id, status = ?hold.status, "hold reviewed");
    state.lock(&state.holds)?.insert(id, hold.clone());
    Ok(Json(hold))
}
