//! Thin wasm-bindgen facade over `wallet-core`. One class, four methods, no logic: only
//! conversion between JS values and core types. Errors surface as `JsError("CODE: message")`.

use serde::{Deserialize, Serialize};
use wallet_core::{
    AbiTxDecoder, AccountContext, AuditLog, CoreError, DecodedAction, Ed25519ReceiptVerifier, EvalContext,
    ExternalSignals, Hash32, LogEntry, OutcomeKind, PolicyConfig, RiskAssessment, RiskScorer, RuleBasedScorer,
    TxDecoder, TxRequest,
};
use wasm_bindgen::prelude::*;

#[derive(Deserialize)]
struct WalletCoreConfig {
    policy: PolicyConfig,
    /// Swissquote's Ed25519 public key, hex (with or without `0x`).
    swissquote_public_key: String,
}

#[derive(Deserialize)]
struct AssessInput {
    tx: TxRequest,
    #[serde(default)]
    signals: ExternalSignals,
    #[serde(default)]
    account: AccountContext,
}

#[derive(Serialize)]
struct AssessOutput {
    action: DecodedAction,
    assessment: RiskAssessment,
}

#[derive(Deserialize)]
struct EntryInput {
    seq: u64,
    prev_head: Hash32,
    user_op_hash: Hash32,
    tx: TxRequest,
    assessment: RiskAssessment,
    outcome: OutcomeKind,
    #[serde(default)]
    step_up: bool,
    #[serde(default)]
    warnings: Vec<String>,
    timestamp: u64,
}

#[derive(Serialize)]
struct EntryOutput {
    entry: LogEntry,
    entry_hash: Hash32,
}

#[derive(Serialize)]
struct VerifyOutput {
    ok: bool,
    head: Hash32,
    entries: usize,
}

fn js_err(e: CoreError) -> JsError {
    JsError::new(&format!("{}: {e}", e.code()))
}

fn from_js<T: for<'de> Deserialize<'de>>(v: JsValue, what: &str) -> Result<T, JsError> {
    serde_wasm_bindgen::from_value(v).map_err(|e| JsError::new(&format!("DECODE: invalid {what}: {e}")))
}

fn to_js<T: Serialize>(v: &T) -> Result<JsValue, JsError> {
    let ser = serde_wasm_bindgen::Serializer::json_compatible();
    v.serialize(&ser).map_err(|e| JsError::new(&format!("INTERNAL: {e}")))
}

#[wasm_bindgen]
pub struct WalletCore {
    scorer: RuleBasedScorer,
    decoder: AbiTxDecoder,
    verifier: Ed25519ReceiptVerifier,
    policy: PolicyConfig,
}

#[wasm_bindgen]
impl WalletCore {
    #[wasm_bindgen(constructor)]
    pub fn new(config: JsValue) -> Result<WalletCore, JsError> {
        let cfg: WalletCoreConfig = from_js(config, "config")?;
        cfg.policy.validate().map_err(js_err)?;
        let key = hex::decode(cfg.swissquote_public_key.trim_start_matches("0x"))
            .map_err(|e| JsError::new(&format!("CONFIG: public key is not hex: {e}")))?;
        let verifier = Ed25519ReceiptVerifier::from_bytes(&key).map_err(js_err)?;
        Ok(WalletCore { scorer: RuleBasedScorer::standard(), decoder: AbiTxDecoder::new(), verifier, policy: cfg.policy })
    }

    /// `{ tx, signals?, account? }` → `{ action, assessment }`
    pub fn assess(&self, input: JsValue) -> Result<JsValue, JsError> {
        let input: AssessInput = from_js(input, "assess input")?;
        let action = self.decoder.decode(&input.tx).map_err(js_err)?;
        let ctx = EvalContext {
            action: &action,
            origin: input.tx.origin.as_deref(),
            account: &input.account,
            signals: &input.signals,
            config: &self.policy,
        };
        let assessment = self.scorer.assess(&ctx).map_err(js_err)?;
        to_js(&AssessOutput { action, assessment })
    }

    /// Builds the entry the extension sends to `/cosign` and keeps locally → `{ entry, entry_hash }`
    pub fn build_entry(&self, input: JsValue) -> Result<JsValue, JsError> {
        let i: EntryInput = from_js(input, "entry input")?;
        let action = self.decoder.decode(&i.tx).map_err(js_err)?;
        let entry = LogEntry {
            seq: i.seq,
            prev_head: i.prev_head,
            user_op_hash: i.user_op_hash,
            action,
            assessment: i.assessment,
            outcome: i.outcome,
            step_up: i.step_up,
            warnings: i.warnings,
            timestamp: i.timestamp,
        };
        let entry_hash = entry.hash().map_err(js_err)?;
        to_js(&EntryOutput { entry, entry_hash })
    }

    /// Full chain walk plus receipt verification against Swissquote's key → `{ ok, head, entries }`
    pub fn verify_log(&self, log: JsValue) -> Result<JsValue, JsError> {
        let log: AuditLog = from_js(log, "audit log")?;
        let head = log.verify(&self.verifier).map_err(js_err)?;
        to_js(&VerifyOutput { ok: true, head, entries: log.len() })
    }

    pub fn rule_ids(&self) -> Vec<String> {
        self.scorer.rule_ids().into_iter().map(String::from).collect()
    }
}
