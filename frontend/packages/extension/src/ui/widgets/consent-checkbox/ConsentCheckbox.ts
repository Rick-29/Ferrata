import { LitElement, css, html, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { emitWidgetEvent } from '../../core/events';

/** An explicit "I agree / I understand" the user must tick themselves. Never pre-ticked. */
@customElement('sq-consent-checkbox')
export class ConsentCheckbox extends LitElement {
  @property() label = '';
  @property({ type: Boolean }) checked = false;
  @property({ type: Boolean }) disabled = false;

  static override styles = css`
    label {
      display: flex;
      gap: var(--sq-space-2);
      align-items: flex-start;
      font-size: 13px;
      line-height: 1.45;
      cursor: pointer;
    }
    input {
      flex: none;
      width: 18px;
      height: 18px;
      margin: 1px 0 0;
      accent-color: var(--sq-accent);
      cursor: pointer;
    }
    input:focus-visible {
      outline: 2px solid var(--sq-focus);
      outline-offset: 2px;
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
