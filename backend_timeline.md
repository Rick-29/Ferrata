# Backend timeline

Status of everything in `backend/`, kept current by P1. The frontend has its own file.
Legend: ✅ done and tested · 🟡 work in progress · ⬜ not started · ❌ dropped.

Last update: 2026-10-10, step 10 (multi-chain seam, verified step-up, auth gate, anchoring, reset).

## Verification snapshot

| Check | Result |
| --- | --- |
| `cargo test --workspace` | all green (core 38, adapters 23, api-types bindings, services 11 end-to-end) |
| `cargo clippy --workspace --all-targets -- -D warnings` | clean; `unwrap`/`expect`/`panic` denied outside tests |
| `cargo build -p wallet-wasm --target wasm32-unknown-unknown` | ok |
| TypeScript bindings | regenerated into `frontend/packages/types/src` by `cargo test` |

## Crates

| Crate | Role | Status |
| --- | --- | --- |
| `wallet-core` | pure domain: tx decoder, 8 risk rules + scorer, hash-chained log, Ed25519 receipts | ✅ |
| `sq-adapters` | pseudo-blockchain, `ChainBackend` trait + registry, log store, signer, fixture signals, clocks | ✅ |
| `api-types` | HTTP DTOs → TS (`#[derive(TS)]`) | ✅ |
| `wallet-wasm` | `WalletCore { assess, build_entry, verify_log, rule_ids }` | ✅ builds · ⬜ not yet packaged with `wasm-pack` into the frontend |
| `sq-services` | Axum API, one module per capability | ✅ |

## Features

### Security claims (each backed by a test)

| Claim | Where | Status |
| --- | --- | --- |
| No tx without owner passkey **and** Swissquote co-signature | `chain/ledger.rs::submit` | ✅ |
| Server re-scores every request; never trusts the client's assessment | `assess.rs::cosign` | ✅ |
| Log is a hash chain; seq gap, wrong head, tampered entry, forged receipt all rejected | `log/mod.rs`, `receipt/mod.rs` | ✅ |
| Medium band needs a **verified** passkey step-up signature, not a flag | `assess.rs::step_up_hash` | ✅ |
| Known recipients derived from Swissquote's own records; client can add, not hide | `assess.rs::known_recipients` | ✅ |
| Escape hatch: owner-only, timelocked, exit address fixed, no Swissquote | `ledger.rs` | ✅ |
| Escape exit shows up as Critical in reconciliation | `reconcile.rs` | ✅ |
| Recovery: cancel during timelock beats execute; execute rotates owner on-chain with Swissquote co-sign | `recovery.rs`, `ledger.rs::rotate_owner` | ✅ |
| Log head anchored on-chain; rewritten log → `ANCHOR_MISMATCH` | `log.rs::anchor`, `reconcile.rs` | ✅ anchored · 🟡 mismatch path has no test yet |
| Bearer token required on every non-public route | `auth.rs::require_session` | ✅ (`SQ_REQUIRE_AUTH=0` to disable) |
| WebAuthn P-256 signatures verified like an on-chain verifier would | `chain/auth.rs` | ✅ unit-tested · ⬜ not yet exercised from a real browser |

### Multi-chain ("one wallet, many mini-wallets")

| Item | Status |
| --- | --- |
| `ChainBackend` trait: identity, accounts, prepare/simulate/submit, escape hatch, rotation, reads, anchor | ✅ |
| `ChainRegistry` keyed by chain id; services only see `dyn ChainBackend` | ✅ |
| Register creates one account per chain; `/wallet/overview` aggregates; `/chains` lists | ✅ |
| `MockChain` (EVM-style account model) as the only backend | ✅ |
| Second backend (e.g. UTXO mock) to prove the seam | ⬜ deliberately not built; estimate ≈ 3 h for a mock |
| Chain-tagged address / asset types in `wallet-core` (today `Address` is 20-byte EVM) | ⬜ the one core change a non-EVM backend needs |
| Audit log keyed per `(chain, address)` instead of per address | ⬜ fine while all chains share EVM addresses |
| Real Base Sepolia backend (Alloy RPC + bundler + paymaster) | ⬜ optional; implements the same trait |

### API surface

| Group | Endpoints | Status |
| --- | --- | --- |
| Auth | `POST /auth/session` | ✅ mock credentials from fixtures |
| Ownership | `GET /ownership/challenge`, `POST /wallet/register`, `POST /wallet/overview` | ✅ |
| Risk | `POST /assess`, `POST /cosign` (cosigned / step_up / held / refused) | ✅ |
| Holds | `GET /holds/{id}`, `POST /holds/{id}/justify` | ✅ mock compliance reviewer |
| Log | `GET /log/{address}`, `POST /log/{address}/anchor` | ✅ |
| Recovery | `POST /recovery/start`, `GET /recovery/{id}`, `POST …/cancel`, `POST …/execute` | ✅ |
| Reconcile | `POST /reconcile/{address}` | ✅ |
| Chain | `GET /chains`, `/chain/info`, accounts, faucet, prepare, simulate, submit, escape, history, blocks, tx | ✅ |
| Dev | `POST /dev/passkeys`, `GET /dev/passkeys`, `POST /dev/passkeys/{name}/sign`, `POST /dev/reset` | ✅ off with `SQ_DEV_SIGNER=0` |

### Operations

| Item | Status |
| --- | --- |
| Config from env + `fixtures/` (`SQ_PORT`, `SQ_FIXTURES_DIR`, `SQ_SIGNING_SEED`, `SQ_LOG_SNAPSHOT`, `SQ_DEV_SIGNER`, `SQ_REQUIRE_AUTH`) | ✅ |
| Audit-log JSON snapshot on every append | ✅ (opt-in) |
| Chain, holds, recoveries persist across restarts | ⬜ in memory only; `/dev/reset` needs `SQ_SIGNING_SEED` set |
| Request-id on every span | ⬜ |
| Hold expiry sweeper | 🟡 lazy (status flips to `Expired` on read) |
| Docker / one-command run | ⬜ |

## Open decisions and known gaps

- **Band thresholds** (25 / 50 / 80) and rule points are my proposal; the design doc the specs cite is not in the repo.
- **Co-signature is Ed25519** on the pseudo-chain. A real EVM account would need secp256k1 from the same key hierarchy; the trait hides this, the signer does not yet.
- **Sessions are not bound to wallets.** Any logged-in client can call any address. Binding `client_id ↔ owner key` at register is a small follow-up.
- **Step-up with WebAuthn**: the step-up hash goes in the WebAuthn challenge exactly like `user_op_hash`; untested from a browser.
- **Receipts for held/refused entries** exist and are signed; the client should still append them so its log matches the server's.

## Next (in order)

1. Bind session → owner key at register; reject calls for other wallets.
2. Test the `ANCHOR_MISMATCH` path (rewrite a snapshot, reconcile).
3. `wasm-pack build` into `frontend/packages/core-wasm` when P3 asks.
4. Chain-tagged address/asset in `wallet-core`, then a UTXO mock backend if time allows.
5. Request ids, persistence of chain state.
