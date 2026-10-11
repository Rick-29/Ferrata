import { css, html, nothing, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';
import { shortAddress } from '../../core/format';
import { surfaceStyles, textStyles } from '../../core/styles';
import { Widget } from '../../core/Widget';
import type { SendOutcome } from '../../services/UiBridge';
import '../button/Button';

/** Outcomes that end the confirm flow. A confirmation request is not one: the Confirm screen handles it in place. */
export type FinalOutcome = Exclude<SendOutcome, { readonly kind: 'confirmation_required' }>;

interface Copy {
  readonly tone: 'low' | 'critical';
  readonly title: string;
  readonly icon: TemplateResult;
}

const CHECK = html`<path d="m5 12 5 5 9-10" />`;
const CROSS = html`<path d="m7 7 10 10M17 7 7 17" />`;

const COPY: Readonly<Record<FinalOutcome['kind'], Copy>> = {
  confirmed: { tone: 'low', title: 'Transaction envoyée', icon: CHECK },
  refused: { tone: 'critical', title: 'Transaction refusée', icon: CROSS },
};

/** End of the send flow: what happened and what it means for the user's funds. */
@customElement('sq-outcome-panel')
export class OutcomePanel extends Widget<FinalOutcome> {
  static override styles = [
    textStyles,
    surfaceStyles,
    css`
      section {
        min-height: 520px;
        display: flex;
        flex-direction: column;
        justify-content: center;
        align-items: stretch;
        gap: 14px;
        text-align: center;
      }
      .orb {
        position: relative;
        width: 94px;
        height: 94px;
        margin: 0 auto 13px;
        border-radius: 35px;
        display: grid;
        place-items: center;
        color: var(--tone);
        background: linear-gradient(145deg, color-mix(in srgb, var(--tone) 22%, transparent), rgba(123, 92, 255, 0.16));
        border: 1px solid color-mix(in srgb, var(--tone) 20%, transparent);
        box-shadow: 0 0 45px color-mix(in srgb, var(--tone) 18%, transparent);
      }
      .orb::before {
        content: '';
        position: absolute;
        inset: 15px;
        border-radius: 23px;
        background: color-mix(in srgb, var(--tone) 10%, transparent);
      }
      .orb svg {
        position: relative;
        width: 38px;
        height: 38px;
      }
      .eyebrow {
        letter-spacing: 0.12em;
      }
      h1 {
        font-size: 28px;
      }
      p {
        max-width: 285px;
        margin: 0 auto;
        font-size: 11px;
        line-height: 1.5;
      }
      .details {
        margin-top: 10px;
        display: grid;
        gap: 8px;
        padding: 12px;
        border-radius: 18px;
        border: 1px solid var(--sq-border);
        background: var(--sq-surface);
        font-size: 10px;
      }
      .receipt {
        justify-self: center;
        padding: 5px 9px;
        border-radius: 999px;
        color: var(--sq-risk-low);
        background: rgba(46, 213, 152, 0.08);
      }
      sq-button {
        margin-top: 10px;
      }
    `,
  ];

  protected override renderReady(outcome: FinalOutcome): TemplateResult {
    const copy = COPY[outcome.kind];
    return html`
      <section role="status" style="--tone: var(--sq-risk-${copy.tone})" data-outcome=${outcome.kind}>
        <span class="orb" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
            ${copy.icon}
          </svg>
        </span>
        <span class="eyebrow">${copy.title}</span>
        ${this.#body(outcome)}
        <sq-button variant="secondary" @click=${() => this.emit('done', undefined)}>Retour à l'accueil</sq-button>
      </section>
    `;
  }

  #body(outcome: FinalOutcome): TemplateResult {
    switch (outcome.kind) {
      case 'confirmed':
        return html`
          <h1>${outcome.receipt ? 'Analysée par Swissquote' : 'Envoyée avec votre seule passkey'}</h1>
          <p class="muted">
            ${outcome.receipt
              ? "La transaction est exécutée et l'analyse de Swissquote est inscrite au journal d'audit."
              : "La transaction est exécutée sans l'analyse de Swissquote : votre passkey suffit."}
          </p>
          <div class="details">
            ${outcome.receipt ? html`<span class="receipt">Reçu d'analyse n° ${outcome.receipt.seq} · Swissquote</span>` : nothing}
            ${outcome.explorerUrl
              ? html`<a class="mono" href=${outcome.explorerUrl} target="_blank" rel="noopener noreferrer">Tx ${shortAddress(outcome.txHash)} · Base Sepolia, sans gas</a>`
              : html`<span class="mono muted">Tx ${shortAddress(outcome.txHash)}</span>`}
          </div>
        `;
      case 'refused':
        // No reasons on purpose: a regulatory refusal must not disclose what was flagged.
        return html`
          <h1>Signature Swissquote indisponible</h1>
          <p class="muted">
            Swissquote ne peut pas signer cette transaction pour des raisons réglementaires. Vos fonds n'ont pas bougé.
          </p>
        `;
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'sq-outcome-panel': OutcomePanel;
  }
}
