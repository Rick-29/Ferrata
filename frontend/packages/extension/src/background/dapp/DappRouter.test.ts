// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../storage';
import { DappRouter, type ConnectApprover } from './DappRouter';
import { NetworkKeyring, type Bytes, type KeyWrapper } from './NetworkKeyring';
import { RpcProxy } from './RpcProxy';

/** Real AES-GCM with an in-memory key, so the keyring is exercised end to end without IndexedDB. */
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
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, await this.#key, data);
    return new Uint8Array(plain);
  }
}

const UNISWAP = 'https://app.uniswap.org';
const EVIL = 'https://evil.example';

function setup(options: { ready?: boolean; approve?: boolean; rpc?: (body: unknown) => unknown } = {}) {
  const keyStore = new MemoryStore();
  const keyring = new NetworkKeyring(keyStore, new TestWrapper());
  const rpcCalls: unknown[] = [];
  const rpc = new RpcProxy('https://rpc.test', async (_url, init) => {
    const body: unknown = JSON.parse(String(init.body));
    rpcCalls.push(body);
    return new Response(JSON.stringify(options.rpc?.(body) ?? { jsonrpc: '2.0', id: 1, result: '0x10' }));
  });
  const approvals: string[] = [];
  const approver: ConnectApprover = {
    approveConnect: async (origin) => {
      approvals.push(origin);
      return options.approve ?? true;
    },
  };
  const router = new DappRouter({
    keyring,
    rpc,
    permissions: new MemoryStore(),
    approver,
    walletReady: async () => options.ready ?? true,
  });
  return { router, keyring, keyStore, rpcCalls, approvals };
}

describe('DappRouter', () => {
  it('answers the chain id locally (Base Sepolia)', async () => {
    const { router, rpcCalls } = setup();
    expect(await router.handle(UNISWAP, 'eth_chainId', [])).toEqual({ ok: true, result: '0x14a34' });
    expect(await router.handle(UNISWAP, 'net_version', [])).toEqual({ ok: true, result: '84532' });
    expect(rpcCalls).toHaveLength(0);
  });

  it('shows no account to a site that has not connected', async () => {
    const { router } = setup();
    expect(await router.handle(UNISWAP, 'eth_accounts', [])).toEqual({ ok: true, result: [] });
  });

  it('connects after approval, creates the key once and remembers the site', async () => {
    const { router, keyring, approvals } = setup();

    const first = await router.handle(UNISWAP, 'eth_requestAccounts', []);
    const address = await keyring.address();
    expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(first).toEqual({ ok: true, result: [address] });

    expect(await router.handle(UNISWAP, 'eth_requestAccounts', [])).toEqual({ ok: true, result: [address] });
    expect(await router.handle(UNISWAP, 'eth_accounts', [])).toEqual({ ok: true, result: [address] });
    expect(approvals).toEqual([UNISWAP]);
  });

  it('keeps one site connection from leaking to another', async () => {
    const { router } = setup();
    await router.handle(UNISWAP, 'eth_requestAccounts', []);
    expect(await router.handle(EVIL, 'eth_accounts', [])).toEqual({ ok: true, result: [] });
  });

  it('rejects with 4001 when the user (or the allowlist) refuses', async () => {
    const { router, keyring } = setup({ approve: false });
    const result = await router.handle(EVIL, 'eth_requestAccounts', []);
    expect(result).toEqual({ ok: false, error: { code: 4001, message: 'User rejected the request.' } });
    expect(await keyring.address()).toBeNull();
  });

  it('asks the user to sign in before connecting', async () => {
    const { router, approvals } = setup({ ready: false });
    const result = await router.handle(UNISWAP, 'eth_requestAccounts', []);
    expect(!result.ok && result.error.code).toBe(4100);
    expect(approvals).toHaveLength(0);
  });

  it('only switches to Base Sepolia', async () => {
    const { router } = setup();
    expect(await router.handle(UNISWAP, 'wallet_switchEthereumChain', [{ chainId: '0x14A34' }])).toEqual({ ok: true, result: null });
    const mainnet = await router.handle(UNISWAP, 'wallet_switchEthereumChain', [{ chainId: '0x1' }]);
    expect(!mainnet.ok && mainnet.error.code).toBe(4902);
  });

  it('forwards read calls to the RPC node', async () => {
    const { router, rpcCalls } = setup();
    const result = await router.handle(UNISWAP, 'eth_getBalance', ['0xabc', 'latest']);
    expect(result).toEqual({ ok: true, result: '0x10' });
    expect(rpcCalls).toMatchObject([{ method: 'eth_getBalance', params: ['0xabc', 'latest'] }]);
  });

  it('relays RPC errors with their code', async () => {
    const { router } = setup({ rpc: () => ({ jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted' } }) });
    expect(await router.handle(UNISWAP, 'eth_call', [{}])).toEqual({ ok: false, error: { code: 3, message: 'execution reverted' } });
  });

  it('never forwards a method that is not on the read list', async () => {
    const { router, rpcCalls } = setup();
    for (const method of ['eth_sendRawTransaction', 'eth_sign', 'eth_accountsSecret', 'debug_traceCall']) {
      const result = await router.handle(UNISWAP, method, []);
      expect(!result.ok && result.error.code).toBe(4200);
    }
    expect(rpcCalls).toHaveLength(0);
  });

  it('refuses signing from a site that is not connected, and is not wired yet for connected ones', async () => {
    const { router } = setup();
    const before = await router.handle(UNISWAP, 'eth_sendTransaction', [{}]);
    expect(!before.ok && before.error.code).toBe(4100);
    await router.handle(UNISWAP, 'eth_requestAccounts', []);
    const after = await router.handle(UNISWAP, 'eth_sendTransaction', [{}]);
    expect(!after.ok && after.error.code).toBe(4200);
  });

  it('forgets a site on disconnect', async () => {
    const { router } = setup();
    await router.handle(UNISWAP, 'eth_requestAccounts', []);
    await router.disconnect(UNISWAP);
    expect(await router.handle(UNISWAP, 'eth_accounts', [])).toEqual({ ok: true, result: [] });
  });
});

describe('NetworkKeyring', () => {
  it('stores the key encrypted and gives back the same signing account', async () => {
    const { keyring, keyStore } = setup();
    const address = await keyring.ensure();

    const stored = JSON.stringify(await keyStore.get('sqw-network-key:base-sepolia'));
    const account = await keyring.account();
    expect(account?.address).toBe(address);
    // Storage holds the address and an AES-GCM blob, never a 32-byte hex key in clear.
    expect(stored).not.toMatch(/0x[0-9a-fA-F]{64}/);
  });

  it('keeps the same address across calls', async () => {
    const { keyring } = setup();
    expect(await keyring.ensure()).toBe(await keyring.ensure());
  });
});
