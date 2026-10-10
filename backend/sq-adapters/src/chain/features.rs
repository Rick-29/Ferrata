//! Per-event feature vector for the validator, the visualiser and the risk model.
//!
//! Computed once, at commit time, from the chain state *before* the event is applied, so the
//! numbers mean "what was known when this happened". Stored on the event (not hashed, like
//! flags) and versioned: new fields default, unknown fields are ignored.
//!
//! The selection follows what AML / fraud models on chain data actually use:
//! - Elliptic (Weber et al. 2019): local features (amount, fee, in/out degree, time step) plus
//!   one-hop aggregates of the counterparties.
//! - FATF virtual-asset red flags (2020): structuring near limits, velocity, dormancy then burst,
//!   new counterparties, round amounts, mixers / sanctioned exposure, immediate pass-through.
//! - Payment-fraud practice: hour of day, decision latency, authentication strength (step-up),
//!   origin of the request (dApp vs. first-party), account age.

use std::collections::{BTreeMap, BTreeSet};

use alloy_primitives::{Address, U256};
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use wallet_core::RiskBand;

use super::auth::OwnerSignature;
use super::ledger::MockChain;
use super::{ChainTx, Network, TxKind};

pub const FEATURES_VERSION: u32 = 3;
const DAY: u64 = 86_400;

/// What the policy engine concluded when Swissquote co-signed. Recorded for learning, never
/// trusted for enforcement (the chain enforces signatures, not scores).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PolicySnapshot {
    #[ts(type = "number | null")]
    pub score: Option<u32>,
    pub band: Option<RiskBand>,
    #[serde(default)]
    pub reasons: Vec<String>,
    pub sanctions_hit: Option<bool>,
    #[ts(type = "number | null")]
    pub exposure_hops: Option<u32>,
    /// The user was warned and accepted the risk before this was co-signed.
    #[serde(default)]
    pub risk_accepted: bool,
}

