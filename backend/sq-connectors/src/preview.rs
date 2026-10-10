//! Risk **before** a transaction: "how risky is paying this address on this network, for this user,
//! for this amount, and why". The answer is built for a UI sentence: an odds multiplier against a
//! typical transfer, and the factors that produced it, each with its own multiplier.
//!
//! The multipliers come straight from the logistic model: every feature multiplies the odds by
//! `exp(weight × value)`, so "3.2× riskier than normal because the recipient is new (×2.0) and it
//! moves 90 % of your balance (×1.6)" is exact arithmetic, not a paraphrase. Rule-based reasons
//! are listed next to them for auditability.

use std::time::Instant;

use serde::{Deserialize, Serialize};
use sq_adapters::{Network, RiskModel, TxFeatures};
use ts_rs::TS;
use wallet_core::RiskBand;

use crate::provenance::{Evidence, ProvenanceAssessment, Watchlists, judge};
use crate::report::ReportConfig;
use crate::risk::{RiskInputs, RiskReason, TransferRisk};
use crate::tracing::{TraceConfig, trace_exposure};
use crate::{AccountInfo, ConnectorError, NetworkSource, ObservedEvent};

const DAY: u64 = 86_400;

/// What the wallet knows about its own user. The services fill it from the Ferra chain profile;
/// a caller without a Ferra account can pass it directly.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SenderContext {
    /// Balance of the asset being sent, whole units.
    pub balance_units: f64,
    /// Outgoing transfers so far.
    #[ts(type = "number")]
    pub prior_out_count: u64,
    pub mean_out_units: f64,
    pub p95_out_units: f64,
    #[ts(type = "number")]
    pub age_secs: u64,
    pub known_recipient: bool,
    /// Outgoing transfers in the last 24 h.
    #[ts(type = "number")]
    pub out_count_24h: u64,
    /// `new`, `holder`, `buyer`, `seller`, `trader`, `dormant` (from the profile) when known.
    pub archetype: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AmountSpec {
    pub units: f64,
    pub asset_symbol: String,
    pub decimals: u8,
}

/// One model factor, phrased for people. `odds_multiplier > 1` raises the risk, `< 1` lowers it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RiskFactor {
    /// Feature name in `TxFeatures::to_vector()` terms, e.g. `counterparty_new_for_sender`.
    pub code: String,
    pub odds_multiplier: f64,
    /// Log-odds contribution; sum of these is the model's total shift from its baseline.
    pub contribution: f64,
    /// The feature's value as the model saw it.
    pub value: f64,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RiskPreview {
    #[ts(type = "number")]
    pub schema_version: u32,
    pub network: Network,
    pub counterparty: String,
    pub amount: Option<AmountSpec>,
    /// Model probability for a transfer with nothing unusual about it.
    pub baseline_probability: f64,
    /// Model probability for this transfer.
    pub probability: f64,
    /// `odds(probability) / odds(baseline)`: "x times riskier than a typical transfer".
    pub odds_vs_baseline: f64,
    pub band: RiskBand,
    /// Rule-based reasons with points (auditable), same as in the transfer report.
    pub reasons: Vec<RiskReason>,
    /// Model factors, strongest first, those raising the risk before those lowering it.
    pub factors: Vec<RiskFactor>,
    /// One English sentence the UI can show or translate: "{x}× riskier than normal: … ".
    pub summary: String,
    pub counterparty_info: Option<AccountInfo>,
    pub provenance: Option<ProvenanceAssessment>,
    pub features: TxFeatures,
    #[ts(type = "number")]
    pub elapsed_ms: u64,
    pub notes: Vec<String>,
}

