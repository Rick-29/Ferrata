import type { AccountView } from '@sqw/types/AccountView';
import type { AssetBalance } from '@sqw/types/AssetBalance';
import { css, html, nothing, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { icon } from '../../core/icons';
import { Screen, toWidgetState } from '../../core/Screen';
import { screenStyles, textStyles } from '../../core/styles';
import { idle, loading, type WidgetState } from '../../core/Widget';
import type { UiError } from '../../core/errors';
import type { RecoveryAlert, TestnetWallet } from '../../services/UiBridge';
import '../../widgets/asset-list/AssetList';
import '../../widgets/balance-card/BalanceCard';
import '../../widgets/brand/Brand';
import '../../widgets/recovery-alert/RecoveryAlert';
import '../../widgets/testnet-balance/TestnetBalanceCard';
import './TestnetReceivePanel';
import './TestnetSendPanel';

type NetworkTab = 'mainnet' | 'testnet';

/** Remembers the last tab in this popup (per-viewer convenience; storage may be unavailable). */
const TAB_KEY = 'sqw-home-network';
function savedTab(): NetworkTab {
  try {
    return localStorage.getItem(TAB_KEY) === 'testnet' ? 'testnet' : 'mainnet';
  } catch {
    return 'mainnet';
  }
}

/**
 * Two worlds, one switch: Mainnet shows the client's account (balance, send, activity), Testnet
 * shows only the test coins (Solana devnet, Base Sepolia). Reloads the wallet every time it opens.
 */
@customElement('sq-home-screen')
export class HomeScreen extends Screen {
  @state() private wallet: WidgetState<AccountView> = loading;
  @state() private tab: NetworkTab = savedTab();
  @state() private testnet: WidgetState<readonly TestnetWallet[]> = idle;
  @state() private receiving = false;
  @state() private sending = false;
  @state() private alerts: readonly RecoveryAlert[] = [];
  @state() private alertBusy = false;
  @state() private alertError: UiError | null = null;

  static override styles = [
    screenStyles,
    textStyles,
    css`
      .header {
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      .lock {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        height: 26px;
        padding: 0 10px;
        border-radius: 999px;
        border: 1px solid var(--sq-border);
        background: rgba(255, 255, 255, 0.04);
        color: var(--sq-text-muted);
        font: 600 10px var(--sq-font);
        cursor: pointer;
      }
      .lock:hover {
        color: var(--sq-text);
      }
      .networks {
        display: grid;
        grid-template-columns: 1fr 1fr;
        padding: 3px;
        border-radius: 999px;
        background: var(--sq-surface-sunken);
        border: 1px solid var(--sq-border);
      }
      .networks button {
        border: 0;
        padding: 7px 0;
        border-radius: 999px;
        background: none;
        color: var(--sq-text-muted);
        font: 600 11px var(--sq-font);
        cursor: pointer;
        transition: color var(--sq-duration) var(--sq-ease);
      }
      .networks button[aria-pressed='true'] {
        color: var(--sq-accent-text);
        background: var(--sq-brand-gradient);
        box-shadow: 0 6px 16px rgba(255, 75, 31, 0.25);
      }
      .networks button:focus-visible {
        outline: 2px solid var(--sq-focus);
        outline-offset: 2px;
      }
      .quick {
        display: flex;
        justify-content: space-around;
        margin: 4px 3px 0;
      }
      .quick button {
        border: 0;
        padding: 0;
        background: none;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 6px;
        color: #c8cbd7;
        font: inherit;
        font-size: 10px;
        cursor: pointer;
      }
      .quick i {
        width: 44px;
        height: 44px;
        border-radius: 15px;
        display: grid;
        place-items: center;
        background: linear-gradient(
          145deg,
          rgba(255, 106, 26, 0.18),
          rgba(255, 61, 127, 0.14) 50%,
          rgba(123, 92, 255, 0.2)
        );
        border: 1px solid rgba(255, 255, 255, 0.07);
        transition:
          transform var(--sq-duration) var(--sq-ease),
          box-shadow var(--sq-duration) var(--sq-ease);
      }
      .quick button:hover:not(:disabled) i {
        background: var(--sq-brand-gradient);
        transform: translateY(-2px);
        box-shadow: 0 10px 22px rgba(255, 75, 31, 0.2);
      }
      .quick button:focus-visible i {
        outline: 2px solid var(--sq-focus);
        outline-offset: 2px;
      }
      .quick button:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
      section {
        display: grid;
        gap: 7px;
      }
      .section-title {
        font: 600 13px var(--sq-font-display);
      }
    `,
  ];

  override connectedCallback(): void {
    super.connectedCallback();
    void this.#load();
    if (this.tab === 'testnet') void this.#loadTestnet();
  }

  override render(): TemplateResult {
    return html`
      <div class="header">
        <sq-brand compact></sq-brand>
        <button type="button" class="lock" title="Verrouiller le wallet" @click=${this.#lock}>${icon('key', 16)} Verrouiller</button>
      </div>
      ${this.alerts.map(
        (alert) => html`<sq-recovery-alert
          .alert=${alert}
          ?busy=${this.alertBusy}
          .error=${this.alertError}
          @cancel-recovery=${(e: CustomEvent<string>) => void this.#cancelRecovery(e.detail)}
        ></sq-recovery-alert>`,
      )}
      <div class="networks" role="group" aria-label="Réseau">
        ${this.#tabButton('mainnet', 'Mainnet')} ${this.#tabButton('testnet', 'Testnet')}
      </div>
      ${this.tab === 'testnet' ? this.#renderTestnet() : this.#renderMainnet()}
    `;
  }

  #tabButton(tab: NetworkTab, label: string): TemplateResult {
    return html`<button type="button" aria-pressed=${this.tab === tab ? 'true' : 'false'} @click=${() => this.#select(tab)}>
      ${label}
    </button>`;
  }

  #renderMainnet(): TemplateResult {
    const isReady = this.wallet.kind === 'ready';
    return html`
      <sq-balance-card .state=${this.wallet} @retry=${this.#load}></sq-balance-card>
      <nav class="quick" aria-label="Actions">
        <button type="button" ?disabled=${!isReady} @click=${() => this.router.go('send', undefined)}>
          <i>${icon('send')}</i>Envoyer
        </button>
        <button type="button" @click=${() => this.router.go('activity', undefined)}>
          <i>${icon('activity')}</i>Activité
        </button>
        <button type="button" @click=${() => this.router.go('settings', undefined)}>
          <i>${icon('gear')}</i>Réglages
        </button>
      </nav>
      <section>
        <span class="section-title">Actifs</span>
        <sq-asset-list .state=${assetsState(this.wallet)}></sq-asset-list>
      </section>
    `;
  }

  /** Same layout as Mainnet, plus "Recevoir": Envoyer and Recevoir open their panel under the buttons. */
  #renderTestnet(): TemplateResult {
    const wallets = this.testnet.kind === 'ready' ? this.testnet.data : null;
    return html`
      <sq-testnet-balance .state=${this.testnet}></sq-testnet-balance>
      <nav class="quick" aria-label="Actions">
        <button
          type="button"
          ?disabled=${wallets === null}
          aria-expanded=${this.sending ? 'true' : 'false'}
          @click=${() => {
            this.sending = !this.sending;
            this.receiving = false;
          }}
        >
          <i>${icon('send')}</i>Envoyer
        </button>
        <button
          type="button"
          ?disabled=${wallets === null}
          aria-expanded=${this.receiving ? 'true' : 'false'}
          @click=${() => {
            this.receiving = !this.receiving;
            this.sending = false;
          }}
        >
          <i>${icon('receive')}</i>Recevoir
        </button>
        <button type="button" @click=${() => this.router.go('activity', undefined)}>
          <i>${icon('activity')}</i>Activité
        </button>
        <button type="button" @click=${() => this.router.go('settings', undefined)}>
          <i>${icon('gear')}</i>Réglages
        </button>
      </nav>
      ${this.sending && wallets
        ? html`<sq-testnet-send .wallets=${wallets} @testnet-changed=${this.#loadTestnet}></sq-testnet-send>`
        : ''}
      ${this.receiving && wallets
        ? html`<sq-testnet-receive .wallets=${wallets} @testnet-changed=${this.#loadTestnet}></sq-testnet-receive>`
        : ''}
      <section>
        <span class="section-title">Actifs</span>
        <sq-asset-list
          .state=${testnetAssets(this.testnet)}
          .notes=${this.testnet.kind === 'ready' ? this.testnet.data.map((w) => w.label) : []}
        ></sq-asset-list>
      </section>
    `;
  }

  #select(tab: NetworkTab): void {
    this.tab = tab;
    if (tab === 'testnet') void this.#loadTestnet();
    try {
      localStorage.setItem(TAB_KEY, tab);
    } catch {
      // Storage unavailable: the choice just lasts for this popup.
    }
  }

  readonly #lock = async (): Promise<void> => {
    await this.bridge.lock();
    this.router.go('onboarding', undefined);
  };

  readonly #load = async (): Promise<void> => {
    this.wallet = loading;
    this.wallet = toWidgetState(await this.bridge.getWallet());
    // Best effort: a failure to read alerts must not hide the wallet.
    const alerts = await this.bridge.getRecoveryAlerts();
    if (this.isConnected) this.alerts = alerts.ok ? alerts.value : [];
  };

  /** "Ce n'est pas moi": the current passkey cancels a recovery started elsewhere. */
  readonly #cancelRecovery = async (id: string): Promise<void> => {
    if (this.alertBusy) return;
    this.alertBusy = true;
    this.alertError = null;
    const cancelled = await this.bridge.cancelRecovery(id);
    this.alertBusy = false;
    if (!this.isConnected) return;
    if (!cancelled.ok) {
      this.alertError = cancelled.error;
      return;
    }
    this.alerts = this.alerts.filter((a) => a.id !== id);
  };

  /** Also makes the backend sync each test address, so new deposits land on the Ferra chain. */
  readonly #loadTestnet = async (): Promise<void> => {
    if (this.testnet.kind !== 'ready') this.testnet = loading;
    this.testnet = toWidgetState(await this.bridge.getTestnetWallets());
  };
}

/** Test coins as asset rows, so the Testnet tab reuses the Mainnet asset list as is. */
function testnetAssets(testnet: WidgetState<readonly TestnetWallet[]>): WidgetState<readonly AssetBalance[]> {
  switch (testnet.kind) {
    case 'ready':
      return {
        kind: 'ready',
        data: testnet.data.map((w) => ({ asset: null, symbol: w.symbol, decimals: w.decimals, amount: w.balance ?? '0' })),
      };
    case 'error':
      return { kind: 'idle' };
    default:
      return testnet;
  }
}

/** The asset list follows the wallet's state; its error is already shown on the balance card. */
function assetsState(wallet: WidgetState<AccountView>): WidgetState<readonly AssetBalance[]> {
  switch (wallet.kind) {
    case 'ready':
      return { kind: 'ready', data: wallet.data.balances };
    case 'error':
      return { kind: 'idle' };
    default:
      return wallet;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'sq-home-screen': HomeScreen;
  }
}
