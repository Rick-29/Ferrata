# Swissquote Wallet — Rust Spec

This spec describes the backend **as built** in `backend/`. Progress and gaps live in
`backend_timeline.md`; this file fixes structure and contracts.

## Scope and rules

P1 owns all Rust: the pure domain crate shared by extension and server, the thin WASM facade,
the pseudo-blockchain(s), and the Swissquote services.

**Owns:** policy engine and risk bands, audit-log hash chain, receipt signing and verification,
transaction decoding, the `ChainBackend` seam and its mock implementation, co-sign / hold /
recovery / reconciliation / ownership / anchoring services, mock providers, generated TS types.

**Does not own:** passkey creation in the browser, any UI, the TS SDK.

**Non-negotiables**

1. No private key, share or seed is ever a parameter, field or log line in Rust. Only public keys and signatures. The single labelled exception is the `/dev` mock-passkey keyring, off with `SQ_DEV_SIGNER=0`.
2. `wallet-core` is pure: no I/O, no async, no `wasm-bindgen`, no clock (time is passed in).
3. Behaviour lives in `impl` blocks on structs with private fields; services depend on traits (`Arc<dyn …>` / `dyn ChainBackend`), never on concrete types.
4. No `unwrap()` / `expect()` / `panic!` outside tests. Workspace lints deny them. Every fallible call returns a typed error.
5. Only established crypto crates: `sha2`, `ed25519-dalek`, `p256`, `alloy-primitives` (keccak). No hand-written cryptography.

## Workspace layout

```text
backend/
├── Cargo.toml              # workspace; lints deny unwrap/expect/panic
├── .cargo/config.toml      # TS_RS_EXPORT_DIR → ../frontend/packages/types/src
├── wallet-core/src/
│   ├── tx/                 # TxRequest, DecodedAction, TxDecoder, AbiTxDecoder (+ encode_erc20_call)
│   ├── policy/             # RiskBand, Reason, RiskAssessment, ExternalSignals, PolicyConfig, Rule, RuleBasedScorer, rules.rs
│   ├── log/                # LogEntry, SignedEntry, AuditLog (hash chain), OutcomeKind
│   └── receipt/            # Receipt, ReceiptVerifier, Ed25519ReceiptVerifier
├── sq-adapters/src/
│   ├── chain/backend.rs    # ChainBackend trait, ChainRegistry
│   ├── chain/ledger.rs     # MockChain: EVM-style account model, 2-of-2, escape hatch, rotation, anchoring
│   ├── chain/auth.rs       # OwnerKey (ed25519 | p256), OwnerSignature (ed25519 | webauthn), verify_owner
│   ├── log_store.rs        # LogStore, InMemoryLogStore (+ JSON snapshot)
│   ├── signer.rs           # ReceiptSigner, Ed25519Signer (receipts + co-signatures)
│   ├── signals.rs          # SignalProvider, FixtureSignalProvider (sanctions set + exposure BFS)
│   └── clock.rs            # Clock, SystemClock, FixedClock
├── api-types/src/lib.rs    # HTTP DTOs, #[derive(TS)]; re-exports core + chain types
├── wallet-wasm/src/lib.rs  # one #[wasm_bindgen] class, four methods, no logic
└── sq-services/
    ├── src/{main,config,state,error,lib}.rs
    ├── src/{auth,ownership,assess,holds,log,recovery,reconcile,chain,dev}.rs
    └── tests/flow.rs       # whole demo through the router with FixedClock
fixtures/                   # accounts · policy · sanctions · exposure-graph · kyc-scripts · demo-seed
```

| Crate | Depends on | Must not depend on |
| --- | --- | --- |
| `wallet-core` | `serde`, `serde_json`, `sha2`, `ed25519-dalek` (verify), `alloy-primitives`, `thiserror`, `ts-rs` | anything async, I/O, `wasm-bindgen` |
| `sq-adapters` | `wallet-core`, `ed25519-dalek` (sign), `p256`, `base64` | services, api-types |
| `api-types` | `wallet-core`, `sq-adapters` (chain DTOs) | services |
| `wallet-wasm` | `wallet-core`, `wasm-bindgen`, `serde-wasm-bindgen` | adapters, services, api-types |
| `sq-services` | all of the above except `wallet-wasm`; `axum`, `tower-http`, `tracing` | — |

