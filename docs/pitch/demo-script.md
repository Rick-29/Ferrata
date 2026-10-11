# Live demo — 2 minutes

Three acts: everything works → stolen phone and email, attacker stopped → the real owner recovers.
The app interface is in French; you speak English. Button names are approximate: **check every label in rehearsal**.

## Setup (before going on stage)

| Item | How | Check |
| --- | --- | --- |
| Install | After the last pull: `cd frontend; npm ci` and `cd packages/mobile; npm install` (servers stopped first) | No error |
| Backend | `scripts/dev` (or `cd backend; .\dev.ps1`) on `http://localhost:8787` | `GET /chain/verify` → `ok: true` |
| Recovery delay | The smart delay never goes below `recovery_delay_secs` in `fixtures/demo-seed.json` (120 s today). Agree with Alexandre on the demo value | Restart the backend after a change |
| Extension | Built in real mode, loaded unpacked in Chrome; wallet created with the passkey; **recovery phone already paired**; testnet wallets funded from the faucets | Home shows Ferra and testnet balances |
| Phone | Laptop and phone on the **phone's hotspot** (campus Wi-Fi isolates devices); remove `EXPO_PUBLIC_BRIDGE=fake` from `mobile/.env.local`; `npm start`, open in Expo Go | The app is not in "Mode démo" |
| Second browser profile | A clean Chrome profile with the extension, for "I lost my passkey" | Opens on onboarding |
| Visualiser | `cd app; pnpm tauri dev`, open the backend URL | The wallet's events are listed |
| Screen | Mirror the phone next to the laptop | Both visible |

## Act 1 — Everything works (0:00 – 0:40)

| Time | Click | Say |
| --- | --- | --- |
| 0:00 | Unlock the extension with the passkey (Windows Hello) | "Alice's wallet. Her key is a passkey on this laptop. No seed phrase." |
| 0:08 | Testnet panel → send a small amount on Base Sepolia → passkey → open the explorer link | "A real transfer, signed by her passkey and broadcast on a public testnet." |
| 0:20 | Send 2,000 USDC to `0x…c0ffee` → high-risk warning → "Comprendre ce score" | "Now a scam site sends her two hops from a mixer. The bank's engine explains why it's risky." |
| 0:32 | Tick "I understand" → second passkey confirmation | "She decides. The bank warns, it never blocks. The decision is recorded." |

## Act 2 — Stolen phone and email, attacker stopped (0:40 – 1:10)

| Time | Click | Say |
| --- | --- | --- |
| 0:40 | Second profile: "J'ai perdu ma passkey" with Alice's address → QR | "A thief stole Alice's phone, her recovery phone, and her email. He starts a recovery." |
| 0:48 | Phone: "Scanner un code" → "C'est bien moi, continuer" → identity check → "Simuler un attaquant" | "The phone signs, but the identity check fails: the face doesn't match the ID. The video check is simulated here; the rule is enforced on chain: no bank attestation, no rotation." |
| 1:00 | Laptop (Alice's real extension): the recovery alert → "Annuler" | "And even before that, Alice's real device was alerted and can cancel." |

## Act 3 — The real owner recovers (1:10 – 2:00)

| Time | Click | Say |
| --- | --- | --- |
| 1:10 | Second profile: "J'ai perdu ma passkey" → new passkey → QR | "Now the real Alice really lost her laptop. She creates a new passkey on a new device." |
| 1:18 | Phone: scan → "C'est bien moi, continuer" → ID document: "Remplir avec un exemple fictif (démo)" → "Vérifier la bande" → accepted → "Je suis le titulaire" | "Her phone signs. Her ID is checked for real: check digits, age, expiry. Video and chip are simulated." |
| 1:32 | Extension: countdown → "Pourquoi ce délai" | "A smart delay, explained in plain words, from her account history." |
| 1:40 | Visualiser: the recovery events, `Verified` integrity | "Meanwhile, the compliance desk: every block replayed and verified." |
| 1:52 | Delay over → finalise → the new passkey opens the wallet | "Phone signature plus bank attestation, on chain: the key rotates. Alice is back. The bank could never have done that alone." |

## Plan B

| If this fails | Do this |
| --- | --- |
| Passkey prompt does not appear | Rebuild with `VITE_PASSKEY=dev` (simulated passkey, labelled on screen) and say so |
| Testnet send stuck (faucet empty, RPC down) | Show a transfer made during rehearsal in the explorer; continue on the Ferra ledger |
| Backend down | `scripts/dev` again; else extension with `VITE_BRIDGE=fake`, phone with `EXPO_PUBLIC_BRIDGE=fake` (labelled demo mode) |
| Phone cannot reach the laptop | Both on the hotspot; else type the pairing code ("Code" → "Valider le code") |
| Camera or Face ID refused | "Continuer sans" on the face check; the unlock code works instead of Face ID |
| Delay too long | Start Act 3 right after Act 1 and run Act 2 during the wait |
| Anything else | Play the screen recording of the full demo (record it in rehearsal) |
