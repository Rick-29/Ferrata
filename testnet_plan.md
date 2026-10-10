# Testnet plan: real blocks on the Ferra chain, real trades from the wallet

Goal: airdrop testnet SOL / ETH to the wallet, place a trade on a Solana devnet or Ethereum Sepolia
dApp, get the wallet's allow / deny prompt, then open the Ferra chain file with `ferra-verify` and
see the intent, the decision, the broadcast and the origin-network event. End goal: connect the
wallet to pump.fun (Solana).

Status after reading `implementation/` and `frontend/` on 2026-10-10:

- **Frontend** has the popup (onboarding, home, send, confirm) on a `FakeBridge`. There is no
  background worker, no SDK package, no injected provider, no approval window, no Activity or
  Settings screen, no WebAuthn. `UiBridge` is the only contract the UI needs.
- **Legal decision changed the product** (`Positionnement légal du blocage.md`): Swissquote never
  holds or blocks on risk; High and Critical warn and require the user's explicit acceptance plus a
  second passkey signature; the only refusal is regulatory (sanctions) and its reason is not shown.
  The backend still implements `held` for High. This is the first thing to fix, on both sides.
- **Backend** can already record anything on the Ferra chain and verify it, and can pull history from
  TON, Bitcoin and Base Sepolia. It cannot yet see a wallet's addresses on other networks by itself,
  has no Solana source, and has no way to link a real-network broadcast to the intent that produced it.

## How a real trade flows (target design)

```text
dApp page ──(injected provider: EIP-1193 or Solana wallet-standard)──▶ content script ──▶ background worker
background ──▶ POST /assess  (records an `intent`, returns band + intent_id)
background ──▶ opens approval window ──▶ user sees TxSummary + risk, allows / denies
   deny ──▶ POST /intents/{addr}/{id}/cancel                                         (intent_outcome: cancelled)
   allow ──▶ passkey signs user_op_hash (+ step_up_hash when asked, + risk acceptance when High)
         ──▶ POST /cosign ──▶ Swissquote co-signature + receipt                       (log entry, intent_outcome)
         ──▶ background signs the real-network transaction with the network key and broadcasts it
         ──▶ POST /chain/ingest { event: {network, tx_id, …}, linked: {intent_id, user_op_hash} }   (external event)
Ferra chain ──▶ ferra-verify --events --behaviour --provenance shows the whole story
```

Honest framing for the pitch: on real networks the co-signature gates the broadcast **inside the
wallet** (the background refuses to sign without a Swissquote receipt); on-chain 2-of-2 enforcement is
what the Ferra chain demonstrates and what a smart account would give later. Nothing is broadcast
without an `intent`, a co-signature and a receipt, and the Ferra chain records all three.

## Backend (P1) — in order

| # | Task | Why it is needed for the goal | Size |
| --- | --- | --- | --- |
| B1 | **Align the co-sign decision with the legal doc.** `/cosign`: Low → cosigned; Medium → `step_up` (level `standard`); High and non-regulatory Critical → `step_up` with level `high_risk`, which requires `accepted_risk: true` **and** the step-up signature on the retry; regulatory (any `SANCTIONED` reason) → `refused` without reasons in the payload. Record the acceptance in the log entry (`warnings`, `step_up`) and as the intent outcome. Remove the hold path from `/cosign` (keep the endpoints dormant or delete them). Update README, Rust spec, tests, fixtures. | The UI already implements this contract (`SendOutcome.confirmation_required.level`); the backend currently returns `held`. | 2 h |
| B2 | **Wallet addresses on other networks.** `POST /wallet/addresses { wallet, network, address_raw }` (owner-signed), `GET /wallet/addresses/{wallet}`. Stored as an on-chain event (`address_linked`) so the file stays self-contained. | The sync loop and the visualiser need to know which Solana / Sepolia addresses belong to the wallet. | 1 h |
| B3 | **Background sync loop.** Every `SQ_SYNC_SECS` (default 30) run `/chain/sync` for every linked address, following cursors. Log how many events landed. | This is what makes the chain write blocks by itself while you trade; `ferra-verify` then sees real data without manual calls. | 1 h |
| B4 | **Link broadcasts to intents.** `IngestRequest.linked: Option<{ intent_id, user_op_hash }>`; the external event carries it in `extra`, the intent gets a `submitted` outcome with the real tx id, and reconciliation matches external events to co-signed log entries by `user_op_hash`. | Without it the real trade and the Swissquote decision are two unrelated events on the chain. | 1.5 h |
| B5 | **Solana source** (`solana-devnet`): JSON-RPC `getSignaturesForAddress` + `getTransaction` (jsonParsed), native SOL and SPL token balance changes → `ObservedEvent`. Also register `eth-sepolia` (Blockscout `https://eth-sepolia.blockscout.com/api`). Env: `SQ_SOLANA_RPC`, `SQ_NETWORKS`. | pump.fun is Solana; Sepolia is the EVM fallback. | 2 h |
| B6 | **Assess for non-EVM / opaque transactions.** `POST /assess/external { wallet, network, from_raw, to_raw, asset_symbol, decimals, amount, program?, summary? }`: maps raw addresses to a stable 20-byte pseudo-address (`keccak(network:raw)[12..]`) so the policy, known-recipients and sanctions (raw list) work unchanged; returns the same `AssessResponse` + `intent_id`. `/cosign` accepts the same shape (`user_op_hash` = hash of the serialized unsigned transaction, supplied by the wallet). | Solana transactions are not EVM calldata; the policy must still score them and the chain must record the intent. | 2 h |
| B7 | **Hold cleanup in reconcile / review / features** after B1 (no `Held` outcome on new entries; keep reading old ones). | Consistency. | 0.5 h |
| B8 | **Push notifications to the extension**: `GET /events/stream` (SSE) emitting `external_event`, `flag`, `recovery_started` for the caller's wallets. | "the wallet giving me notifications" for inbound events and flags; dApp prompts do not need it (they come through the provider). | 1.5 h |
| B9 | **WebAuthn end-to-end check** from a real browser: register a P-256 owner, sign `user_op_hash` and `step_up_hash` as the challenge. The verifier exists; it has never seen a real authenticator. | Real passkeys instead of `/dev/passkeys`. | 1 h with P3 |
| B10 | Optional: `GET /chain/export` to download the chain file over HTTP, so `ferra-verify` can be run from any machine. | Convenience for the demo. | 0.5 h |

