import type { AssetBalance } from '@sqw/types/AssetBalance';
import { css, html, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';
import { formatUnits } from '../../core/format';
import { textStyles } from '../../core/styles';
import { Widget } from '../../core/Widget';

/** Glossy round coin per asset (design: .coin). Unknown assets get a neutral one. */
const COINS: Readonly<Record<string, { readonly glyph: string; readonly name: string; readonly tone: string }>> = {
  USDC: { glyph: '$', name: 'USD Coin', tone: 'usdc' },
  ETH: { glyph: '◆', name: 'Ethereum', tone: 'eth' },
};

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
        border-radius: 18px;
        overflow: hidden;
        background: rgba(20, 23, 38, 0.82);
        border: 1px solid var(--sq-border);
        box-shadow: var(--sq-shadow);
      }
      li {
        min-height: 58px;
        padding: 10px 12px;
        display: flex;
        align-items: center;
        gap: 10px;
        box-sizing: border-box;
      }
      li + li {
        border-top: 1px solid var(--sq-border);
      }
      .coin {
        flex: none;
        width: 35px;
        height: 35px;
        border-radius: 50%;
        display: grid;
        place-items: center;
        color: #fff;
        font: 700 17px var(--sq-font-display);
        border: 2px solid rgba(255, 255, 255, 0.18);
        box-shadow:
          inset -4px -4px 8px rgba(0, 0, 0, 0.2),
          inset 3px 3px 7px rgba(255, 255, 255, 0.25),
          0 5px 14px var(--glow);
      }
      .usdc {
        background: linear-gradient(145deg, #54a9ff, #2775ca);
        --glow: rgba(86, 170, 255, 0.45);
      }
      .eth {
        background: linear-gradient(145deg, #b4a8ff, #6150c9);
        --glow: rgba(129, 115, 223, 0.45);
        font-size: 13px;
      }
      .other {
        background: linear-gradient(145deg, #5e567b, #2d3047);
        --glow: rgba(0, 0, 0, 0.3);
      }
      .name,
      .value {
        display: grid;
        gap: 3px;
      }
      .value {
        margin-left: auto;
        text-align: right;
      }
      strong {
        font-size: 11px;
        font-weight: 600;
      }
      small {
        font-size: 9px;
        color: var(--sq-text-muted);
      }
      .amount {
        font-variant-numeric: tabular-nums;
      }
      .empty {
        padding: var(--sq-space-4);
        text-align: center;
        font-size: 12px;
      }
    `,
  ];

  protected override renderReady(balances: readonly AssetBalance[]): TemplateResult {
    if (balances.length === 0) return html`<p class="muted empty">Aucun actif pour le moment.</p>`;
    return html`
      <ul aria-label="Actifs">
        ${balances.map((b) => {
          const coin = COINS[b.symbol];
          return html`<li>
            <span class="coin ${coin?.tone ?? 'other'}" aria-hidden="true">${coin?.glyph ?? b.symbol.slice(0, 1)}</span>
            <span class="name"><strong>${coin?.name ?? b.symbol}</strong><small>${b.symbol}</small></span>
            <span class="value"><strong class="amount">${formatUnits(b.amount, b.decimals)} ${b.symbol}</strong></span>
          </li>`;
        })}
      </ul>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'sq-asset-list': AssetList;
  }
}
