import { css, html, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { errorMessage, type UiError } from '../../core/errors';
import { formatUnits } from '../../core/format';
import { Screen } from '../../core/Screen';
import { textStyles } from '../../core/styles';
import type { AirdropOutcome, TestnetNetwork, TestnetWallet } from '../../services/UiBridge';
import '../../widgets/copy-address/CopyAddress';

type AirdropState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'busy' }
  | { readonly kind: 'done'; readonly outcome: AirdropOutcome }
  | { readonly kind: 'error'; readonly error: UiError };

/** Coin per test network, same glossy look as the asset list (design: .coin). */
const COINS: Readonly<Record<TestnetNetwork, { readonly glyph: string; readonly tone: string }>> = {
  'solana-devnet': { glyph: '◎', tone: 'sol' },
  'base-sepolia-usdc': { glyph: '$', tone: 'usdc' },
  'base-sepolia': { glyph: '◆', tone: 'eth' },
  'eth-sepolia': { glyph: '◆', tone: 'eth' },
};

/**
 * "Recevoir" on the Testnet tab (P3): each test network's address and how to fund it (in-wallet
 * airdrop or web faucet). Fires `testnet-changed` after an airdrop so Home reloads the balances.
 * Every deposit, whatever its source, is recorded on the Ferra chain when Home reloads.
 */
@customElement('sq-testnet-receive')
export class TestnetReceivePanel extends Screen {
  @property({ attribute: false }) wallets: readonly TestnetWallet[] = [];
  @state() private airdrop: AirdropState = { kind: 'idle' };

  static override styles = [
    textStyles,
    css`
      :host {
        display: grid;
        gap: 7px;
      }
      .section-title {
        font: 600 13px var(--sq-font-display);
      }
      ul {
        list-style: none;
        margin: 0;
        padding: 0;
        border-radius: 18px;
        overflow: hidden;
        background: rgba(20, 23, 38, 0.82);
        border: 1px solid var(--sq-border);
        box-shadow: var(--sq-shadow);
      }
      li {
        padding: 12px;
        display: grid;
        gap: 10px;
      }
      li + li {
        border-top: 1px solid var(--sq-border);
      }
      .row {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .coin {
        flex: none;
        width: 35px;
        height: 35px;
        border-radius: 50%;
        display: grid;
        place-items: center;
        color: #fff;
        font: 700 16px var(--sq-font-display);
        border: 2px solid rgba(255, 255, 255, 0.18);
        box-shadow:
          inset -4px -4px 8px rgba(0, 0, 0, 0.2),
          inset 3px 3px 7px rgba(255, 255, 255, 0.25),
          0 5px 14px var(--glow);
      }
      .sol {
        background: linear-gradient(145deg, #19fb9b, #9945ff);
        --glow: rgba(153, 69, 255, 0.4);
      }
      .eth {
        background: linear-gradient(145deg, #b4a8ff, #6150c9);
        --glow: rgba(129, 115, 223, 0.45);
        font-size: 13px;
      }
      .usdc {
        background: linear-gradient(145deg, #5fd1ff, #2775ca);
        --glow: rgba(39, 117, 202, 0.45);
        font-size: 13px;
      }
      .name {
        display: grid;
        gap: 3px;
      }
      .row sq-copy-address {
        margin-left: auto;
      }
      strong {
        font-size: 11px;
        font-weight: 600;
      }
      small {
        font-size: 9px;
        color: var(--sq-text-muted);
      }
      .actions {
        display: flex;
        gap: 8px;
      }
      .actions > * {
        flex: 1;
        text-align: center;
        padding: 8px 10px;
        border-radius: var(--sq-radius-sm);
        font: 600 11px var(--sq-font);
        text-decoration: none;
        cursor: pointer;
      }
      .primary {
        border: 0;
        color: var(--sq-accent-text);
        background: var(--sq-brand-gradient);
      }
      .primary:disabled {
        opacity: 0.6;
        cursor: progress;
      }
      .secondary {
        color: var(--sq-text);
        background: var(--sq-surface-sunken);
        border: 1px solid var(--sq-border);
      }
      .note {
        margin: 0;
        font-size: 10px;
        line-height: 1.45;
        color: var(--sq-text-muted);
      }
      .ok {
        color: var(--sq-risk-low);
      }
      .error {
        color: var(--sq-risk-critical);
      }
      a {
        color: var(--sq-accent);
      }
    `,
  ];

  override render(): TemplateResult {
    return html`
      <span class="section-title">Recevoir des cryptos de test</span>
      <ul aria-label="Recevoir">${this.wallets.map((w) => this.#renderWallet(w))}</ul>
    `;
  }

