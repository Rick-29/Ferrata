// @vitest-environment node
import { ed25519 } from '@noble/curves/ed25519';
import { p256 } from '@noble/curves/p256';
import { sha256 } from '@noble/hashes/sha2';
import { base58 } from '@scure/base';
import { describe, expect, it, vi } from 'vitest';
import { err, ok } from '@sqw/sdk';
import { uiError } from '../../ui/core/errors';
import { NetworkKeyring, type Bytes, type KeyWrapper } from '../dapp/NetworkKeyring';
import { MemoryStore } from '../storage';
import { verifyOwner } from '../verifyOwner';
import { SolanaDevnet } from './SolanaDevnet';
import { SolanaKeyring } from './SolanaKeyring';
import { compactU16, signedTransaction, transferMessage } from './solanaTx';
import type { GaslessUsdc } from './GaslessUsdc';
import { TestnetSender, type EvmSend } from './TestnetSender';

const SMART_ACCOUNT = `0x${'5a'.repeat(20)}`;
/** Stand-in for the ERC-4337 path: records what it was asked to send, never touches a bundler. */
function fakeGasless(enabled = true) {
  const sends: { owner: string; to: string; amount: bigint }[] = [];
  const gasless = {
    enabled,
    address: async () => SMART_ACCOUNT,
    balance: async () => '0',
    send: async (owner: { address: string }, to: string, amount: bigint) => {
      sends.push({ owner: owner.address, to, amount });
      return { ok: true as const, hash: '0xuserophash' as `0x${string}` };
    },
  } as unknown as GaslessUsdc;
  return { gasless, sends };
}

class TestWrapper implements KeyWrapper {
  readonly #key = crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  async wrap(plain: Bytes) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await this.#key, plain));
    return { iv: Buffer.from(iv).toString('base64'), data: Buffer.from(data).toString('base64') };
  }
  async unwrap(sealed: { iv: string; data: string }) {
    const iv = new Uint8Array(Buffer.from(sealed.iv, 'base64'));
    const data = new Uint8Array(Buffer.from(sealed.data, 'base64'));
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, await this.#key, data));
  }
}

const RECIPIENT = base58.encode(ed25519.getPublicKey(ed25519.utils.randomPrivateKey()));
const BLOCKHASH = base58.encode(new Uint8Array(32).fill(7));

function setup(options: { evmSend?: EvmSend; rpc?: (method: string) => unknown; gasless?: GaslessUsdc } = {}) {
  const store = new MemoryStore();
  const wrapper = new TestWrapper();
  const solana = new SolanaKeyring(store, wrapper);
  const evm = new NetworkKeyring(store, wrapper);
  const sentTxs: string[] = [];
  const devnet = new SolanaDevnet(
    'https://devnet.test',
    async (_url, init) => {
      const { method, params } = JSON.parse(String(init.body)) as { method: string; params: unknown[] };
      const custom = options.rpc?.(method);
      if (custom !== undefined) return new Response(JSON.stringify(custom));
      if (method === 'getLatestBlockhash') return new Response(JSON.stringify({ result: { value: { blockhash: BLOCKHASH } } }));
      if (method === 'sendTransaction') {
        sentTxs.push(params[0] as string);
        return new Response(JSON.stringify({ result: '5sendSig' }));
      }
      if (method === 'getSignatureStatuses') return new Response(JSON.stringify({ result: { value: [{ confirmationStatus: 'confirmed', err: null }] } }));
      return new Response(JSON.stringify({ result: null }));
    },
    async () => undefined,
  );
  const evmSend = options.evmSend ?? vi.fn<EvmSend>(async () => ({ ok: true, hash: '0xethhash' }));
  const sync = vi.fn(async () => ok({ network: { family: 'solana', name: 'solana-devnet', chain_id: null }, fetched: 1, recorded: 1, skipped_existing: 0, next_cursor: null } as never));
  const sender = new TestnetSender({ solana, devnet, evm, evmSend, sync, ...(options.gasless ? { gasless: options.gasless } : {}) });
  return { sender, solana, evm, sentTxs, evmSend, sync };
}

const approve = vi.fn(async (_hash: string) => ok(undefined));

