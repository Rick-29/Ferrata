# Swissquote Wallet — Frontend Spec

## Scope and rules

P2 owns everything the user sees: the extension popup, the dApp approval window, onboarding and recovery screens, plus the problem/product and demo parts of the pitch. P2 never calls the chain, Rust or Swissquote directly; every action goes through the `@sqw/sdk` facade P3 provides.

**Non-negotiables**

1. Strict TypeScript (`strict: true`, `noUncheckedIndexedAccess`, no `any`, no `as` casts outside DTO parsing).
2. Every visible element belongs to a widget class; screens only compose widgets.
3. No secret is ever stored, logged or rendered. The UI handles addresses, amounts, signatures-in-progress states — nothing else.
4. No `innerHTML` with dynamic content; all text rendered through Lit templates (auto-escaped) to prevent injection from dApp-supplied strings.
5. Every async action has explicit loading, success and typed error states.

## Extension structure

Manifest V3 with four entry points; widgets are written in Lit (TypeScript class components, auto-escaped templates). Build with Vite plus an MV3 plugin (CRXJS); fall back to plain Vite multi-entry if the plugin misbehaves.

| Entry point | Runs where | Owner | Job |
| --- | --- | --- | --- |
| `popup/` | Toolbar popup | P2 | Balance, send, activity, settings |
| `approval/` | Separate window opened by background | P2 | Confirm dApp requests (tx, typed data) |
| `background/` | Service worker | P3 | Message router, SDK host, session state |
| `inpage/` + `content/` | dApp pages | P3 | EIP-1193 provider injected for dApps |

```text
ts/packages/extension/src/
├── manifest.ts
├── ui/
│   ├── core/            # Widget base class, Screen base class, Router, theme tokens
│   ├── widgets/         # one folder per widget: Widget.ts + styles.ts + Widget.test.ts
│   ├── screens/         # compose widgets; no business logic
│   └── services/        # UiBridge: typed wrapper over chrome.runtime messaging
├── popup/main.ts        # mounts Router with popup screens
├── approval/main.ts     # mounts Router with approval screens
├── background/          # P3
└── inpage/, content/    # P3
```

## Widget architecture

Every widget extends one abstract base that standardises loading, error and data states, so no widget invents its own. Widgets receive data via typed properties and report user intent via typed events; they never call services themselves.

```ts
// ui/core/Widget.ts
export type WidgetState<T> =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; data: T }
  | { kind: 'error'; error: UiError };

export abstract class Widget<T> extends LitElement {
  @property({ attribute: false }) state: WidgetState<T> = { kind: 'idle' };

  protected abstract renderReady(data: T): TemplateResult;
  protected renderLoading(): TemplateResult { return html`<sq-skeleton></sq-skeleton>`; }
  protected renderError(e: UiError): TemplateResult { return html`<sq-error-panel .error=${e}></sq-error-panel>`; }

  protected emit<E extends keyof WidgetEvents>(name: E, detail: WidgetEvents[E]): void {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }

  override render(): TemplateResult {
    switch (this.state.kind) {
      case 'idle':    return html``;
      case 'loading': return this.renderLoading();
      case 'ready':   return this.renderReady(this.state.data);
      case 'error':   return this.renderError(this.state.error);
    }
  }
}

// ui/core/Screen.ts — owns data loading, wires events to UiBridge
export abstract class Screen extends LitElement {
  // custom elements cannot take constructor args: inject via @lit/context, provided once in main.ts
  @consume({ context: bridgeContext }) protected bridge!: UiBridge;
  @consume({ context: routerContext }) protected router!: Router;
}
```

- **One-way flow:** Screen loads data via `UiBridge` → sets widget `state` → widget emits typed event (`'send-requested'`, `'confirm'`, `'reject'`) → Screen calls `UiBridge`.
- `WidgetEvents` is a single typed map; adding an event means adding it there, so typos fail compilation.
- Shared look via CSS custom properties in `ui/core/theme.ts` (Swissquote-like palette, light/dark).
- Each widget is testable in isolation with `@open-wc/testing` by setting `state` directly.

## Screens and widgets

Nine screens built from about fifteen reusable widgets; build in the priority order below so the demo path works first.

| Priority | Screen | Widgets | Demo step |
| --- | --- | --- | --- |
| 1 | Onboarding | `sq-login-form`, `sq-passkey-prompt`, `sq-step-progress` | Create wallet |
| 1 | Home | `sq-balance-card`, `sq-asset-list`, `sq-gasless-badge` | Show USDC / ETH |
| 1 | Send | `sq-address-input`, `sq-amount-input`, `sq-asset-picker` | Send USDC |
| 1 | Confirm (popup + approval window) | `sq-tx-summary`, `sq-balance-delta`, `sq-risk-badge`, `sq-reason-list`, `sq-passkey-prompt`, `sq-risk-warning`, `sq-legal-notice` | Low / Medium / High warning / regulatory refusal |
| 2 | Recovery start (new device) | `sq-kyc-mock-call`, `sq-guardian-status`, `sq-countdown` | Attacker / real recovery |
| 2 | Security alert (existing device) | `sq-alert-banner`, `sq-cancel-recovery-button` | Real user cancels |
| 3 | Activity | `sq-activity-list` (log entries + receipt check mark), `sq-risk-badge` | Reconciliation finding |
| 3 | Settings | `sq-signer-list`, `sq-escape-hatch-panel` | Escape hatch |

Shared primitives: `sq-button`, `sq-skeleton`, `sq-error-panel`, `sq-copy-address`, `sq-consent-checkbox`. Mock KYC call is a scripted screen, clearly labelled "Simulated video identification".

**Risk never blocks.** Swissquote warns and asks for a second confirmation; the user decides. High-risk transactions show `sq-risk-warning` and need the user to tick "I understand the risks" before confirming again. The only refusal is regulatory (sanctions), shown without its reason. There is no Hold screen. Wording and rationale: `Swissquote Wallet — Positionnement légal du blocage.md`.
