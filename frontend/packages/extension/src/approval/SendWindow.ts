import { css, html, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';
import { Screen } from '../ui/core/Screen';
import { textStyles } from '../ui/core/styles';

// Website "Send" (P3): the Ferrata website asks `sqw_openSend`, the background opens this window,
// which reuses the extension's own Send → Confirm screens (risk analysis, explainer, passkey).
// The website never signs anything: it only learns that the window closed.

/** Query parameters of the send window: `?send=1&to=…&amount=…`. */
export const SEND_PARAM = 'send';

export interface SendPreset {
  readonly to: string;
  readonly amount: string;
}

/** Reads the optional preset the website passed; anything malformed is dropped. */
export function sendPreset(search: string): SendPreset {
  const params = new URLSearchParams(search);
  const to = params.get('to') ?? '';
  const amount = params.get('amount') ?? '';
  return {
    to: /^0x[0-9a-fA-F]{40}$/.test(to) ? to : '',
    amount: /^\d{1,18}([.,]\d{1,18})?$/.test(amount) ? amount : '',
  };
}

/**
 * The window's "home": before the send it forwards to Send (after an unlock, onboarding lands here);
 * after it (sent, or the user backed out of Send), it closes the window.
 */
@customElement('sq-send-window-home')
export class SendWindowHome extends Screen {
  static started = false;

  static override styles = [textStyles, css`p { text-align: center; }`];

  override connectedCallback(): void {
    super.connectedCallback();
    queueMicrotask(() => {
      if (!SendWindowHome.started) {
        SendWindowHome.started = true;
        this.router.go('send', undefined);
        return;
      }
      window.close();
    });
  }

  override render(): TemplateResult {
    return html`<p class="muted">Vous pouvez fermer cette fenêtre.</p>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'sq-send-window-home': SendWindowHome;
  }
}
