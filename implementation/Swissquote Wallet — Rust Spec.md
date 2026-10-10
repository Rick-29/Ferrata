# Swissquote Wallet — Rust Spec

## Scope and rules

P1 owns all Rust: the pure domain crate shared by extension and server, the thin WASM facade, and the Swissquote services. The design doc is the source of truth for behaviour; this spec fixes structure.

**Owns:** policy engine and risk bands, audit-log hash chain, receipt signing and verification, transaction decoding, co-sign / recovery / reconciliation / ownership services, mock providers, generated TS types.

**Does not own:** passkey creation, userOp building, bundler and paymaster calls (P3, TypeScript), any UI (P2).

**Non-negotiables**

1. No private key, share or seed is ever a parameter, field or log line in any Rust code. Only public keys and signatures.
2. `wallet-core` is pure: no I/O, no async, no `wasm-bindgen`, no clock (time is passed in). Everything external sits behind a trait.
3. OOP through traits and structs with private fields; behaviour lives in `impl` blocks, not free functions.
4. No `unwrap()` / `expect()` / `panic!` outside tests. Every fallible call returns a typed error.
5. Only established crypto crates; no hand-written cryptography.

## Workspace layout

Five crates; dependencies only point inward toward `wallet-core`, and only `wallet-wasm` knows about JavaScript.

```text
rust/
├── Cargo.toml                  # workspace, shared lints: deny(clippy::unwrap_used, clippy::expect_used)
├── crates/
│   ├── wallet-core/            # pure domain: policy, log, receipts, decoding (no I/O)
│   │   └── src/
│   │       ├── lib.rs          # re-exports only
│   │       ├── error.rs        # CoreError
│   │       ├── tx/             # TxRequest, TxDecoder, DecodedAction
│   │       ├── policy/         # Rule, RiskScorer, RuleBasedScorer, RiskBand, PolicyConfig
│   │       ├── log/            # LogEntry, AuditLog, HashChain
│   │       └── receipt/        # Receipt, ReceiptVerifier
│   ├── api-types/              # request/response DTOs, #[derive(TS)] → ts/packages/types
│   ├── wallet-wasm/            # thin wasm-bindgen facade over wallet-core (≈ 150 lines)
│   ├── sq-adapters/            # trait impls: stores, chain reader, signer, mock KYC/sanctions/escrow
│   └── sq-services/            # Axum binary: routes → services → ports
└── tests/                      # cross-crate integration tests
```

| Crate | May depend on | Must not depend on |
| --- | --- | --- |
| `wallet-core` | `serde`, `sha2`, `ed25519-dalek` (verify), `alloy-primitives`, `thiserror` | anything async, I/O, `wasm-bindgen` |
| `api-types` | `wallet-core`, `serde`, `ts-rs` | services, adapters |
| `wallet-wasm` | `wallet-core`, `api-types`, `wasm-bindgen`, `serde-wasm-bindgen` | adapters, services |
| `sq-adapters` | `wallet-core`, `alloy`, `tokio`, `ed25519-dalek` (sign) | services |
| `sq-services` | all of the above except `wallet-wasm`; `axum`, `tower-http`, `tracing` | — |

## Domain model

Each concern is one trait plus one or more structs; services compose them through `Arc<dyn Trait>`, never concrete types. Signatures below are the contract; bodies are P1's.

