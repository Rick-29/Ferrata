// @vitest-environment node
import { ed25519 } from '@noble/curves/ed25519';
import { base58 } from '@scure/base';
import { describe, expect, it, vi } from 'vitest';
import { err, ok, sdkError } from '@sqw/sdk';
import { NetworkKeyring, type Bytes, type KeyWrapper } from '../dapp/NetworkKeyring';
import { MemoryStore } from '../storage';
import { SolanaDevnet } from './SolanaDevnet';
import { SolanaKeyring } from './SolanaKeyring';
import { TestnetWallets, type TestnetWalletsDeps } from './TestnetWallets';

/** Real AES-GCM with an in-memory key: the keyring is exercised end to end without IndexedDB. */
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

type RpcHandler = (method: string, params: unknown[]) => { status?: number; body: unknown };

/** A devnet node answering from `handler`, recording every call. */
function fakeDevnet(handler: RpcHandler) {
  const calls: Array<{ method: string; params: unknown[] }> = [];
  const devnet = new SolanaDevnet(
    'https://devnet.test',
    async (_url, init) => {
      const { method, params } = JSON.parse(String(init.body)) as { method: string; params: unknown[] };
      calls.push({ method, params });
      const { status = 200, body } = handler(method, params);
      return new Response(JSON.stringify(body), { status });
    },
    async () => undefined,
  );
  return { devnet, calls };
}

const rpc = (result: unknown) => ({ body: { jsonrpc: '2.0', id: 1, result } });

const happyPath: RpcHandler = (method) => {
  switch (method) {
    case 'getBalance':
      return rpc({ context: { slot: 1 }, value: 2_500_000_000 });
    case 'requestAirdrop':
      return rpc('5igSig');
    case 'getSignatureStatuses':
      return rpc({ context: { slot: 1 }, value: [{ confirmationStatus: 'confirmed', err: null }] });
    default:
      return rpc(null);
  }
};

const SYNCED = ok({ network: { family: 'solana', name: 'solana-devnet', chain_id: null }, fetched: 1, recorded: 1, skipped_existing: 0, next_cursor: null } as never);

function setup(
  handler: RpcHandler = happyPath,
  sync = vi.fn<TestnetWalletsDeps['sync']>(async () => SYNCED),
  evmBalance: TestnetWalletsDeps['evmBalance'] = async (network) => (network === 'base-sepolia' ? '20000000000000000' : '30000000000000000'),
) {
  const keyStore = new MemoryStore();
  const wrapper = new TestWrapper();
  const solana = new SolanaKeyring(keyStore, wrapper);
  const evm = new NetworkKeyring(keyStore, wrapper);
  const { devnet, calls } = fakeDevnet(handler);
  return { service: new TestnetWallets({ solana, devnet, evm, evmBalance, sync }), solana, evm, keyStore, calls, sync };
}

describe('SolanaKeyring', () => {
  it('creates a base58 Ed25519 address once and signs with the matching key', async () => {
    const { solana, keyStore } = setup();
    const address = await solana.ensure();
    expect(await solana.ensure()).toBe(address);
    expect(base58.decode(address)).toHaveLength(32);

    const message = new TextEncoder().encode('hello devnet');
    const signature = await solana.sign(message);
    expect(signature).not.toBeNull();
    expect(ed25519.verify(signature ?? new Uint8Array(), message, base58.decode(address))).toBe(true);

    // Only the address and an AES-GCM blob are stored: no 32-byte secret in clear.
    const stored = JSON.stringify(await keyStore.get('sqw-network-key:solana-devnet'));
    expect(stored).toContain(address);
    expect(stored).not.toMatch(/[0-9a-f]{64}/);
  });
});

