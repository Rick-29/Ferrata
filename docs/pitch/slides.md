---
marp: true
html: true
paginate: true
size: 16:9
title: Ferrata
style: |
  @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=Inter:wght@400;500;600;700&display=swap');
  :root { --ink: #f5f6fb; --muted: #959cb2; --faint: #5f667c; --bg: #07080e; --panel: rgba(22,25,40,.88); --line: rgba(255,255,255,.09); --accent: #ff5a2a; --accent2: #ff8a3d; --ok: #3fd69b; --sim: #b3a6ff; --warn: #ffbb55; --bad: #ff6d86; }
  section { background: radial-gradient(900px 520px at 95% -10%, rgba(255,90,42,.30), transparent 62%), radial-gradient(760px 520px at -8% 112%, rgba(123,92,255,.22), transparent 60%), var(--bg); color: var(--ink); font-family: Inter, "Segoe UI", sans-serif; font-size: 21px; padding: 44px 58px; justify-content: flex-start; }
  section::before { content: ""; position: absolute; inset: 0; background-image: radial-gradient(rgba(255,255,255,.05) 1px, transparent 1px); background-size: 26px 26px; mask-image: linear-gradient(180deg, rgba(0,0,0,.7), transparent 70%); pointer-events: none; }
  h1 { font-family: "Space Grotesk", Inter, sans-serif; color: var(--ink); font-size: 42px; line-height: 1.05; letter-spacing: -1.5px; margin: 0 0 16px; }
  h2 { color: var(--accent); font-size: 13px; font-weight: 700; letter-spacing: 3.5px; text-transform: uppercase; margin: 0 0 10px; }
  strong { color: var(--accent); font-weight: 600; }
  section::after { color: var(--faint); font-size: 12px; }
  .muted { color: var(--muted); }
  .row { display: flex; gap: 12px; align-items: stretch; }
  .col { display: flex; flex-direction: column; gap: 10px; }
  .card { position: relative; background: var(--panel); border: 1px solid var(--line); border-radius: 16px; padding: 12px 15px; font-size: 16px; line-height: 1.38; }
  .card b { display: block; font-size: 17px; margin-bottom: 3px; }
  .ok { border-color: rgba(63,214,155,.5); } .ok b { color: var(--ok); }
  .sim { border: 1px dashed rgba(179,166,255,.7); } .sim b { color: var(--sim); }
  .warn { border: 1px dashed rgba(255,187,85,.7); } .warn b { color: var(--warn); }
  .bad { border-color: rgba(255,109,134,.55); } .bad b { color: var(--bad); }
  .tag { display: inline-block; font-size: 10.5px; font-weight: 700; letter-spacing: .6px; text-transform: uppercase; padding: 1px 7px; border-radius: 99px; border: 1px solid currentColor; vertical-align: 2px; margin-left: 3px; white-space: nowrap; }
  .t-ok { color: var(--ok); } .t-sim { color: var(--sim); } .t-warn { color: var(--warn); } .t-bad { color: var(--bad); }
  .hero { font-family: "Space Grotesk", Inter, sans-serif; font-size: 60px; font-weight: 700; line-height: 1.0; letter-spacing: -2.5px; }
  .grad { background: linear-gradient(92deg, var(--accent2), var(--accent) 55%, #e93b1b); -webkit-background-clip: text; background-clip: text; color: transparent; }
  .shot { position: relative; overflow: hidden; border-radius: 14px; border: 1px solid rgba(255,255,255,.14); box-shadow: 0 30px 80px rgba(0,0,0,.65), 0 0 0 6px rgba(255,255,255,.03); background: #111; }
  .shot img { position: absolute; max-width: none !important; height: auto; }
  .lane { font-size: 10.5px; font-weight: 700; letter-spacing: 2.2px; text-transform: uppercase; color: var(--muted); margin: 2px 0 0; }
  .foot { font-size: 13px; color: var(--muted); margin-top: 8px; }
  .actor { display: flex; gap: 10px; align-items: center; }
  .ico { flex: none; width: 38px; height: 38px; border-radius: 11px; display: grid; place-items: center; }
  .ico svg { width: 21px; height: 21px; }
  .matrix { display: grid; grid-template-columns: 1.35fr repeat(3, 1fr); border: 1px solid var(--line); border-radius: 16px; overflow: hidden; background: var(--panel); font-size: 15px; }
  .matrix > div { padding: 9px 12px; border-bottom: 1px solid var(--line); display: flex; align-items: center; gap: 8px; }
  .matrix > div:nth-last-child(-n+4) { border-bottom: 0; }
  .matrix .h { font-size: 10.5px; font-weight: 700; letter-spacing: 1.6px; text-transform: uppercase; color: var(--muted); background: rgba(255,255,255,.02); }
  .y, .n, .p { width: 22px; height: 22px; border-radius: 50%; display: inline-grid; place-items: center; font-size: 13px; font-weight: 700; flex: none; }
  .y { background: rgba(63,214,155,.16); color: var(--ok); } .n { background: rgba(255,109,134,.14); color: var(--bad); } .p { background: rgba(255,187,85,.15); color: var(--warn); }
  .timeline { display: flex; align-items: stretch; gap: 0; position: relative; }
  .timeline .st { flex: 1; position: relative; padding: 30px 8px 0; font-size: 14px; line-height: 1.32; }
  .timeline .st::before { content: ""; position: absolute; top: 9px; left: 0; right: 0; height: 2px; background: linear-gradient(90deg, rgba(255,90,42,.7), rgba(255,90,42,.25)); }
  .timeline .st::after { content: attr(data-n); position: absolute; top: 0; left: 8px; width: 20px; height: 20px; border-radius: 50%; background: var(--accent); color: #fff; font-size: 11px; font-weight: 700; display: grid; place-items: center; box-shadow: 0 0 0 4px rgba(255,90,42,.18); }
  .timeline .st b { display: block; font-size: 15px; margin-bottom: 2px; }
  .stat { font-family: "Space Grotesk", Inter, sans-serif; font-size: 36px; font-weight: 700; letter-spacing: -1px; line-height: 1; }
  .ladder { display: flex; border-radius: 14px; overflow: hidden; }
  .ladder div { flex: 1; padding: 9px 12px; background: var(--panel); font-size: 14px; line-height: 1.3; border-top: 4px solid; }
  .ladder b { display: block; font-size: 15px; }
  .pill { display: inline-flex; align-items: center; gap: 6px; padding: 5px 12px; border-radius: 99px; background: rgba(255,255,255,.05); border: 1px solid var(--line); font-size: 14px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
---

<!-- _paginate: false -->

<div class="row" style="gap:44px;align-items:center;height:100%">
<div style="flex:1.15">

## Swissquote Wallet track · Ferrata

<div class="hero">Clients who want<br>their own keys<br><span class="grad">leave the bank.</span></div>

<p style="font-size:20px;margin-top:20px;max-width:31ch" class="muted">Today they withdraw to an external wallet and leave the ecosystem. Ferrata gives them their keys, one step from their account.</p>

<div class="row" style="margin-top:22px;gap:8px;flex-wrap:wrap">
  <span class="pill"><span class="dot" style="background:var(--ok)"></span>Passkey, no seed phrase</span>
  <span class="pill"><span class="dot" style="background:var(--accent)"></span>Bank-grade risk analysis</span>
  <span class="pill"><span class="dot" style="background:var(--sim)"></span>Recovery without the bank alone</span>
</div>

</div>
<div style="flex:.85">
  <div class="shot" style="aspect-ratio:440/515;transform:rotate(2.5deg)"><img src="shots/web-home.png" style="width:363.6%;left:-205.7%;top:-29.1%"></div>
</div>
</div>

---

## Custody model · creation · authentication

# 2-of-2 where <span class="grad">only you can spend</span>

<div class="row" style="gap:20px">
<div class="col" style="flex:1">
  <div class="card ok actor"><div class="ico" style="background:rgba(63,214,155,.14)"><svg viewBox="0 0 24 24" fill="none" stroke="#3fd69b" stroke-width="2"><circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M15 8l2 2"/></svg></div><div><b>Your passkey</b>Created on your device, Face ID / fingerprint. Signs every payment. <span class="tag t-ok">real</span></div></div>
  <div class="card ok actor"><div class="ico" style="background:rgba(179,166,255,.14)"><svg viewBox="0 0 24 24" fill="none" stroke="#b3a6ff" stroke-width="2"><rect x="6" y="2" width="12" height="20" rx="3"/><path d="M11 18h2"/></svg></div><div><b>Your recovery phone</b>Paired by QR, its key registered on the account. <span class="tag t-ok">real</span></div></div>
  <div class="card actor"><div class="ico" style="background:rgba(255,90,42,.14)"><svg viewBox="0 0 24 24" fill="none" stroke="#ff5a2a" stroke-width="2"><path d="M3 10l9-6 9 6M5 10v9M19 10v9M9 10v9M15 10v9M3 21h18"/></svg></div><div><b>The bank</b>Analyses risk, signs a receipt, attests KYC. <span class="muted">Holds no key to your funds.</span></div></div>
  <div class="card ok"><b>Create</b>Log in to the bank account → passkey on the device → it signs a bank challenge → wallet bound to the client ID</div>
</div>
<div class="col" style="flex:1.15">
  <div class="matrix">
    <div class="h">Who, alone…</div><div class="h">Send</div><div class="h">Block</div><div class="h">Change key</div>
    <div>Your passkey</div><div><span class="y">✓</span></div><div><span class="n">✕</span></div><div><span class="n">✕</span></div>
    <div>Recovery phone</div><div><span class="n">✕</span></div><div><span class="n">✕</span></div><div><span class="n">✕</span></div>
    <div>The bank</div><div><span class="n">✕</span></div><div><span class="n">✕</span></div><div><span class="n">✕</span></div>
    <div>Phone + bank KYC + delay</div><div><span class="n">✕</span></div><div><span class="n">✕</span></div><div><span class="p">✓</span><span class="muted" style="font-size:12px">you can cancel</span></div>
  </div>
  <div class="ladder">
    <div style="border-color:var(--ok)"><b>Low</b>one touch</div>
    <div style="border-color:var(--warn)"><b>Medium</b>2nd confirmation</div>
    <div style="border-color:var(--accent)"><b>High</b>explained score + "I understand"</div>
    <div style="border-color:var(--bad)"><b>Sanctions</b>strongest warning, decision recorded</div>
  </div>
  <div class="row">
    <div class="card ok" style="flex:1"><b>Pros</b>No seed phrase · the bank can neither move nor freeze funds · works if the bank is down</div>
    <div class="card bad" style="flex:1"><b>Cons</b>Lost passkey + phone → needs the bank's KYC · risk checks are advice, not a lock</div>
  </div>
</div>
</div>

---

## Threat model · recovery

# Lost passkey? <span class="grad">Phone + identity + time.</span>

<div class="timeline">
  <div class="st" data-n="1"><b>Pair a phone</b>QR + fingerprints checked on both screens <span class="tag t-ok">real</span></div>
  <div class="st" data-n="2"><b>"I lost my passkey"</b>new passkey on the new device, QR to the phone <span class="tag t-ok">real</span></div>
  <div class="st" data-n="3"><b>Phone signs + KYC</b>ID document MRZ, age, expiry <span class="tag t-ok">real</span> · video, face, NFC <span class="tag t-sim">simulated</span></div>
  <div class="st" data-n="4"><b>Smart delay</b>base ×1 to ×14 from account history, reasons on both devices <span class="tag t-ok">real</span></div>
  <div class="st" data-n="5"><b>Rotation</b>needs phone signature <em>and</em> bank attestation, on chain <span class="tag t-ok">real</span></div>
</div>

<div class="row" style="margin-top:22px;gap:12px">
  <div class="card" style="flex:1"><b>Phishing site</b>Explained risk score and warning before signing</div>
  <div class="card" style="flex:1"><b>Stolen phone + email</b>Phone alone can't send. Recovery still needs KYC; the old passkey gets an alert and cancels</div>
  <div class="card" style="flex:1"><b>The bank, alone or with a partner</b>Cannot move, freeze or rotate: the phone's signature is required on chain</div>
  <div class="card" style="flex:1"><b>Bank gone for good</b>The passkey alone keeps moving funds. No bank signature needed</div>
</div>

<p class="foot">Known limit: if the attacker retries after a cancel ("contested"), the delay grows but the old passkey can no longer cancel; KYC is then the last barrier, and it is simulated today.</p>

---

## Architecture · real vs mocked

# Real chains, <span class="grad">every transfer traceable</span>

<div class="row" style="gap:20px">
<div class="col" style="flex:1">
  <div class="lane">Client</div>
  <div class="row"><div class="card ok" style="flex:1"><b>Chrome extension</b>passkey, sends, dApp provider</div><div class="card ok" style="flex:1"><b>Phone app</b>recovery key, KYC</div></div>
  <div class="lane">Testnets · signed and broadcast</div>
  <div class="row"><div class="card ok" style="flex:1.6"><b>Base Sepolia · gasless USDC</b>ERC-4337 smart account, Pimlico paymaster pays the gas</div><div class="card ok" style="flex:1"><b>Solana devnet</b>Ed25519</div></div>
  <div class="lane">Bank services · Rust</div>
  <div class="card ok"><b>Risk engine · receipts · audit log · recovery attestation</b>connectors read Bitcoin, Ethereum, Solana, TON</div>
  <div class="card sim"><b>Compliance provider</b>KYC, sanctions list, exposure graph <span class="tag t-sim">mocked</span></div>
  <div class="card sim"><b>"Ferra" ledger</b>account rules, signed blocks, replay-verified; mirrors every network's activity <span class="tag t-sim">own chain</span></div>
</div>
<div style="flex:1.05">
  <div class="lane" style="margin-bottom:8px">Compliance desk · Ferra Visualizer</div>
  <div class="shot" style="aspect-ratio:2280/960"><img src="shots/viz-validation.png" style="width:105.3%;left:-5.3%;top:-12.5%"></div>
  <div class="row" style="margin-top:12px;gap:8px;flex-wrap:wrap">
    <span class="pill">Replays every block</span><span class="pill">Scores each transfer</span><span class="pill">Risk by network</span><span class="pill">Sanctioned &amp; reported addresses</span><span class="pill">Follows the money</span><span class="pill">Exports for auditors</span>
  </div>
</div>
</div>

---

## Legal · business

# <span class="grad">Software, not custody:</span> the bank can never act alone

<div class="row" style="gap:14px">
  <div class="card ok" style="flex:1"><b>Custody · Art. 242a DEBA</b>Only the client's passkey can spend; the bank cannot move, freeze or rotate the funds alone, nor with a partner. No power of disposal, so not custody.<br><span class="muted">To be validated with compliance.</span></div>
  <div class="card ok" style="flex:1"><b>Travel Rule · FINMA 02/2019</b>Ownership proved by construction: the passkey signs a bank challenge at creation, bound to the identified client. Every transfer is recorded with sender, recipient, asset and amount.<br><span class="muted">Sending institution for third-party payments? To be validated.</span></div>
  <div class="card warn" style="flex:1"><b>Sanctions</b>The bank warns and records the decision, but does not refuse, because it does not hold the key.<br><span class="muted">Whether that is enough under Swiss sanctions law: to be validated with compliance.</span></div>
</div>

<div class="row" style="gap:14px;margin-top:14px;align-items:center">
  <div class="card" style="flex:1"><b>What the bank gains</b>Keeps the crypto client and the flow back to the account · paid analysis tier · gasless transfers billed in CHF · fees on compliant DeFi · KYC recovery nobody else offers · no client keys to insure</div>
  <div class="card" style="flex:1.35;display:flex;gap:12px;align-items:center;justify-content:space-around;text-align:center">
    <div><div class="stat">723 M</div><span class="muted">CHF revenue 2025</span></div>
    <div><div class="stat grad">85.7 M</div><span class="muted">CHF from crypto (≈12 %)</span></div>
    <div><div class="stat" style="color:var(--bad)">−12.1 %</div><span class="muted">crypto volume 2025</span></div>
  </div>
</div>
<p class="foot">Reported FY2025 figures (press coverage of Swissquote results). What share of crypto clients would self-custody is an assumption to validate.</p>

---

<!-- _paginate: false -->

## Bonus · limits · conclusion

<div class="row" style="gap:14px">
  <div class="card ok" style="flex:1"><b>Gasless · done</b>USDC on Base Sepolia through an ERC-4337 account; Pimlico's paymaster pays the gas under a sponsorship policy. The client never holds ETH.</div>
  <div class="card warn" style="flex:1"><b>dApps · partial</b>EIP-1193 / 6963 provider, origin from the browser; the bank's site reads the wallet and sends through the Ferrata window. Third-party dApp signing waits for the approval window.</div>
  <div class="card warn" style="flex:1"><b>Simulated</b>Video KYC, face match, NFC chip. The "Ferra" ledger enforces the account rules; the testnets carry real transfers.</div>
</div>

<div class="hero" style="margin-top:56px">Your key. Your money.<br><span class="grad">A bank that has your back,</span><br>not your keys.</div>
