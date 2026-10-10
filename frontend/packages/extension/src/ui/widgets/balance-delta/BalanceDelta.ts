import { css, html, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';
import { formatUnits, toHexUnits } from '../../core/format';
import { textStyles } from '../../core/styles';
import { Widget } from '../../core/Widget';

export interface DeltaRow {
  readonly symbol: string;
  readonly decimals: number;
  /** Base units, hex. */
  readonly before: string;
  readonly after: string;
}

const EXACT = { exact: true } as const;

/** Simulated effect on each balance: what the user will actually have after this transaction. */
@customElement('sq-balance-delta')
export class BalanceDelta extends Widget<readonly DeltaRow[]> {
  static override styles = [
    textStyles,
    css`
      ul {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        gap: 6px;
      }
      li {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        gap: var(--sq-space-2);
        font-size: 10px;
        font-variant-numeric: tabular-nums;
      }
      .symbol {
        color: var(--sq-text-muted);
      }
      .flow {
        font: 600 12px var(--sq-font-display);
        margin-left: auto;
      }
      .flow i {
        font-style: normal;
        color: var(--sq-pink);
        margin: 0 2px;
      }
      .change {
        font-weight: 600;
        min-width: 52px;
        text-align: right;
      }
      .out {
        color: var(--sq-risk-critical);
      }
      .in {
        color: var(--sq-risk-low);
      }
    `,
  ];

  protected override renderReady(rows: readonly DeltaRow[]): TemplateResult {
    return html`
      <ul aria-label="Effet sur vos soldes">
        ${rows.map((row) => {
          const change = BigInt(row.after) - BigInt(row.before);
          const sign = change < 0n ? '−' : '+';
          const abs = change < 0n ? -change : change;
          return html`<li>
            <span class="symbol">${row.symbol}</span>
            <span class="flow">${formatUnits(row.before, row.decimals, EXACT)}<i> → </i>${formatUnits(row.after, row.decimals, EXACT)}</span>
            <span class="change ${change < 0n ? 'out' : 'in'}">${sign}${formatUnits(toHexUnits(abs), row.decimals, EXACT)}</span>
          </li>`;
        })}
      </ul>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'sq-balance-delta': BalanceDelta;
  }
}
