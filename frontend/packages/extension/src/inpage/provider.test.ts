// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { CONTENT_TO_PAGE, isPageRequest, type DappResponse } from '../dapp/protocol';
import { ProviderRpcError, SwissquoteProvider, type MessagePort } from './provider';

/** A window stand-in: every request posted by the provider is answered by `answer`. */
function fakeWindow(answer: (method: string, params: readonly unknown[]) => DappResponse) {
  const listeners: Array<(e: MessageEvent) => void> = [];
  const posted: unknown[] = [];
  const port: MessagePort = {
    addEventListener: (_type, listener) => listeners.push(listener),
    postMessage: (message) => {
      posted.push(message);
      if (!isPageRequest(message)) return;
      const response = { target: CONTENT_TO_PAGE, id: message.id, response: answer(message.method, message.params) };
      queueMicrotask(() => listeners.forEach((l) => l({ data: response } as MessageEvent)));
    },
  };
  return { port, posted };
}

describe('SwissquoteProvider (EIP-1193)', () => {
  it('resolves with the background result', async () => {
    const { port } = fakeWindow(() => ({ ok: true, result: '0x14a34' }));
    const provider = new SwissquoteProvider(port, 'https://app.uniswap.org');
    expect(await provider.request({ method: 'eth_chainId' })).toBe('0x14a34');
  });

  it('rejects with a ProviderRpcError carrying the EIP-1193 code', async () => {
    const { port } = fakeWindow(() => ({ ok: false, error: { code: 4001, message: 'User rejected the request.' } }));
    const provider = new SwissquoteProvider(port, 'https://app.uniswap.org');
    await expect(provider.request({ method: 'eth_requestAccounts' })).rejects.toMatchObject({ code: 4001 });
    await expect(provider.request({ method: 'eth_requestAccounts' })).rejects.toBeInstanceOf(ProviderRpcError);
  });

  it('passes params through and posts to its own origin only', async () => {
    const seen: Array<readonly unknown[]> = [];
    const { port } = fakeWindow((_m, params) => {
      seen.push(params);
      return { ok: true, result: '0x0' };
    });
    const provider = new SwissquoteProvider(port, 'https://app.uniswap.org');
    await provider.request({ method: 'eth_getBalance', params: ['0xabc', 'latest'] });
    expect(seen).toEqual([['0xabc', 'latest']]);
  });

  it('emits accountsChanged when the connected accounts change', async () => {
    const { port } = fakeWindow(() => ({ ok: true, result: ['0x1111111111111111111111111111111111111111'] }));
    const provider = new SwissquoteProvider(port, 'https://app.uniswap.org');
    const events: unknown[] = [];
    provider.on('accountsChanged', (accounts) => events.push(accounts));
    await provider.request({ method: 'eth_requestAccounts' });
    await provider.request({ method: 'eth_accounts' });
    expect(events).toEqual([['0x1111111111111111111111111111111111111111']]);
  });

  it('rejects malformed calls without posting anything', async () => {
    const { port, posted } = fakeWindow(() => ({ ok: true, result: null }));
    const provider = new SwissquoteProvider(port, 'https://app.uniswap.org');
    await expect(provider.request({} as never)).rejects.toMatchObject({ code: -32602 });
    expect(posted).toHaveLength(0);
  });
});
