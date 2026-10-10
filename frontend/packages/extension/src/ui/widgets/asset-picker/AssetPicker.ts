import type { AssetBalance } from '@sqw/types/AssetBalance';
import { css, html, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { Widget } from '../../core/Widget';

/** Segmented choice of the asset to send. `selected` is the asset address, `null` for the native asset. */
@customElement('sq-asset-picker')
export class AssetPicker extends Widget<readonly AssetBalance[]> {
  @property({ attribute: false }) selected: string | null = null;

  static override styles = css`
    .group {
      display: flex;
      gap: 4px;
      padding: 4px;
      border-radius: var(--sq-radius-md);
      background: var(--sq-surface-sunken);
    }
    button {
      flex: 1;
      font: inherit;
      font-size: 13px;
      font-weight: 650;
      padding: 8px;
      border: 0;
      border-radius: calc(var(--sq-radius-md) - 4px);
      background: transparent;
      color: var(--sq-text-muted);
      cursor: pointer;
      transition:
        background var(--sq-duration) var(--sq-ease),
        color var(--sq-duration) var(--sq-ease);
    }
    button[aria-checked='true'] {
      background: var(--sq-surface);
      color: var(--sq-text);
      box-shadow: var(--sq-shadow);
    }
    button:focus-visible {
      outline: 2px solid var(--sq-focus);
      outline-offset: 1px;
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
