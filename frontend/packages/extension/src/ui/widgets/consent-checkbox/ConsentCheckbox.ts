import { LitElement, css, html, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { emitWidgetEvent } from '../../core/events';
import { icon } from '../../core/icons';

/** An explicit "I agree / I understand" the user must tick themselves. Never pre-ticked. */
@customElement('sq-consent-checkbox')
export class ConsentCheckbox extends LitElement {
  @property() label = '';
  @property({ type: Boolean }) checked = false;
  @property({ type: Boolean }) disabled = false;

  static override styles = css`
    label {
      display: grid;
      grid-template-columns: 20px 1fr;
      gap: 10px;
      align-items: start;
      font-size: 11px;
      line-height: 1.45;
      color: #bdc2d1;
      cursor: pointer;
    }
    input {
      position: absolute;
      opacity: 0;
      width: 1px;
      height: 1px;
    }
    .box {
      width: 20px;
      height: 20px;
      border-radius: 7px;
      border: 1px solid var(--sq-border-strong);
      background: var(--sq-surface);
      display: grid;
      place-items: center;
      color: #fff;
      transition: background var(--sq-duration) var(--sq-ease);
    }
    input:checked + .box {
      background: var(--sq-gradient);
      border-color: transparent;
    }
    input:focus-visible + .box {
      outline: 2px solid var(--sq-focus);
      outline-offset: 2px;
    }
    input:disabled + .box {
      opacity: 0.5;
    }
  `;

  override render(): TemplateResult {
    return html`
      <label>
        <input
          type="checkbox"
          .checked=${this.checked}
          ?disabled=${this.disabled}
          @change=${(e: Event) =>
            emitWidgetEvent(this, 'consent-changed', e.target instanceof HTMLInputElement && e.target.checked)}
        />
        <span class="box" aria-hidden="true">${this.checked ? icon('check', 14) : nothing}</span>
        <span>${this.label}</span>
      </label>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'sq-consent-checkbox': ConsentCheckbox;
  }
}
