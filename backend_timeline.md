# Backend timeline

Status of everything in `backend/`, kept current by P1. The frontend has its own file.
Legend: ✅ done and tested · 🟡 work in progress · ⬜ not started · ❌ dropped.

Last update: 2026-10-10, step 12 (Ferra chain: networks, external events, features, model).

## Verification snapshot

| Check | Result |
| --- | --- |
| `cargo test --workspace` | 138 green (core 38, adapters 41, api-types 43 binding exports, services 16 end-to-end) |
| `cargo clippy --workspace --all-targets -- -D warnings` | clean; `unwrap`/`expect`/`panic` denied outside tests |
| `cargo build -p wallet-wasm --target wasm32-unknown-unknown` | ok |
| TypeScript bindings | regenerated into `frontend/packages/types/src` by `cargo test`, no `bigint` |
| Persisted chain across a restart | ✅ replayed and verified on start; edited file refused |

## Crates

| Crate | Role | Status |
| --- | --- | --- |
| `wallet-core` | pure domain: tx decoder, 8 risk rules + scorer, hash-chained log, Ed25519 receipts | ✅ |
| `sq-adapters` | tamper-evident pseudo-chain, `ChainBackend` trait + registry, block store, log store, signer, fixture signals, clocks | ✅ |
| `api-types` | HTTP DTOs → TS | ✅ |
| `wallet-wasm` | `WalletCore { assess, build_entry, verify_log, rule_ids }` | ✅ builds · ⬜ not packaged with `wasm-pack` yet |
| `sq-services` | Axum API, one module per capability | ✅ |

## Tamper-evident chain

| Property | How | Status |
| --- | --- | --- |
| Every state change is an event with the signatures that authorised it | `ChainTx { owner_signature, cosignature, extra }`; one `commit` path for live and replayed events | ✅ |
| Event hash binds content to its parent block | `keccak("SQW-EVENT-v1" ‖ version ‖ chain ‖ parent ‖ number ‖ ts ‖ kind ‖ from ‖ to ‖ value ‖ keccak(data) ‖ nonce ‖ user_op_hash ‖ sigs ‖ extra)` | ✅ |
| Blocks commit to a state root | sequential commitment over accounts, balances, allowances in sorted order | ✅ · ⬜ Merkle for per-account proofs |
| Blocks are signed by a validator key distinct from the co-signer | Ed25519 over `"SQW-BLOCK-v1" ‖ block.hash`; `SQ_VALIDATOR_SEED` | ✅ |
| Append-only persistence, replay + verify on start | `JsonlBlockStore`, `MockChain::new` refuses a file that does not replay | ✅ |
| Live-state drift without an event is caught | `verify` compares replayed state root with live | ✅ |
| Integrity endpoint and demo corruption | `GET /chain/verify`, `POST /dev/tamper` (tx value, balance, block parent) | ✅ |
| Versioned, extensible events | `version` field, `#[serde(default)]` on new fields, open `extra` map, unknown keys ignored | ✅ |
| Flags are append-only events, never edits | `TxKind::Flag`, derived `tx.flags`, deduped per (target, source, code) | ✅ |
| Multiple events per block | one event per block today | ⬜ |
| Second validator / 2-of-2 block signing | | ⬜ |
| Chain as its own process | | ⬜ |

## Ferra chain as cross-network ledger + validator data

| Item | Status |
| --- | --- |
| `Network { family: ferra/evm/bitcoin/solana/ton/sui/other, name, chain_id }` on every event and chain | ✅ |
| `TxKind::External` + `POST /chain/ingest`: events seen elsewhere, Swissquote-attested (co-signed `external_hash`), raw addresses kept in `extra.external` | ✅ |
| `TxFeatures` v1 (~45 features) computed from pre-state at commit, stored on the event, not hashed, versioned | ✅ see `backend/features.md` |
| Decision latency (`/assess` or `/prepare` → `/submit`) and policy snapshot from the audit log recorded via `SubmitMeta` | ✅ |
| `GET /chain/dataset`: rows `{ features, label, label_codes }` | ✅ |
| `RiskModel` trait, `LinearModel` from `fixtures/model.json`, `GET /model`, `MODEL_RISK` flag with top contributions | ✅ hand-set weights · ⬜ trained weights |
| Real connectors that call `/chain/ingest` from Ethereum / Bitcoin / Solana RPCs | ⬜ see `future_implementation.md` |
| Price feed for fiat-normalised amounts | ⬜ |
| Device / IP / geo in `SubmitMeta` | ⬜ |
| Two-hop graph aggregates | ⬜ |

## Account review (validation system)

| Item | Status |
| --- | --- |
| `POST /review/{address}`: policy reasons from the log, counterparty sanctions/exposure both directions, chain-vs-log findings, integrity check | ✅ |
| Findings written back as `Flag` events; review idempotent | ✅ |
| Model score per event (`FlagSource::Model`) | ✅ |
| Verdict `clean` / `suspicious` / `blocked` and score | ✅ |
| Flags visible on events, accounts and block pages | ✅ |
| Review as a workflow (open / cleared / escalated, manual flags, "merge back" after escape) | ⬜ see `future_implementation.md` |

