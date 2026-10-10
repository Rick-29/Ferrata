import { css, html, nothing, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { errorMessage, type UiError } from '../../core/errors';
import { formatUnits } from '../../core/format';
import { Screen, toWidgetState } from '../../core/Screen';
import { surfaceStyles, textStyles } from '../../core/styles';
import { loading, type WidgetState } from '../../core/Widget';
import type { AirdropOutcome, TestnetWallet } from '../../services/UiBridge';
import '../../widgets/button/Button';
import '../../widgets/copy-address/CopyAddress';

type AirdropState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'busy' }
  | { readonly kind: 'done'; readonly outcome: AirdropOutcome }
  | { readonly kind: 'error'; readonly error: UiError };

/**
 * Test networks (P3): the wallet's Solana devnet address, its balance and a faucet button. The
 * airdrop lands on devnet, then the Ferra chain records it as an attested external event.
 */
@customElement('sq-testnet-wallets')
export class TestnetWalletsPanel extends Screen {
  @state() private wallets: WidgetState<readonly TestnetWallet[]> = loading;
  @state() private airdrop: AirdropState = { kind: 'idle' };

  static override styles = [
    surfaceStyles,
    textStyles,
    css`
      :host {
        display: grid;
        gap: var(--sq-space-2);
      }
      .card {
        display: grid;
        gap: var(--sq-space-2);
      }
      .row {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        gap: var(--sq-space-2);
      }
      .badge {
        font-size: 11px;
        padding: 2px 6px;
        border-radius: 999px;
        background: var(--sq-surface-sunken);
      }
      .note {
        font-size: 12px;
      }
      .error {
        color: var(--sq-danger, #b42318);
      }
      a {
        color: var(--sq-accent);
      }
    `,
  ];

  override connectedCallback(): void {
    super.connectedCallback();
    void this.#load();
  }

  override render(): TemplateResult {
    return html`
      <span class="eyebrow">Réseaux de test</span>
      ${this.#renderWallets()}
    `;
  }

  #renderWallets(): TemplateResult | typeof nothing {
    switch (this.wallets.kind) {
      case 'idle':
        return nothing;
      case 'loading':
        return html`<p class="note">Chargement…</p>`;
      case 'error':
        return html`<p class="note error">${errorMessage(this.wallets.error)}</p>`;
      case 'ready':
        return html`${this.wallets.data.map((w) => this.#renderWallet(w))}`;
    }
  }

  #renderWallet(wallet: TestnetWallet): TemplateResult {
    const balance = wallet.balance === null ? '—' : `${formatUnits(wallet.balance, wallet.decimals)} ${wallet.symbol}`;
    return html`
      <div class="card">
        <div class="row">
          <strong>${wallet.label}</strong>
          <span class="badge">testnet · sans valeur</span>
        </div>
        <sq-copy-address .address=${wallet.address}></sq-copy-address>
        <div class="row">
          <span>Solde</span>
          <strong>${balance}</strong>
        </div>
        <sq-button variant="secondary" ?busy=${this.airdrop.kind === 'busy'} @click=${this.#requestAirdrop}>
          Recevoir 1 ${wallet.symbol} de test
        </sq-button>
        ${this.#renderAirdrop()}
        <a class="note" href=${wallet.explorerUrl} target="_blank" rel="noopener noreferrer">Voir sur l'explorateur Solana</a>
      </div>
    `;
  }

  #renderAirdrop(): TemplateResult | typeof nothing {
    switch (this.airdrop.kind) {
      case 'idle':
        return nothing;
      case 'busy':
        return html`<p class="note">Demande au faucet devnet puis confirmation (jusqu'à 30 s)…</p>`;
      case 'error':
        return html`<p class="note error">${errorMessage(this.airdrop.error)}</p>`;
      case 'done': {
        const { outcome } = this.airdrop;
        const ferra =
          outcome.recordedOnFerra > 0
            ? `inscrit dans Ferra chain (${outcome.recordedOnFerra} événement${outcome.recordedOnFerra > 1 ? 's' : ''})`
            : "pas encore inscrit dans Ferra chain (le serveur le rattrapera)";
        return html`<p class="note">
          ✓ ${formatUnits(outcome.amount, 9)} SOL reçus, ${ferra}.
          <a href=${outcome.explorerUrl} target="_blank" rel="noopener noreferrer">Transaction</a>
        </p>`;
      }
    }
  }

  readonly #load = async (): Promise<void> => {
    this.wallets = loading;
    this.wallets = toWidgetState(await this.bridge.getTestnetWallets());
  };

  readonly #requestAirdrop = async (): Promise<void> => {
    if (this.airdrop.kind === 'busy') return;
    this.airdrop = { kind: 'busy' };
    const result = await this.bridge.requestAirdrop('solana-devnet');
    this.airdrop = result.ok ? { kind: 'done', outcome: result.value } : { kind: 'error', error: result.error };
    if (result.ok) void this.#load();
  };
}

declare global {
  interface HTMLElementTagNameMap {
    'sq-testnet-wallets': TestnetWalletsPanel;
  }
}
