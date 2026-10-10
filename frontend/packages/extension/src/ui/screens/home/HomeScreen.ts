import type { AccountView } from '@sqw/types/AccountView';
import type { AssetBalance } from '@sqw/types/AssetBalance';
import { css, html, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { icon } from '../../core/icons';
import { Screen, toWidgetState } from '../../core/Screen';
import { screenStyles, textStyles } from '../../core/styles';
import { loading, type WidgetState } from '../../core/Widget';
import '../../widgets/asset-list/AssetList';
import '../../widgets/balance-card/BalanceCard';
import '../../widgets/brand/Brand';
import './TestnetWalletsPanel';

/** Balance, assets and the way into Send. Reloads the wallet every time it opens. */
@customElement('sq-home-screen')
export class HomeScreen extends Screen {
  @state() private wallet: WidgetState<AccountView> = loading;

  static override styles = [
    screenStyles,
    textStyles,
    css`
      .header {
        display: flex;
        justify-content: space-between;
        align-items: center;
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
  }

  override render(): TemplateResult {
    const isReady = this.wallet.kind === 'ready';
    return html`
      <div class="header"><sq-brand compact></sq-brand></div>
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
      ${isReady ? html`<sq-testnet-wallets></sq-testnet-wallets>` : ''}
    `;
  }

  readonly #load = async (): Promise<void> => {
    this.wallet = loading;
    this.wallet = toWidgetState(await this.bridge.getWallet());
  };
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
