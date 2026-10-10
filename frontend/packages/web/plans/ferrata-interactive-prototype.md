> **Superseded in part (2026-10-10).** This is the original Figma Make plan. Since then:
> no blocking on risk, only a regulatory refusal (see `implementation/… Positionnement légal du blocage.md`);
> no "protected/protection" promises; pump.fun dropped (a fictional DemoSwap dApp stands in);
> the product name comes from `frontend/packages/brand` (`APP_NAME`).

# Ferrata by Swissquote — Interactive Prototype Plan

## Objective
Build a polished, English-language, interactive React prototype for **Ferrata by Swissquote** that demonstrates how Swissquote-owned wallet security adapts to a customer’s behavior. The primary review path will be a guided companion website journey that ends in a fully navigable embedded Chrome-extension wallet.

The prototype will be front-end only. Authentication, wallet balances, market data, transactions, passkeys, risk analysis, and blockchain activity will be deterministic mock data; no wallet SDK, backend, Swissquote API, or live chain connection will be introduced.

## Confirmed Product Decisions
- Brand hierarchy: **Ferrata** is the product, consistently endorsed as **by Swissquote**; Swissquote is presented as the owner and security/risk provider.
- Primary experience: guided end-to-end website journey.
- Wallet coverage: Ethereum and Solana, with pump.fun as the flagship connected-dApp scenario.
- Personalization: three switchable personas — Holder, Active Trader, and High-Frequency Trader.
- Risk coverage: Low, Moderate, High, and Blocked/Critical outcomes.
- Themes: complete light and dark themes, switchable at runtime.
- Language: all UI and mock content in English.
- Visual references: evolve the uploaded compact dark wallet examples into a more polished Swiss fintech system rather than reproducing their rough styling or French copy.

## Technical Approach

### Dependencies and application shape
- Keep the existing React 19 + Vite + TypeScript + Tailwind CSS v4 stack.
- Add `lucide-react` for a consistent icon set; do not use emoji or hand-drawn text symbols for interface icons.
- Do not add a routing library. Use a small typed application state model because the prototype is one guided experience rather than a production multi-route site.
- Keep `src/App.tsx` as the composition root and split substantive UI into focused files so the screen logic remains maintainable.

### Proposed file structure
- `src/App.tsx` — top-level state, journey transitions, theme/persona wiring.
- `src/types.ts` — shared unions/interfaces for journey steps, personas, risk tiers, scenarios, extension screens, and transaction records.
- `src/data/demo.ts` — personas, balances, assets, transactions, scenarios, risk reports, and deterministic persona/scenario mappings.
- `src/components/Brand.tsx` — Ferrata wordmark treatment and Swissquote endorsement.
- `src/components/ThemeToggle.tsx` — accessible light/dark switch.
- `src/components/MarketingSite.tsx` — landing content and guided entry point.
- `src/components/AuthFlow.tsx` — simulated Swissquote sign-in and passkey-ready state.
- `src/components/ProfileSetup.tsx` — profiling questions/persona recommendation and selection.
- `src/components/CustomerDashboard.tsx` — portfolio, protection summary, persona controls, scenario controls, and embedded extension shell.
- `src/components/ExtensionShell.tsx` — browser-extension frame and internal extension navigation.
- `src/components/extension/*` — wallet home, dApp connection, trade/send composer, risk review, passkey confirmation, success receipt, activity, and security settings.
- `src/components/ui/*` — only the small reusable primitives actually needed, such as Button, Card, Badge, SegmentedControl, and Modal/Sheet.
- `src/index.css` — Tailwind import first, then theme tokens, global typography, focus styles, subtle background treatments, and motion/reduced-motion rules.

No stock photography is needed: an abstract security/network composition and product UI itself will communicate the fintech proposition more credibly than a generic photo.

## Experience and Screen Map

