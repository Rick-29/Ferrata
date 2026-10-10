import { LitElement, css, html, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { emitWidgetEvent } from '../../core/events';
import { fieldStyles } from '../../core/styles';

/** Amount field in human units ("12.5"). The Screen validates against the balance and passes `error`. */
@customElement('sq-amount-input')
export class AmountInput extends LitElement {
  @property() value = '';
  @property() symbol = '';
  @property() available = '';
  @property() error: string | null = null;
  @property({ type: Boolean }) disabled = false;

  static override styles = [
    fieldStyles,
    css`
      .row {
        display: flex;
        align-items: center;
        gap: var(--sq-space-2);
        border-radius: var(--sq-radius-md);
      }
      input {
        flex: 1;
        font-size: 20px;
        font-weight: 650;
        font-variant-numeric: tabular-nums;
      }
      .symbol {
        font-weight: 650;
        color: var(--sq-text-muted);
      }
      .meta {
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      .max {
        font: inherit;
        font-size: 12px;
        font-weight: 650;
        padding: 2px 8px;
        border-radius: 999px;
        border: 1px solid var(--sq-border);
        background: transparent;
        color: var(--sq-accent);
        cursor: pointer;
      }
      .max:focus-visible {
        outline: 2px solid var(--sq-focus);
        outline-offset: 2px;
      }
    `,
  ];

  override render(): TemplateResult {
    return html`
      <div class="field">
        <label for="amount">Montant</label>
        <div class="row">
          <input
            id="amount"
            inputmode="decimal"
            placeholder="0"
            autocomplete="off"
            .value=${this.value}
            ?disabled=${this.disabled}
            aria-invalid=${this.error ? 'true' : 'false'}
            aria-describedby="amount-meta"
            @input=${this.#onInput}
          />
          <span class="symbol">${this.symbol}</span>
        </div>
        <div class="meta" id="amount-meta">
          ${this.error
            ? html`<span class="field-error">${this.error}</span>`
            : html`<span class="hint">Disponible : ${this.available} ${this.symbol}</span>`}
          ${this.disabled
            ? nothing
            : html`<button type="button" class="max" @click=${() => emitWidgetEvent(this, 'max-requested', undefined)}>
                Max
              </button>`}
        </div>
      </div>
    `;
  }

  #onInput(e: Event): void {
    emitWidgetEvent(this, 'amount-changed', e.target instanceof HTMLInputElement ? e.target.value : '');
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'sq-amount-input': AmountInput;
  }
}