/// Human phrasing for the features that matter most. Unknown features fall back to the code.
fn phrase(code: &str, value: f64, f: &TxFeatures) -> String {
    match code {
        "counterparty_new_for_sender" => "first payment to this address".into(),
        "counterparty_is_account" => "the recipient is a Swissquote-registered wallet".into(),
        "counterparty_pass_through" => "the recipient forwards what it receives".into(),
        "counterparty_fan_out_ratio" => "the recipient spreads funds across many addresses".into(),
        "counterparty_prior_max_severity" => "the recipient was flagged before".into(),
        "reciprocal" => "funds have gone back and forth with this address".into(),
        "fraction_of_balance" => format!("moves {:.0}% of your balance", f.fraction_of_balance * 100.0),
        "share_of_lifetime_volume" => format!("this is {:.0}% of everything you ever sent", f.share_of_lifetime_volume * 100.0),
        "amount_log" => format!("amount of {:.4} {}", f.amount, f.asset_symbol),
        "amount_vs_mean_out" => format!("{:.1}× your usual payment", f.amount_vs_mean_out),
        "amount_vs_p95_out" => format!("{:.1}× your largest usual payment", f.amount_vs_p95_out),
        "is_round_amount" => "round amount".into(),
        "is_night" => "at night (UTC)".into(),
        "is_weekend" => "on a weekend".into(),
        "sender_age_days" => format!("your wallet is {:.0} days old", value),
        "has_prev_tx" => "you have transacted before".into(),
        "sender_out_count_24h" => format!("{} payments in the last 24 h", f.sender_out_count_24h),
        "velocity_ratio" => "much faster than your usual pace".into(),
        "decision_latency_secs" => "signed unusually long after preparing".into(),
        "step_up" => "confirmed with a second passkey signature".into(),
        "risk_accepted" => "you accepted a risk warning".into(),
        "via_dapp" => "requested by a website".into(),
        "sender_escape_active" => "an escape-hatch timer is running on your wallet".into(),
        "policy_sanctions_hit" => "the recipient is on a sanctions list".into(),
        "policy_exposure_hops" => format!("the recipient is {} hop(s) from a flagged address", f.policy.exposure_hops.unwrap_or(0)),
        "policy_band" => format!("the recipient's provenance check came back {}", f.policy.band.map(|b| format!("{b:?}")).unwrap_or_else(|| "unknown".into())),
        "prior_cancel_rate" => "you often cancel payments".into(),
        "cancels_24h" => format!("{} cancelled attempts in the last 24 h", f.cancels_24h),
        "settings_changes_24h" => "your settings changed in the last 24 h".into(),
        "exceeds_own_limit" => "above the limit you set for yourself".into(),
        c if c.starts_with("archetype_") => format!("you are a {}", c.trim_start_matches("archetype_")),
        c if c.starts_with("activity_") => format!("your activity is {}", c.trim_start_matches("activity_")),
        c if c.starts_with("family_") => format!("on {}", c.trim_start_matches("family_")),
        c if c.starts_with("kind_") => format!("event type {}", c.trim_start_matches("kind_")),
        c if c.starts_with("signer_") => format!("signed with {}", c.trim_start_matches("signer_")),
        other => other.replace('_', " "),
    }
}

fn band_of(p: f64, threshold: f64) -> RiskBand {
    if p >= 0.9 {
        RiskBand::Critical
    } else if p >= threshold {
        RiskBand::High
    } else if p >= threshold / 2.0 {
        RiskBand::Medium
    } else {
        RiskBand::Low
    }
}

fn summary(odds: f64, factors: &[RiskFactor], reasons: &[RiskReason]) -> String {
    let up: Vec<&RiskFactor> = factors.iter().filter(|f| f.odds_multiplier > 1.05).take(3).collect();
    let down: Vec<&RiskFactor> = factors.iter().filter(|f| f.odds_multiplier < 0.95).take(2).collect();
    let mut s = if odds >= 1.15 {
        format!("This transfer is {odds:.1}× riskier than a typical one")
    } else if odds <= 0.85 {
        format!("This transfer is {:.1}× safer than a typical one", 1.0 / odds)
    } else {
        "This transfer looks like a typical one".to_string()
    };
    if !up.is_empty() {
        s.push_str(": ");
        s.push_str(&up.iter().map(|f| format!("{} (×{:.1})", f.message, f.odds_multiplier)).collect::<Vec<_>>().join(", "));
    }
    if !down.is_empty() {
        s.push_str(if up.is_empty() { ": " } else { "; in its favour, " });
        s.push_str(&down.iter().map(|f| format!("{} (×{:.1})", f.message, f.odds_multiplier)).collect::<Vec<_>>().join(", "));
    }
    if let Some(r) = reasons.iter().find(|r| r.points >= 100) {
        s.push_str(&format!(". {}", r.message));
    }
    s.push('.');
    s
}