/// Context the services know and the chain does not. All optional.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SubmitMeta {
    /// When `/assess` or `/chain/prepare` produced the hash the user then signed.
    #[ts(type = "number | null")]
    pub prepared_at: Option<u64>,
    pub step_up: bool,
    pub policy: Option<PolicySnapshot>,
    /// Fee paid on the originating network, in that network's native unit (0 on the Ferra chain).
    pub fee: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct TxFeatures {
    #[serde(default = "version_one")]
    #[ts(type = "number")]
    pub version: u32,

    // ----- context: where, what, who -----
    pub network: Network,
    pub kind: TxKind,
    /// `"ed25519"`, `"webauthn"` or `"none"`.
    pub signer_kind: String,
    pub cosigned: bool,
    pub step_up: bool,
    pub via_dapp: bool,
    pub dapp_origin: Option<String>,

    // ----- amount -----
    #[ts(type = "string | null")]
    pub asset: Option<Address>,
    pub asset_symbol: String,
    /// Amount in whole units of the asset (base units / 10^decimals).
    pub amount: f64,
    pub fee: f64,
    pub balance_before: f64,
    /// `amount / balance_before`, 0 when the balance was 0.
    pub fraction_of_balance: f64,
    /// Amount is a multiple of 1, 10, 100 … units (a human typed it).
    pub is_round_amount: bool,

    // ----- timing and velocity -----
    #[ts(type = "number")]
    pub timestamp: u64,
    pub hour_utc: u8,
    pub weekday: u8,
    #[ts(type = "number | null")]
    pub secs_since_sender_prev_tx: Option<u64>,
    #[ts(type = "number")]
    pub sender_age_secs: u64,
    /// Seconds between the hash being prepared and the signed event landing.
    #[ts(type = "number | null")]
    pub decision_latency_secs: Option<u64>,
    #[ts(type = "number")]
    pub sender_out_count_24h: u64,
    pub sender_out_volume_24h: f64,
    /// Outgoing count in the last 24 h divided by the sender's lifetime daily average.
    pub velocity_ratio: f64,

    // ----- sender history (before this event) -----
    #[ts(type = "number")]
    pub sender_tx_count: u64,
    #[ts(type = "number")]
    pub sender_out_count: u64,
    #[ts(type = "number")]
    pub sender_in_count: u64,
    #[ts(type = "number")]
    pub sender_distinct_recipients: u64,
    pub sender_out_volume: f64,
    #[ts(type = "number")]
    pub sender_prior_flags: u64,
    pub sender_prior_max_severity: Option<RiskBand>,
    pub sender_escape_active: bool,
    #[ts(type = "number")]
    pub sender_rotations: u64,
    /// Share of the sender's lifetime outgoing volume (same asset) this single event represents.
    pub share_of_lifetime_volume: f64,

    // ----- counterparty (before this event) -----
    #[ts(type = "string | null")]
    pub counterparty: Option<Address>,
    pub counterparty_is_account: bool,
    pub counterparty_new_for_sender: bool,
    #[ts(type = "number")]
    pub counterparty_tx_count: u64,
    #[ts(type = "number")]
    pub counterparty_in_count: u64,
    #[ts(type = "number")]
    pub counterparty_out_count: u64,
    #[ts(type = "number")]
    pub counterparty_distinct_senders: u64,
    #[ts(type = "number | null")]
    pub counterparty_first_seen_age_secs: Option<u64>,
    #[ts(type = "number")]
    pub counterparty_prior_flags: u64,
    pub counterparty_prior_max_severity: Option<RiskBand>,
    /// Scam / fraud reports filed against the counterparty on its network (v3).
    #[serde(default)]
    #[ts(type = "number")]
    pub counterparty_reports: u64,
    /// The counterparty paid the sender before (round trips, layering).
    pub reciprocal: bool,
    /// `distinct recipients / outgoing count` of the counterparty: 1.0 = spreads everything out.
    pub counterparty_fan_out_ratio: f64,
    /// The counterparty forwarded ≥ 90 % of what it received within 24 h at least once (pass-through).
    pub counterparty_pass_through: bool,

    // ----- what the co-signer concluded (recorded, not trusted) -----
    pub policy: PolicySnapshot,

    // ----- v2: the user's own profile and intentions (see behaviour.rs) -----
    #[serde(default)]
    pub archetype: String,
    #[serde(default)]
    pub activity: String,
    /// `amount / mean of prior outgoing`, 0 without history.
    #[serde(default)]
    pub amount_vs_mean_out: f64,
    #[serde(default)]
    pub amount_vs_p95_out: f64,
    #[serde(default)]
    pub holding_ratio: f64,
    #[serde(default)]
    pub prior_cancel_rate: f64,
    #[serde(default)]
    #[ts(type = "number")]
    pub cancels_24h: u64,
    #[serde(default)]
    #[ts(type = "number")]
    pub settings_changes_24h: u64,
    #[serde(default)]
    #[ts(type = "number | null")]
    pub secs_since_settings_change: Option<u64>,
    /// Compose → signed submission, from the matching `intent` event.
    #[serde(default)]
    #[ts(type = "number | null")]
    pub intent_to_submit_secs: Option<u64>,
    #[serde(default)]
    pub exceeds_own_limit: bool,
    #[serde(default)]
    pub risk_accepted: bool,

    /// Open for future features without a schema change.
    #[serde(default)]
    #[ts(type = "Record<string, number>")]
    pub extra: BTreeMap<String, f64>,
}

fn version_one() -> u32 {
    1
}

