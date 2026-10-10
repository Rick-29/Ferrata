import { css, html, nothing, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import type { UiError } from '../../core/errors';
import { fieldStyles, textStyles } from '../../core/styles';
import { Widget } from '../../core/Widget';
import '../button/Button';

export interface FormStatus {
  readonly busy: boolean;
  readonly error: UiError | null;
}

/** Mock Swissquote login. Keeps what is typed locally and emits it on submit; never stores it. */
@customElement('sq-login-form')
export class LoginForm extends Widget<FormStatus> {
  @state() private username = '';
  @state() private password = '';

  static override styles = [
    textStyles,
    fieldStyles,
    css`
      form {
        display: grid;
        gap: var(--sq-space-3);
      }
    `,
  ];

  protected override renderReady({ busy, error }: FormStatus): TemplateResult {
    const canSubmit = this.username.trim() !== '' && this.password !== '' && !busy;
    return html`
      <form @submit=${this.#onSubmit} @keydown=${this.#onKeydown} novalidate>
        <div class="field">
          <label for="username">Identifiant Swissquote</label>
          <input
            id="username"
            autocomplete="username"
            .value=${this.username}
            ?disabled=${busy}
            @input=${(e: InputEvent) => (this.username = inputValue(e))}
          />
        </div>
        <div class="field">
          <label for="password">Mot de passe</label>
          <input
            id="password"
            type="password"
            autocomplete="current-password"
            .value=${this.password}
            ?disabled=${busy}
            @input=${(e: InputEvent) => (this.password = inputValue(e))}
          />
          <span class="hint">Démo : alice / demo</span>
        </div>
        ${error ? html`<sq-error-panel .error=${error} @retry=${this.#retry}></sq-error-panel>` : nothing}
        <sq-button ?busy=${busy} ?disabled=${!canSubmit} @click=${this.#submit}>Se connecter</sq-button>
      </form>
    `;
  }

  readonly #onSubmit = (e: SubmitEvent): void => {
    e.preventDefault();
    this.#submit();
  };

  // The submit button lives in sq-button's shadow root, so the form has no native submitter: handle Enter here.
  readonly #onKeydown = (e: KeyboardEvent): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      this.#submit();
    }
  };

  // Retrying a login is resubmitting what is typed; the Screen never sees the credentials otherwise.
  readonly #retry = (e: Event): void => {
    e.stopPropagation();
    this.#submit();
  };

  readonly #submit = (): void => {
    if (this.state.kind === 'ready' && this.state.data.busy) return;
    if (this.username.trim() === '' || this.password === '') return;
    this.emit('login-submitted', { username: this.username.trim(), password: this.password });
  };
}

function inputValue(e: Event): string {
  return e.target instanceof HTMLInputElement ? e.target.value : '';
}

declare global {
  interface HTMLElementTagNameMap {
    'sq-login-form': LoginForm;
  }
}