/// Applies what the wallet knows about its user on top of the indexer-derived features.
fn apply_sender(f: &mut TxFeatures, ctx: &SenderContext) {
    f.balance_before = ctx.balance_units;
    f.fraction_of_balance = if ctx.balance_units > 0.0 { (f.amount / ctx.balance_units).min(1.0) } else { 0.0 };
    f.sender_out_count = ctx.prior_out_count;
    f.sender_tx_count = f.sender_tx_count.max(ctx.prior_out_count);
    f.sender_age_secs = ctx.age_secs;
    f.counterparty_new_for_sender = !ctx.known_recipient;
    f.sender_out_count_24h = ctx.out_count_24h;
    f.amount_vs_mean_out = if ctx.mean_out_units > 0.0 { f.amount / ctx.mean_out_units } else { 0.0 };
    f.amount_vs_p95_out = if ctx.p95_out_units > 0.0 { f.amount / ctx.p95_out_units } else { 0.0 };
    f.share_of_lifetime_volume = if ctx.mean_out_units * ctx.prior_out_count as f64 + f.amount > 0.0 { f.amount / (ctx.mean_out_units * ctx.prior_out_count as f64 + f.amount) } else { 0.0 };
    let days = (ctx.age_secs as f64 / DAY as f64).max(1.0);
    f.velocity_ratio = if ctx.prior_out_count == 0 { 0.0 } else { ctx.out_count_24h as f64 / (ctx.prior_out_count as f64 / days) };
    if let Some(a) = &ctx.archetype {
        f.archetype = a.clone();
    }
    f.activity = if ctx.prior_out_count as f64 / days >= 3.0 { "high" } else if ctx.prior_out_count as f64 / days >= 0.3 { "medium" } else { "low" }.into();
}

/// Without the wallet's side, nothing about the sender may count for or against the transfer.
fn neutral_sender(f: &mut TxFeatures) {
    f.share_of_lifetime_volume = 0.0;
    f.fraction_of_balance = 0.0;
    f.counterparty_new_for_sender = false;
    f.sender_age_secs = 0;
    f.amount_vs_mean_out = 0.0;
    f.amount_vs_p95_out = 0.0;
    f.velocity_ratio = 0.0;
    f.archetype = String::new();
    f.activity = String::new();
}

