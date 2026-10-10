import { LitElement, css, html, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { emitWidgetEvent } from '../../core/events';
import { isAddress } from '../../core/format';
import { fieldStyles } from '../../core/styles';

/** Recipient field. Flags a malformed address once the user leaves the field, not while typing. */
@customElement('sq-address-input')
export class AddressInput extends LitElement {
  @property() value = '';
  @property({ type: Boolean }) disabled = false;
  @state() private touched = false;

  static override styles = [
    fieldStyles,
    css`
      input {
        font-family: var(--sq-font-mono);
        font-size: 13px;
      }
    `,
  ];

  get invalid(): boolean {
    return this.touched && this.value !== '' && !isAddress(this.value);
  }

  override render(): TemplateResult {
    return html`
      <div class="field">
        <label for="to">Destinataire</label>
        <input
          id="to"
          placeholder="0x…"
          spellcheck="false"
          autocomplete="off"
          .value=${this.value}
          ?disabled=${this.disabled}
          aria-invalid=${this.invalid ? 'true' : 'false'}
          aria-describedby=${this.invalid ? 'to-error' : nothing}
          @input=${this.#onInput}
          @blur=${() => (this.touched = true)}
        />
        ${this.invalid
          ? html`<span id="to-error" class="field-error" role="alert">Adresse invalide (0x suivi de 40 caractères hexadécimaux).</span>`
          : nothing}
      </div>
    `;
  }

  #onInput(e: Event): void {
    const value = e.target instanceof HTMLInputElement ? e.target.value.trim() : '';
    emitWidgetEvent(this, 'address-changed', value);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'sq-address-input': AddressInput;
  }
}
