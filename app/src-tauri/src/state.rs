//! What the app holds in memory: the open chain (verified prefix + whatever follows a tampered
//! block, kept but marked untrusted), the per-event view the canvas and report are built from, the
//! connector registry for online lookups, the optional link to the Swissquote service, and the
//! recent-files list.

use std::collections::{BTreeMap, HashMap};
use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use alloy_primitives::Address;
use ed25519_dalek::VerifyingKey;
use serde::{Deserialize, Serialize};
use sq_adapters::chain::{ChainConfig, ChainHeader, ChainTx, ChainVerification, ExternalRef, Flag, FlagSource, JsonlBlockStore, LoadedChain, MockChain, TxKind, report_key};
use sq_adapters::chain::BlockWithTxs;
use wallet_core::RiskBand;

use crate::error::{AppError, AppResult};
use crate::online::Online;
use crate::service::ServiceLink;

/// Flag sources that count as a verdict (same set as `MockChain::validation`).
pub const VALIDATOR_SOURCES: [FlagSource; 5] = [FlagSource::Review, FlagSource::Provenance, FlagSource::Model, FlagSource::Behaviour, FlagSource::Manual];

pub fn is_validatable(kind: TxKind) -> bool {
    matches!(kind, TxKind::Cosigned | TxKind::EscapeExit | TxKind::External)
}

/// A node on the manual-mode graph: an address on one network. `id` is `network:address`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NodeRef {
    pub id: String,
    pub network: String,
    pub address: String,
}

impl NodeRef {
    pub fn new(network: &str, address: &str) -> Self {
        let network = network.trim().to_ascii_lowercase();
        let mut address = address.trim().to_string();
        if address.starts_with("0x") || address.starts_with("0X") {
            address = address.to_ascii_lowercase();
        }
        Self { id: format!("{network}:{address}"), network, address }
    }

    pub fn ferra(network: &str, address: Address) -> Self {
        Self::new(network, &format!("{address:#x}"))
    }

    pub fn parse(id: &str) -> AppResult<Self> {
        let (network, address) = id.split_once(':').ok_or_else(|| AppError::BadRequest(format!("node id {id}: expected network:address")))?;
        if network.is_empty() || address.is_empty() {
            return Err(AppError::BadRequest(format!("node id {id}: expected network:address")));
        }
        Ok(Self::new(network, address))
    }

    /// Key compatible with the chain's report index (case-insensitive).
    pub fn report_key(&self) -> String {
        report_key(&self.network, &self.address)
    }
}

/// One event as the UI wants it: the chain record plus everything derived that the canvas,
/// the attention list and the detail panel would otherwise recompute.
#[derive(Debug, Clone, Serialize)]
pub struct EventView {
    #[serde(flatten)]
    pub tx: ChainTx,
    /// `reviewed_risk`, else `risk_level`, else `None` (grey).
    pub effective_risk: Option<RiskBand>,
    /// Co-signed, escape exit or external: needs a verdict.
    pub validatable: bool,
    /// Validatable and no validator flag yet.
    pub pending: bool,
    /// `false` from the first tampered block onward.
    pub trusted: bool,
    /// Whole units of `asset_symbol`.
    pub amount_units: f64,
    pub asset_symbol: String,
    pub asset_decimals: u8,
    /// Money came in to the wallet (vs. left it).
    pub incoming: bool,
    /// The chain account this event is about.
    pub wallet: Address,
    pub counterparty: Option<NodeRef>,
    /// Reports filed against the counterparty on its network.
    pub counterparty_reports: u64,
    pub flag_codes: Vec<String>,
    /// The wallet's policy and the validators disagree on the band.
    pub disagreement: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecentFile {
    pub path: String,
    pub name: String,
    pub chain_id: u64,
    pub network: String,
    pub blocks: u64,
    pub events: u64,
    pub verified_ok: Option<bool>,
    pub last_opened: u64,
}

pub struct Opened {
    pub path: Option<PathBuf>,
    pub name: String,
    pub header: ChainHeader,
    pub chain: MockChain,
    pub verification: ChainVerification,
    pub blocks_total: u64,
    pub events: Vec<EventView>,
    pub by_hash: HashMap<alloy_primitives::B256, usize>,
    /// Accounts registered on this chain (the wallet, usually one).
    pub wallets: Vec<Address>,
    /// `network:address` of a wallet on another network -> its Ferra node id.
    pub aliases: HashMap<String, String>,
    pub opened_at: u64,
}

/// `testnet` when any mirrored network is a test network, `mainnet` when at least one is a
/// main network and none is a test one, else `unknown` (a chain with only native events).
pub fn environment(events: &[EventView]) -> &'static str {
    let mut test = false;
    let mut main = false;
    for e in events {
        let n = e.tx.network.name.to_ascii_lowercase();
        if n == "ferra" {
            continue;
        }
        if n.contains("testnet") || n.contains("sepolia") || n.contains("devnet") || n.contains("goerli") || n.contains("holesky") {
            test = true;
        } else {
            main = true;
        }
    }
    match (test, main) {
        (true, _) => "testnet",
        (false, true) => "mainnet",
        _ => "unknown",
    }
}

