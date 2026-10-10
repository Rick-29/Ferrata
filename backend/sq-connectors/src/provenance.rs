//! Where did the money come from? For an `external` event on the Ferra chain, look at the
//! counterparty on its origin network and judge it with the same heuristics the review uses for
//! Ferra accounts: freshness, pass-through, fan-in, single use, round trips, sanctions.
//! Works for every `NetworkSource`; needs the network, so it runs on demand, not at commit.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use sq_adapters::{ChainTx, ExternalRef, Network, TxKind};
use ts_rs::TS;
use wallet_core::RiskBand;

use crate::{ConnectorError, NetworkSource, ObservedEvent};

const DAY: u64 = 86_400;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ProvenanceReason {
    pub code: String,
    #[ts(type = "number")]
    pub points: u32,
    pub message: String,
}

/// The verdict on one external event's counterparty, from its own history on the origin network.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ProvenanceAssessment {
    pub network: Network,
    pub counterparty: String,
    #[ts(type = "number")]
    pub events_checked: u64,
    #[ts(type = "number")]
    pub score: u32,
    pub risk: RiskBand,
    pub reasons: Vec<ProvenanceReason>,
    /// `false` when the network could not be reached; the verdict is then a conservative default.
    pub verified: bool,
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

fn units(amount: &str, decimals: u8) -> f64 {
    amount.parse::<f64>().unwrap_or(0.0) / 10f64.powi(i32::from(decimals))
}

/// Pure judgement over the counterparty's page of history. `wallet_raw` is our side's address.
#[allow(clippy::too_many_arguments)]
pub fn judge(network: &Network, counterparty: &str, wallet_raw: &str, event: &ExternalRef, event_time: u64, history: &[ObservedEvent], sanctioned: &[String], verified: bool) -> ProvenanceAssessment {
    let mut reasons = Vec::new();
    let mut push = |code: &str, points: u32, msg: String| reasons.push(ProvenanceReason { code: code.into(), points, message: msg });

    if sanctioned.iter().any(|s| s.eq_ignore_ascii_case(counterparty)) {
        push("SANCTIONED_ADDRESS", 100, format!("{counterparty} is on the sanctions list"));
    }
    if !verified {
        push("UNVERIFIED", 30, "origin network could not be queried; counterparty unknown".into());
    } else {
        let n = history.len();
        if n <= 1 {
            push("SINGLE_USE", 25, "the counterparty has no other activity on its network".into());
        }
        let inbound: Vec<&ObservedEvent> = history.iter().filter(|e| e.incoming).collect();
        let outbound: Vec<&ObservedEvent> = history.iter().filter(|e| !e.incoming).collect();
        let senders: BTreeSet<&str> = inbound.iter().map(|e| e.external.from_raw.as_str()).collect();
        if senders.len() >= 20 {
            push("HIGH_FAN_IN", 15, format!("collects from {} distinct senders", senders.len()));
        }
        // pass-through: received about this amount and forwarded ≥ 90 % within a day (no timestamps on
        // the page, so compare amounts: any outbound ≥ 90 % of any inbound counts)
        let amt = units(&event.amount, event.decimals);
        let forwards = outbound.iter().any(|o| units(&o.external.amount, o.external.decimals) >= 0.9 * amt && amt > 0.0);
        if forwards && !inbound.is_empty() {
            push("PASS_THROUGH", 40, "the counterparty forwards what it receives".into());
        }
        let round_trip = history.iter().any(|e| e.incoming && e.external.from_raw == wallet_raw) && history.iter().any(|e| !e.incoming && e.external.to_raw == wallet_raw);
        if round_trip {
            push("ROUND_TRIP", 10, "funds have gone both ways between the wallet and this counterparty".into());
        }
        let newest_block = history.iter().filter_map(|e| e.external.block).max();
        if let (Some(b), Some(eb)) = (newest_block, event.block)
            && n <= 3
            && b <= eb
        {
            push("FRESH_ADDRESS", 20, "the counterparty appeared on its network only around this event".into());
        }
        let _ = event_time; // reserved: timestamped sources can sharpen FRESH_ADDRESS
    }
    let score = reasons.iter().map(|r| r.points).sum();
    let _ = DAY;
    ProvenanceAssessment { network: network.clone(), counterparty: counterparty.into(), events_checked: history.len() as u64, score, risk: band(score), reasons, verified }
}

