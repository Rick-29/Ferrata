import { LitElement, css, html, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { APP_ENDORSEMENT, APP_FULL_NAME, APP_NAME } from '@sqw/brand';

/**
 * Product wordmark (APP_NAME) with the Swissquote mark and endorsement (design: `.brand-official`).
 * The mark is redrawn in SVG from the reference logo; replace with the official asset when
 * Swissquote provides it. The product name lives in packages/brand.
 */
@customElement('sq-brand')
export class Brand extends LitElement {
  @property({ type: Boolean }) compact = false;

  static override styles = css`
    :host {
      display: inline-block;
    }
    .plate {
      position: relative;
      display: inline-flex;
      align-items: center;
      gap: 7px;
      padding: 7px 12px 7px 8px;
      border-radius: 11px;
      background: #ffffff;
      box-shadow: 0 8px 22px rgba(0, 0, 0, 0.16);
    }
    .word {
      font: 600 19px/1 var(--sq-font);
      letter-spacing: -0.035em;
      color: #2b2b2b;
    }
    svg {
      width: 22px;
      height: 22px;
      flex: none;
    }
    .pill {
      position: absolute;
      right: 7px;
      bottom: -7px;
      height: 15px;
      padding: 0 6px;
      border-radius: 999px;
      display: flex;
      align-items: center;
      background: var(--sq-accent);
      color: #fff;
      font: 700 7px/1 var(--sq-font);
      letter-spacing: 0.12em;
      text-transform: uppercase;
      box-shadow: 0 4px 10px rgba(255, 75, 31, 0.24);
    }
    :host([compact]) .plate {
      padding: 5px 9px 5px 6px;
      border-radius: 8px;
      gap: 5px;
    }
    :host([compact]) .word {
      font-size: 13px;
    }
    :host([compact]) svg {
      width: 16px;
      height: 16px;
    }
  `;

  override render(): TemplateResult {
    return html`
      <span class="plate" role="img" aria-label=${APP_FULL_NAME}>
        <svg viewBox="0 0 32 32" aria-hidden="true">
          <circle cx="16" cy="16" r="16" fill="#ff4b1f" />
          <rect x="8" y="9" width="16" height="3" rx="0.6" fill="#fff" />
          <path d="M8 14h16v9h-4v-5h-2.5v5h-3v-5H12v5H8z" fill="#fff" />
        </svg>
        <span class="word">${APP_NAME}</span>
        ${this.compact ? nothing : html`<span class="pill">${APP_ENDORSEMENT}</span>`}
      </span>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'sq-brand': Brand;
  }
}
