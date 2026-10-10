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
cargo test --workspace                         # 147 tests; also regenerates frontend/packages/types/src
cargo run -p sq-connectors --bin ferra-verify -- ../chain.jsonl --events --behaviour   # verify a chain file with nothing else
cargo run -p sq-connectors --bin ferra-verify -- ../chain.jsonl --provenance           # … and check external counterparties on their networks
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
5. POST /cosign              { tx, user_op_hash, seq, prev_head, step_up?, accepted_risk, account? }
                                                                             → { kind: "cosigned", entry, cosignature }
                                                                             | { kind: "step_up", entry, step_up_hash, level: "standard" }  → passkey signs step_up_hash, resend with step_up
                                                                             | { kind: "step_up", entry, step_up_hash, level: "high_risk" } → user ticks "I understand the risks", passkey signs,
                                                                                                                                              resend with step_up + accepted_risk: true
                                                                             | { kind: "refused", entry, reason: "regulatory" }             → sanctions only; do not show the reasons
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
| any new address, more than 1000 USDC | Medium → second confirmation | `LARGE_AMOUNT` + `NEW_RECIPIENT` (45) |
| `0x…c0ffee` | High → warning + acceptance + second confirmation | 2 hops from the mock mixer (`MIXER_EXPOSURE` 40 + 20) |
| `0x…dead` | refused (regulatory) | sanctions list (100) |
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

### Chain file format and the standalone verifier

