import { css, html, nothing, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { errorMessage, type UiError } from '../../core/errors';
import { screenHeader } from '../../core/header';
import { Screen } from '../../core/Screen';
import { screenStyles, textStyles } from '../../core/styles';
import { ready } from '../../core/Widget';
import type { PhonePairing } from '../../services/UiBridge';
import '../../widgets/button/Button';
import '../../widgets/qr-code/QrCode';

const POLL_MS = 2_000;

type Step =
  | { readonly kind: 'loading' }
  | { readonly kind: 'status'; readonly fingerprint: string | null }
  | { readonly kind: 'pairing'; readonly pairing: PhonePairing }
  | { readonly kind: 'compare'; readonly pairing: PhonePairing; readonly fingerprint: string; readonly deviceLabel: string | null }
  | { readonly kind: 'done'; readonly fingerprint: string };

/**
 * "Téléphone de secours" (recovery, P3): the phone becomes the wallet's recovery key. The phone
 * scans a QR, sends its public key through Swissquote's relay, the user compares the fingerprint on
 * both screens, and the passkey signs the registration on the Ferra chain. Swissquote only relays.
 */
@customElement('sq-recovery-phone-screen')
export class RecoveryPhoneScreen extends Screen {
  @state() private step: Step = { kind: 'loading' };
  @state() private busy = false;
  @state() private error: UiError | null = null;
  #timer: ReturnType<typeof setTimeout> | undefined;

  static override styles = [
    screenStyles,
    textStyles,
    css`
      section {
        display: grid;
        gap: 10px;
        padding: 13px;
        border-radius: 18px;
        border: 1px solid var(--sq-border);
        background: rgba(20, 23, 38, 0.82);
      }
      p {
        margin: 0;
        font-size: 11px;
        line-height: 1.5;
      }
      .fingerprint {
        justify-self: center;
        padding: 8px 14px;
        border-radius: 12px;
        font: 600 20px var(--sq-font-mono);
        letter-spacing: 2px;
        background: var(--sq-surface-sunken);
      }
      .ok {
        color: var(--sq-risk-low);
      }
      .error {
        color: var(--sq-risk-critical);
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        justify-content: center;
      }
    `,
  ];

  override connectedCallback(): void {
    super.connectedCallback();
    void this.#load();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    clearTimeout(this.#timer);
  }

  override render(): TemplateResult {
    return html`
      ${screenHeader({ title: 'Téléphone de secours', onBack: this.#back, backDisabled: this.busy })}
      <section>${this.#body()}</section>
      ${this.error ? html`<p class="error" role="alert">${errorMessage(this.error)}</p>` : nothing}
    `;
  }

  #body(): TemplateResult {
    const step = this.step;
    switch (step.kind) {
      case 'loading':
        return html`<p class="muted">Chargement…</p>`;
      case 'status':
        return html`
          <p>
            Si vous perdez votre passkey, votre téléphone de secours, avec une vérification d’identité Swissquote et un
            délai de sécurité, permet de récupérer votre wallet. Swissquote seul ne le peut pas.
          </p>
          ${step.fingerprint
            ? html`<p class="ok">✓ Téléphone associé · empreinte</p>
                <span class="fingerprint">${step.fingerprint}</span>`
            : html`<p class="error">Aucun téléphone de secours : sans lui, une passkey perdue ne peut pas être récupérée.</p>`}
          <div class="actions">
            <sq-button ?disabled=${this.busy} @click=${this.#start}>
              ${step.fingerprint ? 'Associer un autre téléphone' : 'Associer mon téléphone'}
            </sq-button>
          </div>
        `;
      case 'pairing':
        return html`
          <p>Ouvrez l’app Ferrata sur votre téléphone, connectez-vous, puis scannez ce code.</p>
          <sq-qr-code .state=${ready(step.pairing.qr)}></sq-qr-code>
          <p class="muted">En attente du téléphone…</p>
          <div class="actions"><sq-button variant="ghost" @click=${this.#cancel}>Annuler</sq-button></div>
        `;
      case 'compare':
        return html`
          <p>
            ${step.deviceLabel ? html`<strong>${step.deviceLabel}</strong> a répondu. ` : nothing}Vérifiez que votre
            téléphone affiche exactement la même empreinte :
          </p>
          <span class="fingerprint">${step.fingerprint}</span>
          <p class="muted">Si elle est différente, annulez : une autre clé que celle de votre téléphone a été proposée.</p>
          <div class="actions">
            <sq-button variant="ghost" ?disabled=${this.busy} @click=${this.#cancel}>Annuler</sq-button>
            <sq-button ?disabled=${this.busy} @click=${this.#confirm}>Identique · confirmer avec ma passkey</sq-button>
          </div>
        `;
      case 'done':
        return html`
          <p class="ok">✓ Téléphone de secours enregistré dans Ferra chain.</p>
          <span class="fingerprint">${step.fingerprint}</span>
          <div class="actions"><sq-button @click=${this.#back}>Terminé</sq-button></div>
        `;
    }
  }

  readonly #load = async (): Promise<void> => {
    const status = await this.bridge.getRecoveryPhone();
    if (!this.isConnected) return;
    if (!status.ok) {
      this.error = status.error;
      this.step = { kind: 'status', fingerprint: null };
      return;
    }
    this.step = { kind: 'status', fingerprint: status.value.fingerprint };
  };

  readonly #start = async (): Promise<void> => {
    this.busy = true;
    this.error = null;
    const pairing = await this.bridge.startPhonePairing();
    this.busy = false;
    if (!this.isConnected) return;
    if (!pairing.ok) {
      this.error = pairing.error;
      return;
    }
    this.step = { kind: 'pairing', pairing: pairing.value };
    this.#schedulePoll();
  };

  #schedulePoll(): void {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => void this.#poll(), POLL_MS);
  }

  readonly #poll = async (): Promise<void> => {
    const step = this.step;
    if (step.kind !== 'pairing') return;
    const progress = await this.bridge.pollPhonePairing(step.pairing.pairingId);
    if (!this.isConnected || this.step !== step) return;
    if (!progress.ok) {
      this.error = progress.error;
      return;
    }
    if (progress.value.status === 'answered') {
      this.step = { kind: 'compare', pairing: step.pairing, fingerprint: progress.value.fingerprint, deviceLabel: progress.value.deviceLabel };
      return;
    }
    this.#schedulePoll();
  };

  readonly #confirm = async (): Promise<void> => {
    const step = this.step;
    if (step.kind !== 'compare' || this.busy) return;
    this.busy = true;
    this.error = null;
    const saved = await this.bridge.confirmPhonePairing(step.pairing.pairingId);
    this.busy = false;
    if (!this.isConnected) return;
    if (!saved.ok) {
      this.error = saved.error;
      return;
    }
    this.step = { kind: 'done', fingerprint: saved.value.fingerprint ?? step.fingerprint };
  };

  readonly #cancel = (): void => {
    clearTimeout(this.#timer);
    void this.#load();
  };

  readonly #back = (): void => {
    clearTimeout(this.#timer);
    this.router.go('settings', undefined);
  };
}

declare global {
  interface HTMLElementTagNameMap {
    'sq-recovery-phone-screen': RecoveryPhoneScreen;
  }
}
