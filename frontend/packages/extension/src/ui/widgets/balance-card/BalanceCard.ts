import type { AccountView } from '@sqw/types/AccountView';
import type { AssetBalance } from '@sqw/types/AssetBalance';
import { css, html, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';
import { formatUnits } from '../../core/format';
import { surfaceStyles, textStyles } from '../../core/styles';
import { Widget } from '../../core/Widget';
import '../copy-address/CopyAddress';

const HEADLINE_SYMBOL = 'USDC';

/** The headline balance (USDC, the demo's main asset) and the account address. */
@customElement('sq-balance-card')
export class BalanceCard extends Widget<AccountView> {
  static override styles = [
    textStyles,
    surfaceStyles,
    css`
      .card {
        display: grid;
        gap: var(--sq-space-3);
        position: relative;
        overflow: hidden;
        isolation: isolate;
      }
      .card::after {
        content: '';
        position: absolute;
        inset: auto -40px -60px auto;
        width: 160px;
        height: 160px;
        border-radius: 50%;
        background: radial-gradient(circle, color-mix(in srgb, var(--sq-accent) 22%, transparent), transparent 70%);
        z-index: -1;
      }
      .amount {
        display: flex;
        align-items: baseline;
        gap: var(--sq-space-2);
      }
      .value {
        font-size: 36px;
        font-weight: 700;
        letter-spacing: -0.03em;
        font-variant-numeric: tabular-nums;
        line-height: 1;
      }
      .symbol {
        font-size: 15px;
        font-weight: 650;
        color: var(--sq-text-muted);
      }
    `,
  ];

  protected override renderReady(account: AccountView): TemplateResult {
    const headline = headlineBalance(account.balances);
    return html`
      <section class="card" aria-label="Solde">
        <span class="eyebrow">Solde disponible</span>
        <div class="amount">
          <span class="value">${headline ? formatUnits(headline.amount, headline.decimals) : '0'}</span>
          <span class="symbol">${headline?.symbol ?? HEADLINE_SYMBOL}</span>
        </div>
        <div><sq-copy-address .address=${account.address}></sq-copy-address></div>
      </section>
    `;
  }
}

function headlineBalance(balances: readonly AssetBalance[]): AssetBalance | undefined {
  return balances.find((b) => b.symbol === HEADLINE_SYMBOL) ?? balances[0];
}

declare global {
  interface HTMLElementTagNameMap {
    'sq-balance-card': BalanceCard;
  }
}
