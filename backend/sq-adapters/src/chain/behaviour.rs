//! What the wallet owner *intended* and *configured*, recorded next to what they did, so the
//! chain holds the behavioural data a risk model needs:
//!
//! - `settings_changed`: the owner's own limits and timeouts (owner-signed).
//! - `intent`: a transaction composed in the wallet, with the band the wallet computed, before signing.
//! - `intent_outcome`: what became of it (submitted, cancelled, step-up, held, refused, released).
//!
//! From those plus the transfers, `WalletProfile` summarises who this user is (holder, buyer,
//! seller, trader; low / medium / high activity; cancel rate; amount distribution; active hours)
//! and `behaviour_findings` turns deviations into flags.

use std::collections::{BTreeMap, BTreeSet};

use alloy_primitives::{Address, B256, U256, keccak256};
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use wallet_core::RiskBand;

use super::ledger::MockChain;
use super::{ChainTx, Flag, FlagSource, TxKind};

const DAY: u64 = 86_400;

/// The owner's own guard-rails. All optional; `0` means off. Extensible through `extra`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct WalletSettings {
    #[serde(default = "one")]
    #[ts(type = "number")]
    pub version: u32,
    /// Max share of the balance one transaction may move, in percent (0 = off).
    #[serde(default)]
    pub per_tx_limit_pct: u8,
    /// Max outgoing per rolling day, in whole units of the asset (0 = off).
    #[serde(default)]
    pub daily_limit: f64,
    /// Ask for a passkey step-up above this share of the balance, in percent (0 = off).
    #[serde(default)]
    pub step_up_above_pct: u8,
    /// A composed transaction not submitted within this many seconds counts as abandoned.
    #[serde(default = "default_intent_timeout")]
    #[ts(type = "number")]
    pub intent_timeout_secs: u64,
    /// How long the owner is willing to wait on a hold before it lapses.
    #[serde(default = "default_hold_timeout")]
    #[ts(type = "number")]
    pub hold_timeout_secs: u64,
    #[serde(default)]
    #[ts(type = "string[]")]
    pub allowlist: Vec<Address>,
    #[serde(default)]
    #[ts(type = "Record<string, unknown>")]
    pub extra: BTreeMap<String, serde_json::Value>,
}

fn one() -> u32 {
    1
}
fn default_intent_timeout() -> u64 {
    900
}
fn default_hold_timeout() -> u64 {
    600
}

impl Default for WalletSettings {
    fn default() -> Self {
        Self { version: 1, per_tx_limit_pct: 0, daily_limit: 0.0, step_up_above_pct: 0, intent_timeout_secs: 900, hold_timeout_secs: 600, allowlist: Vec::new(), extra: BTreeMap::new() }
    }
}

