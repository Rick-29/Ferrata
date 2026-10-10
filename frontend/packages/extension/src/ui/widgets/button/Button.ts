import { LitElement, css, html, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

/** The one button. `busy` shows a spinner and blocks clicks so an action can't fire twice. */
@customElement('sq-button')
export class Button extends LitElement {
  @property({ reflect: true }) variant: ButtonVariant = 'primary';
  @property({ type: Boolean }) busy = false;
  @property({ type: Boolean }) disabled = false;

  constructor() {
    super();
    // Listeners bound by the parent sit on this host, so a disabled inner <button> alone does not stop them.
    this.addEventListener(
      'click',
      (e) => {
        if (this.disabled || this.busy) e.stopImmediatePropagation();
      },
      { capture: true },
    );
  }

  static override styles = css`
    :host {
      display: block;
    }
    :host([variant='ghost']) {
      display: inline-block;
    }
    button {
      width: 100%;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: var(--sq-space-2);
      font: inherit;
      font-size: 14px;
      font-weight: 650;
      padding: 12px 16px;
      border-radius: var(--sq-radius-md);
      border: 1px solid transparent;
      cursor: pointer;
      transition:
        background var(--sq-duration) var(--sq-ease),
        border-color var(--sq-duration) var(--sq-ease),
        transform var(--sq-duration) var(--sq-ease);
    }
    button:active:not(:disabled) {
      transform: scale(0.98);
    }
    button:focus-visible {
      outline: 2px solid var(--sq-focus);
      outline-offset: 2px;
    }
    button:disabled {
      cursor: not-allowed;
      opacity: 0.5;
    }
    button[aria-busy='true'] {
      cursor: progress;
      opacity: 0.85;
    }
    .primary {
      background: var(--sq-accent);
      color: var(--sq-accent-text);
    }
    .primary:hover:not(:disabled) {
      background: color-mix(in srgb, var(--sq-accent) 88%, black);
    }
    .secondary {
      background: var(--sq-surface);
      color: var(--sq-text);
      border-color: var(--sq-border);
    }
    .secondary:hover:not(:disabled) {
      border-color: color-mix(in srgb, var(--sq-text) 35%, var(--sq-border));
    }
    .ghost {
      width: auto;
      padding: 6px 8px;
      background: transparent;
      color: var(--sq-text-muted);
    }
    .ghost:hover:not(:disabled) {
      color: var(--sq-text);
      background: var(--sq-surface-sunken);
    }
    .danger {
      background: var(--sq-risk-critical);
      color: #fff;
    }
    .spinner {
      width: 14px;
      height: 14px;
      border-radius: 50%;
      border: 2px solid currentColor;
      border-right-color: transparent;
      animation: spin 0.7s linear infinite;
    }
    @keyframes spin {
      to {
        transform: rotate(360deg);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .spinner {
        animation-duration: 2s;
      }
    }
  `;

  override render(): TemplateResult {
    return html`
      <button
        type="button"
        class=${this.variant}
        ?disabled=${this.disabled || this.busy}
        aria-busy=${this.busy ? 'true' : 'false'}
      >
        ${this.busy ? html`<span class="spinner" aria-hidden="true"></span>` : nothing}
        <slot></slot>
      </button>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'sq-button': Button;
  }
}