impl Opened {
    pub fn environment(&self) -> &'static str {
        environment(&self.events)
    }

    pub fn ferra_network(&self) -> &str {
        &self.header.network.name
    }

    pub fn event(&self, hash: alloy_primitives::B256) -> AppResult<&EventView> {
        self.by_hash.get(&hash).and_then(|i| self.events.get(*i)).ok_or_else(|| AppError::NotFound(format!("event {hash}")))
    }

    pub fn primary_wallet(&self) -> Option<Address> {
        self.wallets.first().copied()
    }

    /// The wallet node, or the node as given when it is no wallet alias.
    pub fn resolve_alias(&self, node: &NodeRef) -> NodeRef {
        match self.aliases.get(&node.id.to_ascii_lowercase()) {
            Some(ferra_id) => NodeRef::parse(ferra_id).unwrap_or_else(|_| node.clone()),
            None => node.clone(),
        }
    }

    pub fn token_meta(&self, asset: Option<Address>) -> (String, u8) {
        match asset {
            None => ("ETH".to_string(), 18),
            Some(a) => self.header.tokens.iter().find(|t| t.address == a).map(|t| (t.symbol.clone(), t.decimals)).unwrap_or_else(|| (format!("{a:#x}"), 18)),
        }
    }
}

pub struct AppState {
    pub opened: Mutex<Option<Opened>>,
    /// Verdicts the in-app validator or a human produced, by event hash. Not written to the chain.
    pub verdicts: Mutex<HashMap<alloy_primitives::B256, Vec<Flag>>>,
    pub auto: Mutex<crate::validator::AutoState>,
    pub online: Arc<Online>,
    pub service: Mutex<ServiceLink>,
    pub recent: Mutex<Vec<RecentFile>>,
    pub data_dir: PathBuf,
}