/// Builds the preview: the counterparty's history, account info and exposure trace are fetched
/// concurrently; the model then scores a synthetic transfer from the wallet to the counterparty.
#[allow(clippy::too_many_arguments)]
pub async fn risk_preview(
    source: &dyn NetworkSource,
    counterparty_raw: &str,
    wallet_raw: Option<&str>,
    amount: Option<AmountSpec>,
    sender: Option<&SenderContext>,
    lists: &Watchlists,
    model: Option<&dyn RiskModel>,
    cfg: ReportConfig,
    now: u64,
) -> Result<RiskPreview, ConnectorError> {
    let started = Instant::now();
    let network = source.network();
    let counterparty = source.canonical(counterparty_raw);
    let wallet = wallet_raw.map(|w| source.canonical(w)).unwrap_or_else(|| "wallet".into());
    let mut notes = Vec::new();

    let (history, info, exposure) = tokio::join!(
        async {
            let mut all = Vec::new();
            let mut cursor: Option<String> = None;
            for _ in 0..cfg.max_pages.min(1) {
                match source.fetch(&counterparty, cursor.as_deref(), cfg.page_limit).await {
                    Ok(p) => {
                        all.extend(p.events);
                        cursor = p.next_cursor;
                        if cursor.is_none() {
                            break;
                        }
                    }
                    Err(e) => return Err(e),
                }
            }
            Ok::<_, ConnectorError>(all)
        },
        async { source.account_info(&counterparty).await },
        async {
            if cfg.with_exposure && !lists.flagged.is_empty() {
                // A pre-signing call: one hop, few requests. The full trace runs in the review afterwards.
                trace_exposure(source, &counterparty, &lists.flagged, TraceConfig { max_depth: 1, max_degree: 40, page_limit: 25, request_budget: 6 }).await.ok()
            } else {
                None
            }
        }
    );
    let (history, verified) = match history {
        Ok(h) => (h, true),
        Err(e) => {
            notes.push(format!("counterparty history: {e}"));
            (Vec::new(), false)
        }
    };
    let info = match info {
        Ok(i) => Some(i),
        Err(e) => {
            notes.push(format!("counterparty account info: {e}"));
            None
        }
    };

    let (symbol, decimals, amount_units) = amount.as_ref().map(|a| (a.asset_symbol.clone(), a.decimals, a.units)).unwrap_or_else(|| (info.as_ref().map(|i| i.native_symbol.clone()).unwrap_or_default(), info.as_ref().map(|i| i.native_decimals).unwrap_or(0), 0.0));
    let base_units = (amount_units * 10f64.powi(i32::from(decimals))).round();
    let ext = sq_adapters::ExternalRef {
        network: network.clone(),
        tx_id: String::new(),
        block: None,
        from_raw: wallet.clone(),
        to_raw: counterparty.clone(),
        asset_symbol: symbol,
        decimals,
        amount: format!("{base_units:.0}"),
        fee: None,
        explorer_url: None,
        timestamp: Some(now),
        asset_address: None,
    };
    let provenance = judge(&Evidence { network: &network, counterparty: &counterparty, wallet: &wallet, event: &ext, event_time: now, history: &history, info: info.as_ref(), exposure: exposure.as_ref(), lists, verified });
    let transfer = ObservedEvent { external: ext, incoming: false, counterparty: None, counterparty_label: info.as_ref().and_then(|i| i.name.clone()), scam_flag: info.as_ref().is_some_and(|i| i.is_scam) };
    let inputs = RiskInputs { network: &network, transfer: &transfer, sender_history: &[], sender_info: None, receiver_history: &history, receiver_info: info.as_ref(), provenance: Some(&provenance), now };
    let mut features = crate::risk::features_from_history(&inputs);
    match sender {
        Some(ctx) => apply_sender(&mut features, ctx),
        None => neutral_sender(&mut features),
    }
    let TransferRisk { reasons, .. } = crate::risk::assess_features(&inputs, features.clone(), None);

    let (baseline, probability, factors, threshold) = match model {
        Some(m) => {
            let contributions = m.explain(&features, usize::MAX);
            let vector = features.to_vector();
            let mut factors: Vec<RiskFactor> = contributions
                .into_iter()
                .filter(|(_, c)| c.abs() > 1e-9)
                .map(|(code, c)| RiskFactor { odds_multiplier: c.exp(), contribution: c, value: vector.get(&code).copied().unwrap_or(0.0), message: phrase(&code, vector.get(&code).copied().unwrap_or(0.0), &features), code })
                .collect();
            factors.sort_by(|a, b| b.contribution.abs().partial_cmp(&a.contribution.abs()).unwrap_or(std::cmp::Ordering::Equal));
            (m.baseline(), m.score(&features), factors, m.describe().threshold)
        }
        None => {
            let p = f64::from(reasons.iter().map(|r| r.points).sum::<u32>().min(100)) / 100.0;
            (0.1, p.max(0.01), Vec::new(), 0.6)
        }
    };
    let odds = |p: f64| p / (1.0 - p).max(1e-9);
    let odds_vs_baseline = odds(probability) / odds(baseline).max(1e-9);
    let band = if reasons.iter().any(|r| r.points >= 100) { RiskBand::Critical } else { band_of(probability, threshold) };
    let summary = summary(odds_vs_baseline, &factors, &reasons);

    Ok(RiskPreview {
        schema_version: 1,
        network,
        counterparty,
        amount,
        baseline_probability: baseline,
        probability,
        odds_vs_baseline,
        band,
        reasons,
        factors,
        summary,
        counterparty_info: info,
        provenance: Some(provenance),
        features,
        elapsed_ms: started.elapsed().as_millis() as u64,
        notes,
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use crate::Page;
    use async_trait::async_trait;
    use sq_adapters::{ChainFamily, ExternalRef, LinearModel};
    use std::collections::BTreeMap;

    struct Fake;
    #[async_trait]
    impl NetworkSource for Fake {
        fn network(&self) -> Network {
            Network { family: ChainFamily::Other, name: "t".into(), chain_id: None }
        }
        async fn fetch(&self, _: &str, _: Option<&str>, _: u32) -> Result<Page, ConnectorError> {
            Ok(Page {
                events: vec![ObservedEvent {
                    external: ExternalRef { network: self.network(), tx_id: "x".into(), block: Some(1), from_raw: "someone".into(), to_raw: "mule".into(), asset_symbol: "X".into(), decimals: 2, amount: "100".into(), fee: None, explorer_url: None, timestamp: Some(900), asset_address: None },
                    incoming: true,
                    counterparty: None,
                    counterparty_label: None,
                    scam_flag: false,
                }],
                next_cursor: None,
            })
        }
    }

    fn model() -> LinearModel {
        LinearModel {
            name: "t".into(),
            bias: -3.0,
            threshold: 0.6,
            weights: BTreeMap::from([("counterparty_new_for_sender".to_string(), 0.7), ("fraction_of_balance".to_string(), 1.8), ("has_prev_tx".to_string(), -0.3)]),
            transforms: BTreeMap::new(),
        }
    }

    #[tokio::test]
    async fn preview_explains_odds_with_multiplicative_factors() {
        let m = model();
        let ctx = SenderContext { balance_units: 10.0, prior_out_count: 20, mean_out_units: 0.5, p95_out_units: 1.0, age_secs: 400 * DAY, known_recipient: false, out_count_24h: 0, archetype: Some("holder".into()) };
        let p = risk_preview(&Fake, "mule", Some("me"), Some(AmountSpec { units: 9.0, asset_symbol: "X".into(), decimals: 2 }), Some(&ctx), &Watchlists::default(), Some(&m), ReportConfig::default(), 1_000).await.unwrap();
        assert!((p.baseline_probability - 1.0 / (1.0 + 3f64.exp())).abs() < 1e-9);
        assert!(p.probability > p.baseline_probability);
        let new_recipient = p.factors.iter().find(|f| f.code == "counterparty_new_for_sender").unwrap();
        assert!((new_recipient.odds_multiplier - 0.7f64.exp()).abs() < 1e-9);
        let drain = p.factors.iter().find(|f| f.code == "fraction_of_balance").unwrap();
        assert!((drain.odds_multiplier - (1.8 * 0.9f64).exp()).abs() < 1e-9, "{drain:?}");
        // product of the factors equals the odds shift from the baseline
        let product: f64 = p.factors.iter().map(|f| f.odds_multiplier).product();
        assert!((product - p.odds_vs_baseline).abs() < 1e-6, "{product} vs {}", p.odds_vs_baseline);
        assert!(p.summary.starts_with("This transfer is"), "{}", p.summary);
        assert!(p.summary.contains("first payment to this address"));
        assert!(p.reasons.iter().any(|r| r.code == "DRAINS_BALANCE"));
        assert!(p.features.sender_age_secs == 400 * DAY && p.features.archetype == "holder");
    }

    #[tokio::test]
    async fn preview_without_model_uses_reason_points() {
        let p = risk_preview(&Fake, "mule", None, None, None, &Watchlists::default(), None, ReportConfig::default(), 1_000).await.unwrap();
        assert!(p.factors.is_empty());
        assert!(p.summary.ends_with('.'));
    }
}
