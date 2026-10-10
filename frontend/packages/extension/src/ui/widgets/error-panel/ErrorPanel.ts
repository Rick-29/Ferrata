import { LitElement, css, html, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { errorMessage, type UiError } from '../../core/errors';
import { emitWidgetEvent } from '../../core/events';

/**
 * Renders a UiError with the user-facing text from the error table. Plain LitElement, not a
 * Widget, because Widget itself renders it.
 */
@customElement('sq-error-panel')
export class ErrorPanel extends LitElement {
  @property({ attribute: false }) error: UiError | null = null;

  static override styles = css`
    :host {
      display: block;
    }
    .panel {
      display: grid;
      gap: var(--sq-space-2, 8px);
      padding: var(--sq-space-3, 12px) var(--sq-space-4, 16px);
      border-radius: var(--sq-radius-md, 12px);
      border: 1px solid color-mix(in srgb, var(--sq-risk-critical, #c0182e) 35%, transparent);
      background: color-mix(in srgb, var(--sq-risk-critical, #c0182e) 8%, var(--sq-surface, #fff));
    }
    p {
      margin: 0;
      font-size: 14px;
      line-height: 1.4;
    }
    code {
      font-family: var(--sq-font-mono, monospace);
      font-size: 11px;
      color: var(--sq-text-muted, #666);
    }
    button {
      justify-self: start;
      font: inherit;
      font-size: 13px;
      font-weight: 600;
      padding: 6px 12px;
      border-radius: var(--sq-radius-sm, 6px);
      border: 1px solid var(--sq-border, #ddd);
      background: var(--sq-surface, #fff);
      color: var(--sq-text, #111);
      cursor: pointer;
      transition: background var(--sq-duration, 160ms) var(--sq-ease, ease);
    }
    button:hover {
      background: var(--sq-surface-sunken, #eee);
    }
    button:focus-visible {
      outline: 2px solid var(--sq-focus, #1f6feb);
      outline-offset: 2px;
    }
  `;

  override render(): TemplateResult | typeof nothing {
    if (!this.error) return nothing;
    return html`
      <div class="panel" role="alert">
        <p>${errorMessage(this.error)}</p>
        <code>${this.error.code}</code>
        ${this.error.retryable ? html`<button type="button" @click=${this.#retry}>Réessayer</button>` : nothing}
      </div>
    `;
  }

  #retry(): void {
    emitWidgetEvent(this, 'retry', undefined);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'sq-error-panel': ErrorPanel;
  }
}
