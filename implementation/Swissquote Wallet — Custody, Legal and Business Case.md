# Swissquote Wallet: Custody, Legal and Business Case

Working position of the team for the Swissquote Wallet Challenge judging (2026-10-11). Not legal advice; statutory wording to be checked on Fedlex before the pitch. The live, editable version is the Claude doc shared with the team.

The client holds the only key that can move funds. Swissquote holds a second key that can co-sign and attest but never spend, which is what keeps the product out of custody while keeping every transaction one step from the Swissquote account.

## Custody model: 2-of-2 where only the client can spend

The account is a 2-of-2 between the client's passkey and a Swissquote key, but the two keys are not symmetric. The passkey authorises a transfer on its own; Swissquote's co-signature is a signed risk-analysis receipt the chain checks when present but does not require. Swissquote can refuse to co-sign, never move funds, and never block a client who wants out.

| Action | Client passkey | Swissquote key | Recovery phone |
| --- | --- | --- | --- |
| Send funds | Required | Co-signs after analysis; refuses only on a sanctions match | No role |
| Send without Swissquote | Allowed; the chain accepts the owner's signature alone | Not needed | No role |
| Escape hatch (leave the ecosystem) | Starts it; after the timelock, transfers to the declared exit address | No role, cannot stop it | No role |
| Rotate the owner (recovery) | Lost | Attests after KYC and the timelock | Signs the recovery |
| Cancel a recovery | Cancels during the timelock | Cannot cancel | Cannot cancel |
| Change settings or recovery key | Signs | Records | No role |

Three consequences the pitch should state plainly. Swissquote is structurally unable to freeze or seize: the escape hatch exits without it. Swissquote alone cannot take over an account: owner rotation needs the client's recovery phone and a passed KYC, and the current passkey can cancel it during the delay. Every decision is a signed, hash-chained audit entry, so the client holds proof of what Swissquote said and when.

## Where the keys live

| Key | Lives in | Can |
| --- | --- | --- |
| Passkey (P-256) | The laptop's authenticator (Windows Hello, Touch ID); never exported | Sign transfers, settings, recovery registration; cancel a recovery |
| EVM network key (secp256k1) | Extension background worker, AES-GCM sealed by a non-extractable device key; never sent | Own the ERC-4337 smart account on Base Sepolia (honest shortcut until the passkey owns it) |
| Recovery key (Ed25519) | The client's phone | Sign a recovery; never funds |
| Swissquote co-sign key (Ed25519) | Swissquote service | Sign receipts and attestations; cannot author a transfer or a rotation |
| Swissquote validator key | Swissquote service | Sign Ferra chain blocks; cannot spend |
| Paymaster (Pimlico) | Hosted service | Pay gas for user operations under a sponsorship policy |

Mocked or hosted in the demo, and labelled as such: banking core, KYC provider, sanctions list, paymaster sponsorship policy.

## Threat model: no single compromise moves funds

| Attacker holds | Can they spend? | What stops them |
| --- | --- | --- |
| Swissquote credentials (login, email) | No. The session only reaches read endpoints and the co-signer; spending needs the passkey. | Passkey on the client's device; Swissquote key cannot spend |
| The client's phone (recovery key), unlocked | Not directly. They can start a recovery. | KYC on the new device; the timelock scaled by the smart delay; the current passkey cancels; a contested recovery gets a longer delay |
| The client's laptop with the passkey, unlocked | Yes, for transfers the device authorises | Biometric or PIN on every signature; Swissquote's analysis warns on new recipients, large amounts, mixer exposure or drains; sanctions matches are refused |
| A malicious dApp | Only what the client approves in the wallet's own window | Every dApp request is decoded and scored; unlimited approvals, permit signatures and simulated drains raise the band |
| Swissquote itself (rogue insider) | No. The key co-signs and attests; it cannot author a transfer or a rotation | Rotation needs the phone's signature; the escape hatch runs without Swissquote; every block is validator-signed and replayable |
| Swissquote's servers (outage or seizure) | Client keeps spending | The chain accepts the passkey alone; the escape hatch moves everything out after the timelock |
| Someone with both phone and laptop | Yes | Out of scope for any wallet; the audit log still records what happened |

The smart delay reads the account's own history before setting the recovery timelock: a passkey that signed in the last 24 hours, more than 10,000 CHF at stake, a recovery in the last 90 days, prior flags, an account under 7 days old, or a contested recovery each raise the score. Low keeps the base delay, Medium triples it, High multiplies by 7, Critical by 14. The reasons are shown on both devices.

On the real network today the Swissquote gate runs inside the wallet: the extension refuses to broadcast on Base Sepolia without a co-sign receipt; on-chain 2-of-2 is enforced on the Ferra chain. Making the Swissquote key a second owner of the ERC-4337 smart account is the next step.

## Swiss regulatory position