```rust
// ---------- tx/ ----------
pub struct TxRequest { chain_id: u64, from: Address, to: Address, value: U256, data: Bytes, origin: Option<String> }
pub enum DecodedAction {
    NativeTransfer { to: Address, amount: U256 },
    Erc20Transfer  { token: Address, to: Address, amount: U256 },
    Erc20Approve   { token: Address, spender: Address, amount: U256, unlimited: bool },
    TypedData      { domain: Eip712Domain, primary_type: String, summary: TypedDataSummary },
    ContractCall   { target: Address, selector: [u8; 4] },
}
pub trait TxDecoder { fn decode(&self, req: &TxRequest) -> Result<DecodedAction, CoreError>; }

// ---------- policy/ ----------
pub enum RiskBand { Low, Medium, High, Critical }
pub struct Reason { code: ReasonCode, points: u32, message: String }
pub struct RiskAssessment { score: u32, band: RiskBand, reasons: Vec<Reason> }

pub struct EvalContext<'a> { action: &'a DecodedAction, account: &'a AccountContext, signals: &'a ExternalSignals }
pub trait Rule: Send + Sync {
    fn id(&self) -> &'static str;
    fn evaluate(&self, ctx: &EvalContext) -> Result<Option<Reason>, CoreError>;
}
pub trait RiskScorer: Send + Sync {
    fn assess(&self, ctx: &EvalContext) -> Result<RiskAssessment, CoreError>;
}
pub struct RuleBasedScorer { rules: Vec<Box<dyn Rule>>, config: PolicyConfig }
impl RuleBasedScorer { pub fn new(config: PolicyConfig) -> Self; pub fn with_rule(self, rule: Box<dyn Rule>) -> Self; }

// ---------- log/ ----------
pub struct LogEntry { seq: u64, prev_head: Hash32, user_op_hash: Hash32, action: DecodedAction,
                      assessment: RiskAssessment, step_up: bool, warnings: Vec<String>, timestamp: u64 }
impl LogEntry { pub fn hash(&self) -> Hash32; }
pub struct AuditLog { entries: Vec<SignedEntry> }
impl AuditLog {
    pub fn head(&self) -> Hash32;
    pub fn append(&mut self, entry: SignedEntry) -> Result<(), CoreError>;     // checks seq + prev_head
    pub fn verify(&self, verifier: &dyn ReceiptVerifier) -> Result<(), CoreError>; // full chain + receipts
}

// ---------- receipt/ ----------
pub struct Receipt { entry_hash: Hash32, prev_head: Hash32, seq: u64, band: RiskBand, user_op_hash: Hash32, timestamp: u64, signature: [u8; 64] }
pub trait ReceiptVerifier { fn verify(&self, r: &Receipt) -> Result<(), CoreError>; }
pub struct Ed25519ReceiptVerifier { public_key: VerifyingKey }
```

**Rules shipped in the demo** (one struct each, in `policy/rules/`): `AllowlistRule`, `AmountLimitRule`, `NewRecipientRule`, `UnlimitedApprovalRule`, `TypedDataPermitRule`, `SanctionsRule`, `ExposureRule`, `SimulationDrainRule`. Each takes its config in `new()` and has unit tests.

**External data** (sanctions hits, exposure depth, simulation deltas) arrives as `ExternalSignals`, filled by adapters before scoring. This keeps the core pure and identical on both targets.

## Error handling

One `thiserror` enum per layer, converted upward with `#[from]`; every error that leaves Rust carries a stable machine code the TypeScript side can switch on.

```rust
#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    #[error("cannot decode transaction: {0}")]           Decode(String),
    #[error("log sequence gap: expected {expected}, got {got}")] SeqGap { expected: u64, got: u64 },
    #[error("log chain broken at seq {0}")]                ChainBroken(u64),
    #[error("receipt signature invalid at seq {0}")]       BadReceipt(u64),
    #[error("rule {rule} failed: {msg}")]                  Rule { rule: &'static str, msg: String },
    #[error("invalid config: {0}")]                        Config(String),
}
impl CoreError { pub fn code(&self) -> &'static str { /* "DECODE", "SEQ_GAP", ... */ } }

#[derive(Debug, thiserror::Error)]
pub enum ServiceError {
    #[error(transparent)] Core(#[from] CoreError),
    #[error("not found: {0}")]       NotFound(String),
    #[error("unauthorized")]         Unauthorized,
    #[error("conflict: {0}")]        Conflict(String),   // e.g. recovery already pending
    #[error("upstream {provider}: {msg}")] Upstream { provider: &'static str, msg: String },
}
```

- `ServiceError` has a single `impl IntoResponse`: maps to HTTP status + JSON `{ "code", "message", "details" }`. Handlers never build error responses by hand.
- Policy outcomes (hold, refuse) are **not** errors: they are `Ok(CosignOutcome::Held{..})` / `Ok(CosignOutcome::Refused{..})` with reasons.
- `tracing` with a request id on every span; never log signatures' preimages beyond hashes, never log personal KYC data.
- `anyhow` is allowed only in `main.rs` for startup.

## Services

One Axum binary, one module per capability, each split into three files: `routes.rs` (HTTP only), `service.rs` (a struct with the logic), `ports.rs` (the traits it needs). Handlers stay under \~15 lines: parse, call service, map result.

```text
sq-services/src/
├── main.rs            # config, tracing, build AppState, serve
├── state.rs           # AppState { cosign, recovery, reconcile, ownership: Arc<...Service> }
├── error.rs           # ServiceError + IntoResponse
├── cosign/            # POST /cosign, POST /holds/{id}/justify
├── recovery/          # POST /recovery/start, POST /recovery/{id}/cancel
├── reconcile/         # POST /reconcile/{address}
├── ownership/         # GET /ownership/challenge, POST /wallet/register
└── auth/              # POST /auth/session (mock), session extractor
```

