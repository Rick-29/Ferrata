import { css, html, nothing, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';
import type { ActivityRow } from '../../core/activity';
import { shortAddress } from '../../core/format';
import { icon, type IconName } from '../../core/icons';
import { BAND_LABELS, bandColor } from '../../core/risk-copy';
import { textStyles } from '../../core/styles';
import { Widget } from '../../core/Widget';

const ICONS: Readonly<Record<ActivityRow['direction'], IconName>> = { out: 'arrowUp', in: 'arrowDown', none: 'gear' };

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
      }
      li {
        min-height: 66px;
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 8px 0;
        border-bottom: 1px solid var(--sq-border);
      }
      .icon {
        flex: none;
        width: 32px;
        height: 32px;
        border-radius: 11px;
        display: grid;
        place-items: center;
        color: #d7c9ff;
        background: linear-gradient(145deg, rgba(255, 61, 127, 0.12), rgba(123, 92, 255, 0.14));
      }
      .main {
        flex: 1;
        min-width: 0;
        display: grid;
        gap: 4px;
      }
      .label {
        font-size: 11px;
        font-weight: 600;
      }
      .meta {
        display: flex;
        flex-wrap: wrap;
        gap: 5px;
        align-items: center;
        font-size: 9px;
        color: var(--sq-text-muted);
      }
      .amount {
        font-size: 11px;
        font-weight: 600;
        white-space: nowrap;
        font-variant-numeric: tabular-nums;
      }
      .in {
        color: var(--sq-risk-low);
      }
      .chip {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        padding: 2px 6px;
        border-radius: 999px;
        font-size: 8px;
        font-weight: 600;
        color: var(--tone);
        background: color-mix(in srgb, var(--tone) 10%, transparent);
      }
      .receipt {
        --tone: var(--sq-risk-low);
      }
      a {
        color: #ae9eff;
        font-weight: 600;
      }
      a:focus-visible {
        outline: 2px solid var(--sq-focus);
        outline-offset: 2px;
      }
      .empty {
        padding: var(--sq-space-6) var(--sq-space-4);
        text-align: center;
        font-size: 12px;
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
        <span class="icon" aria-hidden="true">${icon(ICONS[row.direction])}</span>
        <div class="main">
          <span class="label">${row.label}</span>
          <div class="meta">
          <time datetime=${new Date(row.timestamp * 1000).toISOString()}>${dateFormat.format(row.timestamp * 1000)}</time>
          ${row.counterparty ? html`<span class="mono" title=${row.counterparty}>${shortAddress(row.counterparty)}</span>` : nothing}
          ${row.network !== 'ferra' ? html`<span>${row.network}</span>` : nothing}
          ${risk ? html`<span class="chip" style="--tone: ${bandColor(risk)}">${BAND_LABELS[risk]}</span>` : nothing}
          ${row.flags.map(
            (f) => html`<span class="chip" style="--tone: ${bandColor(f.severity)}" title=${f.message}>⚑ ${f.code}</span>`,
          )}
          ${row.hasReceipt ? html`<span class="chip receipt" title="Analysé par Swissquote, reçu inscrit au journal">✓ Analysé</span>` : nothing}
          ${row.explorerUrl
            ? html`<a href=${row.explorerUrl} target="_blank" rel="noopener noreferrer">Explorateur ↗</a>`
            : nothing}
          </div>
        </div>
        ${row.amount ? html`<span class="amount ${row.direction}">${sign}${row.amount}</span>` : nothing}
      </li>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'sq-activity-list': ActivityList;
  }
}