## Domain model (`wallet-core`)

```rust
pub struct TxRequest { chain_id: u64, from: Address, to: Address, value: U256, data: Bytes, origin: Option<String> }
pub enum DecodedAction { NativeTransfer, Erc20Transfer, Erc20Approve { unlimited }, TypedData, ContractCall }
pub trait TxDecoder { fn decode(&self, req: &TxRequest) -> Result<DecodedAction, CoreError>; }

pub enum RiskBand { Low, Medium, High, Critical }           // thresholds in PolicyConfig: 25 / 50 / 80
pub struct RiskAssessment { score: u32, band: RiskBand, reasons: Vec<Reason> }
pub struct EvalContext<'a> { action, origin, account: &AccountContext, signals: &ExternalSignals, config: &PolicyConfig }
pub trait Rule { fn id(&self) -> &'static str; fn evaluate(&self, ctx: &EvalContext) -> Result<Option<Reason>, CoreError>; }
pub trait RiskScorer { fn assess(&self, ctx: &EvalContext) -> Result<RiskAssessment, CoreError>; }
pub struct RuleBasedScorer { rules: Vec<Box<dyn Rule>> }     // ::standard() = the 8 demo rules

pub struct LogEntry { seq, prev_head, user_op_hash, action, assessment, outcome: OutcomeKind, step_up, warnings, timestamp }
pub struct SignedEntry { entry, entry_hash, receipt }
pub struct AuditLog { entries }                               // head(), next_seq(), check_extends(), append(), verify()
pub struct Receipt { entry_hash, prev_head, seq, band, user_op_hash, timestamp, signature }
pub trait ReceiptVerifier { fn verify(&self, r: &Receipt) -> Result<(), CoreError>; }
```

Rules and points: `Sanctioned` 100 · `SimulatedDrain` 50 · `MixerExposure` 40 · `UnlimitedApproval` 30 ·
`PermitSignature` 30 · `LargeAmount` 25 · `NewRecipient` 20 · `UnknownAsset` 15 · `UnknownOrigin` 10.

Entry hash = `sha256("SQW-ENTRY-v1" ‖ json(entry))`. Receipt signature = Ed25519 over
`"SQW-RECEIPT-v1" ‖ entry_hash ‖ prev_head ‖ seq ‖ band ‖ user_op_hash ‖ timestamp`.

## The chain seam (`sq-adapters::chain`)

The wallet the user sees is one owner key with one account per registered `ChainBackend`.
Services talk only to `ChainRegistry` → `dyn ChainBackend`. Adding a chain is one struct
implementing the trait and one `.register(...)` in `AppState::build`.

```rust
pub trait ChainBackend: Send + Sync {
    fn chain_id(&self) -> u64;                       fn info(&self) -> ChainInfo;
    fn address_for(&self, owner: &OwnerKey) -> Address;
    fn create_account(&mut self, owner: OwnerKey) -> Result<Address, ChainError>;
    fn has_account(&self, a: Address) -> bool;       fn account(&self, a: Address, now: u64) -> Result<AccountView, ChainError>;
    fn fund(&mut self, to, asset: Option<Address>, amount, now) -> Result<SubmitResult, ChainError>;
    fn prepare(&self, tx: &TxRequest) -> Result<PreparedOp, ChainError>;      // user_op_hash + nonce
    fn simulate(&self, tx: &TxRequest) -> Result<Vec<BalanceDelta>, ChainError>;
    fn submit(&mut self, op: &SignedUserOp, now) -> Result<SubmitResult, ChainError>;   // owner sig + cosig, or unlocked escape
    fn escape_hash / escape_cancel_hash / start_escape_hatch / cancel_escape_hatch;
    fn rotate_hash / rotate_owner;                   // Swissquote-only, after its timelock
    fn anchor_hash / anchor (co-signed) / flag / verify / tamper (dev);
    fn latest_block / block / blocks(from, limit) / tx / history;
}
```

**Tamper evidence.** Every state change is an event (`ChainTx`) carrying `version`, `timestamp`,
`kind`, the signatures that authorised it, an open `extra` map and derived `flags`. Events are
hashed against their parent block; blocks commit to a state root and are signed by a validator
key distinct from the co-signer; an append-only JSON-lines store is replayed and re-verified on
start (`MockChain::new`), and `verify()` replays the live chain and compares state roots.
Flags (`TxKind::Flag`) are append-only events that reference a target event; history is never edited.

