use std::collections::{HashMap, HashSet, VecDeque};
use std::path::Path;

use alloy_primitives::Address;
use serde::Deserialize;
use wallet_core::{BalanceDelta, DecodedAction, ExternalSignals};

pub trait SignalProvider: Send + Sync {
    fn signals(&self, action: &DecodedAction, simulation: Vec<BalanceDelta>) -> ExternalSignals;
}

#[derive(Debug, Deserialize)]
struct SanctionsFile {
    addresses: Vec<Address>,
}

#[derive(Debug, Deserialize)]
struct ExposureFile {
    /// Addresses considered tainted (mixers, hacks); hop 0.
    flagged: Vec<Address>,
    /// Undirected edges `[a, b]` meaning funds flowed between them.
    edges: Vec<(Address, Address)>,
}

/// Mock sanctions list and exposure graph loaded from `fixtures/`. Labelled as mock in the UI.
#[derive(Debug, Default)]
pub struct FixtureSignalProvider {
    sanctioned: HashSet<Address>,
    flagged: HashSet<Address>,
    edges: HashMap<Address, Vec<Address>>,
    max_hops: u32,
}

impl FixtureSignalProvider {
    pub fn new(max_hops: u32) -> Self {
        Self { max_hops, ..Default::default() }
    }

    pub fn load(fixtures_dir: &Path, max_hops: u32) -> Result<Self, String> {
        let mut p = Self::new(max_hops);
        let s: SanctionsFile = read_json(&fixtures_dir.join("sanctions.json"))?;
        p.sanctioned = s.addresses.into_iter().collect();
        let g: ExposureFile = read_json(&fixtures_dir.join("exposure-graph.json"))?;
        p.flagged = g.flagged.into_iter().collect();
        for (a, b) in g.edges {
            p.edges.entry(a).or_default().push(b);
            p.edges.entry(b).or_default().push(a);
        }
        Ok(p)
    }

    pub fn with_sanctioned(mut self, a: Address) -> Self {
        self.sanctioned.insert(a);
        self
    }

    pub fn with_edge(mut self, a: Address, b: Address) -> Self {
        self.edges.entry(a).or_default().push(b);
        self.edges.entry(b).or_default().push(a);
        self
    }

    pub fn with_flagged(mut self, a: Address) -> Self {
        self.flagged.insert(a);
        self
    }

    /// Breadth-first distance from `start` to the nearest flagged address, bounded by `max_hops`.
    pub fn exposure_hops(&self, start: Address) -> Option<u32> {
        if self.flagged.contains(&start) {
            return Some(0);
        }
        let mut seen = HashSet::from([start]);
        let mut queue = VecDeque::from([(start, 0u32)]);
        while let Some((node, d)) = queue.pop_front() {
            if d >= self.max_hops {
                continue;
            }
            for next in self.edges.get(&node).into_iter().flatten() {
                if !seen.insert(*next) {
                    continue;
                }
                if self.flagged.contains(next) {
                    return Some(d + 1);
                }
                queue.push_back((*next, d + 1));
            }
        }
        None
    }
}

fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    serde_json::from_slice(&bytes).map_err(|e| format!("{}: {e}", path.display()))
}

impl SignalProvider for FixtureSignalProvider {
    fn signals(&self, action: &DecodedAction, simulation: Vec<BalanceDelta>) -> ExternalSignals {
        let counterparty = action.counterparty();
        ExternalSignals {
            sanctions_hit: counterparty.is_some_and(|c| self.sanctioned.contains(&c)),
            exposure_hops: counterparty.and_then(|c| self.exposure_hops(c)),
            simulation,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bfs_finds_two_hop_exposure_within_bound() {
        let mixer = Address::repeat_byte(0x01);
        let mid = Address::repeat_byte(0x02);
        let target = Address::repeat_byte(0x03);
        let p = FixtureSignalProvider::new(2).with_flagged(mixer).with_edge(mixer, mid).with_edge(mid, target);
        assert_eq!(p.exposure_hops(target), Some(2));
        assert_eq!(FixtureSignalProvider::new(1).with_flagged(mixer).with_edge(mixer, mid).with_edge(mid, target).exposure_hops(target), None);
    }
}
