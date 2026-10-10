use std::net::SocketAddr;

use anyhow::Context;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info,tower_http=debug")))
        .init();

    let config = sq_services::config::Config::from_env().context("loading configuration")?;
    let port = config.port;
    let state = sq_services::state::AppState::build(config).context("building application state")?;
    let app = sq_services::router(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr).await.with_context(|| format!("binding {addr}"))?;
    tracing::info!("Swissquote wallet service listening on http://localhost:{port}");
    axum::serve(listener, app).await.context("serving")?;
    Ok(())
}
