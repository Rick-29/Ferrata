import { css, html, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { errorMessage, type UiError } from '../../core/errors';
import { formatUnits, shortAddress, toBaseUnits } from '../../core/format';
import { Screen } from '../../core/Screen';
import { textStyles } from '../../core/styles';
import type { TestnetNetwork, TestnetSendOutcome, TestnetWallet } from '../../services/UiBridge';

type Step =
  | { readonly kind: 'form' }
  | { readonly kind: 'review' }
  | { readonly kind: 'sending' }
  | { readonly kind: 'done'; readonly outcome: TestnetSendOutcome }
  | { readonly kind: 'error'; readonly error: UiError };

/**
 * "Envoyer" on the Testnet tab (P3): network, recipient, amount, a review, then the passkey approves
 * this exact transfer before the wallet's test key signs it. Fires `testnet-changed` once sent.
 */
@customElement('sq-testnet-send')
export class TestnetSendPanel extends Screen {
  @property({ attribute: false }) wallets: readonly TestnetWallet[] = [];
  @state() private network: TestnetNetwork = 'solana-devnet';
  @state() private to = '';
  @state() private amount = '';
  @state() private step: Step = { kind: 'form' };

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
      .card {
        display: grid;
        gap: 10px;
        padding: 12px;
        border-radius: 18px;
        background: rgba(20, 23, 38, 0.82);
        border: 1px solid var(--sq-border);
        box-shadow: var(--sq-shadow);
      }
      label {
        display: grid;
        gap: 4px;
        font-size: 10px;
        color: var(--sq-text-muted);
      }
      select,
      input {
        min-width: 0;
        padding: 8px 10px;
        border-radius: var(--sq-radius-sm);
        border: 1px solid var(--sq-border);
        background: var(--sq-surface-sunken);
        color: var(--sq-text);
        font: 500 12px var(--sq-font);
      }
      input.mono {
        font-family: var(--sq-font-mono);
        font-size: 11px;
      }
      .row {
        display: flex;
        justify-content: space-between;
        gap: 8px;
        font-size: 11px;
      }
      .row span:first-child {
        color: var(--sq-text-muted);
      }
      .actions {
        display: flex;
        gap: 8px;
      }
      button {
        flex: 1;
        padding: 9px 10px;
        border-radius: var(--sq-radius-sm);
        font: 600 11px var(--sq-font);
        cursor: pointer;
      }
      .primary {
        border: 0;
        color: var(--sq-accent-text);
        background: var(--sq-brand-gradient);
      }
      .primary:disabled {
        opacity: 0.5;
        cursor: not-allowed;
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
    return html`<span class="section-title">Envoyer des cryptos de test</span>
      <div class="card">${this.#body()}</div>`;
  }

  #body(): TemplateResult {
    const wallet = this.#wallet();
    switch (this.step.kind) {
      case 'form':
        return this.#form(wallet);
      case 'review':
        return this.#review(wallet);
      case 'sending':
        return wallet?.gasless
          ? html`<p class="note">Analyse Swissquote en cours…</p>`
          : html`<p class="note">Confirmez avec votre passkey, puis envoi et confirmation sur le réseau de test…</p>`;
      case 'done': {
        const { outcome } = this.step;
        return html`<p class="note ok">
            ✓ ${formatUnits(outcome.amount, wallet?.decimals ?? 18)} ${wallet?.symbol ?? ''} envoyés.
            ${outcome.recordedOnFerra > 0 ? 'Inscrit dans Ferra chain.' : 'Inscription dans Ferra chain en cours.'}
            <a href=${outcome.explorerUrl} target="_blank" rel="noopener noreferrer">Transaction</a>
          </p>
          <div class="actions"><button type="button" class="secondary" @click=${this.#reset}>Nouvel envoi</button></div>`;
      }
      case 'error':
        return html`<p class="note error">${errorMessage(this.step.error)}</p>
          <div class="actions"><button type="button" class="secondary" @click=${() => (this.step = { kind: 'review' })}>Réessayer</button></div>`;
    }
  }

  #form(wallet: TestnetWallet | undefined): TemplateResult {
    const valid = this.#validAmount(wallet) && this.to.trim().length > 0;
    return html`
      <label
        >Réseau
        <select @change=${(e: Event) => (this.network = (e.target as HTMLSelectElement).value as TestnetNetwork)}>
          ${this.wallets.map(
            (w) =>
              html`<option value=${w.network} ?selected=${w.network === this.network}>
                ${w.label} · ${w.balance === null ? '—' : formatUnits(w.balance, w.decimals)} ${w.symbol}
              </option>`,
          )}
        </select>
      </label>
      <label
        >Destinataire
        <input
          class="mono"
          .value=${this.to}
          placeholder=${this.network === 'solana-devnet' ? 'Adresse Solana (base58)' : '0x…'}
          @input=${(e: Event) => (this.to = (e.target as HTMLInputElement).value.trim())}
      /></label>
      <label
        >Montant (${wallet?.symbol ?? ''})
        <input
          inputmode="decimal"
          .value=${this.amount}
          placeholder="0.01"
          @input=${(e: Event) => (this.amount = (e.target as HTMLInputElement).value)}
      /></label>
      ${this.network === 'solana-devnet'
        ? html`<p class="note">Vers une adresse Solana neuve, envoyez au moins 0,001 SOL (minimum exigé par le réseau).</p>`
        : nothing}
      <div class="actions">
        <button type="button" class="primary" ?disabled=${!valid} @click=${() => (this.step = { kind: 'review' })}>Vérifier</button>
      </div>
    `;
  }

  #review(wallet: TestnetWallet | undefined): TemplateResult {
    return html`
      <div class="row"><span>Réseau</span><span>${wallet?.label ?? this.network}</span></div>
      <div class="row"><span>Vers</span><span>${shortAddress(this.to)}</span></div>
      <div class="row"><span>Montant</span><strong>${this.amount} ${wallet?.symbol ?? ''}</strong></div>
      <p class="note">
        Réseau de test, cryptos sans valeur.
        ${wallet?.gasless
          ? html`Swissquote analyse cet envoi comme n'importe quel autre, puis votre passkey le confirme.
              <br /><strong>Sans gas :</strong> aucun ETH requis, les frais sont pris en charge par le paymaster.`
          : html`Votre passkey va confirmer cet envoi précis.`}
      </p>
      <div class="actions">
        <button type="button" class="secondary" @click=${() => (this.step = { kind: 'form' })}>Modifier</button>
        <button type="button" class="primary" @click=${this.#send}>${wallet?.gasless ? 'Analyser et confirmer' : 'Confirmer avec ma passkey'}</button>
      </div>
    `;
  }

  #wallet(): TestnetWallet | undefined {
    return this.wallets.find((w) => w.network === this.network);
  }

  #validAmount(wallet: TestnetWallet | undefined): boolean {
    if (!wallet) return false;
    const units = toBaseUnits(this.amount, wallet.decimals);
    return units !== null && units > 0n && (wallet.balance === null || units <= BigInt(wallet.balance));
  }

  readonly #send = async (): Promise<void> => {
    const wallet = this.#wallet();
    if (wallet?.gasless) return this.#sendThroughSwissquote(wallet);
    this.step = { kind: 'sending' };
    const result = await this.bridge.sendTestnet({ network: this.network, to: this.to, amount: this.amount });
    this.step = result.ok ? { kind: 'done', outcome: result.value } : { kind: 'error', error: result.error };
    if (result.ok) this.dispatchEvent(new CustomEvent('testnet-changed', { bubbles: true, composed: true }));
  };

  /**
   * Gasless USDC is a real asset transfer, so it takes the same road as a Ferra send: Swissquote
   * assesses it, the Confirm screen shows the risk and asks the passkey (and a step-up when needed),
   * then the smart account broadcasts on Base Sepolia.
   */
  async #sendThroughSwissquote(wallet: TestnetWallet): Promise<void> {
    this.step = { kind: 'sending' };
    const units = toBaseUnits(this.amount, wallet.decimals);
    if (units === null) return;
    const asset = wallet.assetAddress ?? null;
    const result = await this.bridge.previewSend({ to: this.to, asset, amount: `0x${units.toString(16)}`, rail: 'base-sepolia-usdc' });
    if (!this.isConnected) return;
    if (!result.ok) {
      this.step = { kind: 'error', error: result.error };
      return;
    }
    this.step = { kind: 'form' };
    this.router.go('confirm', { preview: result.value, asset: { asset, symbol: wallet.symbol, decimals: wallet.decimals, amount: wallet.balance ?? '0' } });
  }

  readonly #reset = (): void => {
    this.to = '';
    this.amount = '';
    this.step = { kind: 'form' };
  };
}

declare global {
  interface HTMLElementTagNameMap {
    'sq-testnet-send': TestnetSendPanel;
  }
}