/// A transaction the owner composed, recorded before it is signed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Intent {
    pub id: String,
    #[ts(type = "string")]
    pub to: Address,
    #[ts(type = "string | null")]
    pub asset: Option<Address>,
    #[ts(type = "string")]
    pub amount: U256,
    pub origin: Option<String>,
    /// What the wallet's policy said at compose time.
    pub band: Option<RiskBand>,
    #[ts(type = "number | null")]
    pub score: Option<u32>,
    /// The hash that would have to be signed to execute it.
    #[ts(type = "string")]
    pub user_op_hash: B256,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum IntentOutcomeKind {
    Submitted,
    Cancelled,
    StepUpRequired,
    Held,
    Refused,
    Released,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct IntentOutcome {
    pub intent_id: String,
    pub outcome: IntentOutcomeKind,
    #[ts(type = "string | null")]
    pub tx_hash: Option<B256>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum Archetype {
    /// Fewer than three outgoing transfers ever.
    New,
    /// Receives and keeps: outgoing volume under a quarter of incoming.
    Holder,
    /// Outgoing dominates incoming.
    Seller,
    /// Incoming dominates but spends regularly.
    Buyer,
    /// Frequent in both directions.
    Trader,
    /// No activity for 30 days.
    Dormant,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ActivityLevel {
    Low,
    Medium,
    High,
}

/// Who this user is, as far as the chain can tell. Computed, never stored.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct WalletProfile {
    #[ts(type = "string")]
    pub address: Address,
    pub archetype: Archetype,
    pub activity: ActivityLevel,
    #[ts(type = "number")]
    pub age_secs: u64,
    #[ts(type = "number")]
    pub events: u64,
    #[ts(type = "number")]
    pub out_count: u64,
    #[ts(type = "number")]
    pub in_count: u64,
    /// Whole units, summed across assets (demo: one stable asset dominates).
    pub out_volume: f64,
    pub in_volume: f64,
    pub mean_out: f64,
    pub p95_out: f64,
    pub max_out: f64,
    /// Share of incoming volume still held: `(in - out) / in`, 0 when nothing came in.
    pub holding_ratio: f64,
    pub out_per_day: f64,
    #[ts(type = "number | null")]
    pub median_interval_secs: Option<u64>,
    /// Outgoing events per UTC hour, 24 buckets.
    #[ts(type = "number[]")]
    pub hour_histogram: Vec<u32>,
    #[ts(type = "number")]
    pub distinct_recipients: u64,
    /// Share of outgoing events to a recipient already paid before.
    pub repeat_recipient_share: f64,
    #[ts(type = "number")]
    pub intents: u64,
    #[ts(type = "number")]
    pub submitted: u64,
    #[ts(type = "number")]
    pub cancelled: u64,
    #[ts(type = "number")]
    pub abandoned: u64,
    pub cancel_rate: f64,
    #[ts(type = "number")]
    pub settings_changes: u64,
    #[ts(type = "number | null")]
    pub last_active: Option<u64>,
    pub settings: WalletSettings,
}

#[derive(Debug, Clone)]
pub(super) struct IntentRecord {
    pub intent: Intent,
    pub at: u64,
    pub outcomes: Vec<(u64, IntentOutcome)>,
}

impl IntentRecord {
    pub fn final_outcome(&self) -> Option<IntentOutcomeKind> {
        self.outcomes.iter().map(|(_, o)| o.outcome).find(|o| matches!(o, IntentOutcomeKind::Submitted | IntentOutcomeKind::Cancelled | IntentOutcomeKind::Refused))
            .or_else(|| self.outcomes.last().map(|(_, o)| o.outcome))
    }
    pub fn submitted_hash(&self) -> Option<B256> {
        self.outcomes.iter().find(|(_, o)| o.outcome == IntentOutcomeKind::Submitted).and_then(|(_, o)| o.tx_hash)
    }
}

fn units(amount: U256, decimals: u8) -> f64 {
    amount.to_string().parse::<f64>().unwrap_or(f64::MAX) / 10f64.powi(i32::from(decimals))
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let idx = ((sorted.len() as f64 - 1.0) * p).round() as usize;
    sorted[idx.min(sorted.len() - 1)]
}

impl MockChain {
    pub fn settings_hash(&self, address: Address, nonce: u64, settings: &WalletSettings) -> B256 {
        let body = serde_json::to_vec(settings).unwrap_or_default();
        let mut buf = Vec::new();
        buf.extend_from_slice(b"SQW-SETTINGS-v1");
        buf.extend_from_slice(&self.chain_id().to_be_bytes());
        buf.extend_from_slice(address.as_slice());
        buf.extend_from_slice(&nonce.to_be_bytes());
        buf.extend_from_slice(keccak256(body).as_slice());
        keccak256(buf)
    }

    pub fn intent_hash(&self, address: Address, intent_id: &str) -> B256 {
        keccak256([b"SQW-INTENT-v1".as_slice(), &self.chain_id().to_be_bytes(), address.as_slice(), intent_id.as_bytes()].concat())
    }

    /// Current settings: the last `settings_changed` event, or defaults.
    pub fn settings_of(&self, address: Address) -> WalletSettings {
        self.order
            .iter()
            .rev()
            .filter_map(|h| self.txs.get(h))
            .find(|t| t.kind == TxKind::SettingsChanged && t.from == address)
            .and_then(|t| t.extra.get("settings").cloned())
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default()
    }

    pub(super) fn intents_of(&self, address: Address) -> Vec<IntentRecord> {
        let mut records: Vec<IntentRecord> = Vec::new();
        for t in self.order.iter().filter_map(|h| self.txs.get(h)).filter(|t| t.from == address) {
            match t.kind {
                TxKind::Intent => {
                    if let Some(i) = t.extra.get("intent").cloned().and_then(|v| serde_json::from_value::<Intent>(v).ok()) {
                        records.push(IntentRecord { intent: i, at: t.timestamp, outcomes: Vec::new() });
                    }
                }
                TxKind::IntentOutcome => {
                    if let Some(o) = t.extra.get("outcome").cloned().and_then(|v| serde_json::from_value::<IntentOutcome>(v).ok())
                        && let Some(r) = records.iter_mut().find(|r| r.intent.id == o.intent_id)
                    {
                        r.outcomes.push((t.timestamp, o));
                    }
                }
                _ => {}
            }
        }
        records
    }

    /// Value flows involving `address`, oldest first: `(tx, incoming, counterparty, units)`.
    pub(super) fn flows_of(&self, address: Address) -> Vec<(ChainTx, bool, Address, f64)> {
        self.order
            .iter()
            .filter_map(|h| self.view_tx(*h))
            .filter(|t| matches!(t.kind, TxKind::Cosigned | TxKind::EscapeExit | TxKind::Faucet | TxKind::External))
            .filter_map(|t| {
                let to = t.action.counterparty()?;
                let decimals = match t.kind {
                    TxKind::External => t.extra.get("external").and_then(|e| e.get("decimals")).and_then(|d| d.as_u64()).unwrap_or(18) as u8,
                    _ => t.action.asset().and_then(|a| self.tokens.get(&a).map(|tk| tk.decimals)).unwrap_or(18),
                };
                let amount = units(t.action.amount(), decimals);
                if t.from == address && to != address {
                    Some((t, false, to, amount))
                } else if to == address {
                    let from = t.from;
                    Some((t, true, from, amount))
                } else {
                    None
                }
            })
            .collect()
    }

    /// Profile as of `now`, from everything on the chain about `address`.
    pub fn profile(&self, address: Address, now: u64) -> WalletProfile {
        let flows = self.flows_of(address);
        let outs: Vec<&(ChainTx, bool, Address, f64)> = flows.iter().filter(|(_, incoming, _, _)| !incoming).collect();
        let ins: Vec<&(ChainTx, bool, Address, f64)> = flows.iter().filter(|(_, incoming, _, _)| *incoming).collect();
        let out_volume: f64 = outs.iter().map(|(_, _, _, a)| a).sum();
        let in_volume: f64 = ins.iter().map(|(_, _, _, a)| a).sum();
        let mut sorted: Vec<f64> = outs.iter().map(|(_, _, _, a)| *a).collect();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let mean_out = if outs.is_empty() { 0.0 } else { out_volume / outs.len() as f64 };
        let created = self.accounts.get(&address).and_then(|a| self.blocks.get(a.created_block as usize)).map(|b| b.timestamp).unwrap_or(now);
        let age_secs = now.saturating_sub(created);
        let days = (age_secs as f64 / DAY as f64).max(1.0);
        let out_per_day = outs.len() as f64 / days;

        let mut hour_histogram = vec![0u32; 24];
        for (t, _, _, _) in &outs {
            hour_histogram[((t.timestamp % DAY) / 3600) as usize] += 1;
        }
        let mut intervals: Vec<u64> = outs.windows(2).map(|w| w[1].0.timestamp.saturating_sub(w[0].0.timestamp)).collect();
        intervals.sort_unstable();
        let median_interval_secs = intervals.get(intervals.len() / 2).copied().filter(|_| !intervals.is_empty());

        let mut seen: BTreeSet<Address> = BTreeSet::new();
        let mut repeats = 0u64;
        for (_, _, cp, _) in &outs {
            if !seen.insert(*cp) {
                repeats += 1;
            }
        }
        let last_active = flows.last().map(|(t, _, _, _)| t.timestamp);

        let settings = self.settings_of(address);
        let intents = self.intents_of(address);
        let submitted = intents.iter().filter(|r| r.final_outcome() == Some(IntentOutcomeKind::Submitted)).count() as u64;
        let cancelled = intents.iter().filter(|r| r.final_outcome() == Some(IntentOutcomeKind::Cancelled)).count() as u64;
        let abandoned = intents.iter().filter(|r| r.final_outcome().is_none() && now.saturating_sub(r.at) > settings.intent_timeout_secs).count() as u64;
        let decided = submitted + cancelled + abandoned;
        let cancel_rate = if decided == 0 { 0.0 } else { (cancelled + abandoned) as f64 / decided as f64 };
        let settings_changes = self.order.iter().filter_map(|h| self.txs.get(h)).filter(|t| t.kind == TxKind::SettingsChanged && t.from == address).count() as u64;

        let activity = if out_per_day >= 3.0 {
            ActivityLevel::High
        } else if out_per_day >= 0.3 {
            ActivityLevel::Medium
        } else {
            ActivityLevel::Low
        };
        let archetype = if last_active.is_some_and(|l| now.saturating_sub(l) > 30 * DAY) {
            Archetype::Dormant
        } else if outs.len() < 3 {
            Archetype::New
        } else if in_volume > 0.0 && out_volume < 0.25 * in_volume {
            Archetype::Holder
        } else if activity == ActivityLevel::High && !ins.is_empty() {
            Archetype::Trader
        } else if out_volume > in_volume {
            Archetype::Seller
        } else {
            Archetype::Buyer
        };

        WalletProfile {
            address,
            archetype,
            activity,
            age_secs,
            events: self.order.iter().filter_map(|h| self.txs.get(h)).filter(|t| t.from == address || t.to == address).count() as u64,
            out_count: outs.len() as u64,
            in_count: ins.len() as u64,
            out_volume,
            in_volume,
            mean_out,
            p95_out: percentile(&sorted, 0.95),
            max_out: sorted.last().copied().unwrap_or(0.0),
            holding_ratio: if in_volume > 0.0 { ((in_volume - out_volume) / in_volume).clamp(0.0, 1.0) } else { 0.0 },
            out_per_day,
            median_interval_secs,
            hour_histogram,
            distinct_recipients: seen.len() as u64,
            repeat_recipient_share: if outs.is_empty() { 0.0 } else { repeats as f64 / outs.len() as f64 },
            intents: intents.len() as u64,
            submitted,
            cancelled,
            abandoned,
            cancel_rate,
            settings_changes,
            last_active,
            settings,
        }
    }

    /// Deviations between what this user usually does and what they just did. Pure; the review
    /// writes them as flags, `ferra-verify --behaviour` prints them.
    pub fn behaviour_findings(&self, address: Address, now: u64) -> Vec<Flag> {
        let mut out = Vec::new();
        let flag = |target: B256, severity: RiskBand, code: &str, msg: String, data: BTreeMap<String, serde_json::Value>| Flag {
            code: code.into(),
            severity,
            source: FlagSource::Behaviour,
            message: msg,
            at: now,
            target,
            data,
        };
        let intents = self.intents_of(address);
        let settings_events: Vec<u64> = self.order.iter().filter_map(|h| self.txs.get(h)).filter(|t| t.kind == TxKind::SettingsChanged && t.from == address).map(|t| t.timestamp).collect();

        // 1. Cancel streak: two or more cancelled / abandoned intents, then a submission.
        let mut streak = 0u32;
        for r in &intents {
            match r.final_outcome() {
                Some(IntentOutcomeKind::Cancelled) => streak += 1,
                None if now.saturating_sub(r.at) > self.settings_of(address).intent_timeout_secs => streak += 1,
                Some(IntentOutcomeKind::Submitted) => {
                    if streak >= 2
                        && let Some(h) = r.submitted_hash()
                    {
                        let mut d = BTreeMap::new();
                        d.insert("cancelled_before".into(), serde_json::json!(streak));
                        out.push(flag(h, RiskBand::High, "CANCEL_STREAK", format!("submitted after {streak} cancelled or abandoned attempts"), d));
                    }
                    streak = 0;
                }
                _ => {}
            }
        }

        // 2. Settings changed between a blocked / cancelled attempt and a retry to the same target.
        for (i, r) in intents.iter().enumerate() {
            let Some(h) = r.submitted_hash() else { continue };
            let retry_of = intents[..i].iter().rev().find(|p| p.intent.to == r.intent.to && p.final_outcome() != Some(IntentOutcomeKind::Submitted));
            if let Some(prev) = retry_of
                && settings_events.iter().any(|s| *s >= prev.at && *s <= r.at)
                && r.at.saturating_sub(prev.at) <= 6 * 3600
            {
                let mut d = BTreeMap::new();
                d.insert("previous_intent".into(), serde_json::json!(prev.intent.id));
                d.insert("previous_outcome".into(), serde_json::json!(prev.final_outcome()));
                out.push(flag(h, RiskBand::High, "SETTINGS_THEN_RETRY", "settings were changed between a blocked attempt and a retry to the same recipient".into(), d));
            }
        }

        // 3. Deviation from the profile, judged per outgoing transfer against the history before it.
        let flows = self.flows_of(address);
        let mut prior: Vec<f64> = Vec::new();
        let mut prior_recipients: BTreeSet<Address> = BTreeSet::new();
        let mut last_ts: Option<u64> = None;
        let mut in_volume = 0.0;
        let mut out_volume = 0.0;
        for (t, incoming, cp, amount) in &flows {
            if *incoming {
                in_volume += amount;
                continue;
            }
            if prior.len() >= 5 {
                let mut sorted = prior.clone();
                sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
                let p95 = percentile(&sorted, 0.95);
                let mean = prior.iter().sum::<f64>() / prior.len() as f64;
                let holder = in_volume > 0.0 && out_volume < 0.25 * in_volume;
                if *amount > (3.0 * p95).max(5.0 * mean) && !prior_recipients.contains(cp) {
                    let mut d = BTreeMap::new();
                    d.insert("amount".into(), serde_json::json!(amount));
                    d.insert("p95_before".into(), serde_json::json!(p95));
                    d.insert("mean_before".into(), serde_json::json!(mean));
                    d.insert("holder".into(), serde_json::json!(holder));
                    let sev = if holder { RiskBand::High } else { RiskBand::Medium };
                    out.push(flag(t.hash, sev, "BEHAVIOUR_DEVIATION", format!("{amount:.2} to a new recipient dwarfs this user's usual {mean:.2} (p95 {p95:.2})"), d));
                }
                if let Some(l) = last_ts
                    && t.timestamp.saturating_sub(l) > 30 * DAY
                    && *amount > p95
                {
                    out.push(flag(t.hash, RiskBand::Medium, "DORMANT_BURST", format!("first transfer after {} days is above the usual size", t.timestamp.saturating_sub(l) / DAY), BTreeMap::new()));
                }
            }
            prior.push(*amount);
            prior_recipients.insert(*cp);
            last_ts = Some(t.timestamp);
            out_volume += amount;
        }

        // 4. Over the owner's own limit (the policy also says so; here it is on the record).
        let settings = self.settings_of(address);
        if settings.per_tx_limit_pct > 0 {
            for t in self.order.iter().filter_map(|h| self.txs.get(h)).filter(|t| t.from == address && matches!(t.kind, TxKind::Cosigned | TxKind::EscapeExit)) {
                if let Some(f) = &t.features
                    && f.fraction_of_balance * 100.0 > f64::from(settings.per_tx_limit_pct)
                {
                    out.push(flag(t.hash, RiskBand::Medium, "OWN_LIMIT_BYPASS", format!("moved {:.0}% of the balance against an own limit of {}%", f.fraction_of_balance * 100.0, settings.per_tx_limit_pct), BTreeMap::new()));
                }
            }
        }
        out
    }
}
