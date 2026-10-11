# Ferra Visualizer — design prompt

Paste everything below this line into Figma Make / Claude Design. It describes the product, the
screens, the interaction model and the exact data the app receives, so the design can use real
field names and real states.

---

## What to design

A desktop app (Tauri: Rust backend, web UI in a native window, macOS + Windows) for Swissquote
compliance admins. It opens a **Ferra chain file** (a self-contained NDJSON file describing a
wallet's whole history) and does two things:

1. **Automatic mode**: validates the chain and produces a full report (integrity, validation
   percentage, risk distribution, the events to look at first).
2. **Manual mode**: a 2D, zoomable, pannable canvas where the chain is drawn as bubbles and
   links, coloured by predicted risk, time running left (old) to right (recent). Clicking a
   bubble expands it with its details and the related events.

The goal is "at a first glance, which transfers deserve attention". Clean, calm, data-dense but
not noisy. Think a mix of a block explorer, a trading terminal and a graph tool. Dark theme first
(canvas work), light theme optional. Brand: Swissquote (red accent `#D4001A`, neutral greys,
white type). Risk colours are fixed and must stay readable on both themes:

| Band | Colour | Meaning |
| --- | --- | --- |
| Low | green `#2EB67D` | checked, nothing found |
| Medium | amber `#F2B134` | second passkey confirmation was required |
| High | orange `#F26B1D` | explicit risk acceptance + second signature |
| Critical | red `#E3242B` | refused (sanctions) or scam evidence |
| unvalidated | grey `#6B7280` | no verdict yet |
| integrity failure | magenta `#C026D3` | the file was edited: hash mismatch |

## Context: what the Ferra chain is

Swissquote offers a self-custody wallet: the user holds a passkey, every transaction is
risk-scored and **co-signed by Swissquote** (which can refuse but can never move funds). The
**Ferra chain** is Swissquote's own tamper-evident ledger of everything that happened to a
wallet: native transfers on the Ferra chain, mirrors of transfers the same user made on other
networks (TON, Ethereum, Sepolia, Bitcoin, Solana), the user's settings changes, intentions
(what they composed before signing, including cancels), flags written by validators, and
community reports about addresses. Every event is hashed, every block is signed by the chain's
validator key, and the file replays from genesis: editing one byte anywhere makes verification
fail at that block.

Two kinds of files exist: **demo chains** (seeded from real public testnet/mainnet history around
one simulated owner) and **real chains** (produced by the live service). The app treats them the
same.

### File format (NDJSON, one JSON object per line)

Line 1 is a `header` record, every other line a `block` record:

```json
{"record":"header","format":"ferra-chain","format_version":1,"chain_id":84532,
 "network":{"family":"ferra","name":"ferra","chain_id":84532},
 "cosigner":"<hex ed25519 key>","validator":"<hex ed25519 key>",
 "tokens":[{"address":"0xaaaa…","symbol":"USDC","decimals":6}],"escape_delay_secs":120,"genesis_time":1769736684}
{"record":"block","block":{"version":1,"number":341,"timestamp":1791657572,"hash":"0x…","parent_hash":"0x…",
 "tx_hashes":["0x…"],"txs_root":"0x…","state_root":"0x…","validator_signature":"0x…"},"txs":[ …events… ]}
```

Blocks are small (usually one event each), so the chain is effectively a time-ordered list of
events. A demo chain has 300 to 700 blocks; a real one grows unbounded.

### Event (`ChainTx`) — the thing a bubble represents

```
hash            0x… (32 bytes)          unique id
block_number    number                  position on the chain (x axis)
timestamp       unix seconds            real time of the event (also x axis; choose one in a toggle)
kind            see below               bubble shape / icon
from, to        0x… Ferra addresses     the wallet is one of them; 0x000…0 means "system"
value           hex amount              size of the bubble (log scale), per asset
action          { kind, target, asset?, amount, counterparty? }   decoded intent
network         { family, name }        ferra | ton | ethereum | bitcoin | solana …  → small network badge
risk_level      Low|Medium|High|Critical|null   what the WALLET's policy said when it was signed
reviewed_risk   Low|Medium|High|Critical|null   what VALIDATORS concluded afterwards (max of flag severities)
flags           [Flag]                  the findings (see below)
features        TxFeatures (~60 numbers) what the risk model saw; shown in the detail panel, never on the canvas
extra           kind-specific payload (external ref, settings, intent, flag, report)
```

**Bubble colour = `reviewed_risk`, falling back to `risk_level`, falling back to grey.** When both
exist and disagree (wallet said Low, validator said High) show a thin outer ring in the
`risk_level` colour: that disagreement is exactly what an admin wants to see.

### Event kinds (`kind`)

| kind | meaning | canvas treatment |
| --- | --- | --- |
| `account_created` | wallet registered | small hollow circle at the start |
| `faucet` | demo funding | small, muted |
| `cosigned` | a transfer the owner signed and Swissquote co-signed | the main bubble type |
| `escape_exit` | owner left through the escape hatch with no Swissquote signature | diamond, always highlighted |
| `escape_start` / `escape_cancel` | timelock started / cancelled | small marker on the timeline |
| `owner_rotation` | recovery: passkey replaced | small marker |
| `external` | a transfer on another network (TON, ETH, BTC, SOL) attested by Swissquote | bubble with the network badge; `extra.external` holds `{network, tx_id, from_raw, to_raw, asset_symbol, decimals, amount, fee, explorer_url, timestamp}` |
| `settings_changed` | owner changed their own limits / allowlist | small marker |
| `intent` / `intent_outcome` | what the user composed before signing, and whether it was submitted, cancelled, refused or abandoned | not bubbles: shown as a faint "ghost" bar under the event they led to; cancels are a behavioural signal |
| `flag` | a validator finding about an earlier event | not a bubble: it attaches to its target event (`extra.flag.target`) |
| `anchor` | the audit-log head co-signed onto the chain | tiny tick |
| `address_report` | someone reported an address as a scam | not a bubble: it is a badge on every event whose counterparty is that address |

Only `cosigned`, `escape_exit` and `external` are **validatable** (need a verdict). The others
are context.

### Flags (the findings on an event)

```
{ code: "MODEL_RISK" | "PROVENANCE" | "VALIDATED" | "REPORTED_ADDRESS" | "REPORTED_COUNTERPARTY" |
        "SANCTIONED_COUNTERPARTY" | "SCAM_COUNTERPARTY" | "MIXER_EXPOSURE" | "POLICY_REASONS" |
        "CANCEL_STREAK" | "SETTINGS_THEN_RETRY" | "BEHAVIOUR_DEVIATION" | "DORMANT_BURST" |
        "OWN_LIMIT_BYPASS" | "CHAIN_TAMPERED" | "UNLOGGED_TX" | …,
  severity: Low|Medium|High|Critical,
  source: policy | reconciliation | review | integrity | model | behaviour | provenance | manual | report,
  message: "human sentence",
  at: unix seconds,
  target: 0x… (the event),
  data: { score?, top?: [[feature, contribution]…], reasons?, counterparty?, exposure_path?, reports? } }
```

`VALIDATED` with severity Low means "checked, clean". A validatable event with no flag from a
validator source (`review`, `provenance`, `model`, `behaviour`, `manual`) is **pending**.

### Validation status

```
{ validatable: 333, validated: 333, percent: 100.0, pending: 0, next: ["0x…", …] }
```

### Integrity verification

```
{ ok: true|false, blocks_checked, txs_checked, first_bad_block: number|null, reason: string|null, head: 0x…, state_root: 0x… }
```

When `ok` is false, everything from `first_bad_block` onward is untrusted: draw it in magenta
and put a hard vertical "break" line on the canvas at that block.

### Reports available per event (for the detail panel)

- **Transfer report** (`POST /report/event/{hash}`, for `external` events): the counterparty
  researched on its origin network. `{ from_info, to_info (name, labels, balance, tokens, is_scam),
  transfers: [{ event, related[], funding[] (where the money came from), funding_coverage, risk }],
  receiver_provenance: { score, risk, reasons[{code, points, message}], exposure{hops, path} },
  max_risk, elapsed_ms, notes[] }`.
- **Risk** on each transfer: `{ heuristic_score 0..100, band, reasons[{code, points, message}],
  model: { name, score 0..1, above_threshold, top: [[feature, contribution]] }, combined, features }`.
- **Risk preview** (`POST /risk/preview`, for any address before paying it): `{ probability,
  baseline_probability, odds_vs_baseline, band, factors: [{ code, odds_multiplier, message }],
  summary: "This transfer is 46.7× riskier than a typical one: the recipient forwards what it
  receives (×5.0), moves 83% of your balance (×4.5); in its favour, your wallet is 231 days old (×0.4)." }`.
- **Wallet profile** (`GET /profile/{address}`): archetype (new | holder | buyer | seller |
  trader | dormant), activity level, age, counts, mean / p95 payment, hour histogram (24
  buckets), distinct recipients, cancel rate, settings changes.
- **Address reports** (`GET /reports/address`): `[{ network, address, count, categories, first_at, last_at }]`.
- **Dataset** (`GET /chain/dataset`): one feature row per event with its label, for export.

### Where the data comes from

The Tauri backend can run fully **offline** on a file: open, verify, list events, validation
status, profiles and behaviour findings (this is what the `ferra-verify` CLI does today). The
**online** parts (transfer reports, provenance, risk preview, the automatic validation worker
that writes flags) talk to the Swissquote service over HTTP (`localhost:8787` in dev) which
holds the same chain. The UI should make the online / offline state visible but never block on
it: the canvas works from the file alone.

## Screens

### 1. Open

- Drop zone / "Open chain file…" button, plus two sample chips: **Demo testnet** (TON testnet +
  Sepolia, 333 events) and **Demo mainnet** (TON, Ethereum, Bitcoin, Solana, 490 events), and
  **Connect to service** (URL field, default `http://localhost:8787`).
- Recent files list with chain id, network, block count, last verified result (green tick /
  magenta cross), last opened.

### 2. Automatic mode: "Validation report"

Runs as soon as a file opens. Top to bottom:

1. **Header strip**: file name, chain id, network, blocks, events, genesis date → last event
   date, cosigner and validator key fingerprints (first 8 hex chars, copy on click).
2. **Integrity card**: big state (VERIFIED / TAMPERED), `blocks_checked`, `txs_checked`, head
   hash, state root; when tampered: the block number, the reason sentence, and a "jump to block
   on canvas" button.
3. **Validation card**: ring or bar for `percent`, counts validatable / validated / pending.
   When connected to the service: a live "worker" line (passes, events checked, flags written,
   retrying, last error) and a "Validate now" button that calls `POST /validator/run`. Progress
   updates every few seconds; events move from grey to coloured on the canvas as they are judged.
4. **Risk distribution**: stacked bar Low / Medium / High / Critical / pending, by count and by
   value; a second bar per network.
5. **Attention list**: the events sorted by `reviewed_risk` desc, then value desc. Each row:
   colour chip, date, kind, network badge, amount + asset, counterparty (short), flag codes as
   small tags, "open on canvas" arrow. Filters: band, network, kind, flag code, date range,
   counterparty search. This list is the product's answer to "where do I look first".
6. **Flag summary**: a table of flag codes with counts and the share of events (e.g.
   `VALIDATED 306 · PROVENANCE 36 · MODEL_RISK 27 · SCAM_COUNTERPARTY 3`).
7. **Wallet profile**: archetype badge, activity, age, out/in counts and volumes, mean / p95
   payment, the hour histogram as a 24-bar sparkline, cancel rate, settings changes, and the
   behaviour findings (CANCEL_STREAK, DORMANT_BURST…) as cards.
8. **Reported addresses**: list with count, categories and the events involved.
9. **Export**: the report as PDF / JSON; the dataset as CSV / JSON.

### 3. Manual mode: "Chain canvas"

The main screen. A full-window canvas with a floating toolbar and a right-hand detail panel
that slides in.

**Layout rules**

- X axis = time (toggle: by block number, evenly spaced; or by timestamp, true gaps). Oldest on
  the left, newest on the right. A time ruler along the bottom with adaptive ticks (hours /
  days / months as you zoom). Genesis at the far left.
- Y axis = **lane**. Default lanes: one per network (`ferra`, `ton`, `ethereum`, `bitcoin`,
  `solana`…), the wallet's own Ferra lane in the middle. Alternative lane modes: by
  counterparty (one lane per distinct counterparty, sorted by risk), by kind.
- Bubble = one validatable event. Radius ∝ log(amount in units) within its asset, with a
  minimum so tiny ones stay clickable. Fill = risk colour (see table), outer ring = wallet's
  `risk_level` when it disagrees, grey = pending. A small network badge at the top-right of
  external bubbles; a diamond outline for `escape_exit`.
- Links (thin lines or curves):
  - **chain order** between consecutive validatable events (faint, always on),
  - **same counterparty**: events sharing a counterparty are connected when one is selected or
    hovered (brighter, in the risk colour of the worst event in the group),
  - **flag → target**: a dotted link from the small flag markers to their event (only when
    "show flags as markers" is on),
  - **intent ghosts**: a faint bar under a `cosigned` bubble showing the intents that preceded
    it; cancelled attempts as small red ticks on that bar.
- Non-bubble events (settings, escape start/cancel, rotation, anchor, address report) are
  small markers on a thin "wallet timeline" rail at the bottom of the Ferra lane. Hovering shows
  what changed.
- Integrity break: a vertical magenta line at `first_bad_block`; everything to the right is
  drawn desaturated with a magenta hatch.

**Interaction**

- Pan (drag / two-finger), zoom (wheel / pinch) centred on the cursor, fit-to-view, "jump to
  newest", mini-map in a corner showing the whole chain with the current viewport.
- Hover a bubble: tooltip with date, kind, amount + asset, counterparty short, `risk_level` →
  `reviewed_risk`, flag codes.
- Click a bubble: it **expands in place** (grows, pushes neighbours slightly) and the right
  panel opens with:
  1. identity: hash (copy), block, date, network, explorer link for externals,
  2. parties: from → to, counterparty with its reports count and labels, "preview risk of paying
     this address again" button (calls the risk preview and shows the odds sentence),
  3. verdicts: the wallet's `risk_level` and the validators' `reviewed_risk`, side by side,
  4. flags: one card per flag (severity colour, source, message, `data.top` as a tiny
     horizontal bar list of feature contributions when present, exposure path when present),
  5. related events on the chain: every other event with the same counterparty, and the
     intents that led to this one, each row clickable (the canvas pans to it and highlights the
     link),
  6. transfer report (online): funding sources with coverage, counterparty account info,
     provenance reasons with points,
  7. features (collapsed): the full `TxFeatures` as a key/value grid, searchable.
- Multi-select (shift-click or lasso): the panel shows the aggregate (count, total value, worst
  band) and the union of counterparties; "export selection".
- Search box (hash, address, amount, flag code) jumps and highlights.
- Filters mirror the attention list; filtered-out bubbles dim rather than disappear, so the
  shape of the chain is preserved.
- Legend (collapsible) with the colour table and the shapes.
- Keyboard: `F` fit, `N` newest, `←/→` previous/next event by time, `↑/↓` by risk, `Esc` close
  panel, `/` search.
- Performance target: 5 000 bubbles at 60 fps (canvas / WebGL, not DOM nodes), level-of-detail
  when zoomed out (bubbles merge into risk-coloured density bars per lane).

### 4. Compare (nice to have)

Two files side by side (e.g. a chain before and after validation, or demo vs real): same
canvas, synchronised scroll and zoom, differences in flags highlighted.

## Component inventory

Top bar (file name, mode switch Automatic | Canvas, connection state pill, verify button),
floating canvas toolbar (lane mode, x-axis mode, flag markers toggle, intents toggle, legend,
fit, mini-map), right detail panel (tabs: Overview · Flags · Related · Report · Features), risk
chip, network badge (ferra, ton, ethereum, bitcoin, solana, sepolia), flag card, event row,
distribution bar, hour histogram sparkline, profile card, empty states (no file, verifying,
tampered, offline), toasts for worker progress.

## Copy and tone

Short, factual, no alarm language beyond the colour. "Checked, nothing found" rather than
"safe". Hashes and addresses truncated `0x7c55…ab51a` with copy on click. Dates absolute in the
admin's timezone with relative hint on hover ("12 Oct 2026 20:07 · 3 days ago").

## Deliverables wanted from the design

1. Open screen, 2. Validation report (desktop, 1440 wide), 3. Canvas with the detail panel
open on a High event showing flags and related events, 4. Canvas zoomed out showing
level-of-detail density bars and the mini-map, 5. Tampered state, 6. Component sheet with the
risk colour system and all badges, dark and light.
