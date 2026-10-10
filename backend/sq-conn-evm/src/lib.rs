//! EVM connector over Blockscout-compatible explorers. One struct per network instance;
//! `well_known()` lists the ones the demo registers.

pub mod blockscout;

pub use blockscout::BlockscoutSource;

/// Networks with a public Blockscout instance; no API key needed.
pub fn well_known() -> Vec<BlockscoutSource> {
    vec![
        BlockscoutSource::new("eth-sepolia", 11_155_111, "https://eth-sepolia.blockscout.com/api"),
        BlockscoutSource::new("base-sepolia", 84_532, "https://base-sepolia.blockscout.com/api"),
        BlockscoutSource::new("ethereum", 1, "https://eth.blockscout.com/api"),
    ]
}
