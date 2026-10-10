import type { RiskAssessment } from '@sqw/types/RiskAssessment';
import { css, html, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';
import { BAND_LABELS, bandColor } from '../../core/risk-copy';
import { Widget } from '../../core/Widget';

// "Low risk" with no signal at all reads as "safe"; say only what we know.
const NO_SIGNAL = 'Aucun signal détecté';

export type RiskBadgeData = Pick<RiskAssessment, 'band' | 'score'>;

/** Band and score, coloured by band. The colour is never the only signal: the label says it too. */
@customElement('sq-risk-badge')
export class RiskBadge extends Widget<RiskBadgeData> {
  static override styles = css`
    .badge {
      min-height: 24px;
      padding: 0 10px;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border-radius: 999px;
      white-space: nowrap;
      font-size: 10px;
      font-weight: 600;
      color: var(--band);
      border: 1px solid color-mix(in srgb, var(--band) 18%, transparent);
      background: color-mix(in srgb, var(--band) 8%, transparent);
    }
    .dot {
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: var(--band);
      box-shadow: 0 0 7px var(--band);
    }
    .score {
      font-variant-numeric: tabular-nums;
      opacity: 0.85;
    }
  `;

  protected override renderReady({ band, score }: RiskBadgeData): TemplateResult {
    return html`
      <span class="badge" style="--band: ${bandColor(band)}" data-band=${band}>
        <span class="dot" aria-hidden="true"></span>
        ${score === 0 ? NO_SIGNAL : BAND_LABELS[band]}
        <span class="score" aria-label="score ${score} sur 100">${score}/100</span>
      </span>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'sq-risk-badge': RiskBadge;
  }
}
