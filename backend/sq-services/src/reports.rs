//! Reports about addresses: "X is a scam". Anyone with a session can file one; Swissquote attests
//! it onto the Ferra chain as an `AddressReport` event. From then on the address weighs on every
//! transaction that touches it: past events get a `REPORTED_ADDRESS` flag now, future events pick
//! the count up through `counterparty_reports` (feature + model + preview reason), and the
//! provenance judge sees it in the watchlists.

use std::collections::BTreeMap;

use api_types::{AddressReportRequest, AddressReportResponse};
use axum::extract::{Path, State};
use axum::routing::get;
use axum::{Json, Router};
use sq_adapters::{AddressReport, Flag, FlagSource, ReportedAddress};
use wallet_core::RiskBand;

use crate::auth::Caller;
use crate::error::{ApiResult, ServiceError};
use crate::state::SharedState;

const CATEGORIES: [&str; 5] = ["scam", "phishing", "hack", "mixer", "other"];

pub fn routes() -> Router<SharedState> {
    Router::new().route("/reports/address", get(list).post(file)).route("/reports/address/{network}/{address}", get(of))
}

/// Canonical spelling for the network, so two reports of the same address land on the same key.
fn canonical(state: &SharedState, network: &str, address: &str) -> String {
    match state.sources.get(network) {
        Ok(s) => s.canonical(address),
        Err(_) => address.trim().to_string(),
    }
}

async fn file(State(state): State<SharedState>, caller: Caller, Json(req): Json<AddressReportRequest>) -> ApiResult<AddressReportResponse> {
    let category = req.category.unwrap_or_else(|| "scam".into()).to_ascii_lowercase();
    if !CATEGORIES.contains(&category.as_str()) {
        return Err(ServiceError::BadRequest(format!("category must be one of {}", CATEGORIES.join(", "))));
    }
    if req.reason.trim().is_empty() || req.reason.len() > 500 {
        return Err(ServiceError::BadRequest("reason must be 1..=500 characters".into()));
    }
    let known_network = state.sources.get(&req.network).is_ok() || state.chain()?.info().network.name == req.network;
    if !known_network {
        return Err(ServiceError::BadRequest(format!("unknown network {}", req.network)));
    }
    let reporter = state.client_of(&caller)?.unwrap_or_else(|| "anonymous".into());
    let now = state.now();
    let report = AddressReport { network: req.network.trim().to_ascii_lowercase(), address: canonical(&state, &req.network, &req.address), category, reason: req.reason.trim().to_string(), reporter, at: now };

    let (tx, total, involved) = {
        let mut chain = state.chain()?;
        let hash = chain.report_hash(&report);
        let cosig = state.signer.cosign(&hash);
        let tx = chain.report_address(report.clone(), &cosig, now)?;
        let total = chain.reports_of(&report.network, &report.address).len() as u64;
        (tx, total, chain.events_involving(&report.network, &report.address))
    };

    // Retroactive: every event that already touched this address carries the report from now on.
    let severity = if total >= 3 { RiskBand::Critical } else { RiskBand::High };
    let mut flagged = 0u64;
    {
        let mut chain = state.chain()?;
        for ev in &involved {
            let mut data = BTreeMap::new();
            data.insert("reports".into(), serde_json::json!(total));
            data.insert("category".into(), serde_json::json!(report.category));
            let f = Flag { code: "REPORTED_ADDRESS".into(), severity, source: FlagSource::Report, message: format!("{} on {} was reported {total} time(s) as {}", report.address, report.network, report.category), at: now, target: ev.hash, data };
            if chain.flag(f, now)?.is_some() {
                flagged += 1;
            }
        }
    }
    tracing::info!(network = %report.network, address = %report.address, total, flagged, "address reported");
    Ok(Json(AddressReportResponse { report, tx, total_reports: total, events_involved: involved.len() as u64, events_flagged: flagged }))
}

async fn list(State(state): State<SharedState>) -> ApiResult<Vec<ReportedAddress>> {
    Ok(Json(state.chain()?.reported_addresses()))
}

async fn of(State(state): State<SharedState>, Path((network, address)): Path<(String, String)>) -> ApiResult<Vec<AddressReport>> {
    let address = canonical(&state, &network, &address);
    Ok(Json(state.chain()?.reports_of(&network, &address)))
}
