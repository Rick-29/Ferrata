# Jury Q&A — 10 likely questions

Short, honest answers. Anything legal ends with "to be validated with compliance".

**1. Can Swissquote move my funds, alone or with a partner?**
No. Your passkey alone signs payments; the bank holds no key to your funds. Changing your key needs your recovery phone's signature and the bank's identity attestation, both checked on chain, plus a delay during which your current device can cancel.

**2. What if Swissquote disappears?**
Your passkey keeps moving your funds; no bank signature is needed. The limit: if you also lose your passkey, recovery needs the bank's identity attestation.

**3. Did you send a real transaction on a blockchain?**
Yes: signed and broadcast on Base Sepolia (including gasless USDC through an ERC-4337 account) and Solana devnet, with explorer links. The account rules (recovery key, delay, attestation) are enforced on our own "Ferra" ledger, which also mirrors the activity of every network; moving those rules into an audited ERC-4337 account is the next step.

**4. What stops a thief with my phone and my email?**
The phone alone cannot send. Recovery also needs the identity check (simulated video in this prototype, real ID document check), there is a delay, and your current device is alerted and can cancel. Known limit: if the thief retries after you cancel, the delay grows but you can no longer cancel; the identity check is then the last barrier.

**5. You let users pay a sanctioned address?**
The bank does not hold the key, so it cannot refuse; it shows the strongest warning and records the user's decision. Whether a bank-provided wallet must hard-block sanctioned addresses is an open question, to be validated with compliance.

**6. How do you handle the Travel Rule?**
Ownership is proved at creation: the passkey signs a bank challenge, so transfers between the client's account and their wallet go to a verified self-hosted wallet. Whether the bank is the sending institution for payments to third parties is to be validated with compliance.

**7. Is Face ID real? What happens to my ID photo?**
The phone's biometrics are real; we never see them. Our face check and the face-to-ID comparison are simulated. ID photos stay on the phone and are deleted after the check; biometric data is sensitive under Swiss law: to be validated with compliance.

**8. Is it gasless? Can I use dApps?**
Gasless, yes: USDC on Base Sepolia through an ERC-4337 smart account; Pimlico's paymaster pays the gas under a sponsorship policy, so the client never holds ETH. dApps: our provider is injected and bound to the real site origin, with a read-only proxy to Base Sepolia; signing for third-party dApps waits for the approval window.

**9. How do you score risk?**
Rules (new recipient, large amount, mixer exposure, sanctions, unlimited approvals) plus a logistic model over transaction features from AML literature, explained to the user. The weights are set by hand today; the dataset export to train them exists.

**10. How does Swissquote make money?**
Crypto assets stay in its ecosystem instead of leaving to external wallets, plus fees on swaps and on-ramp and a premium protection plan. Reported 2025: CHF 85.7 M from crypto, about 12 % of revenue, crypto volume down 12.1 %. The share of crypto clients who would self-custody is an assumption to validate.
