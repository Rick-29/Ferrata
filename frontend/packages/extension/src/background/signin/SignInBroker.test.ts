// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { SIGNIN_CHANNEL, type SignInResult } from '../../signin/protocol';
import { MemoryStore } from '../storage';
import { DappRouter } from '../dapp/DappRouter';
import { NetworkKeyring, type KeyWrapper } from '../dapp/NetworkKeyring';
import { RpcProxy } from '../dapp/RpcProxy';
import { SignInBroker } from './SignInBroker';

const SITE = 'http://localhost:5174';
const IDENTITY: SignInResult = { address: '0xabc', clientId: 'SQ-100001', displayName: 'Alice Keller' };

function setup(options: { provenAt?: number | null } = {}) {
  let now = 1_000;
  let ids = 0;
  const closed: number[] = [];
  const opened: string[] = [];
  let provenAt: number | null = options.provenAt === undefined ? null : options.provenAt;
  const broker = new SignInBroker({
    openWindow: async (query) => {
      opened.push(query);
      return 42;
    },
    closeWindow: (id) => closed.push(id),
    identitySince: async (since) => (provenAt !== null && provenAt >= since ? IDENTITY : null),
    now: () => now,
    newId: () => `req-${++ids}`,
    timeoutMs: 10_000,
  });
  return {
    broker,
    opened,
    closed,
    prove: (at: number) => (provenAt = at),
    advance: (ms: number) => (now += ms),
    message: (op: 'details' | 'complete' | 'cancel', id = 'req-1') => ({ channel: SIGNIN_CHANNEL, op, id }) as const,
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('SignInBroker (website sign-in through the extension)', () => {
  it('opens the approval window and tells it which site asks', async () => {
    const { broker, opened, message } = setup();
    void broker.request(SITE);
    await flush();
    expect(opened).toEqual(['signin=req-1']);
    expect(await broker.handle(message('details'))).toEqual({ ok: true, value: { origin: SITE } });
  });

  it('answers the site with the identity once the passkey proved it, then closes the window', async () => {
    const { broker, closed, prove, advance, message } = setup();
    const answer = broker.request(SITE);
    await flush();
    advance(5_000);
    prove(6_000);
    expect(await broker.handle(message('complete'))).toEqual({ ok: true });
    expect(await answer).toEqual({ ok: true, result: IDENTITY });
    expect(closed).toEqual([42]);
  });

  it('never accepts a passkey proof older than the request (no replay of an earlier unlock)', async () => {
    const { broker, prove, message } = setup();
    prove(500); // unlocked before the site asked
    const answer = broker.request(SITE);
    await flush();
    expect(await broker.handle(message('complete'))).toEqual({ ok: false, code: 'SIGNIN_NOT_PROVEN' });
    // Still pending: a fresh proof completes it.
    prove(2_000);
    expect(await broker.handle(message('complete'))).toEqual({ ok: true });
    expect((await answer).ok).toBe(true);
  });

  it('refuses the site (4001) when the user closes the window or clicks Refuser', async () => {
    const closedByUser = setup();
    const a = closedByUser.broker.request(SITE);
    await flush();
    closedByUser.broker.onWindowClosed(42);
    expect(await a).toEqual({ ok: false, error: { code: 4001, message: 'User rejected the request.' } });

    const refused = setup();
    const b = refused.broker.request(SITE);
    await flush();
    await refused.broker.handle(refused.message('cancel'));
    expect((await b).ok).toBe(false);
  });

  it('refuses after the timeout', async () => {
    vi.useFakeTimers();
    try {
      const { broker } = setup();
      const answer = broker.request(SITE);
      await vi.advanceTimersByTimeAsync(10_000);
      expect((await answer).ok).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores messages for unknown requests', async () => {
    const { broker, message } = setup();
    expect(await broker.handle(message('complete', 'nope'))).toEqual({ ok: false, code: 'SIGNIN_UNKNOWN' });
  });

  it('never hands the session token to the site', async () => {
    const { broker, prove, message } = setup();
    const answer = broker.request(SITE);
    await flush();
    prove(9_999);
    await broker.handle(message('complete'));
    expect(JSON.stringify(await answer)).not.toMatch(/token/i);
  });
});

describe('DappRouter sqw_signIn', () => {
  const noWrap: KeyWrapper = {
    wrap: async () => ({ iv: '', data: '' }),
    unwrap: async () => new Uint8Array(32),
  };
  const router = (signIn = vi.fn(async () => ({ ok: true as const, result: IDENTITY }))) => ({
    signIn,
    router: new DappRouter({
      keyring: new NetworkKeyring(new MemoryStore(), noWrap),
      rpc: new RpcProxy('https://rpc.test', async () => new Response('{}')),
      permissions: new MemoryStore(),
      approver: { approveConnect: async () => true },
      walletReady: async () => true,
      signIn,
      firstPartyOrigins: [SITE],
    }),
  });

  it('is offered to the Ferrata website', async () => {
    const { router: r, signIn } = router();
    expect(await r.handle(SITE, 'sqw_signIn', [])).toEqual({ ok: true, result: IDENTITY });
    expect(signIn).toHaveBeenCalledWith(SITE);
  });

  it('is refused to every other site, which cannot even open the window', async () => {
    const { router: r, signIn } = router();
    for (const origin of ['https://app.uniswap.org', 'https://evil.example', 'http://localhost:5175']) {
      const result = await r.handle(origin, 'sqw_signIn', []);
      expect(!result.ok && result.error.code).toBe(4200);
    }
    expect(signIn).not.toHaveBeenCalled();
  });
});
