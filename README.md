# Swissquote Wallet (Ferrata)

A bank-grade self-custody wallet: a passkey smart account where every transaction is
risk-scored, **co-signed by Swissquote**, written to a hash-chained audit log with
Swissquote-signed receipts, and recoverable through a timelocked, cancellable flow.
Swissquote can refuse to co-sign but can never move funds.

The demo runs on the **Ferra chain**, a tamper-evident pseudo-blockchain that enforces the same
rules a real smart account would and records the wallet's activity on every network (Ethereum,
Bitcoin, Solana, TON, Sui, …) as attested events, each with a feature vector for the validator. Every state change is a signed event, every block commits to a state root
and carries a validator signature, and the whole chain can be replayed and re-verified from its
append-only block file.

Three people, three layers:

| Who | Layer | Folder | Spec / status |
| --- | --- | --- | --- |
| P1 | Rust: domain engine, pseudo-blockchain, WASM facade, Swissquote services | `backend/` | `implementation/… Rust Spec.md`, `backend_timeline.md` |
| P2 | Extension UI (Lit, MV3) | `frontend/` | `implementation/… Frontend Spec.md` |
| P3 | TS SDK, background worker, passkey/chain adapters, legal | `frontend/` | `implementation/… Middleware Spec.md` |

Ideas for the chain visualiser and the real-chain connector live in `future_implementation.md`.

## Using the backend

### Run

