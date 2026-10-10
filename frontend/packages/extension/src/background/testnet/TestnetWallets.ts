import type { SyncRequest } from '@sqw/types/SyncRequest';
import type { SyncResponse } from '@sqw/types/SyncResponse';
import type { Result, SdkError } from '@sqw/sdk';
import { uiError, type UiError } from '../../ui/core/errors';
import { err, ok } from '../../ui/core/result';
import type { AirdropOutcome, TestnetNetwork, TestnetWallet } from '../../ui/services/UiBridge';
import { LAMPORTS_PER_SOL, type DevnetError, type SolanaDevnet } from './SolanaDevnet';
import type { SolanaKeyring } from './SolanaKeyring';

// The wallet's addresses on public test networks and their faucets (testnet_plan M3, M8).
// After an airdrop lands, the backend is asked to pull that network's history so the Ferra chain
// records the inbound transfer as a Swissquote-attested `external` event.

export interface TestnetWalletsDeps {
  readonly solana: SolanaKeyring;
  readonly devnet: SolanaDevnet;
  /** `POST /chain/sync` (SDK). */
  readonly sync: (request: SyncRequest) => Promise<Result<SyncResponse, SdkError>>;
}

/** What one faucet request asks for. The public devnet faucet grants at most a few SOL a day. */
export const SOLANA_AIRDROP_LAMPORTS = LAMPORTS_PER_SOL;

const NETWORK: TestnetNetwork = 'solana-devnet';
const explorerAddress = (address: string): string => `https://explorer.solana.com/address/${address}?cluster=devnet`;
const explorerTx = (signature: string): string => `https://explorer.solana.com/tx/${signature}?cluster=devnet`;

export class TestnetWallets {
  readonly #deps: TestnetWalletsDeps;

  constructor(deps: TestnetWalletsDeps) {
    this.#deps = deps;
  }

  /**
   * Creates the devnet address on first use; the balance is null when devnet cannot be read.
   * Also asks the backend to pull that address's history, so coins sent from elsewhere (the web
   * faucet at faucet.solana.com, another wallet) land on the Ferra chain too. Not awaited.
   */
  async list(ferraWallet: string): Promise<Result<readonly TestnetWallet[], UiError>> {
    const address = await this.#deps.solana.ensure();
    void this.#deps
      .sync({ wallet: ferraWallet, network: NETWORK, address_raw: address, limit: null, cursor: null })
      .catch(() => undefined);
    const balance = await this.#deps.devnet.balance(address);
    return ok([
      {
        network: NETWORK,
        label: 'Solana devnet',
        address,
        symbol: 'SOL',
        decimals: 9,
        balance: balance.ok ? balance.value : null,
        explorerUrl: explorerAddress(address),
      },
    ]);
  }

  /**
   * Faucet → wait for confirmation → record on the Ferra chain. A failed sync does not fail the
   * airdrop (the SOL arrived); the backend sync loop or a later sync records it.
   */
  async airdrop(network: TestnetNetwork, ferraWallet: string): Promise<Result<AirdropOutcome, UiError>> {
    if (network !== NETWORK) return err(uiError('UI_BAD_REQUEST'));
    const { solana, devnet, sync } = this.#deps;
    const address = await solana.ensure();

    const requested = await devnet.requestAirdrop(address, SOLANA_AIRDROP_LAMPORTS);
    if (!requested.ok) return err(toUiError(requested.error));
    const confirmed = await devnet.waitForConfirmation(requested.value);
    if (!confirmed.ok) return err(toUiError(confirmed.error));

    const synced = await sync({ wallet: ferraWallet, network, address_raw: address, limit: null, cursor: null });
    if (!synced.ok) console.warn('[sqw] airdrop landed but /chain/sync failed', synced.error.code);

    return ok({
      network,
      signature: requested.value,
      amount: SOLANA_AIRDROP_LAMPORTS.toString(),
      explorerUrl: explorerTx(requested.value),
      recordedOnFerra: synced.ok ? synced.value.recorded : 0,
    });
  }
}

function toUiError(error: DevnetError): UiError {
  switch (error.kind) {
    case 'rate_limited':
      return uiError('TESTNET_FAUCET_LIMIT');
    case 'unavailable':
      return uiError('TESTNET_UNAVAILABLE', true);
    case 'rpc':
      return uiError('TESTNET_RPC_ERROR');
  }
}
