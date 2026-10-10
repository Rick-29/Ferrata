//! Swissquote-side services: co-signing, holds, recovery, reconciliation, ownership, and the
//! pseudo-blockchain the demo runs against. One Axum router, one module per capability.

pub mod assess;
pub mod auth;
pub mod chain;
pub mod config;
pub mod dev;
pub mod error;
pub mod holds;
pub mod log;
pub mod ownership;
pub mod reconcile;
pub mod recovery;
pub mod state;

use axum::Router;
use axum::http::{Method, header};
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::trace::TraceLayer;

use crate::state::SharedState;

pub fn router(state: SharedState) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::mirror_request())
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers([header::CONTENT_TYPE, header::AUTHORIZATION]);

    let mut app = Router::new()
        .merge(auth::routes())
        .merge(ownership::routes())
        .merge(assess::routes())
        .merge(holds::routes())
        .merge(log::routes())
        .merge(recovery::routes())
        .merge(reconcile::routes())
        .nest("/chain", chain::routes());

    if state.config.dev_signer {
        app = app.nest("/dev", dev::routes());
    }

    app.layer(cors).layer(TraceLayer::new_for_http()).with_state(state)
}
