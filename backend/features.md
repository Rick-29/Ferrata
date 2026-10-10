# Ferra chain event features

Every event on the Ferra chain carries a `features` object (`TxFeatures`, version 1), computed at
commit time from the state *before* the event. It is stored on the event, exported by
`GET /chain/dataset`, scored by the validator's model and shown by the visualiser. It is not part
of the event hash, so the feature schema can evolve without breaking old chains; new fields default,
unknown fields are ignored, and `extra` takes ad-hoc numbers.

The selection is not invented. It follows what the published work on chain-based AML and payment
fraud actually uses, trimmed to what a wallet with one co-signer can observe:

- **Elliptic Bitcoin dataset** (Weber et al., "Anti-Money Laundering in Bitcoin", 2019): local
  features per transaction (amount, fee, in/out degree, time step) plus one-hop aggregates of the
  counterparties' local features. Our `sender_*` and `counterparty_*` blocks are that split.
- **FATF "Virtual Assets: Red Flag Indicators"** (2020): structuring just under thresholds,
  unusual velocity, dormancy followed by bursts, many new counterparties, round amounts,
  immediate pass-through of received funds, exposure to mixers and sanctioned entities.
- **Card and payment fraud practice**: hour of day, authentication strength, decision latency,
  origin of the request, account age, share of balance moved.

## Catalogue

| Group | Feature | Why it matters |
| --- | --- | --- |
| Context | `network` (family + name + chain id) | risk differs per settlement layer; lets one model span Ethereum, Bitcoin, Solana, TON, Sui and the Ferra chain |
| | `kind` | escape exits and rotations are structurally riskier than co-signed payments |
| | `signer_kind` (`ed25519` / `webauthn` / `none`) | a real passkey is stronger evidence of the user than a mock key |
| | `cosigned`, `step_up` | whether Swissquote and a second user gesture stood behind it |
| | `via_dapp`, `dapp_origin` | requests injected by a site carry phishing risk |
| Amount | `amount`, `asset_symbol`, `fee` | the obvious ones, in whole units |
| | `balance_before`, `fraction_of_balance` | draining most of a balance is the single strongest theft signal |
| | `is_round_amount` | humans type round numbers; scripts and layering often do not |
| | `share_of_lifetime_volume` | one event dwarfing everything before it |
| Timing | `hour_utc`, `weekday` | night and weekend activity outside the user's pattern |
| | `secs_since_sender_prev_tx` | dormancy then a burst |
| | `sender_age_secs` | fresh accounts behave differently and are hijacked more |
| | `decision_latency_secs` | prepare → signed submission; too fast means a script, too slow a coerced or confused user |
| | `sender_out_count_24h`, `sender_out_volume_24h`, `velocity_ratio` | velocity against the account's own baseline |
| Sender history | `sender_tx_count`, `sender_out_count`, `sender_in_count` | degree, as in Elliptic |
| | `sender_distinct_recipients`, `sender_out_volume` | spread and scale of past behaviour |
| | `sender_prior_flags`, `sender_prior_max_severity` | the account's own record |
| | `sender_escape_active`, `sender_rotations` | an open escape timer or recent key rotation is exactly when theft happens |
| Counterparty | `counterparty_is_account` | a Ferra account is identified and co-signed; an external address is not |
| | `counterparty_new_for_sender` | first payment to a destination |
| | `counterparty_tx_count`, `_in_count`, `_out_count`, `_distinct_senders` | the destination's degree: mule accounts collect from many senders |
| | `counterparty_first_seen_age_secs` | brand-new destination addresses |
| | `counterparty_prior_flags`, `counterparty_prior_max_severity` | the destination's record |
| | `reciprocal` | round-tripping between two parties |
| | `counterparty_fan_out_ratio` | destinations that immediately spread funds across many addresses |
| | `counterparty_pass_through` | forwarded ≥ 90 % of a receipt within 24 h at least once (layering) |
| Co-signer snapshot | `policy.score`, `policy.band`, `policy.reasons`, `policy.sanctions_hit`, `policy.exposure_hops` | what the rule engine concluded at the time; recorded, never trusted for enforcement |

`TxFeatures::to_vector()` flattens this into a `name → number` map: booleans become 0/1, optional
values get a sentinel plus a presence flag, categorical fields become one-hot (`family_bitcoin`,
`kind_escape_exit`, `signer_webauthn`), and a few logs are added (`amount_log`, `is_night`).

## The model

`RiskModel` is a trait; the only implementation today is `LinearModel`, a logistic regression over
the vector with per-feature transforms, loaded from `fixtures/model.json`. The shipped weights are
hand-set from the heuristics above. To replace them:

1. Run the demo for a while, review accounts so flags accumulate.
2. `GET /chain/dataset` → rows of `{ features, label, label_codes }`.
3. Train anything that outputs a weight per `to_vector()` key (sklearn `LogisticRegression` on the
   flattened dict is the obvious first step), write `bias`, `threshold`, `weights`, `transforms`
   back into `model.json`, restart. No code change.
4. The review raises `MODEL_RISK` (Medium ≥ threshold, High ≥ 0.85) with the top five
   contributions in `flag.data.top`, so the visualiser can explain the score.

A tree model or a tiny MLP fits behind the same trait when the linear one stops being enough.

## What is deliberately not here yet

- Prices and fiat value (no price feed in the demo). Amounts are per asset.
- Device, IP and geolocation signals: the services do not collect them. They belong in
  `SubmitMeta` when they exist, not in the chain core.
- Two-hop graph aggregates (Elliptic uses them). One hop is computed; two is a `features` bump.
- Jurisdiction of the counterparty's custodian (FATF): needs a labelled address list.