## Security claims (each backed by a test)

| Claim | Where | Status |
| --- | --- | --- |
| No tx without owner passkey **and** Swissquote co-signature | `ledger.rs::authorize` | ✅ |
| Server re-scores every request; never trusts the client's assessment | `assess.rs::cosign` | ✅ |
| Log is a hash chain; seq gap, wrong head, tampered entry, forged receipt rejected | `log/`, `receipt/` | ✅ |
| Medium band needs a **verified** passkey step-up signature | `assess.rs::step_up_hash` | ✅ |
| Known recipients derived from Swissquote's records; client can add, not hide | `assess.rs::known_recipients` | ✅ |
| Escape hatch: owner-only, timelocked, exit address fixed, no Swissquote | `ledger.rs` | ✅ |
| Escape exit flagged Critical by reconciliation and review | `reconcile.rs`, `review.rs` | ✅ |
| Recovery: cancel during timelock beats execute; execute rotates owner on-chain with co-sign | `recovery.rs` | ✅ |
| Log head anchored on-chain with a co-signature; rewritten log → `ANCHOR_MISMATCH` | `log.rs`, `reconcile.rs` | ✅ tested |
| Bearer token on every non-public route; **sessions bound to the wallets their client registered** | `auth.rs`, `state.rs::check_owner` | ✅ |
| WebAuthn P-256 signatures verified like an on-chain verifier would | `chain/auth.rs` | ✅ unit · ⬜ from a real browser |

## Multi-chain seam

| Item | Status |
| --- | --- |
| `ChainBackend` trait (identity, accounts, ops, escape, rotation, anchor, flag, verify, tamper, reads) + `ChainRegistry` | ✅ |
| Register creates one account per chain; `/wallet/overview`; `/chains` | ✅ |
| `MockChain` as the only backend | ✅ |
| Real EVM backend (Base Sepolia) | ⬜ plan in `future_implementation.md` |
| Chain-tagged address / asset in `wallet-core` | ⬜ needed for non-EVM |
| Audit log keyed per `(chain, address)` | ⬜ |

## API surface

| Group | Endpoints | Status |
| --- | --- | --- |
| Auth | `POST /auth/session` | ✅ |
| Ownership | `GET /ownership/challenge`, `POST /wallet/register`, `POST /wallet/overview` | ✅ |
| Risk | `POST /assess`, `POST /cosign` | ✅ |
| Holds | `GET /holds/{id}`, `POST /holds/{id}/justify` | ✅ |
| Log | `GET /log/{address}`, `POST /log/{address}/anchor` | ✅ |
| Recovery | start / get / cancel / execute | ✅ |
| Compliance | `POST /reconcile/{address}`, `POST /review/{address}` | ✅ |
| Chain | `/chains`, `/chain/info`, `/chain/verify`, `/chain/blocks[?from&limit]`, `/chain/blocks/{n}`, `/chain/tx/{hash}`, `/chain/history/{address}`, accounts, faucet, prepare, simulate, submit, escape | ✅ |
| Dev | passkeys, sign, reset, tamper | ✅ |

## Operations

| Item | Status |
| --- | --- |
| Config via env + `fixtures/` | ✅ |
| Chain persistence (`SQ_CHAIN_FILE`) | ✅ |
| Audit-log snapshot (`SQ_LOG_SNAPSHOT`) | ✅ |
| Holds, recoveries, sessions, owner bindings persist across restarts | ⬜ in memory |
| Request-id on every span | ⬜ |
| Hold expiry | 🟡 lazy on read |
| Docker / one-command run | ⬜ |

## Open decisions and known gaps

- Band thresholds (25 / 50 / 80) and rule points are my proposal; the design doc the specs cite is not in the repo.
- Co-signature and validator signature are Ed25519. A real EVM account needs secp256k1; see `future_implementation.md` §2.
- `/reconcile` and `/review` are open to any session (compliance persona). Should become role-gated.
- The step-up hash with WebAuthn goes in the challenge exactly like `user_op_hash`; untested from a browser.
- `/dev/reset` needs `SQ_SIGNING_SEED` so the co-signer key survives.

## Next (in order)

0. First real connector: an Ethereum (Base Sepolia) watcher that turns transfers of a registered address into `/chain/ingest` calls, so the visualiser shows a live network next to the Ferra chain.
1. `wasm-pack build` into `frontend/packages/core-wasm` when P3 asks.
2. Role on sessions (client vs compliance) and gate `/reconcile`, `/review`, `/dev`.
3. Review workflow records and manual flags.
4. `SignatureScheme` with secp256k1 (real chain) and hybrid ML-DSA (receipts).
5. Chain-tagged address type, then a second backend.
