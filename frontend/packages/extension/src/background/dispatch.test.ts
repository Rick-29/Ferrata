import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../ui/services/fake-world';
import { FakeBridge } from '../ui/services/FakeBridge';
import { BRIDGE_CHANNEL, isBridgeRequest, type BridgeMethod, type BridgeRequest } from '../ui/services/bridge-protocol';
import { dispatch } from './dispatch';

const request = (method: BridgeMethod, ...args: unknown[]): BridgeRequest => ({ channel: BRIDGE_CHANNEL, method, args });

describe('bridge protocol', () => {
  it('accepts only our channel and known methods', () => {
    expect(isBridgeRequest(request('getWallet'))).toBe(true);
    expect(isBridgeRequest({ ...request('getWallet'), channel: 'other' })).toBe(false);
    expect(isBridgeRequest({ channel: BRIDGE_CHANNEL, method: 'stealKeys', args: [] })).toBe(false);
    expect(isBridgeRequest({ channel: BRIDGE_CHANNEL, method: 'login' })).toBe(false);
  });
});

describe('dispatch', () => {
  it('routes a well-formed call to the bridge', async () => {
    const bridge = new FakeBridge({ delayMs: 0 });
    const result = await dispatch(bridge, request('login', { username: 'alice', password: 'demo' }));
    expect(result.ok).toBe(true);
  });

  it.each([
    ['login', [{ username: 'alice' }]],
    ['previewSend', [{ to: 42, asset: null, amount: '0x1' }]],
    ['confirmSend', ['preview-1', { stepUp: 'yes', acceptedRisk: false }]],
    ['cancelSend', [123]],
    ['saveSettings', [{ ...DEFAULT_SETTINGS, per_tx_limit_pct: 'all' }]],
  ] as const)('rejects malformed %s arguments without calling the bridge', async (method, args) => {
    const result = await dispatch(new FakeBridge({ delayMs: 0 }), request(method, ...args));
    expect(result).toEqual({ ok: false, error: { code: 'UI_BAD_REQUEST', retryable: false } });
  });
});
