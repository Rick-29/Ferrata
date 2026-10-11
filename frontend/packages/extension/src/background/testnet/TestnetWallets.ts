import type { SyncRequest } from '@sqw/types/SyncRequest';
import type { SyncResponse } from '@sqw/types/SyncResponse';
import type { Result, SdkError } from '@sqw/sdk';
import { uiError, type UiError } from '../../ui/core/errors';
import { err, ok } from '../../ui/core/result';
import type { AirdropOutcome, TestnetNetwork, TestnetWallet } from '../../ui/services/UiBridge';
import type { NetworkKeyring } from '../dapp/NetworkKeyring';
import { BASE_SEPOLIA_USDC, CIRCLE_FAUCET_URL, USDC_DECIMALS, type GaslessUsdc } from './GaslessUsdc';
import { LAMPORTS_PER_SOL, type DevnetError, type SolanaDevnet } from './SolanaDevnet';
import type { SolanaKeyring } from './SolanaKeyring';

// The wallet's addresses on public test networks and their faucets (testnet_plan M3, M8).
// Opening the list asks the backend to pull each address's history, so coins from any source
// (in-wallet airdrop, a web faucet, another wallet) land on the Ferra chain as Swissquote-attested
// `external` events.

export interface TestnetWalletsDeps {
  readonly solana: SolanaKeyring;
  readonly devnet: SolanaDevnet;
  /** The Base Sepolia key shared with the dApp provider: one EVM address for dApps and faucets. */
  readonly evm: NetworkKeyring;
  /** Balance in wei (decimal string) on an EVM test network, or null when its node cannot be read. */
  readonly evmBalance: (network: EvmTestnet, address: string) => Promise<string | null>;
  /** ERC-4337 smart account for gasless USDC on Base Sepolia; listed only when configured. */
  readonly gasless?: GaslessUsdc;
  /** `POST /chain/sync` (SDK). */
  readonly sync: (request: SyncRequest) => Promise<Result<SyncResponse, SdkError>>;
}

/** What one faucet request asks for. The public devnet faucet grants at most a few SOL a day. */
export const SOLANA_AIRDROP_LAMPORTS = LAMPORTS_PER_SOL;

/** EVM test networks: one key, one address on all of them. */
export type EvmTestnet = 'base-sepolia' | 'eth-sepolia';

const SOLANA: TestnetNetwork = 'solana-devnet';
const BASE: TestnetNetwork = 'base-sepolia';
const SEPOLIA: TestnetNetwork = 'eth-sepolia';
const BASE_USDC: TestnetNetwork = 'base-sepolia-usdc';
const solanaAddressUrl = (address: string): string => `https://explorer.solana.com/address/${address}?cluster=devnet`;
const solanaTxUrl = (signature: string): string => `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
/** Base Sepolia has no public faucet API (all need a login, captcha or API key): the web faucet it is. */
const BASE_FAUCET_URL = 'https://portal.cdp.coinbase.com/products/faucet';
/** Proof-of-work faucet: no account and no mainnet balance needed (checked 2026-10-10). */
const SEPOLIA_FAUCET_URL = 'https://sepolia-faucet.pk910.de/';

export class TestnetWallets {
  readonly #deps: TestnetWalletsDeps;

  constructor(deps: TestnetWalletsDeps) {
    this.#deps = deps;
  }

  /** Creates the addresses on first use; a balance is null when its network cannot be read. */
  async list(ferraWallet: string): Promise<Result<readonly TestnetWallet[], UiError>> {
    const { solana, devnet, evm, evmBalance, gasless } = this.#deps;
    const [solAddress, evmAddress] = await Promise.all([solana.ensure(), evm.ensure()]);
    const smartAddress = gasless?.enabled ? await this.#smartAccountAddress(gasless) : null;
    this.#syncInBackground(ferraWallet, SOLANA, solAddress);
    this.#syncInBackground(ferraWallet, BASE, evmAddress);
    this.#syncInBackground(ferraWallet, SEPOLIA, evmAddress);
    if (smartAddress !== null) this.#syncInBackground(ferraWallet, BASE, smartAddress);

    const [solBalance, baseBalance, sepoliaBalance, usdcBalance] = await Promise.all([
      devnet.balance(solAddress),
      evmBalance('base-sepolia', evmAddress),
      evmBalance('eth-sepolia', evmAddress),
      smartAddress === null || !gasless ? Promise.resolve(null) : gasless.balance(smartAddress),
    ]);
    const gaslessWallet: TestnetWallet[] =
      smartAddress === null
        ? []
        : [
            {
              network: BASE_USDC,
              label: 'Base Sepolia · USDC sans gas',
              address: smartAddress,
              symbol: 'USDC',
              decimals: USDC_DECIMALS,
              balance: usdcBalance,
              explorerUrl: `https://sepolia.basescan.org/address/${smartAddress}`,
              inWalletAirdrop: false,
              faucetUrl: CIRCLE_FAUCET_URL,
              gasless: true,
              assetAddress: BASE_SEPOLIA_USDC,
            },
          ];
    return ok([
      {
        network: SOLANA,
        label: 'Solana devnet',
        address: solAddress,
        symbol: 'SOL',
        decimals: 9,
        balance: solBalance.ok ? solBalance.value : null,
        explorerUrl: solanaAddressUrl(solAddress),
        inWalletAirdrop: true,
        faucetUrl: 'https://faucet.solana.com',
      },
      {
        network: BASE,
        label: 'Base Sepolia',
        address: evmAddress,
        symbol: 'ETH',
        decimals: 18,
        balance: baseBalance,
        explorerUrl: `https://sepolia.basescan.org/address/${evmAddress}`,
        inWalletAirdrop: false,
        faucetUrl: BASE_FAUCET_URL,
      },
      {
        network: SEPOLIA,
        label: 'Ethereum Sepolia',
        address: evmAddress,
        symbol: 'ETH',
        decimals: 18,
        balance: sepoliaBalance,
        explorerUrl: `https://sepolia.etherscan.io/address/${evmAddress}`,
        inWalletAirdrop: false,
        faucetUrl: SEPOLIA_FAUCET_URL,
      },
      ...gaslessWallet,
    ]);
  }

  async #smartAccountAddress(gasless: GaslessUsdc): Promise<string | null> {
    const owner = await this.#deps.evm.account();
    if (owner === null) return null;
    try {
      return await gasless.address(owner);
    } catch (error) {
      console.warn('[sqw] smart account address unavailable', error);
      return null;
    }
  }

  /**
   * Faucet → wait for confirmation → record on the Ferra chain. Solana devnet only: Base Sepolia
   * is funded from the web faucet (`faucetUrl`). A failed sync does not fail the airdrop (the SOL
   * arrived); the next `list` records it.
   */
  async airdrop(network: TestnetNetwork, ferraWallet: string): Promise<Result<AirdropOutcome, UiError>> {
    if (network !== SOLANA) return err(uiError('TESTNET_NO_FAUCET_API'));
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
      explorerUrl: solanaTxUrl(requested.value),
      recordedOnFerra: synced.ok ? synced.value.recorded : 0,
    });
  }

  #syncInBackground(wallet: string, network: TestnetNetwork, addressRaw: string): void {
    void this.#deps.sync({ wallet, network, address_raw: addressRaw, limit: null, cursor: null }).catch(() => undefined);
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