impl TxFeatures {
    /// Flat numeric view for models and CSV export. Booleans → 0/1, options → value + presence.
    pub fn to_vector(&self) -> BTreeMap<String, f64> {
        let mut v = BTreeMap::new();
        let mut put = |k: &str, x: f64| {
            v.insert(k.to_string(), x);
        };
        let b = |x: bool| if x { 1.0 } else { 0.0 };
        // `Low` is "checked, nothing found": it must not count as a step of severity.
        let sev = |s: Option<RiskBand>| match s {
            None | Some(RiskBand::Low) => 0.0,
            Some(RiskBand::Medium) => 1.0,
            Some(RiskBand::High) => 2.0,
            Some(RiskBand::Critical) => 3.0,
        };
        put(&format!("family_{}", self.network.family.tag()), 1.0);
        put(&format!("kind_{}", kind_tag(self.kind)), 1.0);
        put(&format!("signer_{}", self.signer_kind), 1.0);
        put("cosigned", b(self.cosigned));
        put("step_up", b(self.step_up));
        put("via_dapp", b(self.via_dapp));
        put("amount", self.amount);
        put("amount_log", (self.amount + 1.0).ln());
        put("fee", self.fee);
        put("balance_before", self.balance_before);
        put("fraction_of_balance", self.fraction_of_balance);
        put("is_round_amount", b(self.is_round_amount));
        put("hour_utc", f64::from(self.hour_utc));
        put("is_night", b(self.hour_utc < 6 || self.hour_utc >= 22));
        put("is_weekend", b(self.weekday >= 5));
        put("secs_since_sender_prev_tx", self.secs_since_sender_prev_tx.map(|s| s as f64).unwrap_or(-1.0));
        put("has_prev_tx", b(self.secs_since_sender_prev_tx.is_some()));
        put("sender_age_days", self.sender_age_secs as f64 / DAY as f64);
        put("decision_latency_secs", self.decision_latency_secs.map(|s| s as f64).unwrap_or(-1.0));
        put("sender_out_count_24h", self.sender_out_count_24h as f64);
        put("sender_out_volume_24h", self.sender_out_volume_24h);
        put("velocity_ratio", self.velocity_ratio);
        put("sender_tx_count", self.sender_tx_count as f64);
        put("sender_out_count", self.sender_out_count as f64);
        put("sender_in_count", self.sender_in_count as f64);
        put("sender_distinct_recipients", self.sender_distinct_recipients as f64);
        put("sender_out_volume", self.sender_out_volume);
        put("sender_prior_flags", self.sender_prior_flags as f64);
        put("sender_prior_max_severity", sev(self.sender_prior_max_severity));
        put("sender_escape_active", b(self.sender_escape_active));
        put("sender_rotations", self.sender_rotations as f64);
        put("share_of_lifetime_volume", self.share_of_lifetime_volume);
        put("counterparty_is_account", b(self.counterparty_is_account));
        put("counterparty_new_for_sender", b(self.counterparty_new_for_sender));
        put("counterparty_tx_count", self.counterparty_tx_count as f64);
        put("counterparty_in_count", self.counterparty_in_count as f64);
        put("counterparty_out_count", self.counterparty_out_count as f64);
        put("counterparty_distinct_senders", self.counterparty_distinct_senders as f64);
        put("counterparty_first_seen_age_days", self.counterparty_first_seen_age_secs.map(|s| s as f64 / DAY as f64).unwrap_or(-1.0));
        put("counterparty_prior_flags", self.counterparty_prior_flags as f64);
        put("counterparty_prior_max_severity", sev(self.counterparty_prior_max_severity));
        put("counterparty_reports", self.counterparty_reports as f64);
        put("reciprocal", b(self.reciprocal));
        put("counterparty_fan_out_ratio", self.counterparty_fan_out_ratio);
        put("counterparty_pass_through", b(self.counterparty_pass_through));
        put("policy_score", self.policy.score.map(f64::from).unwrap_or(-1.0));
        put("policy_band", sev(self.policy.band));
        put("policy_reason_count", self.policy.reasons.len() as f64);
        put("policy_sanctions_hit", b(self.policy.sanctions_hit.unwrap_or(false)));
        put("policy_exposure_hops", self.policy.exposure_hops.map(f64::from).unwrap_or(-1.0));
        if !self.archetype.is_empty() {
            put(&format!("archetype_{}", self.archetype), 1.0);
        }
        if !self.activity.is_empty() {
            put(&format!("activity_{}", self.activity), 1.0);
        }
        put("amount_vs_mean_out", self.amount_vs_mean_out);
        put("amount_vs_p95_out", self.amount_vs_p95_out);
        put("holding_ratio", self.holding_ratio);
        put("prior_cancel_rate", self.prior_cancel_rate);
        put("cancels_24h", self.cancels_24h as f64);
        put("settings_changes_24h", self.settings_changes_24h as f64);
        put("secs_since_settings_change", self.secs_since_settings_change.map(|s| s as f64).unwrap_or(-1.0));
        put("intent_to_submit_secs", self.intent_to_submit_secs.map(|s| s as f64).unwrap_or(-1.0));
        put("exceeds_own_limit", b(self.exceeds_own_limit));
        put("risk_accepted", b(self.risk_accepted));
        for (k, x) in &self.extra {
            put(&format!("extra_{k}"), *x);
        }
        v
    }
}