impl AppState {
    pub fn lock<'a, T>(&self, m: &'a Mutex<T>) -> AppResult<MutexGuard<'a, T>> {
        m.lock().map_err(|_| AppError::Internal("lock poisoned".into()))
    }

    pub fn with_chain<T>(&self, f: impl FnOnce(&Opened) -> AppResult<T>) -> AppResult<T> {
        let guard = self.lock(&self.opened)?;
        let opened = guard.as_ref().ok_or(AppError::NoChain)?;
        f(opened)
    }

    /// The events with the local verdicts folded in.
    pub fn merged_events(&self) -> AppResult<Vec<EventView>> {
        let verdicts = self.lock(&self.verdicts)?;
        self.with_chain(|o| {
            Ok(o.events
                .iter()
                .map(|e| match verdicts.get(&e.tx.hash) {
                    Some(flags) if !flags.is_empty() => apply_verdict(e, flags),
                    _ => e.clone(),
                })
                .collect())
        })
    }

    pub fn merged_event(&self, hash: alloy_primitives::B256) -> AppResult<EventView> {
        let verdicts = self.lock(&self.verdicts)?;
        self.with_chain(|o| {
            let e = o.event(hash)?;
            Ok(match verdicts.get(&hash) {
                Some(flags) if !flags.is_empty() => apply_verdict(e, flags),
                _ => e.clone(),
            })
        })
    }

    pub fn recent_path(&self) -> PathBuf {
        self.data_dir.join("recent.json")
    }

    pub fn load_recent(&self) -> Vec<RecentFile> {
        std::fs::read_to_string(self.recent_path()).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
    }

    pub fn remember(&self, entry: RecentFile) -> AppResult<Vec<RecentFile>> {
        let mut list = self.lock(&self.recent)?;
        list.retain(|r| r.path != entry.path);
        list.insert(0, entry);
        list.truncate(12);
        if let Err(e) = std::fs::create_dir_all(&self.data_dir).and_then(|_| std::fs::write(self.recent_path(), serde_json::to_string_pretty(&*list).unwrap_or_default())) {
            eprintln!("recent files not saved: {e}");
        }
        Ok(list.clone())
    }
}

pub fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn key(hex_str: &str, what: &str) -> AppResult<VerifyingKey> {
    let bytes = hex::decode(hex_str).map_err(|e| AppError::Chain(format!("{what}: {e}")))?;
    let arr: [u8; 32] = bytes.try_into().map_err(|_| AppError::Chain(format!("{what}: expected 32 bytes")))?;
    VerifyingKey::from_bytes(&arr).map_err(|e| AppError::Chain(format!("{what}: {e}")))
}

/// Progress callback: `(stage, done, total)`; `total` is 0 when unknown.
pub type Progress<'a> = &'a dyn Fn(&str, u64, u64);

/// Reads and verifies a chain file. A tampered file still opens: the verified prefix becomes the
/// chain, the rest is kept as raw, untrusted events so the canvas can draw the break.
pub fn open_file(path: &Path) -> AppResult<Opened> {
    open_file_with(path, &|_, _, _| {})
}

pub fn open_file_with(path: &Path, progress: Progress<'_>) -> AppResult<Opened> {
    progress("Reading file", 0, 0);
    let file = std::fs::File::open(path).map_err(|e| AppError::Io(format!("{}: {e}", path.display())))?;
    let loaded = JsonlBlockStore::parse(BufReader::new(file))?;
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| path.display().to_string());
    open_loaded_with(loaded, Some(path.to_path_buf()), name, progress)
}

pub fn open_loaded(loaded: LoadedChain, path: Option<PathBuf>, name: String) -> AppResult<Opened> {
    open_loaded_with(loaded, path, name, &|_, _, _| {})
}