describe('TestnetWallets', () => {
  it('lists the devnet address with its balance in lamports, and asks the backend to sync it', async () => {
    const { service, solana, sync } = setup();
    const result = await service.list('0xFerraWallet');
    expect(sync).toHaveBeenCalledWith(expect.objectContaining({ wallet: '0xFerraWallet', network: 'solana-devnet', address_raw: await solana.address() }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [wallet] = result.value;
    expect(wallet).toMatchObject({ network: 'solana-devnet', symbol: 'SOL', decimals: 9, balance: '2500000000' });
    expect(wallet?.address).toBe(await solana.address());
    expect(wallet?.explorerUrl).toContain('cluster=devnet');
  });

  it('still lists the address when devnet cannot be read', async () => {
    const { service } = setup(() => ({ status: 503, body: 'down' }));
    const result = await service.list('0xW');
    expect(result.ok && result.value[0]?.balance).toBeNull();
  });

  it('lists the Base Sepolia address (the dApp key) with a web faucet, and syncs it too', async () => {
    const { service, evm, sync } = setup();
    const result = await service.list('0xFerraWallet');
    const address = await evm.address();
    expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(result.ok && result.value[1]).toMatchObject({
      network: 'base-sepolia',
      address,
      symbol: 'ETH',
      decimals: 18,
      balance: '20000000000000000',
      inWalletAirdrop: false,
    });
    expect(result.ok && result.value[1]?.faucetUrl).toMatch(/^https:\/\//);
    expect(sync).toHaveBeenCalledWith(expect.objectContaining({ wallet: '0xFerraWallet', network: 'base-sepolia', address_raw: address }));
  });

  it('lists Ethereum Sepolia on the same EVM address, with the PoW faucet, and syncs it', async () => {
    const { service, evm, sync } = setup();
    const result = await service.list('0xFerraWallet');
    const address = await evm.address();
    expect(result.ok && result.value.map((w) => w.network)).toEqual(['solana-devnet', 'base-sepolia', 'eth-sepolia']);
    expect(result.ok && result.value[2]).toMatchObject({
      network: 'eth-sepolia',
      address,
      symbol: 'ETH',
      balance: '30000000000000000',
      inWalletAirdrop: false,
      faucetUrl: 'https://sepolia-faucet.pk910.de/',
    });
    expect(sync).toHaveBeenCalledWith(expect.objectContaining({ wallet: '0xFerraWallet', network: 'eth-sepolia', address_raw: address }));
  });

  it('shows a null ETH balance when the Base Sepolia node cannot be read', async () => {
    const { service } = setup(happyPath, undefined, async () => null);
    const result = await service.list('0xW');
    expect(result.ok && result.value[1]?.balance).toBeNull();
  });

  it('has no in-wallet airdrop for Base Sepolia', async () => {
    const { service, calls } = setup();
    const result = await service.airdrop('base-sepolia', '0xW');
    expect(!result.ok && result.error.code).toBe('TESTNET_NO_FAUCET_API');
    expect(calls).toHaveLength(0);
  });

  it('airdrops 1 SOL, waits for confirmation, then records it on the Ferra chain', async () => {
    const { service, calls, sync, solana } = setup();
    const result = await service.airdrop('solana-devnet', '0xFerraWallet');

    expect(result).toEqual({
      ok: true,
      value: {
        network: 'solana-devnet',
        signature: '5igSig',
        amount: '1000000000',
        explorerUrl: 'https://explorer.solana.com/tx/5igSig?cluster=devnet',
        recordedOnFerra: 1,
      },
    });
    const address = await solana.address();
    expect(calls.map((c) => c.method)).toEqual(['requestAirdrop', 'getSignatureStatuses']);
    expect(calls[0]?.params).toEqual([address, 1_000_000_000]);
    expect(sync).toHaveBeenCalledWith({ wallet: '0xFerraWallet', network: 'solana-devnet', address_raw: address, limit: null, cursor: null });
  });

  it('keeps polling until the airdrop is confirmed', async () => {
    let polls = 0;
    const { service } = setup((method, params) => {
      if (method !== 'getSignatureStatuses') return happyPath(method, params);
      polls += 1;
      return rpc({ value: [polls < 3 ? null : { confirmationStatus: 'finalized', err: null }] });
    });
    expect((await service.airdrop('solana-devnet', '0xW')).ok).toBe(true);
    expect(polls).toBe(3);
  });

  it('reports the faucet limit as its own error, without calling the backend', async () => {
    const { service, sync } = setup((method) =>
      method === 'requestAirdrop'
        ? { body: { jsonrpc: '2.0', id: 1, error: { code: 429, message: "You've either reached your airdrop limit today or the airdrop faucet has run dry." } } }
        : rpc(null),
    );
    const result = await service.airdrop('solana-devnet', '0xW');
    expect(!result.ok && result.error.code).toBe('TESTNET_FAUCET_LIMIT');
    expect(sync).not.toHaveBeenCalled();
  });

  it('treats the faucet\'s bare "Internal error" as the faucet limit (seen live on devnet)', async () => {
    const { service } = setup((method) =>
      method === 'requestAirdrop' ? { body: { jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'Internal error' } } } : rpc(null),
    );
    const result = await service.airdrop('solana-devnet', '0xW');
    expect(!result.ok && result.error.code).toBe('TESTNET_FAUCET_LIMIT');
  });

  it('treats HTTP 429 as the faucet limit too', async () => {
    const { service } = setup((method) => (method === 'requestAirdrop' ? { status: 429, body: {} } : rpc(null)));
    const result = await service.airdrop('solana-devnet', '0xW');
    expect(!result.ok && result.error.code).toBe('TESTNET_FAUCET_LIMIT');
  });

  it('fails when the airdrop transaction itself fails', async () => {
    const { service } = setup((method, params) =>
      method === 'getSignatureStatuses' ? rpc({ value: [{ confirmationStatus: 'processed', err: { InstructionError: [0, 'Custom'] } }] }) : happyPath(method, params),
    );
    const result = await service.airdrop('solana-devnet', '0xW');
    expect(!result.ok && result.error.code).toBe('TESTNET_RPC_ERROR');
  });

  it('still reports the airdrop when the Ferra sync fails (the SOL did arrive)', async () => {
    const sync = vi.fn<TestnetWalletsDeps['sync']>(async () => err(sdkError('UNREACHABLE', 'network', 'down')));
    const { service } = setup(happyPath, sync);
    const result = await service.airdrop('solana-devnet', '0xW');
    expect(result.ok && result.value.recordedOnFerra).toBe(0);
  });
});