## Middleware (P3) — what the backend needs from the extension side

| # | Task | Notes |
| --- | --- | --- |
| M1 | **`@sqw/sdk` with `HttpSwissquoteApi`** over `http://localhost:8787`, bearer token from `/auth/session`, typed on `frontend/packages/types`. Replace `FakeBridge` in `popup/main.ts` with a bridge that talks to the background. | The six-call demo flow in the README is the contract. Keep `FakeBridge` for tests. |
| M2 | **Background service worker**: session state, the real `UiBridge` implementation, message router for the popup and the approval window. | `chrome.runtime` messaging; `host_permissions` already allow localhost. |
| M3 | **Network keys.** Generate per network in the background (secp256k1 for EVM via `viem`, Ed25519 for Solana via `@solana/web3.js`), store encrypted in `chrome.storage` (key wrapped with a passkey PRF secret or, for the demo, a device key). Register the addresses with B2. **Never send them anywhere.** | This is the honest shortcut until a smart account exists. The Ferra account owner stays the passkey. |
| M4 | **Passkey**: `navigator.credentials.create` at onboarding → `OwnerKey::P256` for `/wallet/register`; `navigator.credentials.get` with `challenge = user_op_hash` (and `step_up_hash`) for signing; send `{ kind: "webauthn", authenticator_data, client_data_json, signature }`. Runs in the popup / approval window, not the worker. | Backend verifies today. Fallback: `/dev/passkeys` while wiring. |
| M5 | **Injected providers**: EIP-1193 (`window.ethereum`, `eth_requestAccounts`, `eth_sendTransaction`, `personal_sign` / `eth_signTypedData_v4`, chain 11155111) and Solana wallet-standard (`connect`, `signTransaction`, `signAndSendTransaction`, `signMessage`). Content script relays to the background. | pump.fun uses wallet-standard / Phantom-style adapters. Start with EIP-1193 on Uniswap Sepolia if Solana adapter work drags. |
| M6 | **Approval window** opened by the background on every dApp request, mounting the existing `ConfirmScreen` with the `/assess` preview; allow → sign + cosign + broadcast; deny → cancel intent. | The screen exists; it needs a route and a bridge method `confirmExternal`. |
| M7 | **Broadcast then record**: after `sendRawTransaction` / `sendTransaction`, call `POST /chain/ingest` with `linked` (B4). Also `POST /chain/sync` once right after, so the confirmation lands fast. | Backend sync loop (B3) is the safety net. |
| M8 | Airdrops: Sepolia faucet (Alchemy / Google), Solana `solana airdrop 2 <addr> --url devnet` or the devnet faucet; show them in Home via `/wallet/overview` + linked addresses balances (backend B2 + a balance read per network, or just the explorer link). | |

## Frontend (P2)

| # | Task | Notes |
| --- | --- | --- |
| F1 | **Confirm screen for `high_risk`**: already implemented (`sq-risk-warning` + consent). Send `accepted_risk: true` with the retry once B1 lands. | |
| F2 | **Activity screen**: `GET /chain/history/{address}` + `GET /log/{address}`; show kind, network, `risk_level`, `reviewed_risk`, flags, receipt check mark, explorer link for external events. | This is where the user sees the Ferra chain. |
| F3 | **Settings screen**: `GET/POST /settings/{address}` with the hash step signed by the passkey; linked addresses (B2) with "copy address" for airdrops. | |
| F4 | **Notifications**: `chrome.notifications` on SSE events (B8) and when the approval window opens. | |
| F5 | Remove the demo chips' dependence on `fake-world` once the real bridge is in; keep them as fixtures. | |

## What you will be able to do, step by step

1. `cargo run -p sq-services` with `SQ_CHAIN_FILE=../chain.jsonl SQ_SIGNING_SEED=…` (after B1–B5).
2. Load the extension, log in, create the passkey wallet; the background creates the Sepolia and
   devnet keys and links them (B2). Copy the addresses from Settings (F3).
3. Airdrop: Sepolia ETH and devnet SOL to those addresses. Within 30 s the sync loop (B3) records
   the two inbound `external` events; the popup gets a notification (B8 + F4).
4. Open Uniswap on Sepolia (or a devnet Solana dApp), connect, swap. The approval window shows the
   risk preview; allow with the passkey; the background co-signs, broadcasts, records (M5–M7, B4).
5. Stop the server and run `ferra-verify ../chain.jsonl --events --behaviour --provenance`: intent,
   step-up, co-sign receipt in the log, the external event with the real tx id, the counterparty's
   standing on its network, and the behaviour profile.
6. pump.fun: same path through the Solana wallet-standard provider (M5) on mainnet with a tiny
   amount, once devnet works. pump.fun has no devnet, so this is the last step, not the first.

## Order of work for the next session

B1 → B2 → B3 → B5 (Solana + Sepolia) → B4 → B6 → B8, with P3 starting M1–M3 in parallel against
the existing endpoints, then M4–M7 once B1/B4/B6 are in. B9 whenever a browser is at hand.
