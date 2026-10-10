import type { AssetBalance } from '@sqw/types/AssetBalance';
import { css, html, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { Widget } from '../../core/Widget';

const COIN_GLYPHS: Readonly<Record<string, string>> = { USDC: '$', ETH: '◆' };

/** Segmented choice of the asset to send. `selected` is the asset address, `null` for the native asset. */
@customElement('sq-asset-picker')
export class AssetPicker extends Widget<readonly AssetBalance[]> {
  @property({ attribute: false }) selected: string | null = null;

  static override styles = css`
    .group {
      display: flex;
      gap: 4px;
      padding: 4px;
      border-radius: 15px;
      border: 1px solid var(--sq-border);
      background: var(--sq-surface-sunken);
    }
    button {
      flex: 1;
      height: 36px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      font: inherit;
      font-size: 11px;
      font-weight: 600;
      border: 0;
      border-radius: 11px;
      background: transparent;
      color: var(--sq-text-muted);
      cursor: pointer;
      transition:
        background var(--sq-duration) var(--sq-ease),
        color var(--sq-duration) var(--sq-ease);
    }
    button[aria-checked='true'] {
      background: var(--sq-surface-high);
      color: #fff;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
    }
    button:focus-visible {
      outline: 2px solid var(--sq-focus);
      outline-offset: 1px;
    }
    .coin {
      width: 20px;
      height: 20px;
      border-radius: 50%;
      display: grid;
      place-items: center;
      color: #fff;
      font: 700 11px var(--sq-font-display);
      background: linear-gradient(145deg, #5e567b, #2d3047);
    }
    .USDC {
      background: linear-gradient(145deg, #54a9ff, #2775ca);
    }
    .ETH {
      background: linear-gradient(145deg, #b4a8ff, #6150c9);
    }
  `;

  protected override renderReady(balances: readonly AssetBalance[]): TemplateResult {
    return html`
      <div class="group" role="radiogroup" aria-label="Actif à envoyer">
        ${balances.map(
          (b) => html`<button
            type="button"
            role="radio"
            aria-checked=${b.asset === this.selected ? 'true' : 'false'}
            @click=${() => this.emit('asset-selected', b.asset)}
          >
            <span class="coin ${b.symbol}" aria-hidden="true">${COIN_GLYPHS[b.symbol] ?? b.symbol.slice(0, 1)}</span>
            ${b.symbol}
          </button>`,
        )}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'sq-asset-picker': AssetPicker;
  }
}