```rust
// ports used across services (implemented in sq-adapters)
#[async_trait] pub trait LogStore      { async fn load(&self, a: Address) -> Result<AuditLog, ServiceError>;
                                         async fn append(&self, a: Address, e: SignedEntry) -> Result<(), ServiceError>; }
#[async_trait] pub trait ChainReader   { async fn history(&self, a: Address) -> Result<Vec<OnChainTx>, ServiceError>; }
#[async_trait] pub trait SignalProvider{ async fn signals(&self, a: &DecodedAction) -> Result<ExternalSignals, ServiceError>; }
#[async_trait] pub trait KycProvider   { async fn verify(&self, att: &KycAttestation) -> Result<KycResult, ServiceError>; }
pub trait ReceiptSigner: Send + Sync   { fn sign(&self, e: &LogEntry) -> Result<Receipt, ServiceError>; }
pub trait Clock: Send + Sync           { fn now(&self) -> u64; }

pub struct CosignService { scorer: Arc<dyn RiskScorer>, decoder: Arc<dyn TxDecoder>, signals: Arc<dyn SignalProvider>,
                           log: Arc<dyn LogStore>, signer: Arc<dyn ReceiptSigner>, clock: Arc<dyn Clock> }
impl CosignService { pub async fn cosign(&self, req: CosignRequest) -> Result<CosignOutcome, ServiceError>; }
```

**Co-sign algorithm:** decode → fetch signals → assess → check the entry's `seq`/`prev_head` against the stored log → by band: sign receipt + co-sign / require step-up / create hold / refuse → append to log → return outcome. Server always re-scores; it never trusts the extension's assessment.

**Adapters for the demo:** `InMemoryLogStore` (+ JSON file snapshot), `AlloyChainReader` (Base Sepolia RPC), `Ed25519ReceiptSigner` (key from env, HSM in production), `MockKyc`, `MockSanctions`, `MockExposure` (synthetic graph), `SystemClock` / `FixedClock` for tests.

## WASM boundary

`wallet-wasm` exposes exactly one class with four methods; it contains no logic, only conversion between JS values and `wallet-core` types. All bindings live in this one crate.

```rust
#[wasm_bindgen]
pub struct WalletCore { scorer: RuleBasedScorer, decoder: AbiTxDecoder, verifier: Ed25519ReceiptVerifier }

#[wasm_bindgen]
impl WalletCore {
    #[wasm_bindgen(constructor)]
    pub fn new(config: JsValue) -> Result<WalletCore, JsError>;                  // PolicyConfig + Swissquote public key
    pub fn assess(&self, req: JsValue, signals: JsValue) -> Result<JsValue, JsError>;   // → RiskAssessmentDto
    pub fn build_entry(&self, input: JsValue) -> Result<JsValue, JsError>;      // → LogEntryDto + hash
    pub fn verify_log(&self, log: JsValue) -> Result<JsValue, JsError>;          // → { ok, head } or error code
}
```

- Conversion via `serde-wasm-bindgen` using the `api-types` DTOs; the same DTOs generate the TS types, so both sides share one schema.
- Errors become `JsError` with message `"<CODE>: <message>"`; P3's adapter parses the code. No panics cross the boundary (`console_error_panic_hook` only in debug builds).
- Build: `wasm-pack build crates/wallet-wasm --target web --release`, output copied into `ts/packages/core-wasm/`.
- Adding a method requires P1 + P3 agreement; the surface stays at four unless a demo step needs more.

## Tests and delivery checklist

Tests are required only where a bug would break a security claim; everything else is covered by the demo run.

**Required tests**

- Hash chain: append valid, reject seq gap, reject wrong `prev_head`, detect tampered middle entry.
- Receipts: valid signature passes, flipped byte fails, wrong key fails.
- Risk bands: one fixture per band from the design doc table produces that band with the expected reason codes.
- Reconciliation: on-chain tx missing from the log → Critical finding.
- Recovery: cancel during timelock wins; execute after timelock without cancel succeeds (with `FixedClock`).

**Checklist**

- [ ] Hour 1: workspace compiles, lints on, `api-types` exported to TS
- [ ] Hour 3: `wallet-core` hash chain + receipt verify with tests
- [ ] Hour 9: policy engine + `/cosign` returning all four outcomes
- [ ] Hour 9: `wallet-wasm` built and handed to P3
- [ ] Hour 14: recovery endpoints with timelock and cancel
- [ ] Hour 18: reconciliation + anchoring
- [ ] Hour 21: `cargo clippy -- -D warnings` and `cargo test` clean; freeze
