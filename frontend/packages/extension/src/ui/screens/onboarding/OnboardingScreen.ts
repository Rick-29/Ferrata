import type { LoginRequest } from '@sqw/types/LoginRequest';
import { css, html, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import type { UiError } from '../../core/errors';
import type { WidgetEvent } from '../../core/events';
import { Screen } from '../../core/Screen';
import { screenStyles, textStyles } from '../../core/styles';
import { ready } from '../../core/Widget';
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
      header {
        display: grid;
        gap: var(--sq-space-2);
        padding-top: var(--sq-space-2);
      }
      .brand {
        color: var(--sq-accent);
      }
      .lead {
        font-size: 14px;
        line-height: 1.45;
      }
    `,
  ];

  override render(): TemplateResult {
    return html`
      <header>
        <span class="eyebrow brand">Swissquote Wallet</span>
        <h1>${this.step === 'login' ? 'Connectez-vous' : 'Sécurisez votre wallet'}</h1>
        <p class="muted lead">
          ${this.step === 'login'
            ? 'Vos fonds restent à vous. Swissquote co-signe chaque transaction mais ne peut jamais les déplacer.'
            : 'Votre passkey est la clé de votre wallet. Elle reste sur cet appareil et ne le quitte jamais.'}
        </p>
      </header>
      <sq-step-progress .state=${ready({ steps: STEPS, current: this.step === 'login' ? 0 : 1 })}></sq-step-progress>
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
              title: 'Créer votre passkey',
              description: 'Empreinte, visage ou code de votre appareil : rien à retenir.',
              actionLabel: 'Créer ma passkey',
              busy: this.busy,
              disabled: !this.consented,
              error: this.error,
            })}
            @passkey-requested=${this.#createWallet}
            @retry=${this.#createWallet}
          ></sq-passkey-prompt>`}
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
