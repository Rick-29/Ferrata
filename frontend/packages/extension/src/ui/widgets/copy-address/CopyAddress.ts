import { LitElement, css, html, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { shortAddress } from '../../core/format';
import { icon } from '../../core/icons';

const FEEDBACK_MS = 1500;

type CopyStatus = 'idle' | 'copied' | 'failed';

const STATUS_LABEL: Readonly<Record<CopyStatus, string>> = {
  idle: 'Copier',
  copied: 'Copié',
  failed: 'Copie impossible',
};

/** Short address with a copy action; the full address stays in the tooltip and the clipboard. */
@customElement('sq-copy-address')
export class CopyAddress extends LitElement {
  @property() address = '';
  @state() private status: CopyStatus = 'idle';
  #timer: ReturnType<typeof setTimeout> | undefined;

  static override styles = css`
    button {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      height: 24px;
      padding: 0 9px;
      font: inherit;
      font-size: 9px;
      border-radius: 999px;
      border: 1px solid var(--sq-border);
      background: rgba(255, 255, 255, 0.04);
      color: #bcc1cf;
      cursor: pointer;
      transition: color var(--sq-duration) var(--sq-ease);
    }
    button:hover {
      color: var(--sq-text);
    }
    button:focus-visible {
      outline: 2px solid var(--sq-focus);
      outline-offset: 2px;
    }
    .status {
      display: inline-flex;
      font-weight: 600;
    }
    .copied {
      color: var(--sq-risk-low);
    }
  `;

  override disconnectedCallback(): void {
    clearTimeout(this.#timer);
    super.disconnectedCallback();
  }

  override render(): TemplateResult {
    return html`
      <button type="button" title=${this.address} aria-label="Copier l'adresse ${this.address}" @click=${this.#copy}>
        <span>${shortAddress(this.address)}</span>
        <span class="status ${this.status}" aria-live="polite">
          ${this.status === 'idle' ? icon('copy', 13) : STATUS_LABEL[this.status]}
        </span>
      </button>
    `;
  }

  async #copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.address);
      this.status = 'copied';
    } catch {
      this.status = 'failed';
    }
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.status = 'idle';
    }, FEEDBACK_MS);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'sq-copy-address': CopyAddress;
  }
}