`SQ_CHAIN_FILE` is NDJSON: line 1 is a `header` record (format, chain id, network, co-signer and
validator public keys, tokens, escape delay, genesis time), every later line a `block` record with
its events. Append-only. The file is self-contained: `ferra-verify chain.jsonl --events` rebuilds the
chain from it, re-checks every hash, signature and state root, and prints one line per event with
`risk_level` (what the wallet computed at co-sign time, part of the hashed record) and
`reviewed_risk` (what the validator's flags imply, derived). Exit code 0 = intact, 1 = tampered.

### The owner's intentions and settings are on the chain too

```text
POST /settings/{address}/hash { settings }        → hash the owner signs (bound to the nonce)
POST /settings/{address} { settings, signature }  → settings_changed event (per_tx_limit_pct, daily_limit, step_up_above_pct,
                                                     intent_timeout_secs, hold_timeout_secs, allowlist, extra)
GET  /settings/{address}
POST /assess                                      → also records an `intent` event; the response carries intent_id
GET  /intents/{address}/{id}  ·  POST /intents/{address}/{id}/cancel   → intent_outcome events (submitted, cancelled,
                                                     step_up_required, held, refused, released are written automatically)
GET  /profile/{address}                           → WalletProfile: archetype (new/holder/buyer/seller/trader/dormant), activity,
                                                     amount distribution, hours, cancel rate, settings changes, current settings
POST /provenance/{tx_hash}                        → for an external event: the counterparty's standing on its origin network,
                                                     recorded as a PROVENANCE flag (also: POST /review/{address}?provenance=true)
```

The policy applies the owner's own per-transaction limit (`OWN_LIMIT_EXCEEDED`, 25 points). Risk
acceptance is recorded on the log entry (`risk_accepted`), the intent outcome (`risk_accepted`) and
the event features, so "warned and went ahead" is itself data for the model. Features
version 2 add profile-relative numbers (amount versus the user's mean and p95, cancel rate, cancels and
settings changes in the last 24 h, compose-to-submit latency, archetype). The review raises behaviour
flags: `CANCEL_STREAK`, `SETTINGS_THEN_RETRY`, `BEHAVIOUR_DEVIATION`, `DORMANT_BURST`, `OWN_LIMIT_BYPASS`.

### Connected networks

```text
GET  /networks                       networks the Ferra chain can pull from: ton-testnet, bitcoin-testnet, base-sepolia
POST /chain/sync                     { wallet, network, address_raw, limit?, cursor? } → fetch a page from that network's
                                     public indexer and record every new event as a Swissquote-attested "external" event
```

Connectors live in `backend/sq-connectors` behind one `NetworkSource` trait: TON via toncenter
(ported from NetView), Bitcoin via Esplora, EVM via Blockscout. Adding Solana, TON mainnet or Sui is
one struct that turns an indexer's rows into `ObservedEvent`s. `SQ_TONCENTER_API_KEY` raises TON
rate limits; `SQ_TON_NETWORK=mainnet` switches TON.

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
| GET | `/log/{address}` · POST `/log/{address}/anchor` | audit log with receipts; anchor head on-chain |
| POST | `/recovery/start` · GET `/recovery/{id}` · POST `…/cancel` · POST `…/execute` | timelocked recovery; cancel needs the current owner's signature over `cancel_hash` |
| POST | `/reconcile/{address}` · `/review/{address}` | compliance views |
| GET | `/chains` · `/chain/info` · `/chain/verify` · `/chain/blocks` · `/chain/blocks/{n}` · `/chain/tx/{hash}` · `/chain/history/{address}` · `/chain/accounts/{address}` | explorer reads |
| POST | `/chain/accounts` · `/chain/faucet` · `/chain/prepare` · `/chain/simulate` · `/chain/submit` · `/chain/escape/{hash,start,cancel}` · `/chain/ingest` | chain writes |
| GET | `/chain/dataset` · `/model` · `/networks` | validator data, model, connected networks |
| POST | `/chain/sync` | pull one network's history for a wallet onto the Ferra chain |
| GET/POST | `/settings/{address}` · `/settings/{address}/hash` | owner-signed wallet settings on-chain |
| GET/POST | `/intents/{address}/{id}` · `…/cancel` · GET `/profile/{address}` · POST `/provenance/{hash}` | intentions, profile, origin-network check |
| POST | `/dev/passkeys` · GET `/dev/passkeys` · POST `/dev/passkeys/{name}/sign` · POST `/dev/reset` · POST `/dev/tamper` | demo helpers |

Errors are always `{ code, message, details }`. Codes: `CORE_*` (`SEQ_GAP`, `CHAIN_BROKEN`,
`BAD_RECEIPT`, …), `CHAIN_*` (`BAD_NONCE`, `BAD_OWNER_SIGNATURE`, `BAD_COSIGNATURE`,
`ESCAPE_LOCKED`, `TAMPERED`, …), `NOT_FOUND`, `UNAUTHORIZED`, `CONFLICT`, `BAD_REQUEST`.
Step-up and refused are 200s, not errors. **Swissquote never holds or blocks on risk**: it warns,
asks for an explicit acceptance and a second passkey signature, and the user decides. The only
refusal is regulatory (sanctions), and its reasons are not shown to the user
(`implementation/… Positionnement légal du blocage.md`).

## Pseudo-blockchain rules

- An account is 2-of-2: owner passkey + Swissquote's Ed25519 key, fixed at creation. Address = last 20 bytes of `keccak(owner key)`.
- Every state change is an event: `account_created`, `faucet`, `cosigned`, `escape_start`, `escape_cancel`, `escape_exit`, `owner_rotation`, `anchor`, `flag`, `external`, `settings_changed`, `intent`, `intent_outcome`. Events store the signatures that authorised them; replay re-verifies every one. `external` events mirror activity observed on other networks and need Swissquote's attestation.
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
└── sq-services/      main · config · state · error · auth · ownership · assess · log · recovery · reconcile · review · wallet · chain · dev
                      tests/flow.rs: the whole demo through the router with a FixedClock
fixtures/             accounts · policy · sanctions · exposure-graph · kyc-scripts · demo-seed
```

## Rules of the house

- No private key, share or seed appears in any Rust parameter, field or log line. Exceptions, both labelled: the `/dev` mock-passkey keyring (off with `SQ_DEV_SIGNER=0`) and the chain's own validator key.
- `wallet-core` is pure. Time and external signals are passed in.
- No `unwrap` / `expect` / `panic!` outside tests; workspace lints deny them.
- Hold and refuse are `Ok(outcome)`, never `Err`.
- Only established crypto crates: `sha2`, `ed25519-dalek`, `p256`, `alloy-primitives` (keccak).