pub(super) fn kind_tag(k: TxKind) -> &'static str {
    match k {
        TxKind::AccountCreated => "account_created",
        TxKind::Faucet => "faucet",
        TxKind::Cosigned => "cosigned",
        TxKind::EscapeStart => "escape_start",
        TxKind::EscapeCancel => "escape_cancel",
        TxKind::EscapeExit => "escape_exit",
        TxKind::OwnerRotation => "owner_rotation",
        TxKind::Anchor => "anchor",
        TxKind::Flag => "flag",
        TxKind::External => "external",
        TxKind::SettingsChanged => "settings_changed",
        TxKind::Intent => "intent",
        TxKind::IntentOutcome => "intent_outcome",
        TxKind::AddressReport => "address_report",
    }
}

fn to_units(amount: U256, decimals: u8) -> f64 {
    let s = amount.to_string();
    let int: f64 = s.parse().unwrap_or(f64::MAX);
    int / 10f64.powi(i32::from(decimals))
}

fn is_round(amount: U256, decimals: u8) -> bool {
    if amount.is_zero() {
        return false;
    }
    let unit = U256::from(10u64).pow(U256::from(decimals));
    unit > U256::ZERO && (amount % unit).is_zero()
}

/// Moves of value between two addresses, as the feature code sees every event.
fn flow(tx: &ChainTx) -> Option<(Address, Address, Option<Address>, U256)> {
    match tx.kind {
        TxKind::Cosigned | TxKind::EscapeExit | TxKind::Faucet | TxKind::External => {
            let to = tx.action.counterparty()?;
            Some((tx.from, to, tx.action.asset(), tx.action.amount()))
        }
        _ => None,
    }
}

