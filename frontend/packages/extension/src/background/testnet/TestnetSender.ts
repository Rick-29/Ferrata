import { sha256 } from '@noble/hashes/sha2';
import type { SyncRequest } from '@sqw/types/SyncRequest';
import type { SyncResponse } from '@sqw/types/SyncResponse';
import type { Result, SdkError } from '@sqw/sdk';
import { uiError, type UiError } from '../../ui/core/errors';
import { toBaseUnits } from '../../ui/core/format';
import { err, ok } from '../../ui/core/result';
import type { TestnetSendDraft, TestnetSendOutcome } from '../../ui/services/UiBridge';
import type { NetworkKeyring } from '../dapp/NetworkKeyring';
import type { GaslessUsdc } from './GaslessUsdc';
import type { SolanaDevnet } from './SolanaDevnet';
import type { SolanaKeyring } from './SolanaKeyring';
import { isSolanaAddress, signedTransaction, transferMessage } from './solanaTx';
import type { EvmTestnet } from './TestnetWallets';

// Sends test coins from the wallet's own test-network keys (P3). Order matters:
//   1. the passkey approves THIS transfer (hash of network, from, to, amount), verified locally;
//   2. only then the network key signs and the transfer is broadcast;
//   3. the backend syncs the address, so the outgoing transfer lands on the Ferra chain.
// Not yet here: Swissquote's pre-send risk assessment for non-Ferra networks (backend task B6);
// the Ferra validator still reviews the recorded transfer afterwards.

export type EvmSend = (network: EvmTestnet, to: string, valueWei: bigint) => Promise<{ ok: true; hash: string } | { ok: false; message: string }>;

export interface TestnetSenderDeps {
  readonly solana: SolanaKeyring;
  readonly devnet: SolanaDevnet;
  readonly evm: NetworkKeyring;
  /** Signs with the EVM key, broadcasts, waits for the receipt (viem in the background). */
  readonly evmSend: EvmSend;
  /** ERC-4337 smart account + paymaster for USDC on Base Sepolia (`base-sepolia-usdc`); absent = off. */
  readonly gasless?: GaslessUsdc;
  readonly sync: (request: SyncRequest) => Promise<Result<SyncResponse, SdkError>>;
}

/** The passkey approval for one transfer: resolves ok only for a verified owner signature of `hash`. */
export type Authorize = (hash: string) => Promise<Result<void, UiError>>;

const DECIMALS = { 'solana-devnet': 9, 'base-sepolia': 18, 'eth-sepolia': 18, 'base-sepolia-usdc': 6 } as const;
/** The backend's network name for each testnet: the smart account lives on Base Sepolia. */
const SYNC_NETWORK = { 'solana-devnet': 'solana-devnet', 'base-sepolia': 'base-sepolia', 'eth-sepolia': 'eth-sepolia', 'base-sepolia-usdc': 'base-sepolia' } as const;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SEND_FAILED = uiError('TESTNET_SEND_FAILED');

const explorerTx = (network: TestnetSendDraft['network'], id: string): string =>
  network === 'solana-devnet'
    ? `https://explorer.solana.com/tx/${id}?cluster=devnet`
    : network === 'eth-sepolia'
      ? `https://sepolia.etherscan.io/tx/${id}`
      : `https://sepolia.basescan.org/tx/${id}`;

export class TestnetSender {
  readonly #deps: TestnetSenderDeps;

  constructor(deps: TestnetSenderDeps) {
    this.#deps = deps;
  }

  async send(draft: TestnetSendDraft, ferraWallet: string, authorize: Authorize): Promise<Result<TestnetSendOutcome, UiError>> {
    const amount = toBaseUnits(draft.amount, DECIMALS[draft.network]);
    if (amount === null || amount <= 0n) return err(uiError('UI_INVALID_AMOUNT'));
    const solana = draft.network === 'solana-devnet';
    if (solana ? !isSolanaAddress(draft.to) : !EVM_ADDRESS.test(draft.to)) return err(uiError('UI_INVALID_ADDRESS'));

    const gasless = draft.network === 'base-sepolia-usdc';
    if (gasless && !this.#deps.gasless?.enabled) return err(uiError('TESTNET_GASLESS_OFF'));
    const from = solana ? await this.#deps.solana.ensure() : gasless ? await this.#smartAccountAddress() : await this.#deps.evm.ensure();
    // A Solana transfer to oneself lists the same account twice: the network rejects it.
    if (draft.to.toLowerCase() === from.toLowerCase()) return err(uiError('UI_INVALID_ADDRESS'));
    const approved = await authorize(approvalHash(draft.network, from, draft.to, amount));
    if (!approved.ok) return approved;

    const sent = solana
      ? await this.#sendSolana(from, draft.to, amount)
      : gasless
        ? await this.#sendGasless(draft.to, amount)
        : await this.#sendEvm(draft.network as EvmTestnet, draft.to, amount);
    if (!sent.ok) return sent;

    const synced = await this.#deps.sync({ wallet: ferraWallet, network: SYNC_NETWORK[draft.network], address_raw: from, limit: null, cursor: null });
    return ok({
      network: draft.network,
      txId: sent.value,
      amount: amount.toString(),
      explorerUrl: explorerTx(draft.network, sent.value),
      recordedOnFerra: synced.ok ? synced.value.recorded : 0,
    });
  }

  async #sendSolana(from: string, to: string, lamports: bigint): Promise<Result<string, UiError>> {
    const { devnet, solana } = this.#deps;
    const blockhash = await devnet.latestBlockhash();
    if (!blockhash.ok) return err(uiError('TESTNET_UNAVAILABLE', true));
    const message = transferMessage(from, to, lamports, blockhash.value);
    const signature = await solana.sign(message);
    if (signature === null) return err(SEND_FAILED);
    const sent = await devnet.sendTransaction(signedTransaction(signature, message));
    if (!sent.ok) return err(sent.error.kind === 'unavailable' ? uiError('TESTNET_UNAVAILABLE', true) : SEND_FAILED);
    const confirmed = await devnet.waitForConfirmation(sent.value);
    return confirmed.ok ? ok(sent.value) : err(SEND_FAILED);
  }

  async #smartAccountAddress(): Promise<string> {
    await this.#deps.evm.ensure();
    const owner = await this.#deps.evm.account();
    if (owner === null || !this.#deps.gasless) throw new Error('no EVM key on this device');
    return this.#deps.gasless.address(owner);
  }

  /** The EVM key owns the smart account; the paymaster pays, so a USDC-only balance is enough. */
  async #sendGasless(to: string, usdc: bigint): Promise<Result<string, UiError>> {
    const owner = await this.#deps.evm.account();
    if (owner === null || !this.#deps.gasless) return err(SEND_FAILED);
    const sent = await this.#deps.gasless.send(owner, to, usdc);
    if (!sent.ok) console.warn('[sqw] gasless send failed:', sent.message);
    return sent.ok ? ok(sent.hash) : err(SEND_FAILED);
  }

  async #sendEvm(network: EvmTestnet, to: string, wei: bigint): Promise<Result<string, UiError>> {
    const sent = await this.#deps.evmSend(network, to, wei);
    return sent.ok ? ok(sent.hash) : err(SEND_FAILED);
  }
}

/** What the passkey signs: binds the approval to this exact transfer, so it cannot be reused for another. */
export function approvalHash(network: string, from: string, to: string, amount: bigint): string {
  const text = `SQW-TESTNET-SEND-v1|${network}|${from}|${to}|${amount.toString()}|${Date.now()}`;
  const digest = sha256(new TextEncoder().encode(text));
  return `0x${Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}
