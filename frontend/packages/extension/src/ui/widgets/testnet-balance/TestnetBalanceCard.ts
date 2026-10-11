import { css, html, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';
import { formatUnits } from '../../core/format';
import { Widget } from '../../core/Widget';
import type { TestnetWallet } from '../../services/UiBridge';
import '../copy-address/CopyAddress';

/**
 * The Testnet tab's headline (P3), same layout as `sq-balance-card`: the biggest test balance,
 * then one address chip per test network and a "testnet" badge instead of the gasless one.
 */
@customElement('sq-testnet-balance')
export class TestnetBalanceCard extends Widget<readonly TestnetWallet[]> {
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
    .chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 9px;
      color: var(--sq-text-muted);
    }
    .badge {
      display: inline-flex;
      align-items: center;
      height: 24px;
      padding: 0 9px;
      border-radius: 999px;
      font-size: 9px;
      font-weight: 600;
      color: var(--sq-risk-medium);
      border: 1px solid rgba(255, 181, 71, 0.35);
      background: rgba(255, 181, 71, 0.08);
    }
  `;

  protected override renderReady(wallets: readonly TestnetWallet[]): TemplateResult {
    const headline = headlineWallet(wallets);
    return html`
      <section aria-label="Solde de test">
        <span class="label">Solde de test</span>
        <p class="amount">
          ${headline?.balance ? formatUnits(headline.balance, headline.decimals) : '0'}
          <span class="symbol">${headline?.symbol ?? 'SOL'}</span>
        </p>
        <div class="chips">
          ${addressChips(wallets).map(
            (c) => html`<span class="chip">${c.label}<sq-copy-address .address=${c.address}></sq-copy-address></span>`,
          )}
          <span class="badge">Testnet · sans valeur</span>
        </div>
      </section>
    `;
  }
}

/** One chip per distinct address: every EVM test network shares the same key, so one "EVM" chip. */
function addressChips(wallets: readonly TestnetWallet[]): readonly { label: string; address: string }[] {
  const seen = new Set<string>();
  return wallets.flatMap((w) => {
    if (seen.has(w.address.toLowerCase())) return [];
    seen.add(w.address.toLowerCase());
    return [{ label: w.network === 'solana-devnet' ? 'Solana' : 'EVM', address: w.address }];
  });
}

/** The first test network holding coins, else the first one (Solana devnet). */
function headlineWallet(wallets: readonly TestnetWallet[]): TestnetWallet | undefined {
  return wallets.find((w) => w.balance !== null && BigInt(w.balance) > 0n) ?? wallets[0];
}

declare global {
  interface HTMLElementTagNameMap {
    'sq-testnet-balance': TestnetBalanceCard;
  }
}