pub fn open_loaded_with(loaded: LoadedChain, path: Option<PathBuf>, name: String, progress: Progress<'_>) -> AppResult<Opened> {
    let header = loaded.header.clone().ok_or_else(|| AppError::Chain("no header record: not a self-contained ferra-chain file".into()))?;
    let cfg = ChainConfig {
        chain_id: header.chain_id,
        network: header.network.clone(),
        cosigner: key(&header.cosigner, "cosigner")?,
        escape_delay_secs: header.escape_delay_secs,
        tokens: header.tokens.clone(),
        genesis_time: header.genesis_time,
    };
    let validator = key(&header.validator, "validator")?;
    let blocks_total = loaded.blocks.len() as u64;
    let txs_total: u64 = loaded.blocks.iter().map(|b| b.txs.len() as u64).sum();
    let last = loaded.blocks.last().map(|b| b.block.clone());
    progress("Verifying blocks", 0, blocks_total);

    let (chain, verification, untrusted): (MockChain, ChainVerification, Vec<ChainTx>) = match MockChain::replay(cfg.clone(), validator, &loaded.blocks) {
        Ok(chain) => {
            let head = chain.latest();
            let v = ChainVerification { ok: true, blocks_checked: blocks_total, txs_checked: txs_total, first_bad_block: None, reason: None, head: head.hash, state_root: head.state_root };
            (chain, v, Vec::new())
        }
        Err(sq_adapters::chain::ChainError::Tampered { block, reason }) => {
            let split = loaded.blocks.iter().position(|b| b.block.number >= block).unwrap_or(loaded.blocks.len());
            let good: &[BlockWithTxs] = &loaded.blocks[..split];
            let chain = MockChain::replay(cfg.clone(), validator, good).or_else(|_| MockChain::replay(cfg.clone(), validator, &[]))?;
            let untrusted: Vec<ChainTx> = loaded.blocks[split..].iter().flat_map(|b| b.txs.iter().cloned()).collect();
            let (head, root) = last.map(|b| (b.hash, b.state_root)).unwrap_or_default();
            let v = ChainVerification { ok: false, blocks_checked: block, txs_checked: txs_total, first_bad_block: Some(block), reason: Some(reason), head, state_root: root };
            (chain, v, untrusted)
        }
        Err(e) => return Err(e.into()),
    };

    let wallets: Vec<Address> = {
        let mut w: Vec<Address> = chain.events().iter().filter(|t| t.kind == TxKind::AccountCreated).map(|t| t.from).collect();
        w.sort();
        w.dedup();
        w
    };

    progress("Building events", blocks_total, blocks_total);
    let mut opened = Opened { path, name, header, chain, verification, blocks_total, events: Vec::new(), by_hash: HashMap::new(), wallets, aliases: HashMap::new(), opened_at: now() };
    let mut events: Vec<EventView> = opened.chain.events().into_iter().map(|t| event_view(&opened, t, true)).collect();
    events.extend(untrusted.into_iter().map(|t| event_view(&opened, t, false)));
    for e in &events {
        if e.tx.kind == TxKind::External
            && let Some(ext) = external_ref(&e.tx)
        {
            let own = if e.incoming { &ext.to_raw } else { &ext.from_raw };
            let alias = NodeRef::new(&ext.network.name, own);
            opened.aliases.insert(alias.id.to_ascii_lowercase(), NodeRef::ferra(&opened.header.network.name, e.wallet).id);
        }
    }
    opened.by_hash = events.iter().enumerate().map(|(i, e)| (e.tx.hash, i)).collect();
    opened.events = events;
    progress("Ready", blocks_total, blocks_total);
    Ok(opened)
}

pub fn external_ref(tx: &ChainTx) -> Option<ExternalRef> {
    tx.extra.get("external").and_then(|e| serde_json::from_value(e.clone()).ok())
}

fn u256_units(v: alloy_primitives::U256, decimals: u8) -> f64 {
    v.to_string().parse::<f64>().unwrap_or(0.0) / 10f64.powi(i32::from(decimals))
}

/// The counterparty of an event as a graph node, mirroring the chain's own report keying.
pub fn counterparty_of(opened: &Opened, tx: &ChainTx) -> Option<NodeRef> {
    match tx.kind {
        TxKind::External => {
            let ext = external_ref(tx)?;
            let incoming = tx.extra.get("incoming").and_then(|v| v.as_bool()).unwrap_or(false);
            Some(NodeRef::new(&ext.network.name, if incoming { &ext.from_raw } else { &ext.to_raw }))
        }
        TxKind::Cosigned | TxKind::EscapeExit => {
            let c = tx.action.counterparty().filter(|c| *c != tx.from && *c != Address::ZERO)?;
            Some(NodeRef::ferra(opened.ferra_network(), c))
        }
        TxKind::Faucet => (tx.from != Address::ZERO).then(|| NodeRef::ferra(opened.ferra_network(), tx.from)),
        _ => None,
    }
}

