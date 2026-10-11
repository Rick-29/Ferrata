import type { AssetBalance } from '@sqw/types/AssetBalance';
import { css, html, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { UiError } from '../../core/errors';
import type { WidgetEvent } from '../../core/events';
import { screenHeader } from '../../core/header';
import { Screen } from '../../core/Screen';
import { screenStyles, surfaceStyles, textStyles } from '../../core/styles';
import { ready } from '../../core/Widget';
import type { ConfirmationLevel, SendPreview } from '../../services/UiBridge';
import type { DeltaRow } from '../../widgets/balance-delta/BalanceDelta';
import type { FinalOutcome } from '../../widgets/outcome-panel/OutcomePanel';
import '../../widgets/balance-delta/BalanceDelta';
import '../../widgets/button/Button';
import '../../widgets/legal-notice/LegalNotice';
import '../../widgets/outcome-panel/OutcomePanel';
import '../../widgets/passkey-prompt/PasskeyPrompt';
import '../../widgets/reason-list/ReasonList';
import '../../widgets/risk-explainer/RiskExplainer';
import '../../widgets/risk-badge/RiskBadge';
import '../../widgets/risk-warning/RiskWarning';
import '../../widgets/tx-summary/TxSummary';

const NATIVE_DECIMALS = 18;

/**
 * `review` → the user signs. Swissquote may then ask for a second confirmation: `standard` (e.g. a
 * large amount) or `high_risk`, where the user is warned and must accept the risk themselves.
 * Self-custody: Swissquote never blocks, and if its analysis is unreachable the user may send anyway.
 */
type Phase =
  | { readonly kind: 'review' }
  | { readonly kind: 'confirm-again'; readonly level: ConfirmationLevel }
  | { readonly kind: 'done'; readonly outcome: FinalOutcome };

interface PromptCopy {
  readonly title: string;
  readonly description: string;
  readonly actionLabel: string;
}

const PROMPT_COPY: Readonly<Record<'review' | ConfirmationLevel, PromptCopy>> = {
  review: {
    title: 'Signer avec votre passkey',
    description: 'Votre passkey suffit pour autoriser la transaction. Swissquote l’a analysée et inscrit son analyse au journal d’audit.',
    actionLabel: 'Confirmer et signer',
  },
  standard: {
    title: 'Confirmation supplémentaire',
    description: 'Pour ce montant, Swissquote vous demande de confirmer une seconde fois avec votre passkey.',
    actionLabel: 'Confirmer à nouveau',
  },
  high_risk: {
    title: 'Confirmer malgré le risque',
    description: 'Cochez la case ci-dessus, puis confirmez une seconde fois avec votre passkey.',
    actionLabel: 'Envoyer quand même',
  },
};

/** Shows exactly what will happen and how risky it is, then gets the passkey signature(s); Swissquote only advises. */
@customElement('sq-confirm-screen')
export class ConfirmScreen extends Screen {
  @property({ attribute: false }) preview!: SendPreview;
  @property({ attribute: false }) asset!: AssetBalance;
  @state() private phase: Phase = { kind: 'review' };
  @state() private busy = false;
  @state() private error: UiError | null = null;
  @state() private riskAccepted = false;
  @state() private explainerOpen = false;

  static override styles = [
    screenStyles,
    textStyles,
    surfaceStyles,
    css`
      :host {
        gap: 13px;
      }
      .risk {
        display: flex;
        justify-content: center;
      }
      .card {
        display: grid;
        gap: 10px;
      }
      .block {
        display: grid;
        gap: 6px;
      }
      hr {
        width: 100%;
        margin: 0;
        border: 0;
        border-top: 1px solid var(--sq-border);
      }
      .cancel {
        justify-self: center;
      }
      .why {
        justify-self: start;
        padding: 0;
        border: 0;
        background: none;
        font: 600 10px var(--sq-font);
        color: var(--sq-accent);
        text-decoration: underline;
        cursor: pointer;
      }
    `,
  ];

  override render(): TemplateResult {
    if (this.phase.kind === 'done') {
      return html`<sq-outcome-panel
        .state=${ready(this.phase.outcome)}
        @done=${() => this.router.go('home', undefined)}
      ></sq-outcome-panel>`;
    }

    const { assessment, signals } = this.preview.assessment;
    const highRisk = this.phase.kind === 'confirm-again' && this.phase.level === 'high_risk';
    return html`
      ${screenHeader({ title: 'Confirmer', onBack: this.#cancel, backDisabled: this.busy })}
      <div class="risk">
        <sq-risk-badge .state=${ready({ band: assessment.band, score: assessment.score })}></sq-risk-badge>
      </div>
      <section class="card">
        <sq-tx-summary
          .state=${ready({
            to: this.preview.draft.to,
            amount: this.preview.draft.amount,
            symbol: this.asset.symbol,
            decimals: this.asset.decimals,
          })}
        ></sq-tx-summary>
        <hr />
        <div class="block">
          <span class="eyebrow">Après la transaction</span>
          <sq-balance-delta .state=${ready(this.#deltaRows(signals.simulation))}></sq-balance-delta>
        </div>
        <hr />
        <div class="block">
          <span class="eyebrow">Pourquoi ce niveau ?</span>
          <sq-reason-list .state=${ready(assessment.reasons)}></sq-reason-list>
          <button type="button" class="why" @click=${() => (this.explainerOpen = true)}>Comprendre ce score</button>
        </div>
      </section>
      ${highRisk
        ? html`<sq-risk-warning
            .state=${ready({ reasons: assessment.reasons, acknowledged: this.riskAccepted, disabled: this.busy })}
            @consent-changed=${(e: WidgetEvent<'consent-changed'>) => (this.riskAccepted = e.detail)}
          ></sq-risk-warning>`
        : nothing}
      ${this.#prompt(highRisk)}
      ${this.error?.code === 'SQ_ANALYSIS_UNAVAILABLE'
        ? html`<sq-button variant="secondary" ?disabled=${this.busy} @click=${this.#sendWithoutAnalysis}
            >Envoyer sans l’analyse (passkey seule)</sq-button
          >`
        : nothing}
      <sq-legal-notice></sq-legal-notice>
      <sq-button class="cancel" variant="ghost" ?disabled=${this.busy} @click=${this.#cancel}>Annuler</sq-button>
      ${this.explainerOpen
        ? html`<sq-risk-explainer
            .state=${ready({
              score: assessment.score,
              band: assessment.band,
              reasons: assessment.reasons,
              exposureHops: signals.exposure_hops,
              balanceShare: this.#balanceShare(signals.simulation),
            })}
            @explainer-closed=${() => (this.explainerOpen = false)}
          ></sq-risk-explainer>`
        : nothing}
    `;
  }

  /** Share of the sent asset's balance that leaves the account, from the simulation. */
  #balanceShare(simulation: SendPreview['assessment']['signals']['simulation']): number | null {
    const row = simulation.find((d) => d.asset === this.asset.asset);
    if (!row) return null;
    const before = BigInt(row.before);
    const after = BigInt(row.after);
    if (before <= 0n || after >= before) return null;
    return Number(((before - after) * 1000n) / before) / 1000;
  }

  #prompt(highRisk: boolean): TemplateResult {
    const copy = PROMPT_COPY[this.phase.kind === 'confirm-again' ? this.phase.level : 'review'];
    return html`<sq-passkey-prompt
      .state=${ready({ ...copy, busy: this.busy, disabled: highRisk && !this.riskAccepted, error: this.error })}
      @passkey-requested=${this.#confirm}
      @retry=${this.#confirm}
    ></sq-passkey-prompt>`;
  }

  #deltaRows(simulation: SendPreview['assessment']['signals']['simulation']): readonly DeltaRow[] {
    return simulation.map((d) => ({
      symbol: d.symbol,
      decimals: d.asset === this.asset.asset ? this.asset.decimals : NATIVE_DECIMALS,
      before: d.before,
      after: d.after,
    }));
  }

  readonly #confirm = async (): Promise<void> => {
    if (this.busy) return;
    const phase = this.phase;
    const confirmingAgain = phase.kind === 'confirm-again';
    // The risk must be accepted by the user, not just the button enabled: guard here too.
    if (confirmingAgain && phase.level === 'high_risk' && !this.riskAccepted) return;
    this.busy = true;
    this.error = null;
    const result = await this.bridge.confirmSend(this.preview.id, {
      stepUp: confirmingAgain,
      acceptedRisk: confirmingAgain && phase.level === 'high_risk' && this.riskAccepted,
    });
    this.busy = false;
    if (!this.isConnected) return;
    if (!result.ok) {
      this.error = result.error;
      return;
    }
    const outcome = result.value;
    this.phase =
      outcome.kind === 'confirmation_required'
        ? { kind: 'confirm-again', level: outcome.level }
        : { kind: 'done', outcome };
  };

  /** Self-custody: the analysis is down and the user goes ahead with the passkey alone. */
  readonly #sendWithoutAnalysis = async (): Promise<void> => {
    if (this.busy) return;
    this.busy = true;
    this.error = null;
    const result = await this.bridge.confirmSend(this.preview.id, { stepUp: false, acceptedRisk: false, withoutAnalysis: true });
    this.busy = false;
    if (!this.isConnected) return;
    if (!result.ok) {
      this.error = result.error;
      return;
    }
    if (result.value.kind !== 'confirmation_required') this.phase = { kind: 'done', outcome: result.value };
  };

  readonly #cancel = async (): Promise<void> => {
    if (this.busy) return;
    this.busy = true;
    // Recording the cancel is best effort: a failure must never keep the user on this screen.
    await this.bridge.cancelSend(this.preview.id);
    this.busy = false;
    if (this.isConnected) this.router.go('send', undefined);
  };
}

declare global {
  interface HTMLElementTagNameMap {
    'sq-confirm-screen': ConfirmScreen;
  }
}
