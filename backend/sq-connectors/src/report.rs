//! One JSON document about "the transfers from A to B on network N": the transfers themselves,
//! both parties as the indexer sees them, the sender's recent activity, where the sender got the
//! money, the receiver's provenance and the predicted risk. Same shape for every network.
//!
//! Every lookup that does not depend on another runs concurrently: the sender's pages, both
//! account infos, the receiver's history and exposure trace, every funder's account info.
//! `report_for_event` is the one-sided variant for a Ferra chain event: the wallet is known,
//! only the counterparty is researched.

use std::collections::{BTreeMap, BTreeSet};
use std::time::Instant;

use futures::future::join_all;
use serde::{Deserialize, Serialize};
use sq_adapters::{ChainTx, ExternalRef, Network, RiskModel, TxKind};
use ts_rs::TS;

use crate::provenance::{Evidence, ProvenanceAssessment, Watchlists, judge};
use crate::risk::{RiskInputs, TransferRisk};
use crate::tracing::{ExposureResult, TraceConfig, trace_exposure};
use crate::{AccountInfo, ConnectorError, NetworkSource, ObservedEvent};

/// A compact view of one observed event, as a list row.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct EventSummary {
    pub tx_id: String,
    pub explorer_url: Option<String>,
    #[ts(type = "number | null")]
    pub timestamp: Option<u64>,
    /// ISO-8601 UTC, derived from `timestamp` for humans.
    pub date: Option<String>,
    pub incoming: bool,
    pub counterparty: String,
    pub counterparty_label: Option<String>,
    /// Base units, decimal string.
    pub amount: String,
    /// Whole units.
    pub amount_units: f64,
    pub asset_symbol: String,
    pub asset_address: Option<String>,
    pub decimals: u8,
    pub fee: Option<f64>,
    pub scam_flag: bool,
}

impl EventSummary {
    pub fn from_event(e: &ObservedEvent) -> Self {
        let other = if e.incoming { &e.external.from_raw } else { &e.external.to_raw };
        Self {
            tx_id: e.external.tx_id.clone(),
            explorer_url: e.external.explorer_url.clone(),
            timestamp: e.external.timestamp,
            date: e.external.timestamp.map(iso8601),
            incoming: e.incoming,
            counterparty: other.clone(),
            counterparty_label: e.counterparty_label.clone(),
            amount: e.external.amount.clone(),
            amount_units: units(&e.external.amount, e.external.decimals),
            asset_symbol: e.external.asset_symbol.clone(),
            asset_address: e.external.asset_address.clone(),
            decimals: e.external.decimals,
            fee: e.external.fee,
            scam_flag: e.scam_flag,
        }
    }
}