fn event_view(opened: &Opened, tx: ChainTx, trusted: bool) -> EventView {
    let incoming = match tx.kind {
        TxKind::External => tx.extra.get("incoming").and_then(|v| v.as_bool()).unwrap_or(false),
        TxKind::Faucet => true,
        TxKind::Cosigned => opened.wallets.contains(&tx.to) && !opened.wallets.contains(&tx.from),
        _ => false,
    };
    // Outgoing externals are written as `wallet -> 0x0`, incoming ones as `0x0 -> wallet`.
    let wallet = match tx.kind {
        TxKind::External => if incoming { tx.to } else { tx.from },
        TxKind::Faucet => tx.to,
        _ if tx.from == Address::ZERO => tx.to,
        _ => tx.from,
    };
    let (amount_units, asset_symbol, asset_decimals) = match (tx.kind, external_ref(&tx)) {
        (TxKind::External, Some(ext)) => (ext.amount.parse::<f64>().unwrap_or(0.0) / 10f64.powi(i32::from(ext.decimals)), ext.asset_symbol.clone(), ext.decimals),
        _ => {
            let (symbol, decimals) = opened.token_meta(tx.action.asset());
            let amount = match tx.action.amount() {
                a if a.is_zero() => u256_units(tx.value, decimals),
                a => u256_units(a, decimals),
            };
            (amount, symbol, decimals)
        }
    };
    let counterparty = counterparty_of(opened, &tx);
    let counterparty_reports = counterparty.as_ref().map(|c| opened.chain.report_count(&c.network, &c.address)).unwrap_or(0);
    let validatable = is_validatable(tx.kind);
    let has_verdict = tx.flags.iter().any(|f| VALIDATOR_SOURCES.contains(&f.source));
    let effective_risk = tx.reviewed_risk.or(tx.risk_level);
    let disagreement = matches!((tx.reviewed_risk, tx.risk_level), (Some(a), Some(b)) if a != b);
    let flag_codes = {
        let mut codes: Vec<String> = tx.flags.iter().map(|f| f.code.clone()).collect();
        codes.sort();
        codes.dedup();
        codes
    };
    EventView { effective_risk, validatable, pending: validatable && !has_verdict, trusted, amount_units, asset_symbol, asset_decimals, incoming, wallet, counterparty, counterparty_reports, flag_codes, disagreement, tx }
}

/// An event view with extra (local) flags: the validators' band becomes the worst severity among
/// validator-source flags, the event stops being pending.
pub fn apply_verdict(e: &EventView, local: &[Flag]) -> EventView {
    let mut tx = e.tx.clone();
    for f in local {
        if !tx.flags.iter().any(|x| x.code == f.code && x.source == f.source && x.at == f.at) {
            tx.flags.push(f.clone());
        }
    }
    let reviewed = tx.flags.iter().filter(|f| VALIDATOR_SOURCES.contains(&f.source)).map(|f| Some(f.severity)).fold(None, max_band);
    tx.reviewed_risk = reviewed.or(tx.reviewed_risk);
    let has_verdict = tx.flags.iter().any(|f| VALIDATOR_SOURCES.contains(&f.source));
    let effective_risk = tx.reviewed_risk.or(tx.risk_level);
    let disagreement = matches!((tx.reviewed_risk, tx.risk_level), (Some(a), Some(b)) if a != b);
    let mut flag_codes: Vec<String> = tx.flags.iter().map(|f| f.code.clone()).collect();
    flag_codes.sort();
    flag_codes.dedup();
    EventView { effective_risk, pending: e.validatable && !has_verdict, disagreement, flag_codes, tx, ..e.clone() }
}

/// Bands ordered for sorting: Critical first.
pub fn band_rank(b: Option<RiskBand>) -> u8 {
    match b {
        Some(RiskBand::Critical) => 4,
        Some(RiskBand::High) => 3,
        Some(RiskBand::Medium) => 2,
        Some(RiskBand::Low) => 1,
        None => 0,
    }
}

pub fn max_band(a: Option<RiskBand>, b: Option<RiskBand>) -> Option<RiskBand> {
    if band_rank(a) >= band_rank(b) { a } else { b }
}

/// Reports index by node key, built once per request from the chain.
pub fn reports_index(opened: &Opened) -> BTreeMap<String, u64> {
    opened.chain.reported_addresses().into_iter().map(|r| (report_key(&r.network, &r.address), r.count)).collect()
}