### 1. Marketing landing page
Create a premium Swiss-fintech landing page with:
- Header containing “Ferrata by Swissquote,” Product, Security, and How it works anchors; theme toggle; and “Access wallet” action.
- Hero message focused on self-directed crypto access protected by Swissquote intelligence.
- A concise trust row: co-signed protection, real-time risk analysis, Ethereum + Solana, and non-custodial control language that does not make unsupported regulatory guarantees.
- A designed wallet preview showing a protected pump.fun request and risk signal.
- “How Ferrata protects you” sequence: connect, assess, co-sign.
- Persona-adaptation section showing that identical actions can produce different guidance based on expected behavior.
- Primary CTA starts the simulated sign-in; secondary CTA scrolls to the product explanation.

### 2. Swissquote sign-in
Use a centered, branded authentication panel inspired by the uploaded login reference:
- Three-step indicator: Swissquote ID, Passkey, Ready.
- Demo credentials visibly provided and prefillable; form validation for empty fields.
- Successful credential submission advances to a simulated passkey prompt.
- Passkey confirmation advances to profile setup.
- Clear disclosure that this is a prototype/demo and no real credentials should be entered.

### 3. Investor profile setup
Build a short profiling flow that demonstrates why personalization exists:
- Three concise questions: primary intent, expected transaction frequency, and typical transaction size.
- Answers produce one of three recommended persona cards.
- Users can accept the recommendation or explicitly select Holder, Active Trader, or High-Frequency Trader.
- Each persona card explains what changes: dashboard emphasis, baseline limits, confirmation sensitivity, and warning language.
- Continue into the customer dashboard with the chosen persona.

### 4. Companion website dashboard
Use a responsive desktop dashboard as the main prototype hub:
- Compact sidebar/top navigation for Overview, Risk center, Activity, and Security profile.
- Greeting and active persona label with a three-option persona switcher so reviewers can immediately compare behavior.
- Portfolio overview with total value and Ethereum/Solana allocation.
- “Protection status” card showing Swissquote co-signing active, passkey active, and policy limits.
- Personalized insight card whose language changes by persona.
- Scenario launcher containing four test cases so every risk state is reachable without hidden controls.
- Large embedded Chrome-extension frame on desktop. On smaller screens, it becomes the principal content area and the website navigation collapses.
- “Restart demo” control returns to the landing/auth journey without reloading.

### 5. Extension wallet home
Design the extension at an approximately 400–420 px compact wallet width, while allowing it to fill available width on narrow devices:
- Header: Ferrata by Swissquote, current network selector, theme-aware status, and account menu.
- Total portfolio, abbreviated address/copy action, and protection status.
- Primary actions: Send, Receive, and Connect.
- Asset rows for SOL, ETH, USDC, and USDT with mock balances and values.
- Recent activity rows with risk badges.
- Connected-app card for pump.fun when the flagship scenario is active.
- Internal bottom navigation or compact tab bar for Wallet, Activity, and Security.

### 6. pump.fun connection and trade flow
The flagship guided flow will be:
1. pump.fun connection request with requested permissions, network, verified-domain signal, and Cancel/Connect actions.
2. Trade composer with token summary, amount, estimated output, slippage, network fee, and wallet impact.
3. “Review with Ferrata” runs the mock assessment and opens the risk report.
4. Risk report presents tier, numeric score/range, plain-English reasons, before/after balances, destination or contract identity, and recommended action.
5. Depending on tier, the user can continue to passkey, must complete extra acknowledgement, or is blocked.
6. Passkey/co-sign screen explains that the user authorizes and Swissquote co-signs/records the action.
7. Success receipt shows transaction summary, Solana signature abbreviation, risk tier, and “View activity.”

Also provide a standard send flow for Ethereum/stablecoin transfers so the wallet is demonstrably multichain rather than a pump.fun-only product.

### 7. Activity and security settings
- Activity: filterable mock history covering deposits, Ethereum sends, Solana trades, co-signed approvals, and a blocked request. Each row opens a compact detail view with risk rationale and audit metadata.
- Security settings: persona, passkey state, per-transaction percentage, daily cap, additional confirmation threshold, auto-expiry timeout, trusted dApps, and account address.
- Save settings locally in component state and show a clear confirmation message; values influence displayed policy summaries but do not need a generalized rules engine.

## Personalization and Risk Model

