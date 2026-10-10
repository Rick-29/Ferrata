//! Predicted risk for a transfer seen on an external network. Two views that the report ships side
//! by side: plain reasons anyone can audit (new recipient, size against the sender's habit, scam
//! labels, provenance), and the validator's model scored on the same `TxFeatures` the Ferra chain
//! computes, built here from indexer data instead of chain state.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use sq_adapters::{Network, PolicySnapshot, RiskModel, TxFeatures, TxKind};
use ts_rs::TS;
use wallet_core::RiskBand;

use crate::provenance::ProvenanceAssessment;
use crate::report::units;
use crate::{AccountInfo, ObservedEvent};

const DAY: u64 = 86_400;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RiskReason {
    pub code: String,
    #[ts(type = "number")]
    pub points: u32,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ModelScore {
    pub name: String,
    /// Probability-like, 0..1.
    pub score: f64,
    pub above_threshold: bool,
    /// Top contributions `(feature, weight × value)`.
    #[ts(type = "Array<[string, number]>")]
    pub top: Vec<(String, f64)>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct TransferRisk {
    /// Sum of the reasons' points, capped at 100.
    #[ts(type = "number")]
    pub heuristic_score: u32,
    pub band: RiskBand,
    pub reasons: Vec<RiskReason>,
    pub model: Option<ModelScore>,
    /// `max(heuristic / 100, model.score)`: one number for sorting and thresholds.
    pub combined: f64,
    /// The exact vector the model saw, for the dataset and for explanations.
    pub features: TxFeatures,
}

pub struct RiskInputs<'a> {
    pub network: &'a Network,
    pub transfer: &'a ObservedEvent,
    /// Sender's events, newest first, excluding nothing.
    pub sender_history: &'a [ObservedEvent],
    pub sender_info: Option<&'a AccountInfo>,
    pub receiver_history: &'a [ObservedEvent],
    pub receiver_info: Option<&'a AccountInfo>,
    pub provenance: Option<&'a ProvenanceAssessment>,
    pub now: u64,
    /// Reports filed against the counterparty (from the Ferra chain), when the caller knows them.
    pub counterparty_reports: u64,
}

fn band(score: u32) -> RiskBand {
    if score >= 80 {
        RiskBand::Critical
    } else if score >= 50 {
        RiskBand::High
    } else if score >= 25 {
        RiskBand::Medium
    } else {
        RiskBand::Low
    }
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let idx = ((sorted.len() as f64 - 1.0) * p).round() as usize;
    sorted[idx.min(sorted.len() - 1)]
}

/// Builds the feature vector from indexer data. Fields the chain fills from its own state
/// (signer, co-sign, intents, settings) stay at their neutral defaults.
pub fn features_from_history(i: &RiskInputs<'_>) -> TxFeatures {
    let t = &i.transfer.external;
    let ts = t.timestamp.unwrap_or(i.now);
    let amount = units(&t.amount, t.decimals);
    let same_asset = |e: &ObservedEvent| e.external.asset_symbol == t.asset_symbol;
    let outs: Vec<&ObservedEvent> = i.sender_history.iter().filter(|e| !e.incoming && e.external.tx_id != t.tx_id).collect();
    let ins: Vec<&ObservedEvent> = i.sender_history.iter().filter(|e| e.incoming).collect();
    let before = |e: &&ObservedEvent| e.external.timestamp.is_none_or(|x| x <= ts);
    let prior_outs: Vec<&ObservedEvent> = outs.iter().copied().filter(before).collect();
    let recipients: BTreeSet<&str> = prior_outs.iter().map(|e| e.external.to_raw.as_str()).collect();
    let out_volume: f64 = prior_outs.iter().filter(|e| same_asset(e)).map(|e| units(&e.external.amount, e.external.decimals)).sum();
    let mut sorted: Vec<f64> = prior_outs.iter().filter(|e| same_asset(e)).map(|e| units(&e.external.amount, e.external.decimals)).collect();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let mean_out = if sorted.is_empty() { 0.0 } else { out_volume / sorted.len() as f64 };
    let p95 = percentile(&sorted, 0.95);
    let since24 = ts.saturating_sub(DAY);
    let out_24h: Vec<&ObservedEvent> = prior_outs.iter().copied().filter(|e| e.external.timestamp.is_some_and(|x| x >= since24)).collect();
    let first_seen = i.sender_history.iter().filter_map(|e| e.external.timestamp).min();
    let sender_age_secs = first_seen.map(|f| ts.saturating_sub(f)).unwrap_or(0);
    let days = (sender_age_secs as f64 / DAY as f64).max(1.0);
    let velocity_ratio = if prior_outs.is_empty() { 0.0 } else { out_24h.len() as f64 / (prior_outs.len() as f64 / days) };
    let prev = i.sender_history.iter().filter(|e| e.external.tx_id != t.tx_id).filter_map(|e| e.external.timestamp).filter(|x| *x < ts).max();
    let balance_before = i.sender_info.and_then(|s| s.balance.as_deref()).map(|b| units(b, i.sender_info.map(|s| s.native_decimals).unwrap_or(t.decimals))).filter(|_| t.asset_address.is_none()).unwrap_or(0.0);

    let cp = if i.transfer.incoming { &t.from_raw } else { &t.to_raw };
    let cp_in: Vec<&ObservedEvent> = i.receiver_history.iter().filter(|e| e.incoming).collect();
    let cp_out: Vec<&ObservedEvent> = i.receiver_history.iter().filter(|e| !e.incoming).collect();
    let cp_senders: BTreeSet<&str> = cp_in.iter().map(|e| e.external.from_raw.as_str()).collect();
    let cp_recipients: BTreeSet<&str> = cp_out.iter().map(|e| e.external.to_raw.as_str()).collect();
    let wallet = if i.transfer.incoming { &t.to_raw } else { &t.from_raw };
    let reciprocal = i.receiver_history.iter().any(|e| !e.incoming && &e.external.to_raw == wallet) && i.receiver_history.iter().any(|e| e.incoming && &e.external.from_raw == wallet);
    let pass_through = cp_in.iter().any(|x| {
        let received = units(&x.external.amount, x.external.decimals);
        received > 0.0 && cp_out.iter().filter(|o| o.external.asset_symbol == x.external.asset_symbol).map(|o| units(&o.external.amount, o.external.decimals)).sum::<f64>() >= 0.9 * received
    });
    let is_round = amount > 0.0 && (amount - amount.round()).abs() < 1e-9;

    let archetype = if prior_outs.len() < 3 {
        "new"
    } else if out_volume < 0.25 * ins.iter().filter(|e| same_asset(e)).map(|e| units(&e.external.amount, e.external.decimals)).sum::<f64>() {
        "holder"
    } else if prior_outs.len() as f64 / days >= 3.0 {
        "trader"
    } else {
        "spender"
    };

    TxFeatures {
        version: 2,
        network: i.network.clone(),
        kind: TxKind::External,
        signer_kind: "none".into(),
        cosigned: false,
        step_up: false,
        via_dapp: false,
        dapp_origin: None,
        asset: None,
        asset_symbol: t.asset_symbol.clone(),
        amount,
        fee: t.fee.unwrap_or(0.0),
        balance_before,
        fraction_of_balance: if balance_before > 0.0 { (amount / balance_before).min(1.0) } else { 0.0 },
        is_round_amount: is_round,
        timestamp: ts,
        hour_utc: ((ts % DAY) / 3600) as u8,
        weekday: (((ts / DAY) + 3) % 7) as u8,
        secs_since_sender_prev_tx: prev.map(|p| ts.saturating_sub(p)),
        sender_age_secs,
        decision_latency_secs: None,
        sender_out_count_24h: out_24h.len() as u64,
        sender_out_volume_24h: out_24h.iter().filter(|e| same_asset(e)).map(|e| units(&e.external.amount, e.external.decimals)).sum(),
        velocity_ratio,
        sender_tx_count: i.sender_history.len() as u64,
        sender_out_count: prior_outs.len() as u64,
        sender_in_count: ins.len() as u64,
        sender_distinct_recipients: recipients.len() as u64,
        sender_out_volume: out_volume,
        sender_prior_flags: 0,
        sender_prior_max_severity: None,
        sender_escape_active: false,
        sender_rotations: 0,
        share_of_lifetime_volume: if out_volume + amount > 0.0 { amount / (out_volume + amount) } else { 0.0 },
        counterparty: None,
        counterparty_is_account: false,
        counterparty_new_for_sender: !recipients.contains(cp.as_str()),
        counterparty_tx_count: i.receiver_info.and_then(|r| r.tx_count).unwrap_or(i.receiver_history.len() as u64),
        counterparty_in_count: cp_in.len() as u64,
        counterparty_out_count: cp_out.len() as u64,
        counterparty_distinct_senders: cp_senders.len() as u64,
        counterparty_first_seen_age_secs: i.receiver_history.iter().filter_map(|e| e.external.timestamp).min().map(|f| ts.saturating_sub(f)),
        counterparty_prior_flags: u64::from(i.receiver_info.is_some_and(|r| r.is_scam)),
        counterparty_prior_max_severity: i.receiver_info.filter(|r| r.is_scam).map(|_| RiskBand::Critical),
        counterparty_reports: i.provenance.map(|p| p.reasons.iter().filter(|r| r.code == "REPORTED_ADDRESS").count() as u64).unwrap_or(0).max(i.counterparty_reports),
        reciprocal,
        counterparty_fan_out_ratio: if cp_out.is_empty() { 0.0 } else { cp_recipients.len() as f64 / cp_out.len() as f64 },
        counterparty_pass_through: pass_through,
        policy: PolicySnapshot {
            score: i.provenance.map(|p| p.score),
            band: i.provenance.map(|p| p.risk),
            reasons: i.provenance.map(|p| p.reasons.iter().map(|r| r.code.clone()).collect()).unwrap_or_default(),
            sanctions_hit: i.provenance.map(|p| p.reasons.iter().any(|r| r.code == "SANCTIONED_ADDRESS")),
            exposure_hops: i.provenance.and_then(|p| p.exposure.as_ref()).and_then(|x| x.hops),
            risk_accepted: false,
        },
        archetype: archetype.into(),
        activity: if prior_outs.len() as f64 / days >= 3.0 { "high" } else if prior_outs.len() as f64 / days >= 0.3 { "medium" } else { "low" }.into(),
        amount_vs_mean_out: if mean_out > 0.0 { amount / mean_out } else { 0.0 },
        amount_vs_p95_out: if p95 > 0.0 { amount / p95 } else { 0.0 },
        holding_ratio: 0.0,
        prior_cancel_rate: 0.0,
        cancels_24h: 0,
        settings_changes_24h: 0,
        secs_since_settings_change: None,
        intent_to_submit_secs: None,
        exceeds_own_limit: false,
        risk_accepted: false,
        extra: BTreeMap::new(),
    }
}

/// Reasons a compliance officer can read, plus the model when one is loaded.
pub fn assess(i: &RiskInputs<'_>, model: Option<&dyn RiskModel>) -> TransferRisk {
    assess_features(i, features_from_history(i), model)
}

/// Same, over a feature vector the caller already adjusted (the preview adds what the wallet knows).
pub fn assess_features(i: &RiskInputs<'_>, f: TxFeatures, model: Option<&dyn RiskModel>) -> TransferRisk {
    let mut reasons = Vec::new();
    let mut push = |code: &str, points: u32, msg: String| reasons.push(RiskReason { code: code.into(), points, message: msg });
    let t = &i.transfer.external;

    if i.receiver_info.is_some_and(|r| r.is_scam) || i.transfer.scam_flag {
        push("SCAM_COUNTERPARTY", 100, "the indexer marks the counterparty as a scam".into());
    }
    if f.counterparty_reports > 0 {
        push("REPORTED_COUNTERPARTY", if f.counterparty_reports >= 3 { 100 } else { 60 }, format!("{} Swissquote user(s) reported this address as a scam or fraud", f.counterparty_reports));
    }
    if let Some(p) = i.provenance {
        if p.reasons.iter().any(|r| r.code == "SANCTIONED_ADDRESS") {
            push("SANCTIONED_COUNTERPARTY", 100, "counterparty is on the sanctions list".into());
        } else if p.score > 0 {
            push(&format!("PROVENANCE_{:?}", p.risk).to_uppercase(), p.score / 2, format!("origin-network check: {}", p.reasons.iter().map(|r| r.code.as_str()).collect::<Vec<_>>().join(", ")));
        }
    }
    if f.counterparty_new_for_sender && f.sender_out_count > 0 {
        push("NEW_RECIPIENT", 20, "first transfer from this sender to this counterparty".into());
    }
    // Only when the sender's history was actually loaded: an empty history means "unknown", not "none".
    if f.sender_out_count == 0 && (!i.sender_history.is_empty() || f.sender_age_secs > 0) {
        push("FIRST_OUTGOING", 10, "the sender had never sent anything before".into());
    }
    if f.sender_out_count >= 5 && f.amount_vs_p95_out > 3.0 {
        push("LARGE_FOR_SENDER", 25, format!("{:.4} {} is {:.1}× the sender's 95th percentile", f.amount, t.asset_symbol, f.amount_vs_p95_out));
    }
    if f.fraction_of_balance >= 0.8 && f.balance_before > 0.0 {
        push("DRAINS_BALANCE", 25, format!("moves {:.0}% of the sender's balance", f.fraction_of_balance * 100.0));
    }
    if f.velocity_ratio >= 5.0 && f.sender_out_count_24h >= 5 {
        push("VELOCITY_SPIKE", 15, format!("{} outgoing in 24 h against a usual {:.2} per day", f.sender_out_count_24h, f.sender_out_count as f64 / (f.sender_age_secs as f64 / DAY as f64).max(1.0)));
    }
    if f.counterparty_pass_through && i.provenance.is_none() {
        push("PASS_THROUGH_COUNTERPARTY", 30, "the counterparty forwards what it receives".into());
    }
    if f.reciprocal {
        push("ROUND_TRIP", 10, "funds have gone both ways with this counterparty".into());
    }
    if t.block.is_none() && i.transfer.counterparty_label.as_deref() == Some("unconfirmed") {
        push("UNCONFIRMED", 5, "not yet confirmed on its network".into());
    }
    let heuristic_score = reasons.iter().map(|r| r.points).sum::<u32>().min(100);
    let model_score = model.map(|m| {
        let score = m.score(&f);
        ModelScore { name: m.name().to_owned(), score, above_threshold: score >= m.describe().threshold, top: m.explain(&f, 5) }
    });
    let combined = (f64::from(heuristic_score) / 100.0).max(model_score.as_ref().map(|m| m.score).unwrap_or(0.0));
    TransferRisk { heuristic_score, band: band(heuristic_score), reasons, model: model_score, combined, features: f }
}
