import { describe, expect, it, vi } from 'vitest';
import { encodeErc20Transfer } from './erc20';
import { UNREACHABLE } from './errors';
import type { FetchLike } from './http';
import { HttpSwissquoteApi } from './HttpSwissquoteApi';

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function apiWith(fetchImpl: FetchLike, token: string | null = 'tok-1'): HttpSwissquoteApi {
  return new HttpSwissquoteApi({ baseUrl: 'http://sq.test/', token: () => token, fetch: fetchImpl });
}

describe('HttpSwissquoteApi', () => {
  it('sends JSON with the bearer token and returns the typed body', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => json(200, { token: 't', client_id: 'SQ-1', display_name: 'A' }));
    const result = await apiWith(fetchImpl, null).login({ username: 'alice', password: 'demo' });

    expect(result).toEqual({ ok: true, value: { token: 't', client_id: 'SQ-1', display_name: 'A' } });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe('http://sq.test/auth/session');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({ username: 'alice', password: 'demo' }));
    expect(init?.headers).not.toHaveProperty('Authorization');
  });

  it('adds the bearer token on authenticated calls and encodes path segments', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => json(200, { address: '0xabc', txs: [] }));
    await apiWith(fetchImpl).cancelIntent('0xabc', 'intent/1');

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe('http://sq.test/intents/0xabc/intent%2F1/cancel');
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer tok-1' });
  });

  it("maps the backend's { code, message } error to an SdkError", async () => {
    const fetchImpl: FetchLike = async () => json(401, { code: 'UNAUTHORIZED', message: 'bad token', details: null });
    const result = await apiWith(fetchImpl).overview({ kind: 'ed25519', key: '0x01' });

    expect(result).toEqual({
      ok: false,
      error: { code: 'UNAUTHORIZED', source: 'swissquote', message: 'bad token', status: 401 },
    });
  });

  it('reports an unreachable server as a network error', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new TypeError('Failed to fetch');
    };
    const result = await apiWith(fetchImpl).chainInfo();
    expect(!result.ok && result.error).toMatchObject({ code: UNREACHABLE, source: 'network' });
  });

  it('keeps a non-JSON error body readable', async () => {
    const fetchImpl: FetchLike = async () => new Response('gateway down', { status: 502 });
    const result = await apiWith(fetchImpl).chainInfo();
    expect(!result.ok && result.error).toMatchObject({ code: 'HTTP_502', message: 'gateway down', status: 502 });
  });
});

describe('encodeErc20Transfer', () => {
  it('produces standard transfer(address,uint256) calldata', () => {
    const data = encodeErc20Transfer('0x00000000000000000000000000000000000000AA', 50_000_000n);
    expect(data).toBe(
      '0xa9059cbb' +
        '00000000000000000000000000000000000000000000000000000000000000aa' +
        '0000000000000000000000000000000000000000000000000000000002faf080',
    );
  });

  it('rejects malformed input', () => {
    expect(() => encodeErc20Transfer('0x123', 1n)).toThrow(RangeError);
    expect(() => encodeErc20Transfer(`0x${'1'.repeat(40)}`, -1n)).toThrow(RangeError);
  });
});
