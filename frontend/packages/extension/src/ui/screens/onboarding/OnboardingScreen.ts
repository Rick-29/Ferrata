import type { LoginRequest } from '@sqw/types/LoginRequest';
import { css, html, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import type { UiError } from '../../core/errors';
import type { WidgetEvent } from '../../core/events';
import { Screen } from '../../core/Screen';
import { screenStyles, textStyles } from '../../core/styles';
import { ready } from '../../core/Widget';
import { icon } from '../../core/icons';
import '../../widgets/brand/Brand';
import '../../widgets/consent-checkbox/ConsentCheckbox';
import '../../widgets/legal-notice/LegalNotice';
import '../../widgets/login-form/LoginForm';
import '../../widgets/passkey-prompt/PasskeyPrompt';
import '../../widgets/step-progress/StepProgress';

const STEPS = ['Connexion', 'Passkey', 'Prêt'] as const;

type Step = 'login' | 'passkey';

/** Create wallet: Swissquote login, then a passkey that becomes the account owner. */
@customElement('sq-onboarding-screen')
export class OnboardingScreen extends Screen {
  @state() private step: Step = 'login';
  @state() private busy = false;
  @state() private error: UiError | null = null;
  @state() private consented = false;

  static override styles = [
    screenStyles,
    textStyles,
    css`
      :host {
        display: flex;
        flex-direction: column;
        gap: var(--sq-space-4);
        min-height: 560px;
      }
      header {
        display: grid;
        gap: 25px;
        margin-top: 34px;
      }
      .lead {
        max-width: 290px;
        font: 500 18px/1.35 var(--sq-font-display);
        letter-spacing: -0.035em;
      }
      .hero {
        margin-top: 26px;
        display: grid;
        justify-items: center;
        gap: 10px;
        text-align: center;
      }
      .orb {
        position: relative;
        width: 110px;
        height: 110px;
        margin-bottom: 12px;
        border-radius: 38px;
        display: grid;
        place-items: center;
        color: #eeeaff;
        background: linear-gradient(145deg, rgba(255, 61, 127, 0.2), rgba(123, 92, 255, 0.2));
        border: 1px solid rgba(255, 255, 255, 0.1);
        box-shadow:
          inset 0 0 28px rgba(255, 255, 255, 0.05),
          0 0 50px rgba(123, 92, 255, 0.22);
      }
      .mini-key {
        position: absolute;
        right: -3px;
        bottom: 5px;
        width: 28px;
        height: 28px;
        border-radius: 10px;
        display: grid;
        place-items: center;
        background: var(--sq-brand-gradient);
        color: #fff;
      }
      .hero p {
        max-width: 280px;
        font-size: 11px;
        line-height: 1.5;
      }
      sq-step-progress {
        margin-top: auto;
        padding-top: var(--sq-space-4);
      }
    `,
  ];

  override render(): TemplateResult {
    return html`
      ${this.step === 'login'
        ? html`<header>
            <sq-brand></sq-brand>
            <p class="lead">
              Vos fonds restent à vous. Swissquote co-signe chaque transaction mais ne peut jamais les déplacer.
            </p>
          </header>`
        : html`<div class="hero">
            <div class="orb" aria-hidden="true">${icon('fingerprint', 54)}<span class="mini-key">${icon('key', 16)}</span></div>
            <h1>Créer votre passkey</h1>
            <p class="muted">
              Votre passkey est la clé de votre wallet. Elle reste sur cet appareil et Swissquote n'y a jamais accès.
            </p>
          </div>`}
      ${this.step === 'login'
        ? html`<sq-login-form
            .state=${ready({ busy: this.busy, error: this.error })}
            @login-submitted=${this.#login}
          ></sq-login-form>`
        : html`<sq-consent-checkbox
              label="J'accepte les conditions d'utilisation et je comprends que l'analyse de risque de Swissquote est indicative."
              .checked=${this.consented}
              ?disabled=${this.busy}
              @consent-changed=${(e: WidgetEvent<'consent-changed'>) => (this.consented = e.detail)}
            ></sq-consent-checkbox>
            <sq-legal-notice></sq-legal-notice>
            <sq-passkey-prompt
            .state=${ready({
              title: 'Passkey de cet appareil',
              description: 'Empreinte, visage ou code de votre appareil : rien à retenir.',
              actionLabel: 'Créer ma passkey',
              busy: this.busy,
              disabled: !this.consented,
              error: this.error,
            })}
            @passkey-requested=${this.#createWallet}
            @retry=${this.#createWallet}
          ></sq-passkey-prompt>`}
      <sq-step-progress .state=${ready({ steps: STEPS, current: this.step === 'login' ? 0 : 1 })}></sq-step-progress>
    `;
  }

  readonly #login = async (e: WidgetEvent<'login-submitted'>): Promise<void> => {
    const credentials: LoginRequest = e.detail;
    await this.#run(async () => {
      const result = await this.bridge.login(credentials);
      if (!result.ok) return result.error;
      this.step = 'passkey';
      return null;
    });
  };

  readonly #createWallet = async (): Promise<void> => {
    if (!this.consented) return;
    await this.#run(async () => {
      const result = await this.bridge.createWallet();
      if (!result.ok) return result.error;
      if (this.isConnected) this.router.go('home', undefined);
      return null;
    });
  };

  /** One action at a time: shows busy, then the error if the action returned one. */
  async #run(action: () => Promise<UiError | null>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.error = null;
    this.error = await action();
    this.busy = false;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'sq-onboarding-screen': OnboardingScreen;
  }
}