`MockChain` rules: address = `keccak(owner)[12..]`; one block per event; `user_op_hash =
keccak("SQW-USEROP-v1" ‖ chain_id ‖ from ‖ to ‖ value ‖ keccak(data) ‖ nonce)`; co-signature =
Ed25519 over `"SQW-COSIGN-v1" ‖ hash`; owner signatures are Ed25519 over the raw hash or WebAuthn
(`challenge = base64url(hash)`, ECDSA P-256 over `authenticatorData ‖ sha256(clientDataJSON)`).

## Errors

```rust
pub enum CoreError   { Decode, SeqGap{expected,got}, ChainBroken(seq), BadReceipt(seq), Rule{rule,msg}, Config }   // code(): DECODE, SEQ_GAP, …
pub enum ChainError  { WrongChain, UnknownAccount, AccountExists, BadNonce, BadOwnerSignature, MissingCosignature, BadCosignature,
                       InsufficientBalance, EscapeNotStarted, EscapeLocked, EscapeWrongRecipient, UnknownToken, UnknownTx, UnknownChain, Poisoned, Decode }
pub enum ServiceError{ Core, Chain, NotFound, Unauthorized, Conflict, BadRequest, Upstream, Internal }
```

`ServiceError` has one `IntoResponse`: status + `{ code, message, details }`. Codes: `CORE_<code>`,
`CHAIN_<code>`, `NOT_FOUND`, `UNAUTHORIZED`, `CONFLICT`, `BAD_REQUEST`. Policy outcomes (step-up,
hold, refuse) are `200` payloads, never errors.

## Services (`sq-services`)

`AppState { config, chains: ChainRegistry, signer, scorer, decoder, signals, log, clock, sessions, challenges, holds, recoveries, dev_keys }`.
Handlers stay thin: parse, call, map. Bearer-token middleware on everything except
`/auth/session`, `/chains`, `/chain/info`, `/dev/*`.

**Co-sign algorithm** (`assess.rs::cosign`): `prepare` on the tx's chain and check the client's
`user_op_hash` → verify the step-up signature if present (owner key, over
`keccak("SQW-STEPUP-v1" ‖ user_op_hash)`) → derive known recipients from log + chain history and
merge with the client's → decode, simulate, signals, score → `check_extends(seq, prev_head)` →
regulatory (`SANCTIONED`) → refuse without disclosing reasons; else Low co-sign · Medium step-up
(`standard`) unless verified · High / Critical step-up (`high_risk`) unless verified **and**
`accepted_risk` → sign receipt, append entry (`risk_accepted` recorded) → return outcome. Swissquote
never holds or blocks on risk (`Positionnement légal du blocage.md`).

Endpoints, DTOs and the demo flow are listed in `backend_timeline.md` and the repo README.

## WASM boundary (`wallet-wasm`)

```rust
#[wasm_bindgen] pub struct WalletCore { scorer, decoder, verifier, policy }
new(config: { policy: PolicyConfig, swissquote_public_key: hex })
assess({ tx, signals?, account? })      → { action, assessment }
build_entry({ seq, prev_head, user_op_hash, tx, assessment, outcome, step_up?, warnings?, timestamp }) → { entry, entry_hash }
verify_log(AuditLog)                    → { ok, head, entries }
rule_ids()                              → string[]
```

Errors become `JsError("<CODE>: message")`. Build: `wasm-pack build wallet-wasm --target web --release --out-dir ../../frontend/packages/core-wasm`.

## Tests

Required and present: hash chain (append, seq gap, wrong head, tampered middle, forged receipt);
receipts (valid, flipped byte, wrong key); one fixture per band with expected reason codes;
pseudo-chain (co-signed transfer, missing/forged co-signature, bad owner, bad nonce, insufficient
balance, escape timelock + wrong recipient + cancel, owner rotation, simulate is pure); WebAuthn and
Ed25519 owner round-trips; exposure BFS; services end-to-end (auth gate, all four bands, verified
step-up, hold release, stale head, unknown chain, escape exit flagged, anchoring, recovery
cancel/execute, dev passkeys + reset).
