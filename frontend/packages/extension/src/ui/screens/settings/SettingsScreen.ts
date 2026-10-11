import type { WalletSettings } from '@sqw/types/WalletSettings';
import { css, html, nothing, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import type { UiError } from '../../core/errors';
import type { WidgetEvent } from '../../core/events';
import { screenHeader } from '../../core/header';
import { Screen } from '../../core/Screen';
import { screenStyles, textStyles } from '../../core/styles';
import { failed, loading, ready, type WidgetState } from '../../core/Widget';
import '../../widgets/button/Button';
import '../../widgets/copy-address/CopyAddress';
import '../../widgets/settings-form/SettingsForm';
import type { SettingsFormData } from '../../widgets/settings-form/SettingsForm';

/** Guard-rails the owner sets for themselves, recorded on the Ferra chain with a passkey signature. */
@customElement('sq-settings-screen')
export class SettingsScreen extends Screen {
  @state() private settings: WalletSettings | null = null;
  @state() private loadError: UiError | null = null;
  @state() private address: string | null = null;
  @state() private busy = false;
  @state() private error: UiError | null = null;
  @state() private saved = false;

  static override styles = [
    screenStyles,
    textStyles,
    css`
      section {
        display: grid;
        gap: var(--sq-space-2);
      }
      p {
        font-size: 13px;
        line-height: 1.45;
      }
    `,
  ];

  override connectedCallback(): void {
    super.connectedCallback();
    void this.#load();
  }

  override render(): TemplateResult {
    return html`
      ${screenHeader({ title: 'Réglages', onBack: () => this.router.go('home', undefined), backDisabled: this.busy })}
      <section>
        <span class="eyebrow">Mes limites</span>
        <p class="muted">
          Vos propres garde-fous. Au-delà, Swissquote vous demande une confirmation supplémentaire ; il ne bloque pas.
        </p>
        <sq-settings-form
          .state=${this.#formState()}
          @settings-submitted=${this.#save}
          @retry=${this.#load}
        ></sq-settings-form>
      </section>
      <section>
        <span class="eyebrow">Récupération</span>
        <p class="muted">Votre téléphone de secours permet de récupérer le wallet si vous perdez votre passkey.</p>
        <div>
          <sq-button variant="secondary" ?disabled=${this.busy} @click=${() => this.router.go('recovery-phone', undefined)}
            >Téléphone de secours</sq-button
          >
        </div>
      </section>
      ${this.address
        ? html`<section>
            <span class="eyebrow">Adresse du compte</span>
            <div><sq-copy-address .address=${this.address}></sq-copy-address></div>
          </section>`
        : nothing}
    `;
  }

  #formState(): WidgetState<SettingsFormData> {
    if (this.loadError) return failed(this.loadError);
    if (!this.settings) return loading;
    return ready({ settings: this.settings, busy: this.busy, error: this.error, saved: this.saved });
  }

  readonly #load = async (): Promise<void> => {
    this.loadError = null;
    this.settings = null;
    const [settings, wallet] = await Promise.all([this.bridge.getSettings(), this.bridge.getWallet()]);
    if (!this.isConnected) return;
    if (!settings.ok) {
      this.loadError = settings.error;
      return;
    }
    this.settings = settings.value;
    this.address = wallet.ok ? wallet.value.address : null;
  };

  readonly #save = async (e: WidgetEvent<'settings-submitted'>): Promise<void> => {
    if (this.busy) return;
    this.busy = true;
    this.error = null;
    this.saved = false;
    const result = await this.bridge.saveSettings(e.detail);
    this.busy = false;
    if (!this.isConnected) return;
    if (!result.ok) {
      this.error = result.error;
      return;
    }
    this.settings = result.value;
    this.saved = true;
  };
}

declare global {
  interface HTMLElementTagNameMap {
    'sq-settings-screen': SettingsScreen;
  }
}
