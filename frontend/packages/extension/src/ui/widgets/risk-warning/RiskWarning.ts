import type { Reason } from '@sqw/types/Reason';
import { css, html, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';
import { REASON_LABELS } from '../../core/risk-copy';
import { textStyles } from '../../core/styles';
import { Widget } from '../../core/Widget';
import '../consent-checkbox/ConsentCheckbox';

export interface RiskWarningData {
  readonly reasons: readonly Reason[];
  readonly acknowledged: boolean;
  readonly disabled: boolean;
}

/**
 * High-risk alert: says plainly why, and asks the user to accept the risk themselves.
 * It warns; it never blocks. Ticking the box is what unlocks the second confirmation.
 */
@customElement('sq-risk-warning')
export class RiskWarning extends Widget<RiskWarningData> {
  static override styles = [
    textStyles,
    css`
      section {
        display: grid;
        gap: 9px;
        padding: 13px;
        border-radius: 19px;
        border: 1px solid rgba(255, 122, 61, 0.2);
        background: linear-gradient(130deg, rgba(255, 122, 61, 0.13), rgba(255, 77, 106, 0.07));
      }
      .head {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .head svg {
        flex: none;
        width: 25px;
        height: 25px;
        padding: 5px;
        box-sizing: border-box;
        border-radius: 9px;
        background: rgba(255, 122, 61, 0.15);
        color: var(--sq-risk-high);
      }
      h2 {
        font: 600 13px var(--sq-font-display);
        color: #ffd5c1;
      }
      p {
        font-size: 10px;
        line-height: 1.5;
        color: #d0a89b;
      }
      ul {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        gap: 5px;
      }
      li {
        min-height: 27px;
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 8px;
        border-radius: 10px;
        background: rgba(0, 0, 0, 0.1);
        font-size: 10px;
        color: #c7cad5;
        box-sizing: border-box;
      }
      li::before {
        content: '';
        width: 4px;
        height: 4px;
        border-radius: 50%;
        background: var(--sq-risk-high);
      }
    `,
  ];

  protected override renderReady(data: RiskWarningData): TemplateResult {
    return html`
      <section role="alert" aria-labelledby="risk-title">
        <div class="head">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
            <path d="M12 3 2 20h20L12 3Z" stroke-linejoin="round" />
            <path d="M12 10v4m0 3v.01" />
          </svg>
          <h2 id="risk-title">Risque élevé détecté</h2>
        </div>
        <p>Cette transaction présente des signaux inhabituels. Vérifiez-la avant de continuer :</p>
        <ul>
          ${data.reasons.map((r) => html`<li>${REASON_LABELS[r.code] ?? r.message}</li>`)}
        </ul>
        <p class="muted">
          Swissquote ne bloque pas cette transaction. Si vous la confirmez, elle sera exécutée et ne pourra pas être
          annulée.
        </p>
        <sq-consent-checkbox
          label="Je comprends les risques et je souhaite envoyer cette transaction."
          .checked=${data.acknowledged}
          ?disabled=${data.disabled}
        ></sq-consent-checkbox>
      </section>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'sq-risk-warning': RiskWarning;
  }
}
