//! Shared by the CLIs: the connector registry (public indexers, keys from the environment).

use sq_connectors::SourceRegistry;

pub fn registry() -> SourceRegistry {
    let tonapi = std::env::var("SQ_TONAPI_KEY").ok();
    let toncenter = std::env::var("SQ_TONCENTER_API_KEY").ok();
    let mut reg = SourceRegistry::new()
        .register(Box::new(sq_conn_ton::TonSource::new(true, tonapi.clone(), toncenter.clone())))
        .register(Box::new(sq_conn_ton::TonSource::new(false, tonapi, toncenter)))
        .register(Box::new(sq_conn_btc::EsploraBitcoinSource::testnet()))
        .register(Box::new(sq_conn_btc::EsploraBitcoinSource::mainnet()))
        .register(Box::new(sq_conn_sol::SolanaSource::new(true, std::env::var("SQ_SOLANA_RPC").ok())))
        .register(Box::new(sq_conn_sol::SolanaSource::new(false, std::env::var("SQ_SOLANA_RPC").ok())));
    for s in sq_conn_evm::well_known() {
        reg = reg.register(Box::new(s));
    }
    reg
}
