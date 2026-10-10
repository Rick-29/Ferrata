import type { AccountView } from '@sqw/types/AccountView';
import type { AssetBalance } from '@sqw/types/AssetBalance';
import { css, html, nothing, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import type { UiError } from '../../core/errors';
import type { WidgetEvent } from '../../core/events';
import { formatUnits, isAddress, toBaseUnits, toHexUnits, unitsToDecimal } from '../../core/format';
import { screenHeader } from '../../core/header';
import { Screen, toWidgetState } from '../../core/Screen';
import { screenStyles, textStyles } from '../../core/styles';
import { loading, ready, type WidgetState } from '../../core/Widget';
import { DEMO_ADDRESSES } from '../../services/fake-world';
import '../../widgets/address-input/AddressInput';
import '../../widgets/amount-input/AmountInput';
import '../../widgets/asset-picker/AssetPicker';
import '../../widgets/button/Button';

const DEFAULT_SYMBOL = 'USDC';

/** Labelled demo shortcuts, one per risk band in the README table. */
const DEMO_RECIPIENTS: readonly { readonly label: string; readonly address: string }[] = [
  { label: 'Commerçant connu', address: DEMO_ADDRESSES.knownMerchant },
  { label: 'Nouvelle adresse', address: '0x1234567890123456789012345678901234567890' },
  { label: 'Proche mixer', address: DEMO_ADDRESSES.mixerExposed },
  { label: 'Sanctionnée', address: DEMO_ADDRESSES.sanctioned },
];

type AmountCheck = { readonly ok: true; readonly units: bigint } | { readonly ok: false; readonly message: string | null };

interface Validation {
  readonly asset: AssetBalance | undefined;
  readonly amountCheck: AmountCheck;
  readonly canSubmit: boolean;
}

/** Recipient, asset and amount; on submit asks for a risk preview and opens Confirm with it. */
@customElement('sq-send-screen')
export class SendScreen extends Screen {
  @state() private wallet: WidgetState<AccountView> = loading;
  /** `undefined` until the user picks; `null` is a real choice (the native asset). */
  @state() private assetKey: string | null | undefined = undefined;
  @state() private to = '';
  @state() private amount = '';
  @state() private busy = false;
  @state() private error: UiError | null = null;

  static override styles = [
    screenStyles,
    textStyles,
    css`
      form {
        display: grid;
        gap: var(--sq-space-4);
      }
      .demo {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        align-items: center;
        margin-top: 10px;
      }
      .demo .eyebrow {
        width: 100%;
      }
      .chip {
        height: 25px;
        padding: 0 10px;
        font: inherit;
        font-size: 10px;
        border-radius: 999px;
        border: 1px solid var(--sq-border);
        background: rgba(255, 255, 255, 0.03);
        color: var(--sq-text-muted);
        cursor: pointer;
        transition: color var(--sq-duration) var(--sq-ease);
      }
      .chip:hover {
        color: #fff;
        border-color: rgba(255, 61, 127, 0.35);
        background: linear-gradient(100deg, rgba(255, 106, 26, 0.13), rgba(123, 92, 255, 0.14));
      }
      .chip:focus-visible {
        outline: 2px solid var(--sq-focus);
        outline-offset: 2px;
      }
    `,
  ];

  override connectedCallback(): void {
    super.connectedCallback();
    void this.#load();
  }

  override render(): TemplateResult {
    return html`
      ${screenHeader({ title: 'Envoyer', onBack: () => this.router.go('home', undefined), backDisabled: this.busy })}
      ${this.#body()}
    `;
  }

  #body(): TemplateResult {
    switch (this.wallet.kind) {
      case 'ready':
        return this.#form(this.wallet.data);
      case 'error':
        return html`<sq-error-panel .error=${this.wallet.error} @retry=${this.#load}></sq-error-panel>`;
      default:
        return html`<sq-skeleton></sq-skeleton>`;
    }
  }

  #form(account: AccountView): TemplateResult {
    const { asset, amountCheck, canSubmit } = this.#validate(account);

    return html`
      <form @submit=${(e: Event) => e.preventDefault()} novalidate>
        <sq-asset-picker
          .state=${ready(account.balances)}
          .selected=${asset?.asset ?? null}
          @asset-selected=${(e: WidgetEvent<'asset-selected'>) => (this.assetKey = e.detail)}
        ></sq-asset-picker>
        <div>
          <sq-address-input
            .value=${this.to}
            ?disabled=${this.busy}
            @address-changed=${(e: WidgetEvent<'address-changed'>) => (this.to = e.detail)}
          ></sq-address-input>
          <div class="demo" aria-label="Adresses de démonstration">
            <span class="eyebrow">Scénarios de démonstration</span>
            ${DEMO_RECIPIENTS.map(
              (r) => html`<button type="button" class="chip" @click=${() => (this.to = r.address)}>${r.label}</button>`,
            )}
          </div>
        </div>
        <sq-amount-input
          .value=${this.amount}
          .symbol=${asset?.symbol ?? ''}
          .available=${asset ? formatUnits(asset.amount, asset.decimals) : '0'}
          .error=${amountCheck.ok ? null : amountCheck.message}
          ?disabled=${this.busy}
          @amount-changed=${(e: WidgetEvent<'amount-changed'>) => (this.amount = e.detail)}
          @max-requested=${() => (this.amount = asset ? unitsToDecimal(BigInt(asset.amount), asset.decimals) : '')}
        ></sq-amount-input>
        ${this.error
          ? html`<sq-error-panel .error=${this.error} @retry=${() => this.#submit(account)}></sq-error-panel>`
          : nothing}
        <sq-button ?busy=${this.busy} ?disabled=${!canSubmit} @click=${() => this.#submit(account)}>
          Vérifier la transaction
        </sq-button>
      </form>
    `;
  }

  /** One source of truth for both the button state and the click handler. */
  #validate(account: AccountView): Validation {
    const asset = this.#selectedAsset(account);
    const amountCheck: AmountCheck = asset ? checkAmount(this.amount, asset) : { ok: false, message: null };
    return { asset, amountCheck, canSubmit: isAddress(this.to) && amountCheck.ok && !this.busy };
  }

  #submit(account: AccountView): void {
    const { asset, amountCheck, canSubmit } = this.#validate(account);
    if (!canSubmit || !asset || !amountCheck.ok) return;
    void this.#preview(asset, amountCheck.units);
  }

  #selectedAsset(account: AccountView): AssetBalance | undefined {
    const balances = account.balances;
    const picked = this.assetKey === undefined ? undefined : balances.find((b) => b.asset === this.assetKey);
    return picked ?? balances.find((b) => b.symbol === DEFAULT_SYMBOL) ?? balances[0];
  }

  readonly #load = async (): Promise<void> => {
    this.wallet = loading;
    this.wallet = toWidgetState(await this.bridge.getWallet());
  };

  async #preview(asset: AssetBalance, units: bigint): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.error = null;
    const result = await this.bridge.previewSend({ to: this.to, asset: asset.asset, amount: toHexUnits(units) });
    this.busy = false;
    // The user may have left this screen while waiting: never navigate them back into a send they abandoned.
    if (!this.isConnected) return;
    if (!result.ok) {
      this.error = result.error;
      return;
    }
    this.router.go('confirm', { preview: result.value, asset });
  }
}

/** Empty input is not an error yet, just not submittable. */
function checkAmount(input: string, asset: AssetBalance): AmountCheck {
  if (input.trim() === '') return { ok: false, message: null };
  const units = toBaseUnits(input, asset.decimals);
  if (units === null || units === 0n) return { ok: false, message: 'Montant invalide.' };
  if (units > BigInt(asset.amount)) return { ok: false, message: 'Solde insuffisant.' };
  return { ok: true, units };
}

declare global {
  interface HTMLElementTagNameMap {
    'sq-send-screen': SendScreen;
  }
}
