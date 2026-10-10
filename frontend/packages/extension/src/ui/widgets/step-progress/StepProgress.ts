import { css, html, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';
import { Widget } from '../../core/Widget';

export interface StepProgressData {
  readonly steps: readonly string[];
  /** Zero-based index of the step in progress. */
  readonly current: number;
}

@customElement('sq-step-progress')
export class StepProgress extends Widget<StepProgressData> {
  static override styles = css`
    ol {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      grid-auto-flow: column;
      grid-auto-columns: 1fr;
      gap: var(--sq-space-2);
    }
    li {
      display: grid;
      gap: 6px;
      font-size: 11px;
      font-weight: 600;
      color: var(--sq-text-muted);
    }
    li::before {
      content: '';
      height: 3px;
      border-radius: 2px;
      background: var(--sq-border);
      transition: background var(--sq-duration) var(--sq-ease);
    }
    li.done::before,
    li[aria-current='step']::before {
      background: var(--sq-accent);
    }
    li[aria-current='step'] {
      color: var(--sq-text);
    }
  `;

  protected override renderReady({ steps, current }: StepProgressData): TemplateResult {
    return html`
      <ol aria-label="Progression">
        ${steps.map(
          (label, i) => html`<li class=${i < current ? 'done' : ''} aria-current=${i === current ? 'step' : 'false'}>
            ${label}
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
