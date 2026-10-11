import { createClient, createPublicClient, encodeFunctionData, erc20Abi, http, type Hex, type LocalAccount } from 'viem';
import { createBundlerClient, toCoinbaseSmartAccount, type SmartAccount, type WebAuthnAccount } from 'viem/account-abstraction';
import { baseSepolia } from 'viem/chains';

// USDC on Base Sepolia from an ERC-4337 smart account (Coinbase Smart Wallet contracts,
// counterfactual: deployed by its first user operation) owned by the client's PASSKEY: the chain
// itself verifies the WebAuthn signature (PasskeyOwner.ts), so the account works without the
// extension's keys and without Swissquote. Pimlico bundles the operation:
// - with VITE_PIMLICO_API_KEY, its verifying paymaster pays the gas under a sponsorship policy
//   (ERC-7677 `pm_getPaymasterData`, handled inside viem when `paymaster: true`): gasless;
// - without it, Pimlico's public bundler, and the account pays its own gas in Base Sepolia ETH.

/** Circle's USDC on Base Sepolia (https://developers.circle.com/stablecoins/usdc-contract-addresses). */
export const BASE_SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as const;
export const USDC_DECIMALS = 6;
/** Mint test USDC to any address: https://faucet.circle.com (Base Sepolia). */
export const CIRCLE_FAUCET_URL = 'https://faucet.circle.com';
export const PIMLICO_HOST = 'https://api.pimlico.io';

const pimlicoUrl = (apiKey: string | null): string =>
  apiKey ? `${PIMLICO_HOST}/v2/${baseSepolia.id}/rpc?apikey=${apiKey}` : `https://public.pimlico.io/v2/${baseSepolia.id}/rpc`;

/** Who owns the smart account: the client's passkey (WebAuthn), or any viem local account (tests). */
export type SmartAccountOwner = WebAuthnAccount | LocalAccount;
// Inferred rather than `PublicClient`: Base's OP-stack formatters (deposit transactions) make the
// chain-specific client not assignable to the generic type.
const baseClient = (rpcUrl?: string) => createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
type BaseClient = ReturnType<typeof baseClient>;

export type GaslessResult = { ok: true; hash: Hex } | { ok: false; message: string };

export interface GaslessUsdcOptions {
  /** Pimlico API key (VITE_PIMLICO_API_KEY). Without it: public bundler, the account pays its gas. */
  readonly pimlicoApiKey: string | null;
  readonly rpcUrl?: string;
}

export class GaslessUsdc {
  readonly #apiKey: string | null;
  readonly #client: BaseClient;

  constructor(options: GaslessUsdcOptions) {
    this.#apiKey = options.pimlicoApiKey;
    this.#client = baseClient(options.rpcUrl);
  }

  /** The smart account rail is always available: the public bundler needs no key. */
  get enabled(): boolean {
    return true;
  }

  /** True when Pimlico's paymaster pays the gas (an API key with a sponsorship policy). */
  get sponsored(): boolean {
    return this.#apiKey !== null && this.#apiKey.length > 0;
  }

  /** ETH (wei, decimal string) the account holds to pay its own gas when not sponsored. */
  async ethBalance(address: string): Promise<string | null> {
    try {
      return (await this.#client.getBalance({ address: address as Hex })).toString();
    } catch {
      return null;
    }
  }

  /** Counterfactual smart-account address for this owner: stable, no deployment needed to receive. */
  async address(owner: SmartAccountOwner): Promise<string> {
    return (await this.#account(owner)).address;
  }

  /** USDC balance in base units (6 decimals) as a decimal string, or null when the node cannot be read. */
  async balance(address: string): Promise<string | null> {
    try {
      const raw = await this.#client.readContract({
        address: BASE_SEPOLIA_USDC,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [address as Hex],
      });
      return raw.toString();
    } catch {
      return null;
    }
  }

  /** Sends `amount` USDC base units from the owner's smart account; gas sponsored by the paymaster. */
  send(owner: SmartAccountOwner, to: string, amount: bigint): Promise<GaslessResult> {
    return this.#sendCalls(owner, [
      { to: BASE_SEPOLIA_USDC, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to as Hex, amount] }) },
    ]);
  }

  /** Sends `wei` of Base Sepolia ETH from the owner's smart account (same user-operation path). */
  sendNative(owner: SmartAccountOwner, to: string, wei: bigint): Promise<GaslessResult> {
    return this.#sendCalls(owner, [{ to: to as Hex, value: wei }]);
  }

  async #sendCalls(owner: SmartAccountOwner, calls: readonly { to: Hex; data?: Hex; value?: bigint }[]): Promise<GaslessResult> {
    try {
      const account = await this.#account(owner);
      const transport = http(pimlicoUrl(this.#apiKey));
      const pimlico = createClient({ chain: baseSepolia, transport });
      const bundler = createBundlerClient({
        account,
        client: this.#client,
        chain: baseSepolia,
        transport,
        // ERC-7677: the bundler endpoint doubles as the paymaster; Pimlico sponsors under the key's policy.
        // Without a key: no paymaster, the account pays from its own ETH.
        ...(this.sponsored ? { paymaster: true } : {}),
        userOperation: {
          // Pimlico rejects operations priced below its own quote; fall back to the chain's estimate.
          estimateFeesPerGas: async () => {
            const price = await pimlico
              .request<{
                Method: 'pimlico_getUserOperationGasPrice';
                Parameters: [];
                ReturnType: { fast: { maxFeePerGas: Hex; maxPriorityFeePerGas: Hex } };
              }>({ method: 'pimlico_getUserOperationGasPrice', params: [] })
              .catch(() => null);
            if (price !== null) return { maxFeePerGas: BigInt(price.fast.maxFeePerGas), maxPriorityFeePerGas: BigInt(price.fast.maxPriorityFeePerGas) };
            return this.#client.estimateFeesPerGas();
          },
        },
      });
      const userOpHash = await bundler.sendUserOperation({ calls: [...calls] });
      const receipt = await bundler.waitForUserOperationReceipt({ hash: userOpHash, timeout: 120_000 });
      return receipt.success ? { ok: true, hash: receipt.receipt.transactionHash } : { ok: false, message: 'user operation reverted' };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'gasless send failed' };
    }
  }

  #account(owner: SmartAccountOwner): Promise<SmartAccount> {
    return toCoinbaseSmartAccount({ client: this.#client, owners: [owner], version: '1.1' });
  }
}