```sh
cd backend
cargo run -p sq-services                       # http://localhost:8787, in-memory chain
SQ_CHAIN_FILE=../chain.jsonl cargo run -p sq-services   # persisted, replayed + verified on start
cargo test --workspace                         # 138 tests; also regenerates frontend/packages/types/src
cargo clippy --workspace --all-targets -- -D warnings
wasm-pack build wallet-wasm --target web --release --out-dir ../../frontend/packages/core-wasm
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `SQ_PORT` | `8787` | listen port |
| `SQ_FIXTURES_DIR` | `../fixtures` | demo world: accounts, policy, sanctions, exposure graph, KYC scripts, chain seed |
| `SQ_SIGNING_SEED` | random | 32-byte hex seed of Swissquote's receipt + co-signing key. Set it for restarts and `/dev/reset` |
| `SQ_VALIDATOR_SEED` | derived from signing seed | seed of the chain's block-signing key |
| `SQ_CHAIN_FILE` | none (memory) | append-only JSON-lines block file. Edit one byte and the server refuses to start |
| `SQ_LOG_SNAPSHOT` | none | JSON mirror of the audit logs |
| `SQ_REQUIRE_AUTH` | `1` | bearer token from `/auth/session` on every non-public route; wallets are bound to the client that registered them |
| `SQ_DEV_SIGNER` | `1` | mock passkeys and demo helpers under `/dev` |

Public routes (no token): `/auth/session`, `/chains`, everything under `/chain/*`, `/dev/*`.

### The demo flow in six calls

Hashes and amounts are `0x` hex strings; numbers are JSON numbers. Send the session token as
`Authorization: Bearer <token>`.

```text
1. POST /auth/session        { username: "alice", password: "demo" }        → { token, client_id }
2. GET  /ownership/challenge                                                 → { challenge }
   POST /wallet/register     { owner, challenge, signature }                 → { address, account, accounts[] }   (one account per chain)
3. POST /chain/faucet        { address, asset: USDC|null, amount }           → { tx_hash, block_number }
4. POST /assess              { tx, account? }                                → { action, assessment, signals, prepared: { user_op_hash, nonce }, next_seq, head }
5. POST /cosign              { tx, user_op_hash, seq, prev_head, step_up?, account? }
                                                                             → { kind: "cosigned", entry, cosignature }
                                                                             | { kind: "step_up", entry, step_up_hash }   → sign step_up_hash with the passkey, resend with step_up
                                                                             | { kind: "held", entry, hold_id }          → POST /holds/{id}/justify { text } → { cosignature, release_entry }
                                                                             | { kind: "refused", entry }
6. POST /chain/submit        { tx, nonce, owner_signature, cosignature }     → { tx_hash, block_number, kind }
```

The owner signs `user_op_hash` with the passkey. Two signature shapes are accepted:
`{ kind: "ed25519", signature }` (fast fake passkey, e.g. `@noble/ed25519`) and
`{ kind: "webauthn", authenticator_data, client_data_json, signature }` straight from
`navigator.credentials.get` with `challenge = user_op_hash` bytes.

**Mock passkeys while WebAuthn is not wired:** `POST /dev/passkeys { name }` returns an owner key
and address; `POST /dev/passkeys/{name}/sign { hash }` returns an owner signature. Deterministic
per name, in-memory only.

### Demo addresses (from `fixtures/`)

| Send USDC to | Band | Why |
| --- | --- | --- |
| an address the account already paid, or one in `account.known_recipients` | Low | nothing fires |
| any new address, small amount | Low | `NEW_RECIPIENT` (20) |
| any new address, more than 1000 USDC | Medium → step-up | `LARGE_AMOUNT` + `NEW_RECIPIENT` (45) |
| `0x…c0ffee` | High → hold | 2 hops from the mock mixer (`MIXER_EXPOSURE` 40 + 20) |
| `0x…dead` | Critical → refused | sanctions list (100) |
| unlimited `approve` from an unknown origin | High | `UNLIMITED_APPROVAL` 30 + `UNKNOWN_ORIGIN` 10 + 20 |

USDC is `0xaaaa…aaaa` (6 decimals). ERC-20 calldata is the standard `transfer(address,uint256)` encoding.

### Explorer, integrity and review

```text
GET  /chains                         every chain: id, head, state_root, cosigner, validator, tokens
GET  /chain/blocks?from=&limit=      blocks with their events (newest page when from is omitted)
GET  /chain/blocks/{n}  /chain/tx/{hash}  /chain/history/{address}  /chain/accounts/{address}
GET  /chain/verify                   replay the whole chain: { ok, blocks_checked, first_bad_block, reason, head, state_root }
POST /log/{address}/anchor           Swissquote co-signs the audit-log head onto the chain
POST /reconcile/{address}            chain-vs-log diff: unlogged txs, escape exits, anchor mismatches
POST /review/{address}               full account review → { verdict: clean|suspicious|blocked, score, flags[], chain }
POST /dev/tamper { tamper }          corrupt live state on purpose; then GET /chain/verify shows where
POST /dev/reset                      fresh chain + empty logs (needs SQ_SIGNING_SEED)
POST /chain/ingest                   record an event seen on another network (Swissquote-attested) → kind "external"
GET  /chain/dataset?from=&limit=     feature rows + flag labels for training the validator's model
GET  /model                          the loaded risk model (fixtures/model.json)
```

Every event carries `network` (family, name, chain id) and `features`: ~45 numbers describing
amount, timing, velocity, sender history, counterparty graph shape and the co-signer's verdict,
computed from the pre-state at commit. `backend/features.md` lists them with their rationale.
The review scores each event with the model and raises `MODEL_RISK` with the top contributions.

Every event (`ChainTx`) carries `version`, `timestamp`, `kind`, the signatures that authorised
it, an open `extra` map, and derived `flags`. Flags are their own append-only events, so adding
one never rewrites history. New fields default when missing, unknown fields are ignored: the
format is backward and forward compatible.

### Full endpoint list

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/auth/session` | mock login (`fixtures/accounts.json`) |
| GET | `/ownership/challenge` · POST `/wallet/register` · POST `/wallet/overview` | ownership proof, account on every chain, aggregated view |
| POST | `/assess` · `/cosign` | risk preview; co-sign decision (server re-scores, verifies step-up, derives known recipients) |
| GET | `/holds/{id}` · POST `/holds/{id}/justify` | hold review (mock compliance: ≥10 chars, no "fraud"/"urgent") |
| GET | `/log/{address}` · POST `/log/{address}/anchor` | audit log with receipts; anchor head on-chain |
| POST | `/recovery/start` · GET `/recovery/{id}` · POST `…/cancel` · POST `…/execute` | timelocked recovery; cancel needs the current owner's signature over `cancel_hash` |
| POST | `/reconcile/{address}` · `/review/{address}` | compliance views |
| GET | `/chains` · `/chain/info` · `/chain/verify` · `/chain/blocks` · `/chain/blocks/{n}` · `/chain/tx/{hash}` · `/chain/history/{address}` · `/chain/accounts/{address}` | explorer reads |
| POST | `/chain/accounts` · `/chain/faucet` · `/chain/prepare` · `/chain/simulate` · `/chain/submit` · `/chain/escape/{hash,start,cancel}` · `/chain/ingest` | chain writes |
| GET | `/chain/dataset` · `/model` | validator data and model |
| POST | `/dev/passkeys` · GET `/dev/passkeys` · POST `/dev/passkeys/{name}/sign` · POST `/dev/reset` · POST `/dev/tamper` | demo helpers |

Errors are always `{ code, message, details }`. Codes: `CORE_*` (`SEQ_GAP`, `CHAIN_BROKEN`,
`BAD_RECEIPT`, …), `CHAIN_*` (`BAD_NONCE`, `BAD_OWNER_SIGNATURE`, `BAD_COSIGNATURE`,
`ESCAPE_LOCKED`, `TAMPERED`, …), `NOT_FOUND`, `UNAUTHORIZED`, `CONFLICT`, `BAD_REQUEST`.
Held and refused are 200s, not errors.

## Pseudo-blockchain rules

- An account is 2-of-2: owner passkey + Swissquote's Ed25519 key, fixed at creation. Address = last 20 bytes of `keccak(owner key)`.
- Every state change is an event: `account_created`, `faucet`, `cosigned`, `escape_start`, `escape_cancel`, `escape_exit`, `owner_rotation`, `anchor`, `flag`, `external`. Events store the signatures that authorised them; replay re-verifies every one. `external` events mirror activity observed on other networks and need Swissquote's attestation.
- One block per event. `block.hash` covers version, chain id, number, timestamp, parent, txs root and **state root**; the validator key signs it. The validator key is not the co-signer key.
- `user_op_hash = keccak("SQW-USEROP-v1" ‖ chain_id ‖ from ‖ to ‖ value ‖ keccak(data) ‖ nonce)`; co-signature = Ed25519 over `"SQW-COSIGN-v1" ‖ hash`.
- Escape hatch: owner-only start, timelock, then transfers only to the declared exit address, no Swissquote. Reconciliation and review flag it Critical.
- Owner rotation (recovery) needs only Swissquote's co-signature, after the service-side timelock.
- `verify` replays the chain from its own blocks and also compares the replayed state root with the live one, so an in-memory edit without an event is caught too.

## Backend layout

```text
backend/
├── wallet-core/      tx/ (decoder) · policy/ (rules, scorer) · log/ (hash chain) · receipt/ (Ed25519 verify)
├── sq-adapters/      chain/ (backend trait + registry, ledger, auth, store) · log_store · signer · signals · clock
├── api-types/        HTTP DTOs, #[derive(TS)]; re-exports core + chain types
├── wallet-wasm/      one #[wasm_bindgen] class: assess · build_entry · verify_log · rule_ids
└── sq-services/      main · config · state · error · auth · ownership · assess · holds · log · recovery · reconcile · review · chain · dev
                      tests/flow.rs: the whole demo through the router with a FixedClock
fixtures/             accounts · policy · sanctions · exposure-graph · kyc-scripts · demo-seed
```

## Rules of the house

- No private key, share or seed appears in any Rust parameter, field or log line. Exceptions, both labelled: the `/dev` mock-passkey keyring (off with `SQ_DEV_SIGNER=0`) and the chain's own validator key.
- `wallet-core` is pure. Time and external signals are passed in.
- No `unwrap` / `expect` / `panic!` outside tests; workspace lints deny them.
- Hold and refuse are `Ok(outcome)`, never `Err`.
- Only established crypto crates: `sha2`, `ed25519-dalek`, `p256`, `alloy-primitives` (keccak).