### Personas
Define the three personas as data, not conditionals scattered through JSX:
- **Holder** — low frequency, capital-preservation emphasis, lower default limits, stronger language for unusual size or unfamiliar destinations.
- **Active Trader** — regular swaps/trades, balanced speed and protection, moderate limits, detailed market/slippage guidance.
- **High-Frequency Trader** — frequent dApp interactions, higher expected turnover, compact execution-focused guidance, but uncompromised blocking for known malicious behavior.

Switching persona updates:
- Dashboard insight and headline metrics.
- Default transaction/daily limits.
- Wallet home emphasis and helper copy.
- Risk score, reasons, warning copy, and required friction for persona-sensitive scenarios.
- Activity/profile labels.

### Four deterministic scenarios
Create a scenario catalog that drives the demo and guarantees full state coverage:
1. **Low risk — Verified routine action:** a small trade on verified pump.fun infrastructure with normal slippage. Continue directly to passkey.
2. **Moderate risk — Unusual exposure:** a larger speculative trade or material portfolio concentration. Show amber report and a required acknowledgement before passkey.
3. **High risk — Behavior mismatch:** a very large stablecoin transfer or thin-liquidity token purchase that is abnormal for the selected profile. Show red report, detailed consequences, typed/checkbox acknowledgement, and stronger confirmation friction. For the same large transfer, Holder should receive a materially stronger score/copy than High-Frequency Trader.
4. **Blocked/Critical — Known dangerous request:** a mock malicious contract, address-poisoning match, or policy breach. Remove the sign action, clearly state why Ferrata will not co-sign, and offer safe exits such as return, disconnect dApp, or view report.

Store risk reports as typed fixture data keyed by scenario and persona. A small selector function may merge persona-specific score/copy/limits with scenario data; do not imply that the front end contains a real fraud model.

### Risk communication rules
- Never rely on color alone; pair color with icon, tier label, score, and plain language.
- Separate “What we found,” “Why this is unusual for you,” “Portfolio impact,” and “What happens next.”
- Clearly distinguish informational analysis from a guarantee of safety.
- Keep audit/co-sign language consistent across confirmation, receipt, and activity.

## Visual Design System

### Direction
Create a refined, restrained Swiss-fintech aesthetic:
- Ferrata uses a confident geometric wordmark treatment; “by Swissquote” is a quieter endorsement immediately adjacent or below.
- Primary accent: Swissquote-inspired vermilion/orange, used selectively for key actions and brand moments.
- Dark theme: graphite/near-black surfaces with warm neutral elevation and crisp off-white typography.
- Light theme: warm white/cool-gray canvas, white cards, charcoal type, and the same vermilion accent.
- Risk colors: green, amber, red, and deep critical red with accessible foreground contrast.
- Typography: a public Google sans face suitable for financial interfaces (planned: Inter) with tabular numerals for balances, scores, and transaction values.
- Shape: medium radii and precise 1 px borders; avoid excessive pill-shaped containers.
- Depth: subtle shadows, restrained gradients, and a faint security-grid/network motif only in large marketing surfaces.
- Motion: short opacity/translate transitions for steps, sheets, and confirmations; disable nonessential motion under `prefers-reduced-motion`.

### Theme behavior
- Use a `data-theme` attribute or class on the root with CSS custom properties for semantic colors.
- Default from system preference on first visit.
- Theme toggle is available on the landing page, dashboard, and extension header.
- Persist the chosen theme in `localStorage`; guard browser-only access so initial render is safe.

## State and Interaction Model
Use typed top-level state with the following conceptual fields:
- `journeyStep`: `landing | signIn | passkey | profile | dashboard`
- `theme`: `light | dark`
- `persona`: `holder | activeTrader | highFrequency`
- `dashboardSection`: `overview | risk | activity | security`
- `extensionScreen`: `home | connect | compose | review | passkey | success | activity | settings`
- `scenarioId`: one of the four deterministic scenarios
- `riskTier`: derived from scenario/persona fixtures rather than independently mutated
- `settings`: limit and security-policy values