**Custody and bankruptcy.** Since 1 August 2021, Art. 242a DEBA (DLT Act) lets crypto-based assets be segregated from a custodian's estate and defines them as assets whose power of disposal is conveyed exclusively through a crypto-based access procedure. Where the provider has no access to the keys that can spend, the assets are not in its estate. The wallet sits in that case: the only spending key is the client's passkey. Open question: whether a right to refuse a co-signature, with no right to move or freeze, is a power of disposal. The escape hatch is the technical answer.

**Ownership verification of self-hosted wallets.** FINMA Guidance 02/2019 allows a supervised institution to transfer tokens only to external wallets belonging to its own identified customers, with ownership proven by suitable technical means. The wallet satisfies this by construction: the passkey signs a Swissquote-issued challenge at creation, the wallet is bound to the identified Swissquote account, and every later public-network address is registered by an owner-signed message.

**Travel rule and AML.** Art. 51a AMLO-FINMA (1 January 2021) sets the identification threshold at CHF 1,000 according to secondary sources (verify on Fedlex). Every transfer is scored and recorded with originator, beneficiary, asset and amount, so the audit log is the travel-rule record. Sanctions screening and the duty not to tip off are in the product: the refusal says "regulatory reasons" and nothing more.

## Liability: a duty of care, one refusal, Art. 100 CO

Swissquote promises an effort, not a result: it analyses, warns and asks for a second confirmation. It does not promise to stop fraud and the product cannot. No hold, no review queue, no delay on risky transactions (team decision of 2026-10-10).

| Band | What the client sees | What is recorded |
| --- | --- | --- |
| No signal, Low | Passkey, co-signature, send | Log entry with receipt |
| Medium | Second passkey confirmation | Entry marked step-up |
| High or Critical, no regulatory ground | Warning with reasons, "I understand the risks" ticked by the client, second passkey confirmation | Entry marked risk accepted, with reasons |
| Sanctions match | Refusal to co-sign, "regulatory reasons", no detail; the passkey alone remains valid on chain | Entry marked refused |

Art. 100 para. 1 CO voids any advance exclusion of liability for intent or gross negligence; para. 2 lets a court strike exclusions of slight negligence for a licensed business. Terms can limit, not exclude. The explicit, twice-signed, recorded risk acceptance is the evidence Swissquote relies on.

## Business case: keep the crypto client who would otherwise leave

| Figure | Value |
| --- | --- |
| Net revenue, FY2025 | CHF 723.3 million |
| Net income from crypto assets, FY2025 | CHF 85.7 million, flat on 2024 (about 12 percent of revenue) |
| Crypto trading volume, FY2025 | down 12.1 percent |

1. Retained trading and FX flow: assets in the wallet convert back into the Swissquote account in one step.
2. Analysis and co-signature as a paid tier, per account or per transaction; gasless transfers billed in CHF.
3. Compliant dApp access (allowlists, simulation, screening) with a spread or fee on DeFi and staking flows.
4. KYC-backed recovery as a bank service nobody else offers; a reason to open an account.

Costs fall: no client keys held, so no hot-wallet insurance or key ceremonies; withdrawal fraud becomes a warned, signed client decision. Assumptions to state: share of crypto clients who would self-custody, and the fee the analysis tier can carry.

## Open questions for counsel

- Is a 2-of-2 where Swissquote can refuse but never move or freeze a power of disposal under the AML Act and Art. 242a DEBA?
- Does warning + explicit acceptance + second signature discharge the duty of care when a fraud goes through? In what form to keep the acceptance?
- On a sanctions match, is refusing to co-sign sufficient, or must Swissquote also report and freeze? What may the client be told?
- Can the signed receipts and audit log serve as the travel-rule record?
- Does attesting a recovery after KYC create a custody-like duty on owner rotation?
- Model clause for the terms of use within Art. 100 CO.

## Sources

- FINMA press release on Guidance 02/2019, Payments on the blockchain, 26 August 2019: https://www.finma.ch/en/news/2019/08/20190826-mm-kryptogwg/
- MME and 21 Analytics, self-hosted wallets as a Swiss VASP: https://www.21analytics.ch/static/mme-article.pdf
- 21 Analytics, Switzerland's travel rule implementation (Art. 51a AMLO-FINMA): https://www.21analytics.ch/static/switzerlands-travel-rule-implementation.pdf
- Bär & Karrer, DLT briefing, September 2020: https://media.baerkarrer.ch/karmarun/image/upload/baer-karrer/BK-Briefing-DLT_2020.pdf
- PwC, partial entry into force of the Swiss DLT Act: https://www.pwc.ch/en/insights/regulation/partial-entry-swiss-dlt-act.html
- Art. 100 CO: https://lawbrary.ch/law/art/OR-v2023.02-en-art-100/print and https://onlinekommentar.ch/en/kommentare/or100
- Finance Magnates, Swissquote 2025 results: https://www.financemagnates.com/forex/swissquote-is-bullish-with-2026-revenue-outlook-but-cautious-on-profits/
- FX News Group, Swissquote H1 2025: https://fxnewsgroup.com/forex-news/retail-forex/swissquote-sets-records-for-revenue-chf-358m-and-profits-chf-158m-in-h1-2025/