/// An inbound event that funded (part of) a transfer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct FundingSource {
    pub event: EventSummary,
    /// How much of the transfer this inbound event covers (0..1), cumulative order newest first.
    pub share_of_transfer: f64,
    pub from_info: Option<AccountInfo>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct TransferDetail {
    pub event: EventSummary,
    /// Other events in the same transaction (e.g. the ERC-20 transfer behind a contract call).
    pub related: Vec<EventSummary>,
    /// Where the sender got the money: inbound events of the same asset before this transfer.
    pub funding: Vec<FundingSource>,
    /// Share of the amount the listed funding covers; below 1 means older history was not fetched.
    pub funding_coverage: f64,
    /// Predicted risk of this transfer.
    pub risk: Option<TransferRisk>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ReportMode {
    /// Both parties researched (`ferra-report`).
    Full,
    /// The wallet is a Ferra account; only the counterparty is researched (`/report/event`).
    CounterpartyOnly,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct TransferReport {
    #[ts(type = "number")]
    pub schema_version: u32,
    pub mode: ReportMode,
    pub network: Network,
    /// Canonical forms.
    pub from: String,
    pub to: String,
    /// As given by the caller.
    pub from_input: String,
    pub to_input: String,
    #[ts(type = "number")]
    pub generated_at: u64,
    #[ts(type = "number")]
    pub elapsed_ms: u64,
    pub from_info: Option<AccountInfo>,
    pub to_info: Option<AccountInfo>,
    /// Transfers from `from` to `to`, newest first.
    pub transfers: Vec<TransferDetail>,
    /// The sender's most recent events (both directions), newest first.
    pub sender_recent: Vec<EventSummary>,
    #[ts(type = "number")]
    pub sender_events_scanned: u64,
    #[ts(type = "number")]
    pub pages_fetched: u64,
    /// Provenance verdict on the receiver, from the sender's point of view.
    pub receiver_provenance: Option<ProvenanceAssessment>,
    /// Highest `combined` risk across the transfers, for sorting.
    pub max_risk: f64,
    /// Anything that limited the report (rate limits, unsupported account info, …).
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Copy)]
pub struct ReportConfig {
    pub max_pages: u32,
    pub page_limit: u32,
    pub recent: usize,
    pub max_funding_sources: usize,
    pub with_exposure: bool,
}

impl Default for ReportConfig {
    fn default() -> Self {
        Self { max_pages: 4, page_limit: 50, recent: 20, max_funding_sources: 5, with_exposure: true }
    }
}

pub fn units(amount: &str, decimals: u8) -> f64 {
    amount.parse::<f64>().unwrap_or(0.0) / 10f64.powi(i32::from(decimals))
}

/// Seconds since the epoch → `YYYY-MM-DDTHH:MM:SSZ`, no external crate.
pub fn iso8601(ts: u64) -> String {
    let days = ts / 86_400;
    let secs = ts % 86_400;
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", secs / 3600, (secs % 3600) / 60, secs % 60)
}

fn base_id(tx_id: &str) -> &str {
    tx_id.split('#').next().unwrap_or(tx_id)
}

fn dedupe(history: &mut Vec<ObservedEvent>) {
    let mut seen: BTreeSet<String> = BTreeSet::new();
    history.retain(|e| seen.insert(format!("{}|{}|{}|{}", e.external.tx_id, e.incoming, e.external.amount, e.external.asset_symbol)));
}

/// Pages of one address's history, sequential because each cursor comes from the previous page.
async fn pages(source: &dyn NetworkSource, address: &str, cfg: ReportConfig, label: &str) -> (Vec<ObservedEvent>, u64, Vec<String>) {
    let mut history = Vec::new();
    let mut cursor: Option<String> = None;
    let mut fetched = 0u64;
    let mut notes = Vec::new();
    loop {
        if fetched >= u64::from(cfg.max_pages) {
            notes.push(format!("stopped after {fetched} pages of the {label}'s history"));
            break;
        }
        match source.fetch(address, cursor.as_deref(), cfg.page_limit).await {
            Ok(page) => {
                fetched += 1;
                history.extend(page.events);
                cursor = page.next_cursor;
                if cursor.is_none() {
                    break;
                }
            }
            Err(e) => {
                notes.push(format!("{label} history: {e}"));
                break;
            }
        }
    }
    dedupe(&mut history);
    (history, fetched, notes)
}

async fn info(source: &dyn NetworkSource, address: &str, label: &str) -> (Option<AccountInfo>, Option<String>) {
    match source.account_info(address).await {
        Ok(i) => (Some(i), None),
        Err(e) => (None, Some(format!("{label} account info: {e}"))),
    }
}

/// Inbound events of the same asset before `t`, newest first, until they cover its amount.
/// Funders' account infos are fetched concurrently.
async fn funding_for(source: &dyn NetworkSource, t: &ObservedEvent, effective: &ObservedEvent, history: &[ObservedEvent], cfg: ReportConfig, notes: &mut Vec<String>) -> (Vec<FundingSource>, f64) {
    let amount = units(&effective.external.amount, effective.external.decimals);
    let before = t.external.timestamp;
    let mut candidates: Vec<&ObservedEvent> = history
        .iter()
        .filter(|e| e.incoming && e.external.asset_symbol == effective.external.asset_symbol && e.external.tx_id != t.external.tx_id)
        .filter(|e| match (e.external.timestamp, before) {
            (Some(a), Some(b)) => a <= b,
            _ => true,
        })
        .collect();
    candidates.sort_by_key(|c| std::cmp::Reverse(c.external.timestamp));
    let mut picked: Vec<(&ObservedEvent, f64)> = Vec::new();
    let mut covered = 0.0;
    for c in candidates {
        if amount > 0.0 && covered >= amount {
            break;
        }
        if picked.len() >= cfg.max_funding_sources {
            notes.push(format!("funding of {}: more than {} sources, truncated", t.external.tx_id, cfg.max_funding_sources));
            break;
        }
        let cu = units(&c.external.amount, c.external.decimals);
        let share = if amount > 0.0 { ((amount - covered).min(cu) / amount).max(0.0) } else { 0.0 };
        covered += cu;
        picked.push((c, share));
    }
    let distinct: Vec<String> = {
        let mut s = BTreeSet::new();
        picked.iter().map(|(c, _)| source.canonical(&c.external.from_raw)).filter(|a| s.insert(a.clone())).collect()
    };
    let infos: BTreeMap<String, Option<AccountInfo>> = join_all(distinct.iter().map(|a| async move { (a.clone(), source.account_info(a).await.ok()) })).await.into_iter().collect();
    let funding = picked
        .into_iter()
        .map(|(c, share)| FundingSource { event: EventSummary::from_event(c), share_of_transfer: share, from_info: infos.get(&source.canonical(&c.external.from_raw)).cloned().flatten() })
        .collect();
    (funding, if amount > 0.0 { (covered / amount).min(1.0) } else { 0.0 })
}

/// The receiver's standing: its history and, when there is a flagged list, an exposure trace; both at once.
async fn receiver_side(source: &dyn NetworkSource, to: &str, lists: &Watchlists, cfg: ReportConfig) -> (Result<Vec<ObservedEvent>, ConnectorError>, Option<ExposureResult>) {
    let history = async { source.fetch(to, None, cfg.page_limit).await.map(|p| p.events) };
    let exposure = async {
        if cfg.with_exposure && !lists.flagged.is_empty() {
            trace_exposure(source, to, &lists.flagged, TraceConfig::default()).await.ok()
        } else {
            None
        }
    };
    tokio::join!(history, exposure)
}

#[allow(clippy::too_many_arguments)]
fn provenance_of(network: &Network, to: &str, from: &str, ext: &ExternalRef, now: u64, receiver_history: &[ObservedEvent], to_info: Option<&AccountInfo>, exposure: Option<&ExposureResult>, lists: &Watchlists, verified: bool) -> ProvenanceAssessment {
    judge(&Evidence { network, counterparty: to, wallet: from, event: ext, event_time: ext.timestamp.unwrap_or(now), history: receiver_history, info: to_info, exposure, lists, verified })
}

fn synthetic(network: &Network, from: &str, to: &str) -> ExternalRef {
    ExternalRef { network: network.clone(), tx_id: String::new(), block: None, from_raw: from.into(), to_raw: to.into(), asset_symbol: String::new(), decimals: 0, amount: "0".into(), fee: None, explorer_url: None, timestamp: None, asset_address: None }
}

/// Builds the full report. Never fails on indexer trouble: what could not be fetched lands in `notes`.
pub async fn transfer_report(source: &dyn NetworkSource, from_input: &str, to_input: &str, lists: &Watchlists, cfg: ReportConfig, model: Option<&dyn RiskModel>, now: u64) -> Result<TransferReport, ConnectorError> {
    let started = Instant::now();
    let network = source.network();
    let from = source.canonical(from_input);
    let to = source.canonical(to_input);
    let mut notes = Vec::new();

    // Everything independent, at once.
    let ((history, pages_fetched, page_notes), (from_info, from_note), (to_info, to_note), (receiver_history, exposure)) =
        tokio::join!(pages(source, &from, cfg, "sender"), info(source, &from, "sender"), info(source, &to, "receiver"), receiver_side(source, &to, lists, cfg));
    notes.extend(page_notes);
    notes.extend(from_note);
    notes.extend(to_note);
    let (receiver_history, verified) = match receiver_history {
        Ok(h) => (h, true),
        Err(e) => {
            notes.push(format!("receiver history: {e}"));
            (Vec::new(), false)
        }
    };

    let matching: Vec<&ObservedEvent> = history.iter().filter(|e| !e.incoming && source.canonical(&e.external.to_raw) == to).collect();
    let ext_for_prov = matching.first().map(|t| t.external.clone()).unwrap_or_else(|| synthetic(&network, &from, &to));
    let receiver_provenance = Some(provenance_of(&network, &to, &from, &ext_for_prov, now, &receiver_history, to_info.as_ref(), exposure.as_ref(), lists, verified));

    let mut transfers = Vec::new();
    for t in &matching {
        let id = base_id(&t.external.tx_id);
        let related: Vec<EventSummary> = history.iter().filter(|e| base_id(&e.external.tx_id) == id && e.external.tx_id != t.external.tx_id).map(EventSummary::from_event).collect();
        let effective: &ObservedEvent = if t.external.amount == "0" { history.iter().find(|e| base_id(&e.external.tx_id) == id && !e.incoming && e.external.amount != "0").unwrap_or(t) } else { t };
        let (funding, coverage) = funding_for(source, t, effective, &history, cfg, &mut notes).await;
        let risk = crate::risk::assess(
            &RiskInputs { network: &network, transfer: effective, sender_history: &history, sender_info: from_info.as_ref(), receiver_history: &receiver_history, receiver_info: to_info.as_ref(), provenance: receiver_provenance.as_ref(), now },
            model,
        );
        transfers.push(TransferDetail { event: EventSummary::from_event(t), related, funding, funding_coverage: coverage, risk: Some(risk) });
    }
    transfers.sort_by_key(|t| std::cmp::Reverse(t.event.timestamp));
    if matching.is_empty() {
        notes.push("no transfer from sender to receiver found in the fetched history".into());
    }
    let max_risk = transfers.iter().filter_map(|t| t.risk.as_ref()).map(|r| r.combined).fold(0.0, f64::max);
    let mut seen_ids: BTreeSet<String> = BTreeSet::new();
    let sender_recent: Vec<EventSummary> = history.iter().filter(|e| seen_ids.insert(e.external.tx_id.clone())).take(cfg.recent).map(EventSummary::from_event).collect();

    Ok(TransferReport {
        schema_version: 2,
        mode: ReportMode::Full,
        network,
        from,
        to,
        from_input: from_input.into(),
        to_input: to_input.into(),
        generated_at: now,
        elapsed_ms: started.elapsed().as_millis() as u64,
        from_info,
        to_info,
        transfers,
        sender_recent,
        sender_events_scanned: history.len() as u64,
        pages_fetched,
        receiver_provenance,
        max_risk,
        notes,
    })
}

/// One-sided report for an `external` event on the Ferra chain: the wallet is ours, only the
/// counterparty is researched. For an inbound event the funding is the counterparty's own
/// inbound history, which is exactly the "where did this money come from" question.
pub async fn report_for_event(source: &dyn NetworkSource, tx: &ChainTx, lists: &Watchlists, cfg: ReportConfig, model: Option<&dyn RiskModel>, now: u64) -> Result<TransferReport, ConnectorError> {
    if tx.kind != TxKind::External {
        return Err(ConnectorError::Parse("not an external event".into()));
    }
    let started = Instant::now();
    let ext: ExternalRef = tx.extra.get("external").cloned().and_then(|v| serde_json::from_value(v).ok()).ok_or_else(|| ConnectorError::Parse("event has no external payload".into()))?;
    let incoming = tx.extra.get("incoming").and_then(|v| v.as_bool()).unwrap_or(true);
    let network = source.network();
    let (wallet, counterparty) = if incoming { (source.canonical(&ext.to_raw), source.canonical(&ext.from_raw)) } else { (source.canonical(&ext.from_raw), source.canonical(&ext.to_raw)) };
    let mut notes = vec![format!("counterparty-only: {wallet} is the Ferra wallet")];

    let ((cp_history, pages_fetched, page_notes), (cp_info, cp_note), exposure) = tokio::join!(pages(source, &counterparty, cfg, "counterparty"), info(source, &counterparty, "counterparty"), async {
        if cfg.with_exposure && !lists.flagged.is_empty() { trace_exposure(source, &counterparty, &lists.flagged, TraceConfig::default()).await.ok() } else { None }
    });
    notes.extend(page_notes);
    notes.extend(cp_note);
    let verified = pages_fetched > 0;

    let provenance = provenance_of(&network, &counterparty, &wallet, &ext, now, &cp_history, cp_info.as_ref(), exposure.as_ref(), lists, verified);
    let event = ObservedEvent { external: ext.clone(), incoming, counterparty: None, counterparty_label: cp_info.as_ref().and_then(|i| i.name.clone()), scam_flag: cp_info.as_ref().is_some_and(|i| i.is_scam) };
    let (funding, coverage) = if incoming { funding_for(source, &event, &event, &cp_history, cfg, &mut notes).await } else { (Vec::new(), 0.0) };
    // The wallet's own history lives on the Ferra chain, not here; the counterparty's history is
    // what the model gets on the receiver side.
    let risk = crate::risk::assess(&RiskInputs { network: &network, transfer: &event, sender_history: &[], sender_info: None, receiver_history: &cp_history, receiver_info: cp_info.as_ref(), provenance: Some(&provenance), now }, model);
    let max_risk = risk.combined;
    let (from, to) = if incoming { (counterparty.clone(), wallet.clone()) } else { (wallet.clone(), counterparty.clone()) };
    let mut seen: BTreeSet<String> = BTreeSet::new();
    Ok(TransferReport {
        schema_version: 2,
        mode: ReportMode::CounterpartyOnly,
        network,
        from_input: from.clone(),
        to_input: to.clone(),
        from,
        to,
        generated_at: now,
        elapsed_ms: started.elapsed().as_millis() as u64,
        from_info: if incoming { cp_info.clone() } else { None },
        to_info: if incoming { None } else { cp_info.clone() },
        transfers: vec![TransferDetail { event: EventSummary::from_event(&event), related: Vec::new(), funding, funding_coverage: coverage, risk: Some(risk) }],
        sender_recent: cp_history.iter().filter(|e| seen.insert(e.external.tx_id.clone())).take(cfg.recent).map(EventSummary::from_event).collect(),
        sender_events_scanned: cp_history.len() as u64,
        pages_fetched,
        receiver_provenance: Some(provenance),
        max_risk,
        notes,
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use crate::Page;
    use alloy_primitives::{Address, Bytes, U256};
    use async_trait::async_trait;
    use sq_adapters::{ChainFamily, ExternalRef};
    use wallet_core::DecodedAction;

    struct Fake;
    fn ev(from: &str, to: &str, amount: &str, incoming: bool, ts: u64, id: &str) -> ObservedEvent {
        ObservedEvent {
            external: ExternalRef { network: Network { family: ChainFamily::Other, name: "t".into(), chain_id: None }, tx_id: id.into(), block: Some(1), from_raw: from.into(), to_raw: to.into(), asset_symbol: "X".into(), decimals: 2, amount: amount.into(), fee: Some(0.01), explorer_url: None, timestamp: Some(ts), asset_address: None },
            incoming,
            counterparty: None,
            counterparty_label: None,
            scam_flag: false,
        }
    }
    #[async_trait]
    impl NetworkSource for Fake {
        fn network(&self) -> Network {
            Network { family: ChainFamily::Other, name: "t".into(), chain_id: None }
        }
        async fn fetch(&self, a: &str, cursor: Option<&str>, _: u32) -> Result<Page, ConnectorError> {
            if cursor.is_some() {
                return Ok(Page::default());
            }
            Ok(Page {
                events: match a {
                    "alice" => vec![ev("alice", "bob", "40000", false, 300, "t3"), ev("dave", "alice", "20000", true, 200, "t2"), ev("carol", "alice", "30000", true, 100, "t1")],
                    "bob" => vec![ev("alice", "bob", "40000", true, 300, "t3")],
                    _ => vec![],
                },
                next_cursor: None,
            })
        }
    }

    #[test]
    fn iso_dates() {
        assert_eq!(iso8601(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso8601(1_700_000_000), "2023-11-14T22:13:20Z");
    }

    #[tokio::test]
    async fn report_finds_transfer_funding_and_risk_concurrently() {
        let r = transfer_report(&Fake, "alice", "bob", &Watchlists::default(), ReportConfig::default(), None, 1_000).await.unwrap();
        assert_eq!(r.mode, ReportMode::Full);
        assert_eq!(r.transfers.len(), 1);
        let t = &r.transfers[0];
        assert_eq!(t.event.amount_units, 400.0);
        assert_eq!(t.funding.len(), 2);
        assert_eq!(t.funding[0].event.counterparty, "dave");
        assert!((t.funding_coverage - 1.0).abs() < 1e-9);
        let risk = t.risk.as_ref().unwrap();
        assert!(risk.reasons.iter().any(|x| x.code == "FIRST_OUTGOING"), "{:?}", risk.reasons);
        assert_eq!(risk.features.sender_in_count, 2);
        assert!(risk.model.is_none());
        assert!(r.receiver_provenance.is_some());
        assert!(r.notes.iter().any(|n| n.contains("account info")));
    }

    #[tokio::test]
    async fn event_report_researches_only_the_counterparty() {
        let mut extra = BTreeMap::new();
        extra.insert("external".into(), serde_json::to_value(ev("alice", "wallet", "40000", true, 300, "t9").external).unwrap());
        extra.insert("incoming".into(), serde_json::Value::Bool(true));
        let tx = ChainTx {
            version: 1,
            hash: Default::default(),
            block_number: 1,
            timestamp: 300,
            kind: TxKind::External,
            from: Address::ZERO,
            to: Address::ZERO,
            value: U256::ZERO,
            data: Bytes::new(),
            nonce: 0,
            user_op_hash: Default::default(),
            action: DecodedAction::ContractCall { target: Address::ZERO, selector: Bytes::new(), value: U256::ZERO },
            owner_signature: None,
            cosignature: None,
            extra,
            flags: vec![],
            network: Fake.network(),
            features: None,
            risk_level: None,
            reviewed_risk: None,
        };
        let r = report_for_event(&Fake, &tx, &Watchlists::default(), ReportConfig::default(), None, 1_000).await.unwrap();
        assert_eq!(r.mode, ReportMode::CounterpartyOnly);
        assert_eq!(r.from, "alice");
        assert_eq!(r.transfers[0].funding.len(), 2, "the counterparty's own inbound history is the funding");
        assert!(r.sender_events_scanned >= 3);
    }
}
