import type { AccountView } from '@sqw/types/AccountView';
import type { AssetBalance } from '@sqw/types/AssetBalance';
import { css, html, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { Screen, toWidgetState } from '../../core/Screen';
import { screenStyles, textStyles } from '../../core/styles';
import { loading, type WidgetState } from '../../core/Widget';
import '../../widgets/asset-list/AssetList';
import '../../widgets/balance-card/BalanceCard';
import '../../widgets/button/Button';
import '../../widgets/gasless-badge/GaslessBadge';

/** Balance, assets and the way into Send. Reloads the wallet every time it opens. */
@customElement('sq-home-screen')
export class HomeScreen extends Screen {
  @state() private wallet: WidgetState<AccountView> = loading;

  static override styles = [
    screenStyles,
    textStyles,
    css`
      .brand {
        color: var(--sq-accent);
      }
      section {
        display: grid;
        gap: var(--sq-space-2);
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
      <div class="topbar">
        <span class="eyebrow brand">Swissquote Wallet</span>
        <sq-gasless-badge></sq-gasless-badge>
      </div>
      <sq-balance-card .state=${this.wallet} @retry=${this.#load}></sq-balance-card>
      <div class="actions">
        <sq-button ?disabled=${!isReady} @click=${() => this.router.go('send', undefined)}>Envoyer</sq-button>
      </div>
      <section>
        <span class="eyebrow">Actifs</span>
        <sq-asset-list .state=${assetsState(this.wallet)}></sq-asset-list>
      </section>
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
