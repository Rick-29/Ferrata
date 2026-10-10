import { LitElement, css, html, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';

/**
 * The one sentence that frames Swissquote's risk analysis as advice, never as a guarantee.
 * Wording agreed in implementation/… Positionnement légal du blocage.md; change it there first.
 */
export const RISK_DISCLAIMER =
  "L'analyse de risque de Swissquote est indicative : elle ne garantit pas la détection des transactions frauduleuses et ne les bloque pas. Vous restez seul décisionnaire de vos transactions.";

@customElement('sq-legal-notice')
export class LegalNotice extends LitElement {
  static override styles = css`
    p {
      margin: 0;
      font-size: 11px;
      line-height: 1.45;
      color: var(--sq-text-muted);
    }
  `;

  override render(): TemplateResult {
    return html`<p>${RISK_DISCLAIMER}</p>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'sq-legal-notice': LegalNotice;
  }
}
