//! Where did the money come from? For an `external` event on the Ferra chain, look at the
//! counterparty on its origin network and judge it: what the indexer says about it (scam label,
//! known service, age, activity), what its own history shows (pass-through, fan-in, single use,
//! round trips), how close it is to a flagged address (exposure trace), and the sanctions list.
//! Works for every `NetworkSource`; needs the network, so it runs on demand, not at commit.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use sq_adapters::{ChainTx, ExternalRef, Network, TxKind};
use ts_rs::TS;
use wallet_core::RiskBand;

use crate::tracing::{ExposureResult, TraceConfig, trace_exposure};
use crate::{AccountInfo, ConnectorError, NetworkSource, ObservedEvent};

const DAY: u64 = 86_400;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ProvenanceReason {
    pub code: String,
    /// Negative points lower the score (a known, labelled service).
    #[ts(type = "number")]
    pub points: i32,
    pub message: String,
}

/// The verdict on one external event's counterparty, from its own standing on the origin network.
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
    #[serde(default)]
    pub counterparty_info: Option<AccountInfo>,
    #[serde(default)]
    pub exposure: Option<ExposureResult>,
}

/// Lists the judge consults, all in the network's canonical address form.
#[derive(Debug, Clone, Default)]
pub struct Watchlists {
    pub sanctioned: BTreeSet<String>,
    /// Mixers, hacks, drainers: used by the exposure trace.
    pub flagged: BTreeSet<String>,
}

impl Watchlists {
    pub fn from_raw(sanctioned: &[String], flagged: &[String]) -> Self {
        Self { sanctioned: sanctioned.iter().cloned().collect(), flagged: flagged.iter().cloned().collect() }
    }
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

const SERVICE_LABELS: &[&str] = &["exchange", "cex", "dex", "bridge", "staking", "validator", "pool", "market"];

/// Inputs the judge needs; gathered by `assess`, built directly by tests.
pub struct Evidence<'a> {
    pub network: &'a Network,
    pub counterparty: &'a str,
    pub wallet: &'a str,
    pub event: &'a ExternalRef,
    pub event_time: u64,
    pub history: &'a [ObservedEvent],
    pub info: Option<&'a AccountInfo>,
    pub exposure: Option<&'a ExposureResult>,
    pub lists: &'a Watchlists,
    pub verified: bool,
}

/// Pure judgement.
pub fn judge(e: &Evidence<'_>) -> ProvenanceAssessment {
    let mut reasons: Vec<ProvenanceReason> = Vec::new();
    let mut known_service = false;
    let mut push = |code: &str, points: i32, msg: String| reasons.push(ProvenanceReason { code: code.into(), points, message: msg });

    if e.lists.sanctioned.contains(e.counterparty) {
        push("SANCTIONED_ADDRESS", 100, format!("{} is on the sanctions list", e.counterparty));
    }
    if !e.verified {
        push("UNVERIFIED", 30, "origin network could not be queried; counterparty unknown".into());
    } else {
        // What the indexer says about the address itself.
        if let Some(info) = e.info {
            if info.is_scam {
                push("SCAM_LABELLED", 80, "the network's indexer marks this address as a scam".into());
            }
            let service = info.labels.iter().any(|l| SERVICE_LABELS.iter().any(|s| l.to_lowercase().contains(s)));
            if service && !info.is_scam {
                known_service = true;
                push("KNOWN_SERVICE", -20, format!("labelled {}", info.labels.join(", ")));
            }
            if let Some(name) = &info.name
                && !info.is_scam
            {
                push("NAMED", -5, format!("resolves to {name}"));
            }
            if let Some(first) = info.first_seen
                && e.event_time.saturating_sub(first) < DAY
            {
                push("FRESH_ADDRESS", 20, "the counterparty appeared on its network less than a day before this event".into());
            }
            if info.is_contract && !service {
                push("UNLABELLED_CONTRACT", 10, "a contract with no known label".into());
            }
        }
        // What its own history shows.
        let n = e.history.len();
        if n <= 1 && e.info.and_then(|i| i.tx_count).unwrap_or(n as u64) <= 1 {
            push("SINGLE_USE", 25, "the counterparty has no other activity on its network".into());
        }
        let inbound: Vec<&ObservedEvent> = e.history.iter().filter(|x| x.incoming).collect();
        let outbound: Vec<&ObservedEvent> = e.history.iter().filter(|x| !x.incoming).collect();
        let senders: BTreeSet<&str> = inbound.iter().map(|x| x.external.from_raw.as_str()).collect();
        if senders.len() >= 20 && !known_service {
            push("HIGH_FAN_IN", 15, format!("collects from {} distinct senders", senders.len()));
        }
        let amt = units(&e.event.amount, e.event.decimals);
        let forwards = outbound.iter().any(|o| units(&o.external.amount, o.external.decimals) >= 0.9 * amt && amt > 0.0);
        if forwards && !inbound.is_empty() && !known_service {
            push("PASS_THROUGH", 40, "the counterparty forwards what it receives".into());
        }
        let round_trip = e.history.iter().any(|x| x.incoming && x.external.from_raw == e.wallet) && e.history.iter().any(|x| !x.incoming && x.external.to_raw == e.wallet);
        if round_trip {
            push("ROUND_TRIP", 10, "funds have gone both ways between the wallet and this counterparty".into());
        }
        if e.history.iter().any(|x| x.scam_flag) {
            push("SCAM_EVENTS", 30, "the indexer marks events of this counterparty as scams".into());
        }
        if e.info.is_none()
            && let Some(newest) = e.history.iter().filter_map(|x| x.external.block).max()
            && let Some(eb) = e.event.block
            && n <= 3
            && newest <= eb
        {
            push("FRESH_ADDRESS", 20, "the counterparty appeared on its network only around this event".into());
        }
        // How close it is to something flagged.
        if let Some(x) = e.exposure
            && let Some(h) = x.hops
        {
            let pts = match h {
                0 => 80,
                1 => 50,
                _ => 30,
            };
            push("EXPOSURE", pts, format!("{h} hop(s) from a flagged address via {}", x.path.join(" → ")));
        }
    }
    let score = reasons.iter().map(|r| r.points).sum::<i32>().max(0) as u32;
    ProvenanceAssessment {
        network: e.network.clone(),
        counterparty: e.counterparty.into(),
        events_checked: e.history.len() as u64,
        score,
        risk: band(score),
        reasons,
        verified: e.verified,
        counterparty_info: e.info.cloned(),
        exposure: e.exposure.cloned(),
    }
}

