import { css, html, type TemplateResult } from 'lit';
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
      .card {
        display: grid;
        gap: var(--sq-space-3);
        justify-items: start;
      }
      .icon {
        display: grid;
        place-items: center;
        width: 48px;
        height: 48px;
        border-radius: 50%;
        color: var(--tone);
        background: color-mix(in srgb, var(--tone) 14%, transparent);
      }
      svg {
        width: 26px;
        height: 26px;
      }
      p {
        font-size: 14px;
        line-height: 1.45;
      }
      .details {
        width: 100%;
        box-sizing: border-box;
        display: grid;
        gap: 4px;
        font-size: 12px;
      }
      sq-button {
        width: 100%;
      }
    `,
  ];

  protected override renderReady(outcome: FinalOutcome): TemplateResult {
    const copy = COPY[outcome.kind];
    return html`
      <section class="card" role="status" style="--tone: var(--sq-risk-${copy.tone})" data-outcome=${outcome.kind}>
        <span class="icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
            ${copy.icon}
          </svg>
        </span>
        <h1>${copy.title}</h1>
        ${this.#body(outcome)}
        <sq-button variant="secondary" @click=${() => this.emit('done', undefined)}>Retour à l'accueil</sq-button>
      </section>
    `;
  }

  #body(outcome: FinalOutcome): TemplateResult {
    switch (outcome.kind) {
      case 'confirmed':
        return html`
          <p class="muted">Co-signée par Swissquote et inscrite au journal d'audit.</p>
          <div class="inset details">
            <span>Reçu n° ${outcome.receipt.seq} · signé par Swissquote</span>
            <span class="mono">Tx ${shortAddress(outcome.txHash)}</span>
          </div>
        `;
      case 'refused':
        // No reasons on purpose: a regulatory refusal must not disclose what was flagged.
        return html`
          <p class="muted">
            Cette transaction ne peut pas être co-signée pour des raisons réglementaires. Vos fonds n'ont pas bougé.
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