  #renderWallet(wallet: TestnetWallet): TemplateResult {
    const coin = COINS[wallet.network];
    return html`
      <li>
        <div class="row">
          <span class="coin ${coin.tone}" aria-hidden="true">${coin.glyph}</span>
          <span class="name"><strong>${wallet.label}</strong><small>${wallet.symbol}</small></span>
          <sq-copy-address .address=${wallet.address}></sq-copy-address>
        </div>
        <div class="actions">
          ${wallet.inWalletAirdrop
            ? html`<button type="button" class="primary" ?disabled=${this.airdrop.kind === 'busy'} @click=${this.#requestAirdrop}>
                ${this.airdrop.kind === 'busy' ? 'Envoi en cours…' : `Recevoir 1 ${wallet.symbol}`}
              </button>`
            : html`<a class="primary" href=${wallet.faucetUrl} target="_blank" rel="noopener noreferrer">Ouvrir le faucet</a>`}
          <a class="secondary" href=${wallet.explorerUrl} target="_blank" rel="noopener noreferrer">Explorateur</a>
        </div>
        ${wallet.inWalletAirdrop ? this.#renderAirdrop(wallet) : this.#faucetHint(wallet.network)}
      </li>
    `;
  }

  /**
   * Web faucets change often (checked 2026-10-10): Coinbase's needs a free CDP account, Alchemy's
   * needs 0.001 ETH on Ethereum mainnet at the address, Chainlink's needs a connected wallet.
   */
  #faucetHint(network: TestnetNetwork): TemplateResult {
    if (network === 'eth-sepolia') {
      return html`<p class="note">
        Faucet « à minage », sans compte : collez l'adresse, cliquez sur « Start Mining », laissez tourner quelques
        minutes puis réclamez. Le dépôt apparaît dans vos actifs et dans Ferra chain.
      </p>`;
    }
    if (network === 'base-sepolia-usdc') {
      return html`<p class="note">
        Compte intelligent (ERC-4337) : les envois d'USDC ne demandent aucun ETH, Swissquote prend le gas en charge via
        un paymaster. Collez l'adresse sur le faucet Circle (réseau Base Sepolia) pour recevoir des USDC de test.
      </p>`;
    }
    if (network !== 'base-sepolia') {
      return html`<p class="note">Collez l'adresse sur la page du faucet. Le dépôt apparaît ici et dans Ferra chain.</p>`;
    }
    return html`<p class="note">
      Le faucet Coinbase demande un compte Coinbase Developer (gratuit) : connectez-vous, collez l'adresse, puis revenez
      ici. Le dépôt apparaît dans vos actifs et dans Ferra chain. Autres faucets :
      <a href="https://www.alchemy.com/faucets/base-sepolia" target="_blank" rel="noopener noreferrer">Alchemy</a>
      (exige 0,001 ETH sur Ethereum mainnet),
      <a href="https://faucets.chain.link/base-sepolia" target="_blank" rel="noopener noreferrer">Chainlink</a>
      (exige de connecter un wallet).
    </p>`;
  }

  #renderAirdrop(wallet: TestnetWallet): TemplateResult | typeof nothing {
    switch (this.airdrop.kind) {
      case 'idle':
        return nothing;
      case 'busy':
        return html`<p class="note">Demande au faucet devnet puis confirmation (jusqu'à 30 s)…</p>`;
      case 'error':
        return html`<p class="note error">
          ${errorMessage(this.airdrop.error)}
          <a href=${wallet.faucetUrl} target="_blank" rel="noopener noreferrer">Ouvrir le faucet web</a>
        </p>`;
      case 'done': {
        const { outcome } = this.airdrop;
        const ferra = outcome.recordedOnFerra > 0 ? 'inscrit dans Ferra chain' : 'en cours d’inscription dans Ferra chain';
        return html`<p class="note ok">
          ✓ ${formatUnits(outcome.amount, wallet.decimals)} ${wallet.symbol} reçu, ${ferra}.
          <a href=${outcome.explorerUrl} target="_blank" rel="noopener noreferrer">Transaction</a>
        </p>`;
      }
    }
  }

  readonly #requestAirdrop = async (): Promise<void> => {
    if (this.airdrop.kind === 'busy') return;
    this.airdrop = { kind: 'busy' };
    const result = await this.bridge.requestAirdrop('solana-devnet');
    this.airdrop = result.ok ? { kind: 'done', outcome: result.value } : { kind: 'error', error: result.error };
    if (result.ok) this.dispatchEvent(new CustomEvent('testnet-changed', { bubbles: true, composed: true }));
  };
}

declare global {
  interface HTMLElementTagNameMap {
    'sq-testnet-receive': TestnetReceivePanel;
  }
}
