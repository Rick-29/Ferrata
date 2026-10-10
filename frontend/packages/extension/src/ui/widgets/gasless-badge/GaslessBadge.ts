import { LitElement, css, html, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';

/** Network fees are sponsored by the paymaster; the user never needs ETH for gas. */
@customElement('sq-gasless-badge')
export class GaslessBadge extends LitElement {
  static override styles = css`
    span {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      font-weight: 650;
      padding: 4px 9px;
      border-radius: 999px;
      color: var(--sq-risk-low);
      background: color-mix(in srgb, var(--sq-risk-low) 12%, transparent);
    }
    svg {
      width: 12px;
      height: 12px;
    }
  `;

  override render(): TemplateResult {
    return html`
      <span title="Les frais de réseau sont pris en charge par Swissquote">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path d="M9 1 3 9h5l-1 6 6-8H8l1-6Z" stroke-linejoin="round" />
        </svg>
        Frais de réseau offerts
      </span>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'sq-gasless-badge': GaslessBadge;
  }
}
