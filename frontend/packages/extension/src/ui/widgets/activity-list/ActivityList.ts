import { css, html, nothing, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';
import type { ActivityRow } from '../../core/activity';
import { shortAddress } from '../../core/format';
import { BAND_LABELS, bandColor } from '../../core/risk-copy';
import { textStyles } from '../../core/styles';
import { Widget } from '../../core/Widget';

const dateFormat = new Intl.DateTimeFormat('fr-CH', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

/** Account history: one row per event, with risk, flags and whether Swissquote signed a receipt. */
@customElement('sq-activity-list')
export class ActivityList extends Widget<readonly ActivityRow[]> {
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
        display: grid;
        gap: 4px;
        padding: var(--sq-space-3) var(--sq-space-4);
      }
      li + li {
        border-top: 1px solid var(--sq-border);
      }
      .line {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        gap: var(--sq-space-2);
      }
      .label {
        font-weight: 650;
        font-size: 14px;
      }
      .amount {
        font-weight: 650;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }
      .out {
        color: var(--sq-text);
      }
      .in {
        color: var(--sq-risk-low);
      }
      .meta {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        align-items: center;
        font-size: 12px;
        color: var(--sq-text-muted);
      }
      .chip {
        font-size: 11px;
        font-weight: 650;
        padding: 2px 8px;
        border-radius: 999px;
        color: var(--tone);
        background: color-mix(in srgb, var(--tone) 13%, transparent);
      }
      .receipt {
        --tone: var(--sq-risk-low);
      }
      a {
        color: var(--sq-accent);
        font-weight: 600;
      }
      a:focus-visible {
        outline: 2px solid var(--sq-focus);
        outline-offset: 2px;
      }
      .empty {
        padding: var(--sq-space-6) var(--sq-space-4);
        text-align: center;
      }
    `,
  ];

  protected override renderReady(rows: readonly ActivityRow[]): TemplateResult {
    if (rows.length === 0) return html`<p class="muted empty">Aucune activité pour le moment.</p>`;
    return html`<ul aria-label="Activité">${rows.map((row) => this.#row(row))}</ul>`;
  }

  #row(row: ActivityRow): TemplateResult {
    const sign = row.direction === 'out' ? '−' : row.direction === 'in' ? '+' : '';
    const risk = row.reviewedRisk ?? row.riskLevel;
    return html`
      <li>
        <div class="line">
          <span class="label">${row.label}</span>
          ${row.amount ? html`<span class="amount ${row.direction}">${sign}${row.amount}</span>` : nothing}
        </div>
        <div class="meta">
          <time datetime=${new Date(row.timestamp * 1000).toISOString()}>${dateFormat.format(row.timestamp * 1000)}</time>
          ${row.counterparty ? html`<span class="mono" title=${row.counterparty}>${shortAddress(row.counterparty)}</span>` : nothing}
          ${row.network !== 'ferra' ? html`<span>${row.network}</span>` : nothing}
          ${risk ? html`<span class="chip" style="--tone: ${bandColor(risk)}">${BAND_LABELS[risk]}</span>` : nothing}
          ${row.flags.map(
            (f) => html`<span class="chip" style="--tone: ${bandColor(f.severity)}" title=${f.message}>⚑ ${f.code}</span>`,
          )}
          ${row.hasReceipt ? html`<span class="chip receipt" title="Reçu signé par Swissquote">✓ Reçu</span>` : nothing}
          ${row.explorerUrl
            ? html`<a href=${row.explorerUrl} target="_blank" rel="noopener noreferrer">Explorateur ↗</a>`
            : nothing}
        </div>
      </li>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'sq-activity-list': ActivityList;
  }
}
