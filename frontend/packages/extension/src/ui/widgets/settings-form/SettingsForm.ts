import type { WalletSettings } from '@sqw/types/WalletSettings';
import { css, html, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import type { UiError } from '../../core/errors';
import { fieldStyles, surfaceStyles, textStyles } from '../../core/styles';
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
  readonly max: number | null;
}

const SECONDS_PER_MINUTE = 60;
const PERCENT_MAX = 100;

const FIELDS: readonly FieldSpec[] = [
  { key: 'perTxPct', label: 'Limite par transaction (% du solde)', hint: '0 = désactivé', max: PERCENT_MAX },
  { key: 'dailyLimit', label: 'Plafond par jour (unités entières)', hint: '0 = désactivé', max: null },
  { key: 'stepUpPct', label: 'Confirmation supplémentaire au-delà de (% du solde)', hint: '0 = désactivé', max: PERCENT_MAX },
  { key: 'timeoutMin', label: 'Transaction abandonnée après (minutes)', hint: 'Sans signature dans ce délai', max: null },
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
    surfaceStyles,
    css`
      form {
        display: grid;
        gap: var(--sq-space-4);
      }
      .saved {
        font-size: 13px;
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
      <form class="card" @submit=${(e: Event) => e.preventDefault()} novalidate>
        ${FIELDS.map((f) => this.#field(f, draft, invalid.includes(f.key), data.busy))}
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
      <div class="field">
        <label for=${id}>${spec.label}</label>
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
        ${invalid
          ? html`<span class="field-error" role="alert">
              ${spec.max === null ? 'Nombre entier positif attendu.' : `Entre 0 et ${spec.max}.`}
            </span>`
          : html`<span class="hint">${spec.hint}</span>`}
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
