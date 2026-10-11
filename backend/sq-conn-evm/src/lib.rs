//! EVM connector over Blockscout-compatible explorers. One struct per network instance;
//! `well_known()` lists the ones the demo registers.

pub mod blockscout;

pub use blockscout::BlockscoutSource;

/// Networks with a public Blockscout instance; no API key needed.
pub fn well_known() -> Vec<BlockscoutSource> {
    vec![
        BlockscoutSource::new("eth-sepolia", 11_155_111, "https://eth-sepolia.blockscout.com/api"),
        BlockscoutSource::new("base-sepolia", 84_532, "https://base-sepolia.blockscout.com/api"),
        BlockscoutSource::new("optimism-sepolia", 11_155_420, "https://optimism-sepolia.blockscout.com/api"),
        BlockscoutSource::new("ethereum", 1, "https://eth.blockscout.com/api"),
        BlockscoutSource::new("base", 8_453, "https://base.blockscout.com/api"),
        BlockscoutSource::new("arbitrum", 42_161, "https://arbitrum.blockscout.com/api"),
        BlockscoutSource::new("optimism", 10, "https://optimism.blockscout.com/api"),
        BlockscoutSource::new("polygon", 137, "https://polygon.blockscout.com/api"),
        BlockscoutSource::new("gnosis", 100, "https://gnosis.blockscout.com/api"),
        BlockscoutSource::new("scroll", 534_352, "https://scroll.blockscout.com/api"),
    ]
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use sq_connectors::NetworkSource;

    use super::well_known;

    #[test]
    fn well_known_names_and_chain_ids_are_unique() {
        let nets: Vec<_> = well_known().iter().map(|s| s.network().clone()).collect();
        let names: BTreeSet<_> = nets.iter().map(|n| n.name.clone()).collect();
        let ids: BTreeSet<_> = nets.iter().filter_map(|n| n.chain_id).collect();
        assert_eq!(names.len(), nets.len(), "duplicate network name would overwrite a source");
        assert_eq!(ids.len(), nets.len(), "duplicate chain id");
    }
}
