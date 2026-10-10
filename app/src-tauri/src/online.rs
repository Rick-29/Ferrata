//! Everything that needs the network but not the Swissquote service: the public indexers behind
//! `sq-connectors` (TON, EVM, Bitcoin, Solana), the risk model and the watchlists. The desktop app
//! embeds the same crates the service uses, so transfer reports, provenance and risk previews work
//! with nothing but internet access.

use std::path::{Path, PathBuf};

use serde::Deserialize;
use sq_adapters::chain::{LinearModel, RiskModel};
use sq_connectors::SourceRegistry;
use sq_connectors::provenance::Watchlists;

use crate::state::Opened;

pub struct Online {
    pub registry: SourceRegistry,
    pub model: Option<LinearModel>,
    pub model_error: Option<String>,
    pub sanctioned_raw: Vec<String>,
    pub flagged_raw: Vec<String>,
    pub fixtures_dir: Option<PathBuf>,
}

#[derive(Deserialize, Default)]
struct SanctionsFile {
    #[serde(default)]
    raw_addresses: Vec<String>,
    #[serde(default)]
    addresses: Vec<String>,
}

#[derive(Deserialize, Default)]
struct ExposureFile {
    #[serde(default)]
    raw_flagged: Vec<String>,
}

fn read_json<T: serde::de::DeserializeOwned + Default>(path: &Path) -> T {
    std::fs::read_to_string(path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

impl Online {
    /// Connectors for every network the demo chains mirror; API keys come from the environment
    /// (`SQ_TONAPI_KEY`, `SQ_TONCENTER_API_KEY`, `SQ_SOLANA_RPC`) and are optional.
    pub fn new(fixtures_dir: Option<PathBuf>) -> Self {
        let tonapi = std::env::var("SQ_TONAPI_KEY").ok();
        let toncenter = std::env::var("SQ_TONCENTER_API_KEY").ok();
        let sol_rpc = std::env::var("SQ_SOLANA_RPC").ok();
        let mut registry = SourceRegistry::new()
            .register(Box::new(sq_conn_ton::TonSource::new(true, tonapi.clone(), toncenter.clone())))
            .register(Box::new(sq_conn_ton::TonSource::new(false, tonapi, toncenter)))
            .register(Box::new(sq_conn_btc::EsploraBitcoinSource::testnet()))
            .register(Box::new(sq_conn_btc::EsploraBitcoinSource::mainnet()))
            .register(Box::new(sq_conn_sol::SolanaSource::new(true, sol_rpc.clone())))
            .register(Box::new(sq_conn_sol::SolanaSource::new(false, sol_rpc)));
        for s in sq_conn_evm::well_known() {
            registry = registry.register(Box::new(s));
        }

        let (model, model_error) = match fixtures_dir.as_ref().map(|d| LinearModel::load(&d.join("model.json"))) {
            Some(Ok(m)) => (Some(m), None),
            Some(Err(e)) => (None, Some(e)),
            None => (None, Some("fixtures directory not found".into())),
        };
        let sanctions: SanctionsFile = fixtures_dir.as_ref().map(|d| read_json(&d.join("sanctions.json"))).unwrap_or_default();
        let exposure: ExposureFile = fixtures_dir.as_ref().map(|d| read_json(&d.join("exposure-graph.json"))).unwrap_or_default();
        let mut sanctioned_raw = sanctions.raw_addresses;
        sanctioned_raw.extend(sanctions.addresses);
        Self { registry, model, model_error, sanctioned_raw, flagged_raw: exposure.raw_flagged, fixtures_dir }
    }

    pub fn model(&self) -> Option<&dyn RiskModel> {
        self.model.as_ref().map(|m| m as &dyn RiskModel)
    }

    /// Static lists plus whatever the open chain says has been reported.
    pub fn watchlists(&self, opened: Option<&Opened>) -> Watchlists {
        let lists = Watchlists::from_raw(&self.sanctioned_raw, &self.flagged_raw);
        match opened {
            Some(o) => lists.with_reported(o.chain.reported_addresses().into_iter().map(|r| (r.network, r.address, r.count))),
            None => lists,
        }
    }

    pub fn is_sanctioned(&self, address: &str) -> bool {
        self.sanctioned_raw.iter().any(|s| s.eq_ignore_ascii_case(address))
    }

    pub fn is_flagged(&self, address: &str) -> bool {
        self.flagged_raw.iter().any(|s| s.eq_ignore_ascii_case(address))
    }

    pub fn has_network(&self, name: &str) -> bool {
        self.registry.get(name).is_ok()
    }
}
