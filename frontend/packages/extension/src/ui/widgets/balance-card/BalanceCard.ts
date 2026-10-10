import type { AccountView } from '@sqw/types/AccountView';
import type { AssetBalance } from '@sqw/types/AssetBalance';
import { css, html, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';
import { formatUnits } from '../../core/format';
import { Widget } from '../../core/Widget';
import '../copy-address/CopyAddress';
import '../gasless-badge/GaslessBadge';

const HEADLINE_SYMBOL = 'USDC';

/** The headline balance (USDC, the demo's main asset), the address and the gasless badge (design: .balance). */
@customElement('sq-balance-card')
export class BalanceCard extends Widget<AccountView> {
  static override styles = css`
    section {
      display: grid;
      justify-items: center;
      gap: 11px;
      margin-top: 10px;
      text-align: center;
    }
    .label {
      font-size: 9px;
      letter-spacing: 0.15em;
      text-transform: uppercase;
      color: var(--sq-text-muted);
    }
    .amount {
      margin: 0;
      font: 600 42px/1 var(--sq-font-display);
      letter-spacing: -0.06em;
      text-shadow: 0 0 30px rgba(255, 61, 127, 0.24);
      font-variant-numeric: tabular-nums;
    }
    .symbol {
      font-size: 17px;
      color: #d7d9e5;
      letter-spacing: -0.03em;
    }
    .chips {
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      gap: 5px;
    }
  `;

  protected override renderReady(account: AccountView): TemplateResult {
    const headline = headlineBalance(account.balances);
    return html`
      <section aria-label="Solde">
        <span class="label">Solde disponible</span>
        <p class="amount">
          ${headline ? formatUnits(headline.amount, headline.decimals) : '0'}
          <span class="symbol">${headline?.symbol ?? HEADLINE_SYMBOL}</span>
        </p>
        <div class="chips">
          <sq-copy-address .address=${account.address}></sq-copy-address>
          <sq-gasless-badge></sq-gasless-badge>
        </div>
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
