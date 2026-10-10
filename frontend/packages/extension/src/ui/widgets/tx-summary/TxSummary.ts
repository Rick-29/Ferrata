import { css, html, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';
import { formatUnits } from '../../core/format';
import { textStyles } from '../../core/styles';
import { Widget } from '../../core/Widget';

export interface TxSummaryData {
  readonly to: string;
  /** Base units, hex. */
  readonly amount: string;
  readonly symbol: string;
  readonly decimals: number;
}

/** What is being sent and to whom. The full recipient address is shown: never truncate it on a confirm screen. */
@customElement('sq-tx-summary')
export class TxSummary extends Widget<TxSummaryData> {
  static override styles = [
    textStyles,
    css`
      :host {
        display: grid;
        gap: var(--sq-space-2);
      }
      .amount {
        display: flex;
        align-items: baseline;
        gap: var(--sq-space-2);
      }
      .value {
        font-size: 30px;
        font-weight: 700;
        letter-spacing: -0.03em;
        font-variant-numeric: tabular-nums;
      }
      .symbol {
        font-weight: 650;
        color: var(--sq-text-muted);
      }
      .to {
        display: grid;
        gap: 2px;
      }
    `,
  ];

  protected override renderReady(tx: TxSummaryData): TemplateResult {
    return html`
      <span class="eyebrow">Vous envoyez</span>
      <div class="amount">
        <span class="value">${formatUnits(tx.amount, tx.decimals, { exact: true })}</span>
        <span class="symbol">${tx.symbol}</span>
      </div>
      <div class="to">
        <span class="eyebrow">À</span>
        <span class="mono">${tx.to}</span>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'sq-tx-summary': TxSummary;
  }
}
