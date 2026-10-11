import { css, html, nothing, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { errorMessage, type UiError } from '../../core/errors';
import { shortAddress } from '../../core/format';
import { screenHeader } from '../../core/header';
import { BAND_LABELS, bandColor } from '../../core/risk-copy';
import { Screen } from '../../core/Screen';
import { screenStyles, textStyles } from '../../core/styles';
import { ready } from '../../core/Widget';
import type { RecoveryView } from '../../services/UiBridge';
import '../../widgets/button/Button';
import '../../widgets/qr-code/QrCode';

const POLL_MS = 3_000;

type Step =
  | { readonly kind: 'loading' }
  | { readonly kind: 'choose'; readonly wallets: readonly string[]; readonly selected: string | null }
  | { readonly kind: 'progress'; readonly view: RecoveryView }
  | { readonly kind: 'done' };

/**
 * "Récupérer mon wallet" on a new device (passkey lost, P3). This device creates its new passkey
 * and shows a QR; the recovery phone signs and runs the KYC; the smart delay runs (its reasons are
 * shown); then the new passkey becomes the owner of the same wallet. Swissquote alone cannot do it.
 */
@customElement('sq-recovery-start-screen')
export class RecoveryStartScreen extends Screen {
  @state() private step: Step = { kind: 'loading' };
  @state() private busy = false;
  @state() private error: UiError | null = null;
  @state() private nowSecs = Math.floor(Date.now() / 1000);
  #poll: ReturnType<typeof setTimeout> | undefined;
  #tick: ReturnType<typeof setInterval> | undefined;

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
      label {
        display: flex;
        gap: 8px;
        align-items: center;
        font: 500 12px var(--sq-font-mono);
      }
      .fingerprint {
        justify-self: center;
        padding: 6px 12px;
        border-radius: 10px;
        font: 600 17px var(--sq-font-mono);
        letter-spacing: 2px;
        background: var(--sq-surface-sunken);
      }
      .countdown {
        justify-self: center;
        font: 600 28px var(--sq-font-display);
        font-variant-numeric: tabular-nums;
      }
      ul {
        margin: 0;
        padding-left: 16px;
        display: grid;
        gap: 4px;
        font-size: 10px;
        color: var(--sq-text-muted);
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
    this.#tick = setInterval(() => (this.nowSecs = Math.floor(Date.now() / 1000)), 1_000);
    void this.#load();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    clearTimeout(this.#poll);
    clearInterval(this.#tick);
  }

  override render(): TemplateResult {
    return html`
      ${screenHeader({ title: 'Récupérer mon wallet', onBack: this.#back, backDisabled: this.busy })}
      <section>${this.#body()}</section>
      ${this.error ? html`<p class="error" role="alert">${errorMessage(this.error)}</p>` : nothing}
    `;
  }

  #body(): TemplateResult {
    const step = this.step;
    switch (step.kind) {
      case 'loading':
        return html`<p class="muted">Chargement…</p>`;
      case 'choose':
        return this.#choose(step.wallets, step.selected);
      case 'progress':
        return this.#progress(step.view);
      case 'done':
        return html`
          <p class="ok">✓ Wallet récupéré : votre nouvelle passkey en est maintenant la clé. Même adresse, mêmes fonds.</p>
          <p>Le téléphone qui a servi n’est plus votre téléphone de secours. Associez-le à nouveau (ou un autre).</p>
          <div class="actions">
            <sq-button @click=${() => this.router.go('recovery-phone', undefined)}>Associer un téléphone de secours</sq-button>
            <sq-button variant="ghost" @click=${() => this.router.go('home', undefined)}>Plus tard</sq-button>
          </div>
        `;
    }
  }

  #choose(wallets: readonly string[], selected: string | null): TemplateResult {
    if (wallets.length === 0) {
      return html`<p>Aucun wallet trouvé pour ce compte Swissquote.</p>`;
    }
    return html`
      <p>
        Vous avez perdu votre passkey ? Cet appareil va créer une nouvelle passkey. Votre <strong>téléphone de secours</strong>
        confirmera, avec une vérification d’identité, puis un délai de sécurité s’écoulera.
      </p>
      ${wallets.map(
        (w) => html`<label
          ><input type="radio" name="wallet" .checked=${w === selected} @change=${() => this.#select(w)} />${shortAddress(w)}</label
        >`,
      )}
      <div class="actions">
        <sq-button ?disabled=${!selected || this.busy} @click=${this.#start}>Créer ma nouvelle passkey et continuer</sq-button>
      </div>
    `;
  }

  #progress(view: RecoveryView): TemplateResult {
    switch (view.phase) {
      case 'waiting_phone':
        return html`
          <p>Sur votre <strong>téléphone de secours</strong>, ouvrez l’app Ferrata et scannez ce code.</p>
          <sq-qr-code .state=${ready(view.qr)}></sq-qr-code>
          <p>Le téléphone doit afficher la même empreinte de nouvelle passkey :</p>
          <span class="fingerprint">${view.newKeyFingerprint}</span>
          <p class="muted">Puis il vous demandera votre biométrie et votre pièce d’identité.</p>
          <div class="actions"><sq-button variant="ghost" ?disabled=${this.busy} @click=${this.#abandon}>Abandonner</sq-button></div>
        `;
      case 'pending': {
        const left = Math.max(0, (view.unlockAt ?? 0) - this.nowSecs);
        return html`
          <p class="ok">✓ Téléphone et identité confirmés. Délai de sécurité en cours.</p>
          <span class="countdown" aria-live="polite">${formatDuration(left)}</span>
          ${view.band
            ? html`<p>Délai fixé par l’analyse Swissquote · <strong style="color: ${bandColor(view.band)}">${BAND_LABELS[view.band]}</strong></p>`
            : nothing}
          ${view.reasons.length > 0 ? html`<ul aria-label="Pourquoi ce délai">${view.reasons.map((r) => html`<li>${r}</li>`)}</ul>` : nothing}
          <p class="muted">
            ${view.contested
              ? 'Récupération contestée : l’ancienne passkey ne peut plus l’annuler.'
              : 'Pendant ce délai, votre ancienne passkey, si quelqu’un l’a encore, peut annuler. Vous êtes alerté.'}
          </p>
          <div class="actions">
            <sq-button ?disabled=${left > 0 || this.busy} @click=${this.#finish}>Finaliser la récupération</sq-button>
          </div>
        `;
      }
      case 'completed':
        return html`<p class="ok">✓ Récupération terminée.</p>
          <div class="actions"><sq-button ?disabled=${this.busy} @click=${this.#finish}>Ouvrir le wallet</sq-button></div>`;
      case 'rejected':
      case 'cancelled':
      case 'expired':
        return html`
          <p class="error">
            ${view.phase === 'rejected'
              ? `Vérification refusée${view.detail ? ` : ${view.detail}` : ''}.`
              : view.phase === 'cancelled'
                ? 'Récupération annulée depuis l’appareil qui a encore la passkey.'
                : 'Le délai pour scanner le code est dépassé.'}
          </p>
          <div class="actions"><sq-button ?disabled=${this.busy} @click=${this.#abandon}>Recommencer</sq-button></div>
        `;
    }
  }

  readonly #load = async (): Promise<void> => {
    this.error = null;
    const current = await this.bridge.getRecovery();
    if (!this.isConnected) return;
    if (current.ok && current.value) {
      this.#show(current.value);
      return;
    }
    const wallets = await this.bridge.listRecoverableWallets();
    if (!this.isConnected) return;
    if (!wallets.ok) {
      this.error = wallets.error;
      this.step = { kind: 'choose', wallets: [], selected: null };
      return;
    }
    this.step = { kind: 'choose', wallets: wallets.value, selected: wallets.value.length === 1 ? (wallets.value[0] ?? null) : null };
  };

  #select(wallet: string): void {
    if (this.step.kind === 'choose') this.step = { ...this.step, selected: wallet };
  }

  #show(view: RecoveryView): void {
    this.step = { kind: 'progress', view };
    clearTimeout(this.#poll);
    if (view.phase === 'waiting_phone' || view.phase === 'pending') {
      this.#poll = setTimeout(() => void this.#refresh(), POLL_MS);
    }
  }

  readonly #refresh = async (): Promise<void> => {
    const current = await this.bridge.getRecovery();
    if (!this.isConnected || this.step.kind !== 'progress') return;
    if (!current.ok) {
      this.error = current.error;
      return;
    }
    if (current.value) this.#show(current.value);
  };

  readonly #start = async (): Promise<void> => {
    if (this.step.kind !== 'choose' || !this.step.selected || this.busy) return;
    this.busy = true;
    this.error = null;
    const started = await this.bridge.startRecovery(this.step.selected);
    this.busy = false;
    if (!this.isConnected) return;
    if (!started.ok) {
      this.error = started.error;
      return;
    }
    this.#show(started.value);
  };

  readonly #finish = async (): Promise<void> => {
    if (this.busy) return;
    this.busy = true;
    this.error = null;
    const opened = await this.bridge.finishRecovery();
    this.busy = false;
    if (!this.isConnected) return;
    if (!opened.ok) {
      this.error = opened.error;
      return;
    }
    clearTimeout(this.#poll);
    this.step = { kind: 'done' };
  };

  readonly #abandon = async (): Promise<void> => {
    clearTimeout(this.#poll);
    await this.bridge.abandonRecovery();
    if (this.isConnected) void this.#load();
  };

  readonly #back = (): void => {
    clearTimeout(this.#poll);
    this.router.go('onboarding', undefined);
  };
}

/** `1 j 02:03:04`, or `02:03` under an hour. */
export function formatDuration(totalSecs: number): string {
  const s = Math.max(0, Math.floor(totalSecs));
  const days = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3_600);
  const m = Math.floor((s % 3_600) / 60);
  const sec = s % 60;
  const pad = (n: number): string => n.toString().padStart(2, '0');
  const clock = h > 0 || days > 0 ? `${pad(h)}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
  return days > 0 ? `${days} j ${clock}` : clock;
}

declare global {
  interface HTMLElementTagNameMap {
    'sq-recovery-start-screen': RecoveryStartScreen;
  }
}
