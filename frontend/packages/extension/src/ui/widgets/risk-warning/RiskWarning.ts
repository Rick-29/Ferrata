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
        gap: var(--sq-space-3);
        padding: var(--sq-space-4);
        border-radius: var(--sq-radius-lg);
        border: 1px solid color-mix(in srgb, var(--sq-risk-high) 45%, transparent);
        background: color-mix(in srgb, var(--sq-risk-high) 9%, var(--sq-surface));
      }
      .head {
        display: flex;
        gap: var(--sq-space-2);
        align-items: center;
        color: var(--sq-risk-high);
      }
      svg {
        flex: none;
        width: 20px;
        height: 20px;
      }
      h2 {
        color: var(--sq-text);
      }
      p {
        font-size: 13px;
        line-height: 1.45;
      }
      ul {
        margin: 0;
        padding-left: 18px;
        font-size: 13px;
        display: grid;
        gap: 2px;
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
