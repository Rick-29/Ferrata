//! Automatic mode: the validation report, computed from the open file alone.

use std::collections::BTreeMap;

use alloy_primitives::{Address, B256};
use api_types::ValidatorStatus;
use serde::Serialize;
use sq_adapters::chain::{ChainVerification, Flag, ReportedAddress, TokenInfo, TxKind, ValidationStatus, WalletProfile};
use wallet_core::RiskBand;

use crate::state::{EventView, NodeRef, Opened, band_rank};

#[derive(Debug, Clone, Serialize)]
pub struct FileInfo {
    pub name: String,
    pub path: Option<String>,
    pub chain_id: u64,
    pub network: String,
    /// `testnet`, `mainnet` or `unknown`, from the networks the chain mirrors.
    pub environment: String,
    pub format_version: u32,
    pub blocks: u64,
    pub events: u64,
    pub validatable: u64,
    pub genesis_time: u64,
    pub first_event_at: Option<u64>,
    pub last_event_at: Option<u64>,
    pub cosigner: String,
    pub validator: String,
    pub tokens: Vec<TokenInfo>,
    pub escape_delay_secs: u64,
    pub opened_at: u64,
    pub wallets: Vec<Address>,
    pub wallet_nodes: Vec<String>,
    pub networks: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AssetTotal {
    pub symbol: String,
    pub units: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct BandSlice {
    /// `null` is "pending" (no verdict and no policy band).
    pub band: Option<RiskBand>,
    pub count: u64,
    pub value: Vec<AssetTotal>,
}

#[derive(Debug, Clone, Serialize)]
pub struct NetworkSlice {
    pub network: String,
    pub count: u64,
    pub bands: Vec<BandSlice>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Distribution {
    pub bands: Vec<BandSlice>,
    pub by_network: Vec<NetworkSlice>,
    pub by_kind: Vec<KindCount>,
}

#[derive(Debug, Clone, Serialize)]
pub struct KindCount {
    pub kind: TxKind,
    pub count: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct AttentionRow {
    pub hash: B256,
    pub block_number: u64,
    pub timestamp: u64,
    pub kind: TxKind,
    pub network: String,
    pub amount_units: f64,
    pub asset_symbol: String,
    pub incoming: bool,
    pub counterparty: Option<NodeRef>,
    pub counterparty_reports: u64,
    pub risk: Option<RiskBand>,
    pub risk_level: Option<RiskBand>,
    pub reviewed_risk: Option<RiskBand>,
    pub flag_codes: Vec<String>,
    pub pending: bool,
    pub trusted: bool,
    pub disagreement: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct FlagCount {
    pub code: String,
    pub count: u64,
    pub events: u64,
    /// Share of validatable events carrying this code.
    pub share: f64,
    pub worst_severity: RiskBand,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProfileCard {
    pub profile: WalletProfile,
    pub node_id: String,
    pub findings: Vec<Flag>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ReportedAddressView {
    #[serde(flatten)]
    pub reported: ReportedAddress,
    pub node_id: String,
    pub events: Vec<B256>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Report {
    pub file: FileInfo,
    pub integrity: ChainVerification,
    pub validation: ValidationStatus,
    pub distribution: Distribution,
    pub attention: Vec<AttentionRow>,
    pub flag_summary: Vec<FlagCount>,
    pub profiles: Vec<ProfileCard>,
    pub reported: Vec<ReportedAddressView>,
    /// The service's validation worker, when connected.
    pub worker: Option<ValidatorStatus>,
    pub generated_at: u64,
}

pub fn file_info(opened: &Opened) -> FileInfo {
    let mut networks: Vec<String> = opened.events.iter().map(|e| e.tx.network.name.clone()).collect();
    networks.sort();
    networks.dedup();
    FileInfo {
        name: opened.name.clone(),
        path: opened.path.as_ref().map(|p| p.display().to_string()),
        chain_id: opened.header.chain_id,
        network: opened.header.network.name.clone(),
        environment: opened.environment().to_string(),
        format_version: opened.header.format_version,
        blocks: opened.blocks_total,
        events: opened.events.len() as u64,
        validatable: opened.events.iter().filter(|e| e.validatable).count() as u64,
        genesis_time: opened.header.genesis_time,
        first_event_at: opened.events.first().map(|e| e.tx.timestamp),
        last_event_at: opened.events.last().map(|e| e.tx.timestamp),
        cosigner: opened.header.cosigner.clone(),
        validator: opened.header.validator.clone(),
        tokens: opened.header.tokens.clone(),
        escape_delay_secs: opened.header.escape_delay_secs,
        opened_at: opened.opened_at,
        wallets: opened.wallets.clone(),
        wallet_nodes: opened.wallets.iter().map(|w| NodeRef::ferra(opened.ferra_network(), *w).id).collect(),
        networks,
    }
}

fn slices(events: &[&EventView]) -> Vec<BandSlice> {
    let order: [Option<RiskBand>; 5] = [Some(RiskBand::Low), Some(RiskBand::Medium), Some(RiskBand::High), Some(RiskBand::Critical), None];
    order
        .into_iter()
        .map(|band| {
            let mut value: BTreeMap<String, f64> = BTreeMap::new();
            let mut count = 0u64;
            for e in events.iter().filter(|e| e.effective_risk == band) {
                count += 1;
                *value.entry(e.asset_symbol.clone()).or_insert(0.0) += e.amount_units;
            }
            BandSlice { band, count, value: value.into_iter().map(|(symbol, units)| AssetTotal { symbol, units }).collect() }
        })
        .collect()
}

/// Validation counts from a list of events (chain flags and local verdicts alike).
pub fn validation_from(events: &[EventView]) -> ValidationStatus {
    let validatable = events.iter().filter(|e| e.validatable).count() as u64;
    let validated = events.iter().filter(|e| e.validatable && !e.pending).count() as u64;
    let next = events.iter().filter(|e| e.validatable && e.pending).take(20).map(|e| e.tx.hash).collect();
    ValidationStatus { validatable, validated, percent: if validatable == 0 { 100.0 } else { validated as f64 * 100.0 / validatable as f64 }, pending: validatable - validated, next }
}

pub fn build(opened: &Opened, events: &[EventView], worker: Option<ValidatorStatus>) -> Report {
    let validatable: Vec<&EventView> = events.iter().filter(|e| e.validatable).collect();
    let bands = slices(&validatable);
    let mut per_network: BTreeMap<String, Vec<&EventView>> = BTreeMap::new();
    for e in &validatable {
        per_network.entry(e.tx.network.name.clone()).or_default().push(e);
    }
    let by_network = per_network.into_iter().map(|(network, evs)| NetworkSlice { network, count: evs.len() as u64, bands: slices(&evs) }).collect();
    let mut kinds: BTreeMap<String, (TxKind, u64)> = BTreeMap::new();
    for e in &opened.events {
        let k = serde_json::to_value(e.tx.kind).ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_default();
        kinds.entry(k).or_insert((e.tx.kind, 0)).1 += 1;
    }
    let by_kind = kinds.into_values().map(|(kind, count)| KindCount { kind, count }).collect();

    let mut attention: Vec<AttentionRow> = validatable
        .iter()
        .map(|e| AttentionRow {
            hash: e.tx.hash,
            block_number: e.tx.block_number,
            timestamp: e.tx.timestamp,
            kind: e.tx.kind,
            network: e.tx.network.name.clone(),
            amount_units: e.amount_units,
            asset_symbol: e.asset_symbol.clone(),
            incoming: e.incoming,
            counterparty: e.counterparty.clone(),
            counterparty_reports: e.counterparty_reports,
            risk: e.effective_risk,
            risk_level: e.tx.risk_level,
            reviewed_risk: e.tx.reviewed_risk,
            flag_codes: e.flag_codes.clone(),
            pending: e.pending,
            trusted: e.trusted,
            disagreement: e.disagreement,
        })
        .collect();
    attention.sort_by(|a, b| {
        band_rank(b.risk)
            .cmp(&band_rank(a.risk))
            .then(b.trusted.cmp(&a.trusted).reverse())
            .then(b.amount_units.partial_cmp(&a.amount_units).unwrap_or(std::cmp::Ordering::Equal))
            .then(b.timestamp.cmp(&a.timestamp))
    });

    let mut codes: BTreeMap<String, (u64, std::collections::BTreeSet<B256>, RiskBand)> = BTreeMap::new();
    for e in &opened.events {
        for f in &e.tx.flags {
            let entry = codes.entry(f.code.clone()).or_insert((0, Default::default(), RiskBand::Low));
            entry.0 += 1;
            entry.1.insert(e.tx.hash);
            if band_rank(Some(f.severity)) > band_rank(Some(entry.2)) {
                entry.2 = f.severity;
            }
        }
    }
    let total_validatable = validatable.len().max(1) as f64;
    let mut flag_summary: Vec<FlagCount> = codes
        .into_iter()
        .map(|(code, (count, events, worst))| FlagCount { code, count, events: events.len() as u64, share: events.len() as f64 / total_validatable, worst_severity: worst })
        .collect();
    flag_summary.sort_by_key(|f| std::cmp::Reverse(f.count));

    let now = opened.chain.latest().timestamp.max(events.last().map(|e| e.tx.timestamp).unwrap_or(0));
    let profiles = opened
        .wallets
        .iter()
        .map(|w| ProfileCard { profile: opened.chain.profile(*w, now), node_id: NodeRef::ferra(opened.ferra_network(), *w).id, findings: opened.chain.behaviour_findings(*w, now) })
        .collect();

    let reported = opened
        .chain
        .reported_addresses()
        .into_iter()
        .map(|r| {
            let node = NodeRef::new(&r.network, &r.address);
            let key = node.report_key();
            let events = events.iter().filter(|e| e.counterparty.as_ref().is_some_and(|c| c.report_key() == key)).map(|e| e.tx.hash).collect();
            ReportedAddressView { reported: r, node_id: node.id, events }
        })
        .collect();

    Report {
        file: file_info(opened),
        integrity: opened.verification.clone(),
        validation: validation_from(events),
        distribution: Distribution { bands, by_network, by_kind },
        attention,
        flag_summary,
        profiles,
        reported,
        worker,
        generated_at: crate::state::now(),
    }
}
