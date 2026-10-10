import type { Reason } from '@sqw/types/Reason';
import { css, html, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';
import { REASON_LABELS } from '../../core/risk-copy';
import { textStyles } from '../../core/styles';
import { Widget } from '../../core/Widget';

/** Why the transaction scored what it did, highest weight first. */
@customElement('sq-reason-list')
export class ReasonList extends Widget<readonly Reason[]> {
  static override styles = [
    textStyles,
    css`
      ul {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        gap: 5px;
      }
      li {
        min-height: 30px;
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 7px 10px;
        border-radius: 10px;
        background: rgba(255, 255, 255, 0.035);
        font-size: 10px;
        color: #c7cad5;
        box-sizing: border-box;
      }
      li::before {
        content: '';
        flex: none;
        width: 4px;
        height: 4px;
        border-radius: 50%;
        background: var(--sq-risk-medium);
      }
      li span:first-child {
        margin-right: auto;
      }
      .points {
        font-variant-numeric: tabular-nums;
        font-weight: 600;
        color: var(--sq-risk-medium);
      }
      .none {
        font-size: 11px;
      }
    `,
  ];

  protected override renderReady(reasons: readonly Reason[]): TemplateResult {
    if (reasons.length === 0) return html`<p class="muted none">Aucun signal de risque détecté.</p>`;
    const sorted = [...reasons].sort((a, b) => b.points - a.points);
    return html`
      <ul aria-label="Signaux de risque">
        ${sorted.map(
          (r) => html`<li>
            <span>${REASON_LABELS[r.code] ?? r.message}</span>
            <span class="points">+${r.points}</span>
          </li>`,
        )}
      </ul>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'sq-reason-list': ReasonList;
  }
}
