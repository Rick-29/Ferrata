# Ferra Visualizer — Tauri backend

Rust side of the compliance desktop app. It opens a Ferra chain file, verifies it, and serves the
automatic report and the manual graph to the web UI through Tauri commands. The TypeScript bridge
with every command and type is `../src/lib/ferra.ts`.

## Run

```sh
cd app
pnpm install
pnpm tauri dev        # starts vite on :8443 and the native window
pnpm tauri build      # installer under src-tauri/target/release/bundle
cd src-tauri && cargo test            # offline pipeline over the demo chains
cd src-tauri && cargo test -- --ignored online --nocapture   # hits the public TON indexer
```

Optional environment for the indexers: `SQ_TONAPI_KEY`, `SQ_TONCENTER_API_KEY`, `SQ_SOLANA_RPC`,
`SQ_ESPLORA_BITCOIN` / `SQ_ESPLORA_BITCOIN_TESTNET` (your own Esplora host, tried before mempool.space
and blockstream.info), `SQ_CONCURRENCY_<NETWORK>` (requests in flight per network; defaults 2 for
Ethereum / Solana, 3 for Bitcoin, 4 elsewhere).
The demo chains, the risk model and the sanctions lists come from `../../fixtures` (bundled as
resources in a release build, read from the repo in dev).

## How it works

- `state.rs` — `open_file` parses the NDJSON, replays it with `MockChain::replay`. A tampered file
  still opens: the verified prefix becomes the chain, every event from `first_bad_block` on is kept
  with `trusted: false` so the canvas can draw the magenta break. Each event becomes an `EventView`:
  the `ChainTx` plus `effective_risk`, `pending`, `amount_units`, `counterparty` (as a graph node),
  `incoming`, `disagreement`. Wallet addresses on other networks are indexed as aliases of the
  wallet node.
- `report.rs` — automatic mode: header strip, integrity, validation, risk distribution (by count
  and by value per asset, per network, per kind), attention list (worst band first, then value),
  flag summary, wallet profile + behaviour findings, reported addresses with their events.
- `graph.rs` — manual mode. `expand_node(id)` returns one address's transfers newest first and
  the addresses on the other end; chain transfers come from the file in the first call, indexer
  history is paged through `next_cursor`. Expanding a returned node repeats the process, so the
  canvas can grow without bound. `node_insight(id)` is the sidebar: reports, flags grouped by code,
  escape exits, verdict disagreements, pending counts, plus (online) the model's risk preview with
  its odds sentence and factors.
- `online.rs` — the embedded connectors (TON, Sepolia/Base/Ethereum, Bitcoin, Solana), the
  `LinearModel` and the watchlists. Transfer reports, provenance checks and risk previews run in the
  app itself with nothing but internet access.
- `service.rs` — optional link to `sq-services` (`http://localhost:8787`): validator status polled
  every 4 s (`service://status` event), "validate now", and opening the chain over HTTP without a
  file.
- `commands.rs` — the `#[tauri::command]` surface; errors arrive as `{ code, message }`.

Node ids are `network:address` (`ferra:0x…`, `ton:0:…`, `bitcoin:bc1…`). `FileInfo.wallet_nodes`
gives the roots to start the graph from.
