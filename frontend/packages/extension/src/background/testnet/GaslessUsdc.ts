import { createClient, createPublicClient, encodeFunctionData, erc20Abi, http, type Hex } from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';
import { createBundlerClient, toCoinbaseSmartAccount, type SmartAccount } from 'viem/account-abstraction';
import { baseSepolia } from 'viem/chains';

// Gasless USDC on Base Sepolia (Swissquote bonus: "transfer USDC without first acquiring the gas
// token"). The wallet's EVM key owns an ERC-4337 smart account (Coinbase Smart Wallet contracts,
// counterfactual: deployed by its first user operation). Pimlico bundles the operation and its
// verifying paymaster pays the gas under a sponsorship policy (ERC-7677 `pm_getPaymasterData`,
// handled inside viem when `paymaster: true`). The user never holds ETH.
//
// Keys: the owner key never leaves NetworkKeyring; this module only receives the viem account for
// the duration of one send. Co-signing: the passkey approves the exact transfer first (TestnetSender),
// Swissquote's on-chain 2-of-2 stays a Ferra-chain property (README, "Honest framing").

/** Circle's USDC on Base Sepolia (https://developers.circle.com/stablecoins/usdc-contract-addresses). */
export const BASE_SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as const;
export const USDC_DECIMALS = 6;
/** Mint test USDC to any address: https://faucet.circle.com (Base Sepolia). */
export const CIRCLE_FAUCET_URL = 'https://faucet.circle.com';
export const PIMLICO_HOST = 'https://api.pimlico.io';

const pimlicoUrl = (apiKey: string): string => `${PIMLICO_HOST}/v2/${baseSepolia.id}/rpc?apikey=${apiKey}`;
// Inferred rather than `PublicClient`: Base's OP-stack formatters (deposit transactions) make the
// chain-specific client not assignable to the generic type.
const baseClient = (rpcUrl?: string) => createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
type BaseClient = ReturnType<typeof baseClient>;

export type GaslessResult = { ok: true; hash: Hex } | { ok: false; message: string };

export interface GaslessUsdcOptions {
  /** Pimlico API key (VITE_PIMLICO_API_KEY). Without it the gasless path reports itself as off. */
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

  get enabled(): boolean {
    return this.#apiKey !== null && this.#apiKey.length > 0;
  }

  /** Counterfactual smart-account address for this owner: stable, no deployment needed to receive. */
  async address(owner: PrivateKeyAccount): Promise<string> {
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
  async send(owner: PrivateKeyAccount, to: string, amount: bigint): Promise<GaslessResult> {
    if (this.#apiKey === null) return { ok: false, message: 'gasless transfers are off: no Pimlico API key' };
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
        paymaster: true,
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
      const userOpHash = await bundler.sendUserOperation({
        calls: [
          {
            to: BASE_SEPOLIA_USDC,
            data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to as Hex, amount] }),
          },
        ],
      });
      const receipt = await bundler.waitForUserOperationReceipt({ hash: userOpHash, timeout: 120_000 });
      return receipt.success ? { ok: true, hash: receipt.receipt.transactionHash } : { ok: false, message: 'user operation reverted' };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'gasless send failed' };
    }
  }

  #account(owner: PrivateKeyAccount): Promise<SmartAccount> {
    return toCoinbaseSmartAccount({ client: this.#client, owners: [owner], version: '1.1' });
  }
}
