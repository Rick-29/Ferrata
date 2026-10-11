# Speaker notes

Total: 4 min 50 s, video included. About 140 words per minute.

| # | Slide | Time | Speaker |
| --- | --- | --- | --- |
| 1 | The problem | 0:00 – 0:25 (25 s) | [Your name] |
| — | Video | 0:25 – 1:10 (45 s) | (video plays) |
| 2 | Custody model | 1:10 – 2:00 (50 s) | Georges |
| 3 | Threats and recovery | 2:00 – 3:00 (60 s) | Alexandre |
| 4 | Architecture, real vs mocked | 3:00 – 3:30 (30 s) | [Your name] |
| 5 | Legal and business | 3:30 – 4:20 (50 s) | Georges |
| 6 | Bonus, limits, conclusion | 4:20 – 4:50 (30 s) | Alexandre |

Roles, for questions: [Your name] built the extension UI and the mobile recovery app (biometrics, device key, ID document check); Georges connected the extension (testnets, passkey auth, dApp provider, recovery phone); Alexandre built most of the backend (Rust services, Ferra ledger, risk engine) and the Ferra Visualizer. Replace `[Your name]`.

---

## 1. The problem — 25 s — [Your name]

> Swiss bank clients who want to hold their own crypto keys have one option today: withdraw to an external wallet, and leave the bank. Custodial accounts aren't really their wallet; seed phrases are one phishing click from disaster. We built a third way. Here it is in 45 seconds.

*(Start the video.)*

## 2. Custody model — 50 s — Georges

> Ferrata is self-custody. Your passkey, created on your device and unlocked with Face ID, signs every payment, alone. The bank holds no key to your funds: it analyses the risk, signs a receipt, and attests your identity when you recover.
>
> Look at the table: on its own, the bank can't send, can't freeze, can't change your key. Neither can your recovery phone. The key changes only with your phone, the bank's identity check and a delay, and you can cancel it.
>
> Small payments take one touch. Riskier ones show an explained score and ask for a second confirmation. Even a sanctioned address gets the strongest warning, and your decision is recorded. The trade-off: risk checks are advice, not a lock.

## 3. Threats and recovery — 60 s — Alexandre

> You lost your passkey. Earlier you paired a phone by QR code, with fingerprints checked on both screens. On a new device you click "I lost my passkey", and scan the code with that phone. The phone signs, and you prove your identity: the ID document is read for real, check digits, age and expiry; the video call and face match are simulated in this prototype.
>
> Then a smart delay, from one to seven days, computed from your account history and explained in plain words. During it, your old device gets an alert and can cancel. At the end, the key rotates only with the phone's signature and the bank's attestation, both checked on chain.
>
> So: a thief with your phone and your email still fails the identity check, and you get the alert. The bank, alone or with a partner, cannot rotate your key. And if the bank disappears, your passkey keeps moving your funds without it.
>
> One honest limit: if an attacker retries after you cancel, the delay grows but you can no longer cancel; the identity check is then the last barrier.

## 4. Architecture — 30 s — [Your name]

> Real: the extension, the phone app, signed and broadcast transfers on Base Sepolia, gasless USDC included, and Solana devnet, and our Rust services. Mocked: the compliance provider, and our own "Ferra" ledger, which enforces the account rules and mirrors every network. On the right, the compliance desk: it replays every block, scores each transfer, flags sanctioned addresses and follows the money.

## 5. Legal and business — 50 s — Georges

> Because the bank can never act alone, we believe the wallet sits on the software side, not custody, in the sense of Article 242a of the debt enforcement law. For the Travel Rule, ownership is proved at creation: the passkey signs a bank challenge, so the client's wallet is a verified self-hosted wallet, and every transfer is traced in the compliance desk. Two questions stay open: whether the bank is the sending institution for third-party payments, and whether warning on sanctions without refusing is enough. All of this is to be validated with compliance.
>
> For the bank: crypto brought 85.7 million francs in 2025, about 12 percent of revenue, while crypto volume fell 12 percent. Ferrata keeps those clients and their flow one step from the account, and adds a paid analysis tier, gasless transfers billed in francs, fees on compliant DeFi and a KYC recovery nobody else offers. How many crypto clients would self-custody is the assumption to validate.

## 6. Bonus, limits, conclusion — 30 s — Alexandre

> Bonus: gasless is live. USDC moves on Base Sepolia through an ERC-4337 account, and a paymaster pays the gas: the client never holds ETH. Our dApp provider is in place; the bank's own site sends through the Ferrata window, and signing for third-party dApps waits for the approval window. Simulated: video KYC, face match and NFC.
>
> Your key. Your money. A bank that has your back, not your keys. Let's show you.

---

## Business case assumptions

Every figure is an **assumption**, not a fact. Replace with sourced numbers before quoting them as data.

| Variable | Assumption | Why |
| --- | --- | --- |
| Clients reachable | 500,000 | Order of magnitude for an online bank; **to be checked** against public reports |
| Adoption | 3 % | Share of clients holding crypto who would try self-custody |
| Revenue per active user | CHF 40 / year | Swap and on-ramp fees, premium protection plan |
| Result | ≈ CHF 0.6 M / year | 500,000 × 3 % × 40 |
