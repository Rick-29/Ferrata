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
      position: relative;
      overflow: hidden;
      width: 100%;
      min-height: 46px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 0 18px;
      border: 0;
      border-radius: 14px;
      font: inherit;
      font-size: 13px;
      font-weight: 650;
      letter-spacing: -0.01em;
      color: #fff;
      cursor: pointer;
      transition:
        transform var(--sq-duration) var(--sq-ease),
        filter var(--sq-duration) var(--sq-ease),
        opacity var(--sq-duration) var(--sq-ease);
    }
    button:hover:not(:disabled) {
      transform: translateY(-1px);
      filter: brightness(1.08);
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
      opacity: 0.36;
      filter: saturate(0.5);
      box-shadow: none;
    }
    button[aria-busy='true'] {
      cursor: progress;
      opacity: 0.85;
    }
    .primary {
      background: var(--sq-brand-gradient);
      box-shadow:
        0 12px 30px rgba(255, 75, 31, 0.24),
        inset 0 1px rgba(255, 255, 255, 0.18);
    }
    /* Light sweep on hover (design: .button-primary:after). */
    .primary::after {
      content: '';
      position: absolute;
      top: -70%;
      left: -25%;
      width: 28%;
      height: 240%;
      background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.25), transparent);
      transform: rotate(20deg);
      transition: left 0.55s ease;
    }
    .primary:hover:not(:disabled)::after {
      left: 105%;
    }
    .secondary {
      background: var(--sq-surface-high);
      border: 1px solid var(--sq-border-strong);
      color: var(--sq-text);
    }
    .ghost {
      width: auto;
      min-height: 30px;
      padding: 4px 10px;
      background: transparent;
      color: var(--sq-text-muted);
      font-size: 11px;
      font-weight: 500;
    }
    .ghost:hover:not(:disabled) {
      color: var(--sq-text);
      transform: none;
    }
    .danger {
      background: linear-gradient(120deg, #ff7a3d, #ff4d6a);
      box-shadow: 0 10px 24px rgba(255, 77, 106, 0.18);
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
      .primary::after {
        display: none;
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
