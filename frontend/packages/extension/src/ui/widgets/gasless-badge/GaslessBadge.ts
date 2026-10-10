import { LitElement, css, html, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';
import { icon } from '../../core/icons';

/** Network fees are sponsored by the paymaster; the user never needs ETH for gas. */
@customElement('sq-gasless-badge')
export class GaslessBadge extends LitElement {
  static override styles = css`
    span {
      height: 24px;
      padding: 0 9px;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      border-radius: 999px;
      border: 1px solid rgba(255, 61, 127, 0.12);
      background: rgba(255, 61, 127, 0.09);
      color: #ffbed4;
      font-size: 9px;
    }
  `;

  override render(): TemplateResult {
    return html`<span title="Les frais de réseau sont pris en charge par Swissquote">
      ${icon('spark', 12)} Frais de réseau offerts
    </span>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'sq-gasless-badge': GaslessBadge;
  }
}
