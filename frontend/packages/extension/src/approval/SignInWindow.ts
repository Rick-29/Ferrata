import { LitElement, css, html, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { SIGNIN_CHANNEL, type SignInDetails } from '../signin/protocol';
import { Screen } from '../ui/core/Screen';
import { screenStyles, textStyles } from '../ui/core/styles';
import { themeStyles } from '../ui/core/theme';

// The approval window when the Ferrata website asks to sign in (sqw_signIn): a banner naming the
// site, then the extension's own login + passkey screens. Reaching "home" means the passkey just
// unlocked the wallet: tell the background, which answers the site and closes this window.

async function send<T>(op: 'details' | 'complete' | 'cancel', id: string): Promise<{ ok: true; value?: T } | { ok: false; code: string }> {
  try {
    return (await chrome.runtime.sendMessage({ channel: SIGNIN_CHANNEL, op, id })) as { ok: true; value?: T } | { ok: false; code: string };
  } catch {
    return { ok: false, code: 'UI_BACKGROUND_UNAVAILABLE' };
  }
}

/** Top banner: which site is asking, and a way to refuse. */
@customElement('sq-signin-banner')
export class SignInBanner extends LitElement {
  @property() requestId = '';
  @state() private origin = '';

  static override styles = [
    themeStyles,
    css`
      :host {
        display: block;
        padding: 12px 20px;
        border-bottom: 1px solid var(--sq-border);
        background: var(--sq-surface-sunken);
        font: 500 12px var(--sq-font);
        color: var(--sq-text-muted);
      }
      strong {
        color: var(--sq-text);
      }
      button {
        margin-left: 8px;
        border: 0;
        background: none;
        color: var(--sq-accent);
        font: inherit;
        cursor: pointer;
        text-decoration: underline;
      }
    `,
  ];

  override connectedCallback(): void {
    super.connectedCallback();
    void send<SignInDetails>('details', this.requestId).then((r) => {
      this.origin = r.ok && r.value ? r.value.origin : 'un site';
    });
  }

  override render(): TemplateResult {
    return html`<strong>${this.origin || '…'}</strong> demande à vous connecter avec votre passkey.
      <button type="button" @click=${() => void send('cancel', this.requestId)}>Refuser</button>`;
  }
}

/** Route "home" of this window: the passkey unlocked the wallet, hand the result to the site. */
@customElement('sq-signin-done')
export class SignInDone extends Screen {
  @property() requestId = '';
  @state() private status: 'sending' | 'done' | 'failed' = 'sending';

  static override styles = [screenStyles, textStyles];

  override connectedCallback(): void {
    super.connectedCallback();
    void send('complete', this.requestId).then((r) => {
      if (r.ok) {
        this.status = 'done';
        setTimeout(() => window.close(), 1_200);
      } else if (r.code === 'SIGNIN_NOT_PROVEN') {
        // The wallet was already unlocked from before: a fresh passkey proof is required.
        this.router.go('onboarding', undefined);
      } else {
        this.status = 'failed';
      }
    });
  }

  override render(): TemplateResult {
    switch (this.status) {
      case 'sending':
        return html`<p class="muted">Connexion au site…</p>`;
      case 'done':
        return html`<h1>Connecté ✓</h1>
          <p class="muted">Vous pouvez revenir sur le site. Cette fenêtre se ferme.</p>`;
      case 'failed':
        return html`<h1>Connexion impossible</h1>
          <p class="muted">La demande a expiré ou a été annulée. Recommencez depuis le site.</p>`;
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'sq-signin-banner': SignInBanner;
    'sq-signin-done': SignInDone;
  }
}
