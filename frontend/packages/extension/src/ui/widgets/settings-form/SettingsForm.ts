import type { WalletSettings } from '@sqw/types/WalletSettings';
import { css, html, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import type { UiError } from '../../core/errors';
import { fieldStyles, textStyles } from '../../core/styles';
import { Widget } from '../../core/Widget';
import '../button/Button';

export interface SettingsFormData {
  readonly settings: WalletSettings;
  readonly busy: boolean;
  readonly error: UiError | null;
  readonly saved: boolean;
}

type FieldKey = 'perTxPct' | 'dailyLimit' | 'stepUpPct' | 'timeoutMin';

interface FieldSpec {
  readonly key: FieldKey;
  readonly label: string;
  readonly hint: string;
  readonly unit: string;
  readonly max: number | null;
}

const SECONDS_PER_MINUTE = 60;
const PERCENT_MAX = 100;

const FIELDS: readonly FieldSpec[] = [
  { key: 'perTxPct', label: 'Limite par transaction', hint: 'du solde', unit: '%', max: PERCENT_MAX },
  { key: 'dailyLimit', label: 'Plafond par jour', hint: 'unités entières', unit: 'unités', max: null },
  { key: 'stepUpPct', label: 'Confirmation supplémentaire au-delà de', hint: 'du solde', unit: '%', max: PERCENT_MAX },
  { key: 'timeoutMin', label: 'Transaction abandonnée après', hint: 'sans signature', unit: 'min', max: null },
];

type Draft = Readonly<Record<FieldKey, string>>;

const toDraft = (s: WalletSettings): Draft => ({
  perTxPct: String(s.per_tx_limit_pct),
  dailyLimit: String(s.daily_limit),
  stepUpPct: String(s.step_up_above_pct),
  timeoutMin: String(Math.round(s.intent_timeout_secs / SECONDS_PER_MINUTE)),
});

const WHOLE_NUMBER = /^\d+$/;

/** The owner's own guard-rails. Saving asks for a passkey signature (done by the Screen). */
@customElement('sq-settings-form')
export class SettingsForm extends Widget<SettingsFormData> {
  @state() private draft: Draft | null = null;

  static override styles = [
    textStyles,
    fieldStyles,
    css`
      form {
        display: grid;
        gap: 13px;
      }
      .card {
        padding: 4px 13px 9px;
        border-radius: 19px;
        border: 1px solid var(--sq-border);
        background: var(--sq-surface);
      }
      .row {
        min-height: 64px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        border-bottom: 1px solid var(--sq-border);
      }
      .text {
        display: grid;
        gap: 3px;
        max-width: 170px;
      }
      label {
        font-size: 11px;
        font-weight: 500;
        letter-spacing: 0;
        text-transform: none;
        color: #c4c8d4;
        line-height: 1.35;
      }
      .box {
        width: 96px;
        height: 34px;
        display: flex;
        align-items: center;
        padding: 0 8px;
        box-sizing: border-box;
        border-radius: 10px;
        border: 1px solid var(--sq-border);
        background: rgba(255, 255, 255, 0.04);
      }
      .box:focus-within {
        border-color: rgba(255, 61, 127, 0.65);
      }
      input {
        width: 52px;
        height: auto;
        padding: 0;
        border: 0;
        background: transparent;
        text-align: right;
        font: 600 12px var(--sq-font-display);
      }
      input:focus-visible {
        box-shadow: none;
      }
      .unit {
        margin-left: auto;
        font-size: 9px;
        color: var(--sq-text-muted);
      }
      .zero {
        display: block;
        margin-top: 8px;
        font-size: 9px;
        color: var(--sq-text-faint);
      }
      .saved {
        font-size: 12px;
        font-weight: 600;
        color: var(--sq-risk-low);
      }
    `,
  ];

  protected override willUpdate(changed: PropertyValues<this>): void {
    // A new settings object from the Screen (loaded or just saved) resets what is being edited;
    // anything else (typing, busy, error) must keep the draft.
    if (!changed.has('state') || this.state.kind !== 'ready') return;
    const previous = changed.get('state');
    if (previous?.kind !== 'ready' || previous.data.settings !== this.state.data.settings) {
      this.draft = toDraft(this.state.data.settings);
    }
  }

  protected override renderReady(data: SettingsFormData): TemplateResult {
    const draft = this.draft ?? toDraft(data.settings);
    const invalid = FIELDS.filter((f) => !isValid(draft[f.key], f.max)).map((f) => f.key);
    return html`
      <form @submit=${(e: Event) => e.preventDefault()} novalidate>
        <div class="card">
          ${FIELDS.map((f) => this.#field(f, draft, invalid.includes(f.key), data.busy))}
          <small class="zero">0 = désactivé</small>
        </div>
        ${data.error ? html`<sq-error-panel .error=${data.error}></sq-error-panel>` : nothing}
        ${data.saved ? html`<p class="saved" role="status">Réglages enregistrés et signés.</p>` : nothing}
        <sq-button
          ?busy=${data.busy}
          ?disabled=${invalid.length > 0}
          @click=${() => invalid.length === 0 && this.emit('settings-submitted', fromDraft(draft, data.settings))}
        >
          Signer et enregistrer
        </sq-button>
      </form>
    `;
  }

  #field(spec: FieldSpec, draft: Draft, invalid: boolean, busy: boolean): TemplateResult {
    const id = `f-${spec.key}`;
    return html`
      <div class="row">
        <span class="text">
          <label for=${id}>${spec.label}</label>
          ${invalid
            ? html`<span class="field-error" role="alert">
                ${spec.max === null ? 'Nombre entier positif attendu.' : `Entre 0 et ${spec.max}.`}
              </span>`
            : html`<span class="hint">${spec.hint}</span>`}
        </span>
        <span class="box">
          <input
            id=${id}
            inputmode="numeric"
            .value=${draft[spec.key]}
            ?disabled=${busy}
            aria-invalid=${invalid ? 'true' : 'false'}
            @input=${(e: Event) => {
              const value = e.target instanceof HTMLInputElement ? e.target.value.trim() : '';
              this.draft = { ...draft, [spec.key]: value };
            }}
          />
          <span class="unit">${spec.unit}</span>
        </span>
      </div>
    `;
  }
}

function isValid(value: string, max: number | null): boolean {
  if (!WHOLE_NUMBER.test(value)) return false;
  return max === null || Number(value) <= max;
}

function fromDraft(draft: Draft, base: WalletSettings): WalletSettings {
  return {
    ...base,
    per_tx_limit_pct: Number(draft.perTxPct),
    daily_limit: Number(draft.dailyLimit),
    step_up_above_pct: Number(draft.stepUpPct),
    intent_timeout_secs: Number(draft.timeoutMin) * SECONDS_PER_MINUTE,
  };
}

declare global {
  interface HTMLElementTagNameMap {
    'sq-settings-form': SettingsForm;
  }
}
