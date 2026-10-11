import { describe, expect, it } from 'vitest';
import { err } from '../../ui/core/result';
import { uiError } from '../../ui/core/errors';
import { FakeBridge } from '../../ui/services/FakeBridge';
import type { UiBridge } from '../../ui/services/UiBridge';
import { readForSite, type SiteRecovery, type SiteWallet } from './SiteReader';

async function signedIn(): Promise<FakeBridge> {
  const bridge = new FakeBridge({ delayMs: 0 });
  await bridge.login({ username: 'alice', password: 'demo' });
  await bridge.createWallet();
  return bridge;
}

describe('readForSite', () => {
  it('gives the website the wallet with formatted balances, never a key', async () => {
    const answer = await readForSite(await signedIn(), 'sqw_wallet');
    if (!answer.ok) throw new Error(answer.error.message);
    const wallet = answer.result as SiteWallet;
    expect(wallet.network).toBe('Ferra chain');
    expect(wallet.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(wallet.balances.find((b) => b.symbol === 'USDC')).toMatchObject({ amount: '5000000000', formatted: expect.stringMatching(/^5\s000$/) });
    expect(JSON.stringify(wallet)).not.toMatch(/token|secret|private/i);
  });

  it('gives activity rows, test-network wallets and the recovery status', async () => {
    const bridge = await signedIn();
    bridge.simulateRecoveryElsewhere();
    const activity = await readForSite(bridge, 'sqw_activity');
    expect(activity.ok && Array.isArray(activity.result) && activity.result.length).toBeGreaterThan(0);
    const testnet = await readForSite(bridge, 'sqw_testnet');
    expect(testnet.ok && (testnet.result as { network: string }[]).map((w) => w.network)).toContain('solana-devnet');
    const recovery = await readForSite(bridge, 'sqw_recovery');
    expect(recovery.ok && (recovery.result as SiteRecovery)).toMatchObject({ phoneFingerprint: null, alerts: [{ newKeyFingerprint: 'E5F6-0718' }] });
  });

  it('says "locked" when the wallet is locked, so the site offers to unlock with Ferrata', async () => {
    const locked = { getWallet: async () => err(uiError('UI_LOCKED')) } as unknown as UiBridge;
    expect(await readForSite(locked, 'sqw_wallet')).toEqual({ ok: false, error: { code: 4100, message: 'locked' } });
    const out = { getWallet: async () => err(uiError('SQ_UNAUTHORIZED')) } as unknown as UiBridge;
    expect(await readForSite(out, 'sqw_wallet')).toEqual({ ok: false, error: { code: 4100, message: 'signed_out' } });
  });
});
