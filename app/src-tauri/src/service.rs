//! The optional link to the running Swissquote service (`sq-services`, `http://localhost:8787` in
//! dev). It holds the same chain and runs the validation worker that writes flags. The app only
//! reads its status, asks for a pass, and can pull the chain over HTTP when there is no file.

use std::time::Duration;

use api_types::{ValidationPass, ValidatorStatus};
use serde::Serialize;
use sq_adapters::chain::{BlockWithTxs, ChainInfo, LoadedChain};
use sq_adapters::chain::ChainHeader;
use tauri::{AppHandle, Emitter, Manager};

use crate::error::{AppError, AppResult};

pub const STATUS_EVENT: &str = "service://status";
const POLL_SECS: u64 = 4;

#[derive(Debug, Clone, Serialize, Default)]
pub struct ServiceState {
    pub url: Option<String>,
    /// Logged in as this client (needed for `/validator/run`).
    pub client: Option<String>,
    pub auth_error: Option<String>,
    pub connected: bool,
    pub last_error: Option<String>,
    pub last_checked: Option<u64>,
    pub validator: Option<ValidatorStatus>,
    pub chain: Option<ChainInfo>,
}

#[derive(Default)]
pub struct ServiceLink {
    pub state: ServiceState,
    pub token: Option<String>,
    poller: Option<tauri::async_runtime::JoinHandle<()>>,
}

impl ServiceLink {
    pub fn stop(&mut self) {
        if let Some(h) = self.poller.take() {
            h.abort();
        }
        self.state = ServiceState::default();
        self.token = None;
    }

    pub fn set_poller(&mut self, h: tauri::async_runtime::JoinHandle<()>) {
        if let Some(old) = self.poller.replace(h) {
            old.abort();
        }
    }
}

fn client() -> reqwest::Client {
    reqwest::Client::builder().timeout(Duration::from_secs(15)).build().unwrap_or_default()
}

fn base(url: &str) -> String {
    url.trim().trim_end_matches('/').to_string()
}

async fn get_json<T: serde::de::DeserializeOwned>(url: &str, path: &str) -> AppResult<T> {
    let r = client().get(format!("{}{}", base(url), path)).send().await.map_err(|e| AppError::Service(e.to_string()))?;
    let status = r.status();
    let text = r.text().await.map_err(|e| AppError::Service(e.to_string()))?;
    if !status.is_success() {
        return Err(AppError::Service(format!("{path}: {status}: {}", text.chars().take(300).collect::<String>())));
    }
    serde_json::from_str(&text).map_err(|e| AppError::Service(format!("{path}: {e}")))
}

async fn post_json<T: serde::de::DeserializeOwned>(url: &str, path: &str, body: serde_json::Value, token: Option<&str>) -> AppResult<T> {
    let mut req = client().post(format!("{}{}", base(url), path)).json(&body);
    if let Some(t) = token {
        req = req.bearer_auth(t);
    }
    let r = req.send().await.map_err(|e| AppError::Service(e.to_string()))?;
    let status = r.status();
    let text = r.text().await.map_err(|e| AppError::Service(e.to_string()))?;
    if !status.is_success() {
        return Err(AppError::Service(format!("{path}: {status}: {}", text.chars().take(300).collect::<String>())));
    }
    serde_json::from_str(&text).map_err(|e| AppError::Service(format!("{path}: {e}")))
}

/// One round trip: validator status + chain info.
pub async fn probe(url: &str) -> AppResult<(ValidatorStatus, ChainInfo)> {
    let (v, c) = tokio::join!(get_json::<ValidatorStatus>(url, "/validator"), get_json::<ChainInfo>(url, "/chain/info"));
    Ok((v?, c?))
}

pub async fn run_validator(url: &str, batch: usize, token: Option<&str>) -> AppResult<ValidationPass> {
    post_json(url, &format!("/validator/run?batch={}", batch.clamp(1, 32)), serde_json::json!({}), token).await
}

#[derive(serde::Deserialize)]
struct Session {
    token: String,
    client_id: String,
}

/// `POST /auth/session` with a mock client (`fixtures/accounts.json`); returns `(token, client id)`.
pub async fn login(url: &str, username: &str, password: &str) -> AppResult<(String, String)> {
    let s: Session = post_json(url, "/auth/session", serde_json::json!({ "username": username, "password": password }), None).await?;
    Ok((s.token, s.client_id))
}

/// Pulls the whole chain through `/chain/blocks` so the app can open it without a file.
pub async fn fetch_chain(url: &str) -> AppResult<LoadedChain> {
    let info: ChainInfo = get_json(url, "/chain/info").await?;
    let mut blocks: Vec<BlockWithTxs> = Vec::new();
    let mut from = 0u64;
    loop {
        let page: Vec<BlockWithTxs> = get_json(url, &format!("/chain/blocks?from={from}&limit=500")).await?;
        if page.is_empty() {
            break;
        }
        let last = page.last().map(|b| b.block.number).unwrap_or(from);
        blocks.extend(page);
        if last >= info.latest_block {
            break;
        }
        from = last + 1;
    }
    blocks.sort_by_key(|b| b.block.number);
    blocks.dedup_by_key(|b| b.block.number);
    let header = ChainHeader {
        format: sq_adapters::chain::CHAIN_FORMAT.into(),
        format_version: sq_adapters::chain::CHAIN_FORMAT_VERSION,
        chain_id: info.chain_id,
        network: info.network.clone(),
        cosigner: info.cosigner.clone(),
        validator: info.validator.clone(),
        tokens: info.tokens.clone(),
        escape_delay_secs: info.escape_delay_secs,
        genesis_time: blocks.first().map(|b| b.block.timestamp).unwrap_or(0),
    };
    Ok(LoadedChain { header: Some(header), blocks })
}

/// Background status poll; emits `service://status` with the full `ServiceState` each tick.
pub fn spawn_poller(app: AppHandle, url: String) -> tauri::async_runtime::JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(POLL_SECS)).await;
            let result = probe(&url).await;
            let Some(state) = app.try_state::<crate::state::AppState>() else { break };
            let snapshot = {
                let Ok(mut link) = state.lock(&state.service) else { break };
                if link.state.url.as_deref() != Some(url.as_str()) {
                    break;
                }
                link.state.last_checked = Some(crate::state::now());
                match result {
                    Ok((v, c)) => {
                        link.state.connected = true;
                        link.state.last_error = None;
                        link.state.validator = Some(v);
                        link.state.chain = Some(c);
                    }
                    Err(e) => {
                        link.state.connected = false;
                        link.state.last_error = Some(e.to_string());
                    }
                }
                link.state.clone()
            };
            let _ = app.emit(STATUS_EVENT, &snapshot);
        }
    })
}