describe('TestnetSender', () => {
  it('asks the passkey first, then signs, broadcasts, confirms and records a Solana transfer', async () => {
    const { sender, solana, sentTxs, sync } = setup();
    const authorize = vi.fn(async (_hash: string) => ok(undefined));
    const result = await sender.send({ network: 'solana-devnet', to: RECIPIENT, amount: '0.25' }, '0xFerra', authorize);

    expect(result).toEqual({
      ok: true,
      value: { network: 'solana-devnet', txId: '5sendSig', amount: '250000000', explorerUrl: 'https://explorer.solana.com/tx/5sendSig?cluster=devnet', recordedOnFerra: 1 },
    });
    expect(authorize).toHaveBeenCalledOnce();
    expect(authorize.mock.calls[0]?.[0]).toMatch(/^0x[0-9a-f]{64}$/);

    // The broadcast transaction is the transfer, signed by the wallet's devnet key.
    const wire = Uint8Array.from(atob(sentTxs[0] ?? ''), (c) => c.charCodeAt(0));
    const signature = wire.slice(1, 65);
    const message = wire.slice(65);
    const from = (await solana.address()) ?? '';
    expect(message).toEqual(transferMessage(from, RECIPIENT, 250_000_000n, BLOCKHASH));
    expect(ed25519.verify(signature, message, base58.decode(from))).toBe(true);
    expect(sync).toHaveBeenCalledWith(expect.objectContaining({ wallet: '0xFerra', network: 'solana-devnet', address_raw: from }));
  });

  it('never signs nor broadcasts when the passkey refuses', async () => {
    const { sender, sentTxs, evmSend } = setup();
    const refuse = async () => err(uiError('PASSKEY_CANCELLED'));
    const sol = await sender.send({ network: 'solana-devnet', to: RECIPIENT, amount: '0.1' }, '0xF', refuse);
    const eth = await sender.send({ network: 'base-sepolia', to: `0x${'1'.repeat(40)}`, amount: '0.001' }, '0xF', refuse);
    expect(!sol.ok && sol.error.code).toBe('PASSKEY_CANCELLED');
    expect(!eth.ok && eth.error.code).toBe('PASSKEY_CANCELLED');
    expect(sentTxs).toHaveLength(0);
    expect(evmSend).not.toHaveBeenCalled();
  });

  it('sends ETH on Base Sepolia and Ethereum Sepolia through the EVM key', async () => {
    const { sender, evmSend } = setup();
    const to = `0x${'2'.repeat(40)}`;
    const base = await sender.send({ network: 'base-sepolia', to, amount: '0.001' }, '0xF', approve);
    expect(base.ok && base.value.explorerUrl).toBe('https://sepolia.basescan.org/tx/0xethhash');
    const sepolia = await sender.send({ network: 'eth-sepolia', to, amount: '0.002' }, '0xF', approve);
    expect(sepolia.ok && sepolia.value.explorerUrl).toBe('https://sepolia.etherscan.io/tx/0xethhash');
    expect(evmSend).toHaveBeenCalledWith('base-sepolia', to, 1_000_000_000_000_000n);
    expect(evmSend).toHaveBeenCalledWith('eth-sepolia', to, 2_000_000_000_000_000n);
  });

  it('sends USDC gaslessly from the smart account owned by the EVM key, then syncs that account on Base Sepolia', async () => {
    const { gasless, sends } = fakeGasless();
    const { sender, evm, evmSend, sync } = setup({ gasless });
    const to = `0x${'3'.repeat(40)}`;
    const authorize = vi.fn(async (_hash: string) => ok(undefined));
    const result = await sender.send({ network: 'base-sepolia-usdc', to, amount: '12.5' }, '0xFerra', authorize);

    expect(result).toEqual({
      ok: true,
      value: { network: 'base-sepolia-usdc', txId: '0xuserophash', amount: '12500000', explorerUrl: 'https://sepolia.basescan.org/tx/0xuserophash', recordedOnFerra: 1 },
    });
    expect(authorize).toHaveBeenCalledOnce();
    expect(sends).toEqual([{ owner: await evm.address(), to, amount: 12_500_000n }]);
    // No native transfer, no ETH: the paymaster pays.
    expect(evmSend).not.toHaveBeenCalled();
    // The on-chain sender is the smart account, so that is what the Ferra chain must watch.
    expect(sync).toHaveBeenCalledWith(expect.objectContaining({ network: 'base-sepolia', address_raw: SMART_ACCOUNT }));
  });

  it('refuses gasless sends when no Pimlico key is configured, before asking the passkey', async () => {
    const off = setup({ gasless: fakeGasless(false).gasless });
    const none = setup();
    const authorize = vi.fn(async (_hash: string) => ok(undefined));
    for (const { sender } of [off, none]) {
      const result = await sender.send({ network: 'base-sepolia-usdc', to: `0x${'4'.repeat(40)}`, amount: '1' }, '0xF', authorize);
      expect(!result.ok && result.error.code).toBe('TESTNET_GASLESS_OFF');
    }
    expect(authorize).not.toHaveBeenCalled();
  });

  it('rejects bad amounts and addresses before asking anything', async () => {
    const { sender } = setup();
    const authorize = vi.fn(async () => ok(undefined));
    const cases = [
      { network: 'solana-devnet', to: RECIPIENT, amount: '0' },
      { network: 'solana-devnet', to: RECIPIENT, amount: 'abc' },
      { network: 'solana-devnet', to: '0x1234', amount: '0.1' },
      { network: 'base-sepolia', to: RECIPIENT, amount: '0.1' },
    ] as const;
    for (const draft of cases) expect((await sender.send(draft, '0xF', authorize)).ok).toBe(false);
    expect(authorize).not.toHaveBeenCalled();
  });

  it('refuses sending to the wallet itself', async () => {
    const { sender, solana } = setup();
    const self = await solana.ensure();
    const result = await sender.send({ network: 'solana-devnet', to: self, amount: '0.1' }, '0xF', approve);
    expect(!result.ok && result.error.code).toBe('UI_INVALID_ADDRESS');
  });

  it('reports a network refusal (e.g. insufficient funds) as TESTNET_SEND_FAILED', async () => {
    const { sender } = setup({ rpc: (m) => (m === 'sendTransaction' ? { error: { code: -32002, message: 'Attempt to debit an account but found no record of a prior credit.' } } : undefined) });
    const result = await sender.send({ network: 'solana-devnet', to: RECIPIENT, amount: '0.1' }, '0xF', approve);
    expect(!result.ok && result.error.code).toBe('TESTNET_SEND_FAILED');
  });
});

