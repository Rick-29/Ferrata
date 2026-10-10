import type { AssetBalance } from '@sqw/types/AssetBalance';
import { css, html, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';
import { formatUnits } from '../../core/format';
import { textStyles } from '../../core/styles';
import { Widget } from '../../core/Widget';

/** Every asset the account holds, one row each. */
@customElement('sq-asset-list')
export class AssetList extends Widget<readonly AssetBalance[]> {
  static override styles = [
    textStyles,
    css`
      ul {
        list-style: none;
        margin: 0;
        padding: 0;
        border-radius: var(--sq-radius-lg);
        background: var(--sq-surface);
        border: 1px solid var(--sq-border);
      }
      li {
        display: flex;
        align-items: center;
        gap: var(--sq-space-3);
        padding: var(--sq-space-3) var(--sq-space-4);
      }
      li + li {
        border-top: 1px solid var(--sq-border);
      }
      .monogram {
        display: grid;
        place-items: center;
        width: 32px;
        height: 32px;
        border-radius: 50%;
        font-size: 12px;
        font-weight: 700;
        color: var(--sq-text);
        background: var(--sq-surface-sunken);
      }
      .symbol {
        font-weight: 650;
        flex: 1;
      }
      .amount {
        font-variant-numeric: tabular-nums;
        font-weight: 600;
      }
      .empty {
        padding: var(--sq-space-4);
        text-align: center;
      }
    `,
  ];

  protected override renderReady(balances: readonly AssetBalance[]): TemplateResult {
    if (balances.length === 0) return html`<p class="muted empty">Aucun actif pour le moment.</p>`;
    return html`
      <ul aria-label="Actifs">
        ${balances.map(
          (b) => html`<li>
            <span class="monogram" aria-hidden="true">${b.symbol.slice(0, 1)}</span>
            <span class="symbol">${b.symbol}</span>
            <span class="amount">${formatUnits(b.amount, b.decimals)}</span>
          </li>`,
        )}
      </ul>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'sq-asset-list': AssetList;
  }
}
