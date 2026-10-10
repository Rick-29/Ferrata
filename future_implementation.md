# Future implementation

Ideas that are planned but not built. Each one says what it needs from the backend that exists
today, so whoever picks it up knows where to start. Backend status lives in `backend_timeline.md`.

## 1. Chain visualiser

A 2D view of the chain: blocks left to right, events inside them, accounts as lanes or nodes,
and colour as the signal. The backend already serves everything it needs.

**Data it reads (all public, no token):**

- `GET /chains` for the chains to draw and each one's head and state root.
- `GET /chain/blocks?from=&limit=` for pages of `{ block, txs[] }`. Poll the newest page, or
  diff `latest_block` from `/chain/info` to know when to fetch.
- `GET /chain/verify` for the integrity verdict and `first_bad_block`.
- `GET /chain/history/{address}` and `GET /chain/accounts/{address}` for the per-account lane,
  balances and the account's accumulated `flags`.
- `POST /review/{address}` to refresh the flags before drawing.

**Colour rules (proposal):**

| Signal | Colour | Source field |
| --- | --- | --- |
| block verified | neutral | `/chain/verify` ok and number < `first_bad_block` |
| block at or after the first bad block | red outline, striped | `first_bad_block`, `reason` as tooltip |
| event with a Critical flag | red fill | `tx.flags[].severity` |
| event with a High flag | orange | same |
| Medium / Low | yellow / grey | same |
| `escape_exit`, `escape_start` | purple edge | `tx.kind` |
| `anchor` | small chain-link glyph on the account lane | `tx.kind` |
| `flag` events | drawn as a badge on their `target`, not as their own node | `tx.extra.flag.target` |
| `owner_rotation` | key glyph | `tx.kind` |

**Money flow:** every `cosigned`, `faucet` and `escape_exit` event has `from`, `action.to` (or
`counterparty()`), `action.asset` and `action.amount`. Draw edges between address nodes weighted
by amount; the exposure graph in `fixtures/exposure-graph.json` can be overlaid so "2 hops from a
mixer" is literally visible. Hovering an edge shows the audit-log entry (`GET /log/{address}`,
match on `user_op_hash`) with its band and reasons.

**Tamper demo:** `POST /dev/tamper` with `{ kind: "tx_value" | "balance" | "block_parent" }`,
then re-poll. The visualiser should show the first red block within one refresh. `POST /dev/reset`
restores a clean chain.

**Stack suggestion:** a plain Vite page with D3 or Cytoscape for the graph and an SVG strip for the
blocks. Types come from `frontend/packages/types/src` (`BlockWithTxs`, `ChainTx`, `Flag`,
`ChainVerification`, `ReviewReport`). Keep it a separate page, not an extension view.

## 2. Real chain behind the same contract

The services only see `dyn ChainBackend`. A real-chain backend implements the same trait and is
registered next to the mock, so the wallet spans both and the visualiser reads both through the
same endpoints.

**`EvmChainBackend` (Base Sepolia first):**

- `prepare` builds an ERC-4337 user operation through an audited account SDK with paymaster data
  and returns its `userOpHash` and nonce.
- `submit` wraps the owner's WebAuthn signature and Swissquote's signature into the account's
  2-of-2 validator format and sends to the bundler; returns the user-op hash, then the receipt.
- `history`, `block`, `blocks`, `tx` read through an Alloy provider and map logs and receipts into
  `ChainTx` with `kind` inferred from the account's events; `flags` still come from the mock
  ledger's flag index, or from a sidecar store.
- `verify` cannot replay a public chain; return `ok` with the provider's latest block hash and
  leave `first_bad_block` empty. Tamper evidence on a public chain is the chain itself.
- `anchor` writes the log head to a tiny registry contract (one `event Anchored(address, bytes32)`).
- Escape hatch and rotation map to the account's own module calls.

**Co-signer key:** the pseudo-chain verifies Ed25519. A real EVM account needs secp256k1. Put a
`SignatureScheme` behind `ReceiptSigner` with Ed25519 (receipts), secp256k1 (on-chain
co-signature) and later hybrid Ed25519 + ML-DSA for long-lived receipts.

**Address type:** `wallet-core::Address` is 20 bytes. A UTXO backend needs a chain-tagged address
and asset id; that is the one core change outside the trait.

**Reading an address the wallet does not own:** the visualiser's "where did this money come from"
question on a real chain is a graph walk over `history` of counterparties. Cap the depth, cache
per address, and reuse the exposure BFS already in `sq-adapters::signals`.

## 2b. Connectors feed the Ferra chain

**Status: the connectors exist** (`backend/sq-connectors`: TON, Bitcoin, Base Sepolia behind
`NetworkSource`) and `POST /chain/sync` pulls one page on demand. What is left is the scheduler.
Rather than teaching the visualiser every RPC, each network gets a small watcher that polls (or
subscribes to) the wallet's addresses and posts `IngestRequest`s to `POST /chain/ingest`. The Ferra
chain then holds one attested, feature-rich, reviewable timeline across Ethereum, Bitcoin, Solana,
TON and Sui, and the visualiser reads only Ferra. Start with an Alloy-based Base Sepolia watcher
(ERC-20 `Transfer` logs plus native transfers), then Bitcoin via a public Esplora API. Fees go in
`ExternalRef.fee`; the chain fills `features.fee` from it.

## 3. Account review as a workflow

Today `POST /review/{address}` runs once and writes flags. Next: a review record with a status
(`open`, `cleared`, `escalated`), a human note, and a `Flag` with source `manual` when an officer
overrides. "Merge back with Swissquote" after an escape-hatch exit becomes: owner cancels the
escape (signed), review returns `clean`, Swissquote records a `manual` clearance flag, and
co-signing resumes. Nothing in the chain changes; it is state on top of flags.

## 4. Post-quantum receipts

A `SignatureScheme` trait with `Ed25519` and `HybridEd25519MlDsa65` implementations (RustCrypto
`ml-dsa`, pure Rust, should build for wasm), selected by `SQ_SIG_SCHEME`. Receipts are the only
artifacts that must verify in ten years, and Swissquote controls both ends, so this is where
post-quantum earns its place. Passkeys stay P-256 until WebAuthn offers more.

## 5. Smaller items

- Merkle state root (per-account proofs) instead of the sequential commitment.
- A second validator and a two-signature block rule, so "Swissquote cannot rewrite the chain alone" becomes literally true.
- Block batching (several events per block) once the visualiser can group them.
- `GET /chain/events?since=<block>` long-poll for the visualiser instead of paging.