/// Fetches the counterparty's page on the origin network and judges it.
pub async fn assess(source: &dyn NetworkSource, tx: &ChainTx, sanctioned: &[String], limit: u32) -> Result<ProvenanceAssessment, ConnectorError> {
    if tx.kind != TxKind::External {
        return Err(ConnectorError::Parse("not an external event".into()));
    }
    let ext: ExternalRef = tx.extra.get("external").cloned().and_then(|v| serde_json::from_value(v).ok()).ok_or_else(|| ConnectorError::Parse("event has no external payload".into()))?;
    let incoming = tx.extra.get("incoming").and_then(|v| v.as_bool()).unwrap_or(true);
    let (counterparty, wallet_raw) = if incoming { (ext.from_raw.clone(), ext.to_raw.clone()) } else { (ext.to_raw.clone(), ext.from_raw.clone()) };
    let network = source.network();
    match source.fetch(&counterparty, None, limit).await {
        Ok(page) => Ok(judge(&network, &counterparty, &wallet_raw, &ext, tx.timestamp, &page.events, sanctioned, true)),
        Err(e) => {
            tracing::warn!(network = %network.name, counterparty, error = %e, "provenance fetch failed");
            Ok(judge(&network, &counterparty, &wallet_raw, &ext, tx.timestamp, &[], sanctioned, false))
        }
    }
}

/// Flag data the review attaches, so the UI can show the reasons.
pub fn as_flag_data(a: &ProvenanceAssessment) -> BTreeMap<String, serde_json::Value> {
    let mut d = BTreeMap::new();
    d.insert("network".into(), serde_json::json!(a.network.name));
    d.insert("counterparty".into(), serde_json::json!(a.counterparty));
    d.insert("score".into(), serde_json::json!(a.score));
    d.insert("verified".into(), serde_json::json!(a.verified));
    d.insert("reasons".into(), serde_json::json!(a.reasons));
    d.insert("events_checked".into(), serde_json::json!(a.events_checked));
    d
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use sq_adapters::ChainFamily;

    fn net() -> Network {
        Network { family: ChainFamily::Ton, name: "ton-testnet".into(), chain_id: None }
    }
    fn ev(from: &str, to: &str, amount: &str, incoming: bool, block: Option<u64>) -> ObservedEvent {
        ObservedEvent {
            external: ExternalRef { network: net(), tx_id: format!("{from}>{to}:{amount}"), block, from_raw: from.into(), to_raw: to.into(), asset_symbol: "TON".into(), decimals: 9, amount: amount.into(), fee: None, explorer_url: None },
            incoming,
            counterparty: None,
        }
    }

    #[test]
    fn pass_through_single_use_and_sanctions_score() {
        let event = ev("EQmule", "EQwallet", "1000000000", true, Some(100)).external;
        // the mule received 1 TON from someone and immediately sent 0.95 TON on
        let history = vec![ev("EQsource", "EQmule", "1000000000", true, Some(99)), ev("EQmule", "EQwallet", "950000000", false, Some(100))];
        let a = judge(&net(), "EQmule", "EQwallet", &event, 1_000, &history, &[], true);
        assert!(a.reasons.iter().any(|r| r.code == "PASS_THROUGH"), "{a:?}");
        assert!(a.reasons.iter().any(|r| r.code == "FRESH_ADDRESS"), "{a:?}");
        assert_eq!(a.risk, RiskBand::High);

        let a = judge(&net(), "EQmule", "EQwallet", &event, 1_000, &history, &["eqmule".into()], true);
        assert_eq!(a.risk, RiskBand::Critical);

        let lone = judge(&net(), "EQx", "EQwallet", &event, 1_000, &[ev("EQx", "EQwallet", "1", true, None)], &[], true);
        assert!(lone.reasons.iter().any(|r| r.code == "SINGLE_USE"));
        assert_eq!(lone.risk, RiskBand::Medium);

        let unverified = judge(&net(), "EQx", "EQwallet", &event, 1_000, &[], &[], false);
        assert!(!unverified.verified);
        assert_eq!(unverified.risk, RiskBand::Medium);
    }

    #[test]
    fn an_established_counterparty_is_low() {
        let event = ev("EQshop", "EQwallet", "5000000", true, Some(500)).external;
        let history: Vec<ObservedEvent> = (0..10).map(|i| ev(&format!("EQc{i}"), "EQshop", "5000000", true, Some(100 + i))).collect();
        let a = judge(&net(), "EQshop", "EQwallet", &event, 1_000, &history, &[], true);
        assert_eq!(a.risk, RiskBand::Low, "{a:?}");
        assert!(a.reasons.is_empty());
    }
}
