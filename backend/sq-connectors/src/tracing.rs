//! Exposure tracing on a live network: starting from an address, walk its counterparties a few
//! hops deep and stop at the first flagged one. The same question the fixture exposure graph
//! answers on the Ferra chain, asked of the origin network. After NetView's `wallet-connection`
//! traversal: bounded depth, bounded degree, newest events first, a request budget.

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{ConnectorError, NetworkSource};

#[derive(Debug, Clone, Copy)]
pub struct TraceConfig {
    pub max_depth: u32,
    /// Skip nodes with more counterparties than this on their first page (exchanges, bridges).
    pub max_degree: usize,
    /// Events fetched per node.
    pub page_limit: u32,
    /// Total `fetch` calls allowed.
    pub request_budget: u32,
}

impl Default for TraceConfig {
    fn default() -> Self {
        Self { max_depth: 2, max_degree: 40, page_limit: 50, request_budget: 25 }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ExposureResult {
    /// Hops from the start to the nearest flagged address; `None` when none found within the budget.
    #[ts(type = "number | null")]
    pub hops: Option<u32>,
    /// Start … flagged, when found.
    pub path: Vec<String>,
    #[ts(type = "number")]
    pub nodes_explored: u64,
    #[ts(type = "number")]
    pub requests: u64,
    /// The walk ran out of budget before covering `max_depth`.
    pub truncated: bool,
}

/// Breadth-first walk over counterparties. `flagged` holds canonical addresses.
pub async fn trace_exposure(source: &dyn NetworkSource, start: &str, flagged: &BTreeSet<String>, cfg: TraceConfig) -> Result<ExposureResult, ConnectorError> {
    let start_c = source.canonical(start);
    if flagged.contains(&start_c) {
        return Ok(ExposureResult { hops: Some(0), path: vec![start_c], nodes_explored: 1, requests: 0, truncated: false });
    }
    let mut parent: BTreeMap<String, String> = BTreeMap::new();
    let mut seen: BTreeSet<String> = BTreeSet::from([start_c.clone()]);
    let mut queue: VecDeque<(String, u32)> = VecDeque::from([(start_c.clone(), 0)]);
    let mut requests = 0u64;
    let mut explored = 0u64;
    let mut truncated = false;

    while let Some((node, depth)) = queue.pop_front() {
        if depth >= cfg.max_depth {
            continue;
        }
        if requests >= u64::from(cfg.request_budget) {
            truncated = true;
            break;
        }
        requests += 1;
        explored += 1;
        let page = match source.fetch(&node, None, cfg.page_limit).await {
            Ok(p) => p,
            Err(ConnectorError::RateLimited { .. }) => {
                truncated = true;
                break;
            }
            Err(e) => return Err(e),
        };
        let mut neighbours: Vec<String> = Vec::new();
        for ev in &page.events {
            let other = if ev.incoming { &ev.external.from_raw } else { &ev.external.to_raw };
            let c = source.canonical(other);
            if c.is_empty() || c == node || neighbours.contains(&c) {
                continue;
            }
            neighbours.push(c);
        }
        if neighbours.len() > cfg.max_degree {
            // A hub (exchange, bridge): everything touches it, it explains nothing. Do not expand.
            continue;
        }
        for n in neighbours {
            if !seen.insert(n.clone()) {
                continue;
            }
            parent.insert(n.clone(), node.clone());
            if flagged.contains(&n) {
                let mut path = vec![n.clone()];
                let mut cur = n;
                while let Some(p) = parent.get(&cur) {
                    path.push(p.clone());
                    cur = p.clone();
                }
                path.reverse();
                return Ok(ExposureResult { hops: Some(depth + 1), path, nodes_explored: explored, requests, truncated: false });
            }
            queue.push_back((n, depth + 1));
        }
    }
    Ok(ExposureResult { hops: None, path: Vec::new(), nodes_explored: explored, requests, truncated })
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use crate::{ObservedEvent, Page};
    use async_trait::async_trait;
    use sq_adapters::{ChainFamily, ExternalRef, Network};
    use std::sync::Mutex;

    /// a → b → c → MIXER; a also touches a hub with many counterparties.
    struct Graph {
        calls: Mutex<u64>,
    }
    fn ev(from: &str, to: &str, incoming: bool) -> ObservedEvent {
        ObservedEvent {
            external: ExternalRef {
                network: Network { family: ChainFamily::Other, name: "test".into(), chain_id: None },
                tx_id: format!("{from}>{to}"),
                block: None,
                from_raw: from.into(),
                to_raw: to.into(),
                asset_symbol: "X".into(),
                decimals: 0,
                amount: "1".into(),
                fee: None,
                explorer_url: None,
                timestamp: None,
                asset_address: None,
            },
            incoming,
            counterparty: None,
            counterparty_label: None,
            scam_flag: false,
        }
    }
    #[async_trait]
    impl NetworkSource for Graph {
        fn network(&self) -> Network {
            Network { family: ChainFamily::Other, name: "test".into(), chain_id: None }
        }
        async fn fetch(&self, address: &str, _: Option<&str>, _: u32) -> Result<Page, ConnectorError> {
            *self.calls.lock().unwrap() += 1;
            let events = match address {
                "a" => vec![ev("a", "b", false), ev("hub", "a", true)],
                "b" => vec![ev("a", "b", true), ev("b", "c", false)],
                "c" => vec![ev("b", "c", true), ev("c", "MIXER", false)],
                "hub" => (0..100).map(|i| ev(&format!("h{i}"), "hub", true)).collect(),
                _ => vec![],
            };
            Ok(Page { events, next_cursor: None })
        }
    }

    #[tokio::test]
    async fn finds_flagged_address_within_depth_and_skips_hubs() {
        let g = Graph { calls: Mutex::new(0) };
        let flagged = BTreeSet::from(["MIXER".to_string()]);
        let r = trace_exposure(&g, "a", &flagged, TraceConfig { max_depth: 3, ..Default::default() }).await.unwrap();
        assert_eq!(r.hops, Some(3));
        assert_eq!(r.path, vec!["a", "b", "c", "MIXER"]);
        let r2 = trace_exposure(&g, "a", &flagged, TraceConfig { max_depth: 2, ..Default::default() }).await.unwrap();
        assert_eq!(r2.hops, None);
        assert!(!r2.truncated);
        let r3 = trace_exposure(&g, "a", &flagged, TraceConfig { max_depth: 3, request_budget: 1, ..Default::default() }).await.unwrap();
        assert!(r3.truncated);
    }
}
