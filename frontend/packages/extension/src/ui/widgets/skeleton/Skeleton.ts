import { LitElement, css, html, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

const DEFAULT_LINES = 3;

/** Placeholder shown while a widget loads. Shimmer stops under prefers-reduced-motion. */
@customElement('sq-skeleton')
export class Skeleton extends LitElement {
  @property({ type: Number }) lines = DEFAULT_LINES;

  static override styles = css`
    :host {
      display: grid;
      gap: var(--sq-space-2, 8px);
    }
    .line {
      height: 14px;
      border-radius: var(--sq-radius-sm, 6px);
      background: linear-gradient(
        90deg,
        var(--sq-surface-sunken, #eee) 0%,
        var(--sq-border, #ddd) 50%,
        var(--sq-surface-sunken, #eee) 100%
      );
      background-size: 200% 100%;
      animation: shimmer 1.2s linear infinite;
    }
    .line:first-child {
      height: 28px;
      width: 60%;
    }
    .line:last-child {
      width: 80%;
    }
    @keyframes shimmer {
      from {
        background-position: 200% 0;
      }
      to {
        background-position: -200% 0;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .line {
        animation: none;
      }
    }
  `;

  override render(): TemplateResult {
    return html`
      <div role="status" aria-label="Chargement">
        ${Array.from({ length: this.lines }, () => html`<div class="line"></div>`)}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'sq-skeleton': Skeleton;
  }
}
