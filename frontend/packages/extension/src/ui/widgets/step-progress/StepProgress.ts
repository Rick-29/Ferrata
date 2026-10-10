import { css, html, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';
import { icon } from '../../core/icons';
import { Widget } from '../../core/Widget';

export interface StepProgressData {
  readonly steps: readonly string[];
  /** Zero-based index of the step in progress. */
  readonly current: number;
}

/** Numbered dots on a line; done steps show a check (design: .steps). */
@customElement('sq-step-progress')
export class StepProgress extends Widget<StepProgressData> {
  static override styles = css`
    ol {
      position: relative;
      list-style: none;
      margin: 0;
      padding: 0 6px;
      display: flex;
      justify-content: space-between;
    }
    ol::before {
      content: '';
      position: absolute;
      top: 11px;
      left: 37px;
      right: 37px;
      height: 1px;
      background: var(--sq-border-strong);
    }
    li {
      position: relative;
      z-index: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
      font-size: 9px;
      color: var(--sq-text-faint);
    }
    .dot {
      width: 22px;
      height: 22px;
      border-radius: 999px;
      display: grid;
      place-items: center;
      border: 1px solid var(--sq-border-strong);
      background: var(--sq-bg);
      font-size: 9px;
    }
    li.on {
      color: var(--sq-text);
    }
    li.on .dot {
      border: 0;
      background: var(--sq-brand-gradient);
      box-shadow: 0 0 16px rgba(255, 75, 31, 0.3);
      color: #fff;
    }
  `;

  protected override renderReady({ steps, current }: StepProgressData): TemplateResult {
    return html`
      <ol aria-label="Progression">
        ${steps.map(
          (label, i) => html`<li class=${i <= current ? 'on' : ''} aria-current=${i === current ? 'step' : 'false'}>
            <span class="dot">${i < current ? icon('check', 11) : i + 1}</span>
            <span>${label}</span>
          </li>`,
        )}
      </ol>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'sq-step-progress': StepProgress;
  }
}
