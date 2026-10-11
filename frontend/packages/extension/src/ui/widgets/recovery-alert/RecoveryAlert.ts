import { LitElement, css, html, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { errorMessage, type UiError } from '../../core/errors';
import { textStyles } from '../../core/styles';
import type { RecoveryAlert } from '../../services/UiBridge';
import '../button/Button';

/**
 * Existing device (P3): someone started recovering this wallet elsewhere. Says when it takes effect
 * and why that delay, and lets the current passkey cancel ("ce n'est pas moi"), unless contested.
 * Fires `cancel-recovery` with the recovery id; the screen calls the bridge.
 */
@customElement('sq-recovery-alert')
export class RecoveryAlertCard extends LitElement {
  @property({ attribute: false }) alert!: RecoveryAlert;
  @property({ attribute: false }) nowSecs = Math.floor(Date.now() / 1000);
  @property({ type: Boolean }) busy = false;
  @property({ attribute: false }) error: UiError | null = null;

  static override styles = [
    textStyles,
    css`
      section {
        display: grid;
        gap: 7px;
        padding: 12px;
        border-radius: 16px;
        border: 1px solid rgba(255, 77, 106, 0.35);
        background: linear-gradient(130deg, rgba(255, 77, 106, 0.16), rgba(255, 122, 61, 0.08));
      }
      h2 {
        margin: 0;
        font: 600 12px var(--sq-font-display);
        color: #ffc2cc;
      }
      p {
        margin: 0;
        font-size: 10px;
        line-height: 1.45;
      }
      ul {
        margin: 0;
        padding-left: 14px;
        font-size: 10px;
        color: var(--sq-text-muted);
      }
      .error {
        color: var(--sq-risk-critical);
      }
    `,
  ];

  override render(): TemplateResult {
    const { alert } = this;
    const left = Math.max(0, alert.unlockAt - this.nowSecs);
    const when = left >= 7_200 ? `${Math.ceil(left / 3_600)} h` : `${Math.ceil(left / 60)} min`;
    return html`<section role="alert">
      <h2>⚠ Une récupération de votre wallet est en cours</h2>
      <p>
        Une nouvelle passkey (empreinte <strong>${alert.newKeyFingerprint}</strong>) remplacera la vôtre dans ${when},
        sauf annulation.
      </p>
      ${alert.reasons.length > 0 ? html`<ul>${alert.reasons.map((r) => html`<li>${r}</li>`)}</ul>` : nothing}
      ${alert.contested
        ? html`<p>Récupération contestée : votre passkey seule ne peut plus l’annuler. Si ce n’est pas vous, contactez Swissquote.</p>`
        : html`<sq-button variant="secondary" ?disabled=${this.busy} @click=${this.#cancel}
            >Ce n’est pas moi · annuler avec ma passkey</sq-button
          >`}
      ${this.error ? html`<p class="error" role="alert">${errorMessage(this.error)}</p>` : nothing}
    </section>`;
  }

  readonly #cancel = (): void => {
    this.dispatchEvent(new CustomEvent('cancel-recovery', { detail: this.alert.id, bubbles: true, composed: true }));
  };
}

declare global {
  interface HTMLElementTagNameMap {
    'sq-recovery-alert': RecoveryAlertCard;
  }
}