impl MockChain {
    /// Features for `tx` given the chain state before it is applied. Pure.
    pub(super) fn features_for(&self, tx: &ChainTx, meta: &SubmitMeta) -> TxFeatures {
        let sender = tx.from;
        let counterparty = tx.action.counterparty().filter(|c| *c != sender);
        let asset = tx.action.asset();
        let decimals = asset.and_then(|a| self.tokens.get(&a).map(|t| t.decimals)).unwrap_or(18);
        let symbol = asset.and_then(|a| self.tokens.get(&a).map(|t| t.symbol.clone())).unwrap_or_else(|| "ETH".into());
        let amount = to_units(tx.action.amount(), decimals);

        let balance_before = self
            .balances_of(sender)
            .into_iter()
            .find(|b| b.asset == asset)
            .map(|b| to_units(b.amount, b.decimals))
            .unwrap_or(0.0);

        let history: Vec<&ChainTx> = self.order.iter().filter_map(|h| self.txs.get(h)).collect();
        let flows: Vec<(&ChainTx, Address, Address, Option<Address>, U256)> =
            history.iter().filter_map(|t| flow(t).map(|(f, to, a, amt)| (*t, f, to, a, amt))).collect();

        // ----- sender -----
        let sender_events: Vec<&ChainTx> = history.iter().copied().filter(|t| t.from == sender && t.kind != TxKind::Flag).collect();
        let sender_out: Vec<_> = flows.iter().filter(|(_, f, _, _, _)| *f == sender).collect();
        let sender_in: Vec<_> = flows.iter().filter(|(_, _, to, _, _)| *to == sender).collect();
        let sender_recipients: BTreeSet<Address> = sender_out.iter().map(|(_, _, to, _, _)| *to).collect();
        let sender_out_volume: f64 = sender_out.iter().filter(|(_, _, _, a, _)| *a == asset).map(|(_, _, _, _, amt)| to_units(*amt, decimals)).sum();
        let since = tx.timestamp.saturating_sub(DAY);
        let out_24h: Vec<_> = sender_out.iter().filter(|(t, _, _, _, _)| t.timestamp >= since).collect();
        let sender_out_volume_24h: f64 = out_24h.iter().filter(|(_, _, _, a, _)| *a == asset).map(|(_, _, _, _, amt)| to_units(*amt, decimals)).sum();
        let created = self.accounts.get(&sender).and_then(|a| self.blocks.get(a.created_block as usize)).map(|b| b.timestamp);
        let sender_age_secs = created.map(|c| tx.timestamp.saturating_sub(c)).unwrap_or(0);
        let lifetime_days = (sender_age_secs as f64 / DAY as f64).max(1.0);
        let velocity_ratio = if sender_out.is_empty() { 0.0 } else { out_24h.len() as f64 / (sender_out.len() as f64 / lifetime_days) };
        let prev = sender_events.iter().filter(|t| t.kind != TxKind::AccountCreated).map(|t| t.timestamp).max();
        let sender_flags = self.flags_of_address(sender);
        let sender_escape_active = self.accounts.get(&sender).is_some_and(|a| a.escape.is_some());
        let sender_rotations = sender_events.iter().filter(|t| t.kind == TxKind::OwnerRotation).count() as u64;

        // ----- counterparty -----
        let (cp_tx_count, cp_in, cp_out, cp_senders, cp_first_seen, cp_flags, reciprocal, fan_out, pass_through) = match counterparty {
            None => (0, 0, 0, 0, None, Vec::new(), false, 0.0, false),
            Some(c) => {
                let cp_in: Vec<_> = flows.iter().filter(|(_, _, to, _, _)| *to == c).collect();
                let cp_out: Vec<_> = flows.iter().filter(|(_, f, _, _, _)| *f == c).collect();
                let senders: BTreeSet<Address> = cp_in.iter().map(|(_, f, _, _, _)| *f).collect();
                let recipients: BTreeSet<Address> = cp_out.iter().map(|(_, _, to, _, _)| *to).collect();
                let first_seen = history.iter().filter(|t| t.from == c || t.to == c || t.action.counterparty() == Some(c)).map(|t| t.timestamp).min();
                let reciprocal = cp_out.iter().any(|(_, _, to, _, _)| *to == sender);
                let fan_out = if cp_out.is_empty() { 0.0 } else { recipients.len() as f64 / cp_out.len() as f64 };
                let pass_through = cp_in.iter().any(|(tin, _, _, a, amt)| {
                    let received = to_units(*amt, decimals);
                    let forwarded: f64 = cp_out
                        .iter()
                        .filter(|(tout, _, _, a2, _)| a2 == a && tout.timestamp >= tin.timestamp && tout.timestamp <= tin.timestamp + DAY)
                        .map(|(_, _, _, _, amt2)| to_units(*amt2, decimals))
                        .sum();
                    received > 0.0 && forwarded >= 0.9 * received
                });
                let count = history.iter().filter(|t| (t.from == c || t.action.counterparty() == Some(c)) && t.kind != TxKind::Flag).count() as u64;
                (count, cp_in.len() as u64, cp_out.len() as u64, senders.len() as u64, first_seen, self.flags_of_address(c), reciprocal, fan_out, pass_through)
            }
        };

        let signer_kind = match &tx.owner_signature {
            Some(OwnerSignature::Ed25519 { .. }) => "ed25519",
            Some(OwnerSignature::WebAuthn { .. }) => "webauthn",
            None => "none",
        };
        let dapp_origin = tx.extra.get("origin").and_then(|v| v.as_str()).map(String::from);
        let max_sev = |fs: &[super::Flag]| fs.iter().map(|f| f.severity).max();

        // ----- the user's own profile, as of just before this event -----
        let profile = self.profile(sender, tx.timestamp);
        let intents = self.intents_of(sender);
        let since24 = tx.timestamp.saturating_sub(DAY);
        let cancels_24h = intents
            .iter()
            .filter(|r| r.outcomes.iter().any(|(at, o)| o.outcome == super::behaviour::IntentOutcomeKind::Cancelled && *at >= since24))
            .count() as u64;
        let settings_times: Vec<u64> = history.iter().filter(|t| t.kind == TxKind::SettingsChanged && t.from == sender).map(|t| t.timestamp).collect();
        let settings_changes_24h = settings_times.iter().filter(|s| **s >= since24).count() as u64;
        let secs_since_settings_change = settings_times.iter().max().map(|s| tx.timestamp.saturating_sub(*s));
        let intent_to_submit_secs = intents.iter().rev().find(|r| r.intent.user_op_hash == tx.user_op_hash && tx.user_op_hash != alloy_primitives::B256::ZERO).map(|r| tx.timestamp.saturating_sub(r.at));
        let exceeds_own_limit = profile.settings.per_tx_limit_pct > 0 && balance_before > 0.0 && amount / balance_before * 100.0 > f64::from(profile.settings.per_tx_limit_pct);

        TxFeatures {
            version: FEATURES_VERSION,
            network: self.network_of(tx),
            kind: tx.kind,
            signer_kind: signer_kind.into(),
            cosigned: tx.cosignature.is_some(),
            step_up: meta.step_up,
            via_dapp: dapp_origin.is_some(),
            dapp_origin,
            asset,
            asset_symbol: symbol,
            amount,
            fee: meta.fee.unwrap_or(0.0),
            balance_before,
            fraction_of_balance: if balance_before > 0.0 { (amount / balance_before).min(1.0) } else { 0.0 },
            is_round_amount: is_round(tx.action.amount(), decimals),
            timestamp: tx.timestamp,
            hour_utc: ((tx.timestamp % DAY) / 3600) as u8,
            weekday: (((tx.timestamp / DAY) + 3) % 7) as u8, // 1970-01-01 was a Thursday; 0 = Monday
            secs_since_sender_prev_tx: prev.map(|p| tx.timestamp.saturating_sub(p)),
            sender_age_secs,
            decision_latency_secs: meta.prepared_at.map(|p| tx.timestamp.saturating_sub(p)),
            sender_out_count_24h: out_24h.len() as u64,
            sender_out_volume_24h,
            velocity_ratio,
            sender_tx_count: sender_events.len() as u64,
            sender_out_count: sender_out.len() as u64,
            sender_in_count: sender_in.len() as u64,
            sender_distinct_recipients: sender_recipients.len() as u64,
            sender_out_volume,
            sender_prior_flags: sender_flags.len() as u64,
            sender_prior_max_severity: max_sev(&sender_flags),
            sender_escape_active,
            sender_rotations,
            share_of_lifetime_volume: if sender_out_volume + amount > 0.0 { amount / (sender_out_volume + amount) } else { 0.0 },
            counterparty,
            counterparty_is_account: counterparty.is_some_and(|c| self.accounts.contains_key(&c)),
            counterparty_new_for_sender: counterparty.is_some_and(|c| !sender_recipients.contains(&c)),
            counterparty_tx_count: cp_tx_count,
            counterparty_in_count: cp_in,
            counterparty_out_count: cp_out,
            counterparty_distinct_senders: cp_senders,
            counterparty_first_seen_age_secs: cp_first_seen.map(|f| tx.timestamp.saturating_sub(f)),
            counterparty_prior_flags: cp_flags.len() as u64,
            counterparty_prior_max_severity: max_sev(&cp_flags),
            counterparty_reports: self.counterparty_reports(tx),
            reciprocal,
            counterparty_fan_out_ratio: fan_out,
            counterparty_pass_through: pass_through,
            policy: meta.policy.clone().unwrap_or_default(),
            archetype: format!("{:?}", profile.archetype).to_lowercase(),
            activity: format!("{:?}", profile.activity).to_lowercase(),
            amount_vs_mean_out: if profile.mean_out > 0.0 { amount / profile.mean_out } else { 0.0 },
            amount_vs_p95_out: if profile.p95_out > 0.0 { amount / profile.p95_out } else { 0.0 },
            holding_ratio: profile.holding_ratio,
            prior_cancel_rate: profile.cancel_rate,
            cancels_24h,
            settings_changes_24h,
            secs_since_settings_change,
            intent_to_submit_secs,
            exceeds_own_limit,
            risk_accepted: meta.policy.as_ref().is_some_and(|p| p.risk_accepted),
            extra: BTreeMap::new(),
        }
    }

    fn flags_of_address(&self, address: Address) -> Vec<super::Flag> {
        self.order
            .iter()
            .filter_map(|h| self.txs.get(h))
            .filter(|t| t.from == address || t.to == address || t.action.counterparty() == Some(address))
            .flat_map(|t| self.flags.get(&t.hash).cloned().unwrap_or_default())
            .collect()
    }
}
