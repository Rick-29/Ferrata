import { css, html, nothing, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';
import type { UiError } from '../../core/errors';
import { surfaceStyles, textStyles } from '../../core/styles';
import { Widget } from '../../core/Widget';
import '../button/Button';

export interface PasskeyPromptData {
  readonly title: string;
  readonly description: string;
  readonly actionLabel: string;
  readonly busy: boolean;
  /** Blocks the action until a precondition is met (e.g. the risk was explicitly accepted). */
  readonly disabled: boolean;
  readonly error: UiError | null;
}

/** Asks the user to use their passkey (create or sign). The Screen does the work on `passkey-requested`. */
@customElement('sq-passkey-prompt')
export class PasskeyPrompt extends Widget<PasskeyPromptData> {
  static override styles = [
    textStyles,
    surfaceStyles,
    css`
      .card {
        display: grid;
        gap: var(--sq-space-3);
      }
      .head {
        display: flex;
        gap: var(--sq-space-3);
        align-items: flex-start;
      }
      .icon {
        flex: none;
        display: grid;
        place-items: center;
        width: 40px;
        height: 40px;
        border-radius: var(--sq-radius-md);
        color: var(--sq-accent);
        background: color-mix(in srgb, var(--sq-accent) 12%, transparent);
      }
      .icon.busy {
        animation: pulse 1.2s var(--sq-ease) infinite;
      }
      svg {
        width: 22px;
        height: 22px;
      }
      p {
        font-size: 13px;
        line-height: 1.45;
        margin-top: 2px;
      }
      @keyframes pulse {
        50% {
          opacity: 0.45;
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .icon.busy {
          animation: none;
        }
      }
    `,
  ];

  protected override renderReady(data: PasskeyPromptData): TemplateResult {
    return html`
      <section class="card" aria-busy=${data.busy ? 'true' : 'false'}>
        <div class="head">
          <span class="icon ${data.busy ? 'busy' : ''}" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
              <circle cx="8" cy="12" r="3.5" />
              <path d="M11.5 12H21m-3 0v3m-3-3v2" />
            </svg>
          </span>
          <div>
            <h2>${data.title}</h2>
            <p class="muted">${data.busy ? 'Suivez les instructions de votre appareil…' : data.description}</p>
          </div>
        </div>
        ${data.error ? html`<sq-error-panel .error=${data.error}></sq-error-panel>` : nothing}
        <sq-button ?busy=${data.busy} ?disabled=${data.disabled} @click=${() => this.emit('passkey-requested', undefined)}>
          ${data.actionLabel}
        </sq-button>
      </section>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'sq-passkey-prompt': PasskeyPrompt;
  }
}