describe('solana transaction encoding', () => {
  it('encodes shortvec lengths', () => {
    expect(Array.from(compactU16(3))).toEqual([3]);
    expect(Array.from(compactU16(127))).toEqual([127]);
    expect(Array.from(compactU16(128))).toEqual([0x80, 0x01]);
    expect(Array.from(compactU16(16384))).toEqual([0x80, 0x80, 0x01]);
  });

  it('lays out a legacy transfer message', () => {
    const from = base58.encode(new Uint8Array(32).fill(1));
    const msg = transferMessage(from, RECIPIENT, 1_000n, BLOCKHASH);
    expect(Array.from(msg.slice(0, 4))).toEqual([1, 0, 1, 3]); // header + 3 account keys
    expect(msg.length).toBe(3 + 1 + 96 + 32 + 1 + 1 + 1 + 2 + 1 + 12);
    expect(Array.from(msg.slice(-12, -8))).toEqual([2, 0, 0, 0]); // Transfer
    expect(new DataView(msg.buffer).getBigUint64(msg.length - 8, true)).toBe(1_000n);
  });
});

describe('verifyOwner', () => {
  it('accepts the owner ed25519 signature of this hash only', () => {
    const secret = ed25519.utils.randomPrivateKey();
    const hash = `0x${'ab'.repeat(32)}`;
    const sig = ed25519.sign(Buffer.from('ab'.repeat(32), 'hex'), secret);
    const owner = { kind: 'ed25519' as const, key: `0x${Buffer.from(ed25519.getPublicKey(secret)).toString('hex')}` };
    const signature = { kind: 'ed25519' as const, signature: `0x${Buffer.from(sig).toString('hex')}` };
    expect(verifyOwner(owner, hash, signature)).toBe(true);
    expect(verifyOwner(owner, `0x${'cd'.repeat(32)}`, signature)).toBe(false);
  });

  it('accepts a WebAuthn assertion with UP but no UV (synced passkeys), rejects one without UP', () => {
    const secret = p256.utils.randomPrivateKey();
    const owner = { kind: 'p256' as const, key: `0x${Buffer.from(p256.getPublicKey(secret, false)).toString('hex')}` };
    const hash = `0x${'ab'.repeat(32)}`;
    const assertion = (flags: number) => {
      const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: Buffer.from('ab'.repeat(32), 'hex').toString('base64url') }));
      const authData = new Uint8Array(37);
      authData[32] = flags;
      const signed = new Uint8Array([...authData, ...sha256(clientData)]);
      const der = p256.sign(sha256(signed), secret).toDERRawBytes();
      const hex = (b: Uint8Array) => `0x${Buffer.from(b).toString('hex')}`;
      return { kind: 'webauthn' as const, authenticator_data: hex(authData), client_data_json: hex(clientData), signature: hex(der) };
    };
    expect(verifyOwner(owner, hash, assertion(0b11001))).toBe(true); // UP|BE|BS, as Chrome returned
    expect(verifyOwner(owner, hash, assertion(0b11000))).toBe(false); // no user presence
    expect(verifyOwner(owner, `0x${'cd'.repeat(32)}`, assertion(0b11001))).toBe(false);
  });
});

// Live check of the hand-built encoding against Solana devnet: the node must parse and verify it
// (it then fails only because the throwaway sender has no funds). Skipped unless SQW_DEVNET=1.
describe.skipIf(process.env['SQW_DEVNET'] !== '1')('solana encoding on devnet', () => {
  it('is accepted as a well-formed, correctly signed transaction', async () => {
    const devnet = new SolanaDevnet();
    const secret = ed25519.utils.randomPrivateKey();
    const from = base58.encode(ed25519.getPublicKey(secret));
    const blockhash = await devnet.latestBlockhash();
    if (!blockhash.ok) throw new Error(blockhash.error.message);
    const message = transferMessage(from, RECIPIENT, 1_000_000n, blockhash.value);
    const tx = signedTransaction(ed25519.sign(message, secret), message);
    const response = await fetch('https://api.devnet.solana.com', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'simulateTransaction', params: [tx, { encoding: 'base64', sigVerify: true }] }),
    });
    const body = (await response.json()) as { result?: { value?: { err?: unknown } }; error?: { message?: string } };
    // A malformed or badly signed tx is a JSON-RPC error; a well-formed one simulates and fails on funds.
    expect(body.error).toBeUndefined();
    expect(JSON.stringify(body.result?.value?.err)).toMatch(/AccountNotFound|InsufficientFunds/);
  });
});