/// Fetches the counterparty's history, its account info and (when `lists.flagged` is not empty)
/// an exposure trace, then judges. Fetch failures degrade to an unverified verdict, never an error.
pub async fn assess(source: &dyn NetworkSource, tx: &ChainTx, lists: &Watchlists, limit: u32) -> Result<ProvenanceAssessment, ConnectorError> {
    if tx.kind != TxKind::External {
        return Err(ConnectorError::Parse("not an external event".into()));
    }
    let ext: ExternalRef = tx.extra.get("external").cloned().and_then(|v| serde_json::from_value(v).ok()).ok_or_else(|| ConnectorError::Parse("event has no external payload".into()))?;
    let incoming = tx.extra.get("incoming").and_then(|v| v.as_bool()).unwrap_or(true);
    let (counterparty, wallet) = if incoming { (ext.from_raw.clone(), ext.to_raw.clone()) } else { (ext.to_raw.clone(), ext.from_raw.clone()) };
    let counterparty = source.canonical(&counterparty);
    let wallet = source.canonical(&wallet);
    let network = source.network();

    let history = match source.fetch(&counterparty, None, limit).await {
        Ok(page) => page.events,
        Err(err) => {
            ::tracing::warn!(network = %network.name, counterparty, error = %err, "provenance fetch failed");
            let e = Evidence { network: &network, counterparty: &counterparty, wallet: &wallet, event: &ext, event_time: tx.timestamp, history: &[], info: None, exposure: None, lists, verified: false };
            return Ok(judge(&e));
        }
    };
    let info = match source.account_info(&counterparty).await {
        Ok(i) => Some(i),
        Err(ConnectorError::Unsupported(_)) => None,
        Err(err) => {
            ::tracing::debug!(network = %network.name, counterparty, error = %err, "account info unavailable");
            None
        }
    };
    let exposure = if lists.flagged.is_empty() {
        None
    } else {
        trace_exposure(source, &counterparty, &lists.flagged, TraceConfig::default()).await.ok()
    };
    let e = Evidence { network: &network, counterparty: &counterparty, wallet: &wallet, event: &ext, event_time: tx.timestamp, history: &history, info: info.as_ref(), exposure: exposure.as_ref(), lists, verified: true };
    Ok(judge(&e))
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
    if let Some(i) = &a.counterparty_info {
        d.insert("counterparty_name".into(), serde_json::json!(i.name));
        d.insert("counterparty_labels".into(), serde_json::json!(i.labels));
        d.insert("counterparty_is_scam".into(), serde_json::json!(i.is_scam));
    }
    if let Some(x) = &a.exposure {
        d.insert("exposure_hops".into(), serde_json::json!(x.hops));
        d.insert("exposure_path".into(), serde_json::json!(x.path));
    }
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
            external: ExternalRef { network: net(), tx_id: format!("{from}>{to}:{amount}"), block, from_raw: from.into(), to_raw: to.into(), asset_symbol: "TON".into(), decimals: 9, amount: amount.into(), fee: None, explorer_url: None, timestamp: None, asset_address: None },
            incoming,
            counterparty: None,
            counterparty_label: None,
            scam_flag: false,
        }
    }
    fn info(labels: &[&str], is_scam: bool, first_seen: Option<u64>) -> AccountInfo {
        AccountInfo {
            network: net(),
            address: "x".into(),
            native_symbol: "TON".into(),
            native_decimals: 9,
            balance: None,
            tokens: vec![],
            tx_count: Some(500),
            first_seen,
            last_active: None,
            name: None,
            labels: labels.iter().map(|s| s.to_string()).collect(),
            is_contract: false,
            is_scam,
            is_active: true,
            extra: BTreeMap::new(),
        }
    }
    fn evidence<'a>(cp: &'a str, event: &'a ExternalRef, history: &'a [ObservedEvent], info: Option<&'a AccountInfo>, exposure: Option<&'a ExposureResult>, lists: &'a Watchlists, verified: bool) -> Evidence<'a> {
        Evidence { network: &NET, counterparty: cp, wallet: "EQwallet", event, event_time: 1_000, history, info, exposure, lists, verified }
    }
    static NET: std::sync::LazyLock<Network> = std::sync::LazyLock::new(net);

    #[test]
    fn pass_through_single_use_and_sanctions_score() {
        let lists = Watchlists::default();
        let event = ev("EQmule", "EQwallet", "1000000000", true, Some(100)).external;
        let history = vec![ev("EQsource", "EQmule", "1000000000", true, Some(99)), ev("EQmule", "EQwallet", "950000000", false, Some(100))];
        let a = judge(&evidence("EQmule", &event, &history, None, None, &lists, true));
        assert!(a.reasons.iter().any(|r| r.code == "PASS_THROUGH"), "{a:?}");
        assert!(a.reasons.iter().any(|r| r.code == "FRESH_ADDRESS"), "{a:?}");
        assert_eq!(a.risk, RiskBand::High);

        let sanctioned = Watchlists::from_raw(&["EQmule".into()], &[]);
        assert_eq!(judge(&evidence("EQmule", &event, &history, None, None, &sanctioned, true)).risk, RiskBand::Critical);

        let lone = judge(&evidence("EQx", &event, &[ev("EQx", "EQwallet", "1", true, None)], None, None, &lists, true));
        assert!(lone.reasons.iter().any(|r| r.code == "SINGLE_USE"));
        assert_eq!(lone.risk, RiskBand::Medium);

        let unverified = judge(&evidence("EQx", &event, &[], None, None, &lists, false));
        assert!(!unverified.verified);
        assert_eq!(unverified.risk, RiskBand::Medium);
    }

    #[test]
    fn indexer_labels_and_exposure_move_the_verdict() {
        let lists = Watchlists::default();
        let event = ev("EQshop", "EQwallet", "5000000", true, Some(500)).external;
        let history: Vec<ObservedEvent> = (0..30).map(|i| ev(&format!("EQc{i}"), "EQshop", "5000000", true, Some(100 + i))).collect();
        // thirty senders would be HIGH_FAN_IN for an anonymous address …
        let anon = judge(&evidence("EQshop", &event, &history, None, None, &lists, true));
        assert!(anon.reasons.iter().any(|r| r.code == "HIGH_FAN_IN"));
        // … but not for a labelled exchange, which also lowers the score
        let cex = info(&["exchange"], false, Some(0));
        let labelled = judge(&evidence("EQshop", &event, &history, Some(&cex), None, &lists, true));
        assert!(labelled.reasons.iter().any(|r| r.code == "KNOWN_SERVICE"));
        assert!(!labelled.reasons.iter().any(|r| r.code == "HIGH_FAN_IN"));
        assert_eq!(labelled.risk, RiskBand::Low);
        // a scam label is decisive
        let scam = info(&[], true, None);
        assert_eq!(judge(&evidence("EQshop", &event, &history, Some(&scam), None, &lists, true)).risk, RiskBand::Critical);
        // one hop from a mixer
        let x = ExposureResult { hops: Some(1), path: vec!["EQshop".into(), "EQmixer".into()], nodes_explored: 2, requests: 1, truncated: false };
        let exposed = judge(&evidence("EQshop", &event, &history[..3], None, Some(&x), &lists, true));
        assert!(exposed.reasons.iter().any(|r| r.code == "EXPOSURE" && r.points == 50));
        assert_eq!(exposed.risk, RiskBand::High);
    }
}
