//! Recovery (self-custody, KYC mandatory): the owner registered a recovery key (their phone) on
//! the Ferra chain. After losing the passkey:
//!   1. `prepare` on the new device: the wallet and its new owner key (the new passkey);
//!   2. `start` from the phone: the recovery key signs `recovery_hash`, plus the KYC;
//!   3. a timelock set by the smart delay (see `recovery_risk`), during which the current passkey
//!      can cancel, except for a contested recovery (one started after a cancel);
//!   4. `execute`: the rotation needs the phone's signature AND Swissquote's attestation.
//! Swissquote alone can never rotate the owner; the phone alone neither.

use alloy_primitives::{Address, B256, keccak256};
use api_types::{
    CancelRecoveryRequest, PrepareRecoveryRequest, RecoveryRisk, RecoveryState, RecoveryStatus, StartRecoveryRequest,
};
use axum::extract::{Path, Query, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use sq_adapters::TxKind;
use sq_adapters::chain::auth::verify_owner;
use wallet_core::RiskBand;

use crate::auth::Caller;
use crate::error::{ApiResult, ServiceError};
use crate::state::{AppState, SharedState};

/// How long the new device's prepared recovery waits for the phone.
const PREPARE_TTL_SECS: u64 = 15 * 60;

pub fn routes() -> Router<SharedState> {
    Router::new()
        .route("/recovery", get(list))
        .route("/recovery/wallets", get(my_wallets))
        .route("/recovery/prepare", post(prepare))
        .route("/recovery/start", post(start))
        .route("/recovery/{id}", get(get_recovery))
        .route("/recovery/{id}/cancel", post(cancel))
        .route("/recovery/{id}/execute", post(execute))
}

fn cancel_hash(id: &str) -> B256 {
    keccak256([b"SQW-RECOVERY-CANCEL-v1".as_slice(), id.as_bytes()].concat())
}

/// With auth on, recovering needs a Swissquote session of the client the wallet is bound to.
fn check_client(state: &AppState, caller: &Caller, address: Address) -> Result<(), ServiceError> {
    if state.config.require_auth && state.client_of(caller)?.is_none() {
        return Err(ServiceError::Unauthorized);
    }
    state.check_owner(caller, address)
}

async fn prepare(State(state): State<SharedState>, caller: Caller, Json(req): Json<PrepareRecoveryRequest>) -> ApiResult<RecoveryState> {
    req.new_owner.validate().map_err(|e| ServiceError::BadRequest(format!("new owner key: {e}")))?;
    check_client(&state, &caller, req.address)?;
    let now = state.now();
    let id = AppState::new_id("rec");
    let recovery_hash = {
        let chain = state.chain()?;
        if !chain.has_account(req.address) {
            return Err(ServiceError::NotFound(format!("account {}", req.address)));
        }
        if chain.recovery_key_of(req.address).is_none() {
            return Err(ServiceError::Conflict("no recovery phone registered for this wallet".into()));
        }
        chain.recovery_hash(req.address, &req.new_owner, &id)
    };
    let mut recoveries = state.lock(&state.recoveries)?;
    if recoveries.values().any(|r| r.address == req.address && matches!(r.status, RecoveryStatus::Pending { .. })) {
        return Err(ServiceError::Conflict("recovery already pending for this account".into()));
    }
    // A new preparation replaces an unfinished one for the same wallet.
    recoveries.retain(|_, r| !(r.address == req.address && matches!(r.status, RecoveryStatus::Prepared { .. })));
    let rec = RecoveryState {
        cancel_hash: cancel_hash(&id),
        recovery_hash,
        id: id.clone(),
        address: req.address,
        new_owner: req.new_owner,
        status: RecoveryStatus::Prepared { expires_at: now + PREPARE_TTL_SECS },
        started_at: now,
        kyc_passed: false,
        recovery_signature: None,
        risk: None,
        contested: false,
    };
    recoveries.insert(id, rec.clone());
    Ok(Json(rec))
}

async fn start(State(state): State<SharedState>, caller: Caller, Json(req): Json<StartRecoveryRequest>) -> ApiResult<RecoveryState> {
    let now = state.now();
    let mut recoveries = state.lock(&state.recoveries)?;
    let address = recoveries.get(&req.id).ok_or_else(|| ServiceError::NotFound(format!("recovery {}", req.id)))?.address;
    // Contested: the current passkey already cancelled a recovery of this wallet.
    let contested = recoveries.values().any(|r| r.address == address && matches!(r.status, RecoveryStatus::Cancelled { .. }));
    check_client(&state, &caller, address)?;
    let rec = recoveries.get_mut(&req.id).ok_or_else(|| ServiceError::NotFound(format!("recovery {}", req.id)))?;
    match rec.status {
        RecoveryStatus::Prepared { expires_at } if now <= expires_at => {}
        RecoveryStatus::Prepared { .. } => return Err(ServiceError::Conflict("recovery preparation expired".into())),
        _ => return Err(ServiceError::Conflict("recovery already started".into())),
    }

    // The user's side: the phone registered by the owner approves this new owner.
    let risk = {
        let chain = state.chain()?;
        let key = chain.recovery_key_of(address).ok_or_else(|| ServiceError::Conflict("no recovery phone registered for this wallet".into()))?;
        if !verify_owner(&key, &rec.recovery_hash, &req.recovery_signature) {
            return Err(ServiceError::Unauthorized);
        }
        let inputs = RecoveryInputs::read(&**chain, address, now, contested);
        recovery_risk(&inputs, state.config.seed.recovery_delay_secs)
    };

    // Swissquote's side: the identity check (scripted "simulated video identification" for now).
    let script = state
        .config
        .kyc_scripts
        .iter()
        .find(|s| s.id == req.kyc.script_id)
        .ok_or_else(|| ServiceError::BadRequest(format!("unknown KYC script {}", req.kyc.script_id)))?;
    rec.recovery_signature = Some(req.recovery_signature);
    rec.started_at = now;
    rec.kyc_passed = script.outcome == "pass";
    rec.contested = contested;
    rec.status = if rec.kyc_passed {
        RecoveryStatus::Pending { unlock_at: now + risk.delay_secs }
    } else {
        RecoveryStatus::Rejected { reason: format!("identity check failed: {}", script.label) }
    };
    rec.risk = Some(risk);
    tracing::warn!(id = %rec.id, %address, kyc_passed = rec.kyc_passed, contested, "recovery started");
    Ok(Json(rec.clone()))
}

/// The wallets the caller's Swissquote client registered: the new device picks the one to recover.
async fn my_wallets(State(state): State<SharedState>, caller: Caller) -> ApiResult<Vec<Address>> {
    let client = state.client_of(&caller)?.ok_or(ServiceError::Unauthorized)?;
    let mut out: Vec<Address> = state.lock(&state.owners)?.iter().filter(|(_, c)| **c == client).map(|(a, _)| *a).collect();
    out.sort();
    Ok(Json(out))
}

#[derive(Deserialize)]
struct ListQuery {
    address: Address,
}

/// Recoveries of one wallet, the ones in progress first, then newest first: the existing device
/// shows the alert from this.
async fn list(State(state): State<SharedState>, caller: Caller, Query(q): Query<ListQuery>) -> ApiResult<Vec<RecoveryState>> {
    state.check_owner(&caller, q.address)?;
    let mut out: Vec<RecoveryState> = state.lock(&state.recoveries)?.values().filter(|r| r.address == q.address).cloned().collect();
    let active = |r: &RecoveryState| matches!(r.status, RecoveryStatus::Pending { .. } | RecoveryStatus::Prepared { .. });
    out.sort_by(|a, b| active(b).cmp(&active(a)).then(b.started_at.cmp(&a.started_at)).then(a.id.cmp(&b.id)));
    Ok(Json(out))
}

async fn get_recovery(State(state): State<SharedState>, Path(id): Path<String>) -> ApiResult<RecoveryState> {
    let recoveries = state.lock(&state.recoveries)?;
    let rec = recoveries.get(&id).ok_or_else(|| ServiceError::NotFound(format!("recovery {id}")))?;
    Ok(Json(rec.clone()))
}

/// Any device holding the *current* owner key can cancel during the timelock, unless contested.
async fn cancel(State(state): State<SharedState>, Path(id): Path<String>, Json(req): Json<CancelRecoveryRequest>) -> ApiResult<RecoveryState> {
    let mut recoveries = state.lock(&state.recoveries)?;
    let rec = recoveries.get_mut(&id).ok_or_else(|| ServiceError::NotFound(format!("recovery {id}")))?;
    if !matches!(rec.status, RecoveryStatus::Pending { .. } | RecoveryStatus::Prepared { .. }) {
        return Err(ServiceError::Conflict("recovery is not pending".into()));
    }
    if rec.contested {
        return Err(ServiceError::Conflict("contested recovery: the current passkey alone can no longer cancel it".into()));
    }
    let owner = state.chain()?.account(rec.address, state.now())?.owner;
    if !verify_owner(&owner, &rec.cancel_hash, &req.signature) {
        return Err(ServiceError::Unauthorized);
    }
    rec.status = RecoveryStatus::Cancelled { at: state.now() };
    tracing::warn!(%id, "recovery cancelled by existing device");
    Ok(Json(rec.clone()))
}

/// After the timelock: the phone's signature plus Swissquote's attestation rotate the owner on-chain.
async fn execute(State(state): State<SharedState>, Path(id): Path<String>) -> ApiResult<RecoveryState> {
    let mut recoveries = state.lock(&state.recoveries)?;
    let rec = recoveries.get_mut(&id).ok_or_else(|| ServiceError::NotFound(format!("recovery {id}")))?;
    let now = state.now();
    match rec.status {
        RecoveryStatus::Pending { unlock_at } if now >= unlock_at => {}
        RecoveryStatus::Pending { unlock_at } => {
            return Err(ServiceError::Conflict(format!("timelock active until {unlock_at}")));
        }
        _ => return Err(ServiceError::Conflict("recovery is not pending".into())),
    }
    let recovery_signature = rec.recovery_signature.clone().ok_or_else(|| ServiceError::Conflict("recovery not signed by the phone".into()))?;
    let mut chain = state.chain()?;
    let nonce = chain.account(rec.address, now)?.nonce;
    let hash = chain.rotate_hash(rec.address, &rec.new_owner, nonce);
    let result = chain.rotate_owner(rec.address, rec.new_owner.clone(), &rec.id, &recovery_signature, &state.signer.cosign(&hash), now)?;
    rec.status = RecoveryStatus::Completed { at: now, tx_hash: result.tx_hash };
    tracing::warn!(%id, tx = %result.tx_hash, "recovery executed: owner rotated");
    Ok(Json(rec.clone()))
}

// ---------- smart delay ----------

/// Demo price used to put ETH and USDC on one scale (CHF ~ USD here); the real service prices assets.
const ETH_PRICE: f64 = 3_000.0;
const DAY: u64 = 86_400;

/// What the Ferra chain tells about the account when a recovery starts.
#[derive(Debug, Clone, PartialEq)]
pub struct RecoveryInputs {
    /// Seconds since the current owner key last signed something (transfer, settings, recovery key…).
    pub secs_since_owner_activity: Option<u64>,
    /// Value at stake, in CHF-equivalent.
    pub value_at_stake: f64,
    pub rotations_last_90d: u64,
    pub prior_flags: u64,
    pub account_age_secs: u64,
    pub contested: bool,
}

impl RecoveryInputs {
    pub fn read(chain: &dyn sq_adapters::chain::ChainBackend, address: Address, now: u64, contested: bool) -> Self {
        let history = chain.history(address);
        let last_owner_act = history
            .iter()
            .filter(|t| t.from == address && t.owner_signature.is_some() && t.kind != TxKind::OwnerRotation)
            .map(|t| t.timestamp)
            .max();
        let rotations_last_90d = history
            .iter()
            .filter(|t| t.from == address && t.kind == TxKind::OwnerRotation && t.timestamp + 90 * DAY >= now)
            .count() as u64;
        let value_at_stake = chain
            .balances_of_view(address)
            .iter()
            .map(|b| {
                let units = b.amount.to::<u128>() as f64 / 10f64.powi(i32::from(b.decimals));
                if b.asset.is_none() { units * ETH_PRICE } else { units }
            })
            .sum();
        let prior_flags = chain.account(address, now).map(|a| a.flags.len() as u64).unwrap_or(0);
        Self {
            secs_since_owner_activity: last_owner_act.map(|t| now.saturating_sub(t)),
            value_at_stake,
            rotations_last_90d,
            prior_flags,
            account_age_secs: chain.profile(address, now).age_secs,
            contested,
        }
    }
}

/// The smart delay. Pure: same inputs, same answer, explainable line by line. It only sets how
/// long the timelock is (never below `base_delay_secs`); the phone and the KYC are always required.
/// Real-world scale with a 24 h base: low 24 h, medium 72 h, high 7 days, critical 14 days.
pub fn recovery_risk(inputs: &RecoveryInputs, base_delay_secs: u64) -> RecoveryRisk {
    let mut score = 0u32;
    let mut reasons = Vec::new();
    match inputs.secs_since_owner_activity {
        Some(s) if s < DAY => {
            score += 40;
            reasons.push("Votre passkey actuelle a signé il y a moins de 24 h : pourquoi récupérer un accès encore utilisé ?".to_string());
        }
        Some(s) if s < 7 * DAY => {
            score += 20;
            reasons.push("Votre passkey actuelle a signé dans les 7 derniers jours.".to_string());
        }
        _ => {}
    }
    if inputs.value_at_stake > 10_000.0 {
        score += 20;
        reasons.push("Plus de 10 000 CHF sont en jeu.".to_string());
    } else if inputs.value_at_stake > 1_000.0 {
        score += 10;
        reasons.push("Plus de 1 000 CHF sont en jeu.".to_string());
    }
    if inputs.rotations_last_90d > 0 {
        score += 25 * inputs.rotations_last_90d as u32;
        reasons.push(format!("{} récupération(s) déjà faite(s) ces 90 derniers jours.", inputs.rotations_last_90d));
    }
    if inputs.prior_flags > 0 {
        score += 15;
        reasons.push("Ce compte a déjà fait l’objet de signalements.".to_string());
    }
    if inputs.account_age_secs < 7 * DAY {
        score += 10;
        reasons.push("Compte créé il y a moins de 7 jours : peu d’historique pour juger.".to_string());
    }
    if inputs.contested {
        score += 30;
        reasons.push("Une récupération précédente a été annulée par la passkey actuelle : récupération contestée.".to_string());
    }
    let (band, factor) = match score {
        0..30 => (RiskBand::Low, 1),
        30..60 => (RiskBand::Medium, 3),
        60..90 => (RiskBand::High, 7),
        _ => (RiskBand::Critical, 14),
    };
    if reasons.is_empty() {
        reasons.push("Aucun signal particulier : délai minimal.".to_string());
    }
    RecoveryRisk { score, band, reasons, delay_secs: base_delay_secs.max(1) * factor }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn quiet() -> RecoveryInputs {
        RecoveryInputs { secs_since_owner_activity: Some(40 * DAY), value_at_stake: 50.0, rotations_last_90d: 0, prior_flags: 0, account_age_secs: 365 * DAY, contested: false }
    }

    #[test]
    fn a_real_loss_gets_the_minimal_delay() {
        let r = recovery_risk(&quiet(), DAY);
        assert_eq!((r.band, r.delay_secs, r.score), (RiskBand::Low, DAY, 0));
    }

    #[test]
    fn a_passkey_still_in_use_with_money_at_stake_slows_recovery_down_and_says_why() {
        let r = recovery_risk(&RecoveryInputs { secs_since_owner_activity: Some(600), value_at_stake: 25_000.0, ..quiet() }, DAY);
        assert_eq!((r.band, r.delay_secs), (RiskBand::High, 7 * DAY));
        assert!(r.reasons.iter().any(|m| m.contains("moins de 24 h")));
        assert!(r.reasons.iter().any(|m| m.contains("10 000 CHF")));
    }

    #[test]
    fn contested_recoveries_wait_longer_and_never_below_the_base() {
        let r = recovery_risk(&RecoveryInputs { contested: true, ..quiet() }, 30);
        assert_eq!((r.band, r.delay_secs), (RiskBand::Medium, 90));
        assert!(recovery_risk(&quiet(), 0).delay_secs >= 1);
    }
}