Interaction requirements:
- Every primary and secondary visible control must either navigate, update state, validate input, copy mock text, or display a clear disabled reason.
- Use back/cancel paths in all multi-step extension flows.
- Modal/sheet content must have focus management, Escape close where safe, labelled controls, and visible keyboard focus.
- Copy buttons should show a temporary “Copied” confirmation without requiring clipboard success for the prototype path.
- Persona/scenario switching should reset any in-progress transaction review to a predictable start state.
- A blocked request can never reach passkey or success.

## Responsive and Accessibility Requirements
- Website: polished at wide desktop, standard laptop, tablet, and mobile widths.
- Embedded extension: retains its compact proportions on desktop; on mobile it becomes a full-width wallet surface without horizontal scrolling.
- Maintain logical heading order, landmarks, labels, button semantics, and sufficient hit areas.
- Ensure WCAG-aware text/background contrast in both themes and all risk tiers.
- Do not place essential instructions solely in hover states.
- Use `aria-live` for form errors, save/copy confirmation, and transaction status changes.

## Content and Prototype Boundaries
- Use realistic but clearly fictional balances, addresses, token names, fees, dates, and transaction IDs.
- Include a concise “Interactive prototype — no real funds or credentials” disclosure in auth and transaction areas.
- Avoid claims that Swissquote guarantees transaction safety or that analysis detects all fraud.
- Do not implement real credential storage, wallet connection, passkeys, signing, payments, analytics, or blockchain calls.
- Do not add production-only architecture such as global state libraries, API clients, or a router.

## Implementation Sequence
1. Load the repository’s design-system guidance before UI implementation, then establish semantic tokens, typography, base styles, icons, and theme persistence.
2. Define typed demo data for personas, scenarios, assets, risk reports, activity, and settings.
3. Build reusable primitives and brand treatment.
4. Implement the landing, auth, passkey, and profile journey with validation and transitions.
5. Implement the responsive companion dashboard and live persona/scenario switching.
6. Build the embedded extension shell, wallet home, activity, and security settings.
7. Implement pump.fun connection/trade review, all four risk outcomes, passkey/co-sign, blocked behavior, and success receipt.
8. Add the Ethereum/stablecoin send path and verify profile-sensitive large-transfer messaging.
9. Polish light/dark states, responsive behavior, focus behavior, reduced motion, and demo disclosures.
10. Format and verify the complete experience.

## Verification Strategy
Because this is a broad new UI rather than a localized edit:
- Run the repository formatter via `pnpm format`.
- Run `pnpm build` and resolve all TypeScript/Vite errors.
- Use the already-running preview server; do not start a second development server.
- Manually exercise the complete guided path: landing → sign-in validation → passkey → profiling → dashboard → pump.fun connect → trade → risk review → passkey → success → activity.
- Switch through all three personas and confirm the dashboard, limits, and risk copy/score visibly update.
- Open all four scenarios and confirm low/moderate/high progress correctly while blocked/critical has no signing path.
- Exercise the Ethereum/stablecoin send flow and confirm the holder versus high-frequency warning difference.
- Check light and dark themes on landing, auth, dashboard, all extension screens, and each risk tier.
- Check keyboard focus, Escape behavior, visible focus rings, labels, live status messages, and reduced-motion behavior.
- Check wide desktop, approximately 1024 px, and narrow mobile layouts for clipping or horizontal overflow.

## Acceptance Criteria
- A reviewer can complete the full demo without encountering dead controls or needing instructions outside the UI.
- Ferrata is consistently presented as a Swissquote-owned/endored product through “Ferrata by Swissquote” branding and co-sign/risk language.
- The website, extension, activity/settings, and all warning states share one coherent design system in both themes.
- Ethereum, Solana, and pump.fun are visibly represented; pump.fun provides the flagship interactive flow.
- Holder, Active Trader, and High-Frequency Trader are live, switchable profiles with meaningful UI and risk differences.
- Low, Moderate, High, and Blocked/Critical reports are all reachable and behaviorally distinct.
- Blocked requests cannot be signed; successful permitted requests produce a receipt and activity entry.
- The app is responsive, keyboard-usable, free of obvious contrast issues, formatted, and builds successfully.
