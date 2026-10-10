import { css, html, nothing, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';
import type { UiError } from '../../core/errors';
import { icon } from '../../core/icons';
import { textStyles } from '../../core/styles';
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
    css`
      section {
        display: grid;
        gap: var(--sq-space-3);
      }
      .card {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 11px 12px;
        border-radius: 16px;
        border: 1px solid var(--sq-border);
        background: var(--sq-soft-gradient);
      }
      .icon {
        flex: none;
        width: 31px;
        height: 31px;
        border-radius: 10px;
        display: grid;
        place-items: center;
        color: #b8adff;
        background: rgba(123, 92, 255, 0.15);
      }
      .icon.busy {
        animation: pulse 1.2s ease-in-out infinite;
      }
      .copy {
        display: grid;
        gap: 3px;
      }
      h2 {
        font: 600 12px/1.3 var(--sq-font);
      }
      p {
        font-size: 10px;
        line-height: 1.45;
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
      <section aria-busy=${data.busy ? 'true' : 'false'}>
        <div class="card">
          <span class="icon ${data.busy ? 'busy' : ''}" aria-hidden="true">${icon('fingerprint')}</span>
          <div class="copy">
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
