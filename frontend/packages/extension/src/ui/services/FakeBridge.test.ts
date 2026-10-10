import { describe, expect, it } from 'vitest';
import { DEMO_ADDRESSES, USDC } from './fake-world';
import { FakeBridge } from './FakeBridge';
import type { SendDraft } from './UiBridge';

const usdc = (whole: bigint): string => `0x${(whole * 10n ** 6n).toString(16)}`;
const NEW_RECIPIENT = '0x1234567890123456789012345678901234567890';

async function loggedInWithWallet(): Promise<FakeBridge> {
  const bridge = new FakeBridge({ delayMs: 0 });
  await bridge.login({ username: 'alice', password: 'demo' });
  await bridge.createWallet();
  return bridge;
}

async function send(bridge: FakeBridge, draft: SendDraft, stepUp = false) {
  const preview = await bridge.previewSend(draft);
  if (!preview.ok) throw new Error(preview.error.code);
  const outcome = await bridge.confirmSend(preview.value.id, { stepUp, acceptedRisk: false });
  return { preview: preview.value, outcome };
}

describe('FakeBridge session', () => {
  it('rejects wrong credentials', async () => {
    const bridge = new FakeBridge({ delayMs: 0 });
    const result = await bridge.login({ username: 'alice', password: 'nope' });
    expect(result).toEqual({ ok: false, error: { code: 'SQ_UNAUTHORIZED', retryable: false } });
  });

  it('refuses wallet calls before login', async () => {
    const bridge = new FakeBridge({ delayMs: 0 });
    const result = await bridge.getWallet();
    expect(result.ok).toBe(false);
  });

  it('creates a funded wallet after login', async () => {
    const bridge = await loggedInWithWallet();
    const wallet = await bridge.getWallet();
    if (!wallet.ok) throw new Error('expected wallet');
    expect(wallet.value.balances.map((b) => b.symbol)).toEqual(['ETH', 'USDC']);
  });
});

describe('FakeBridge risk scenarios (README demo table)', () => {
  it('Low: known merchant is co-signed and debits the balance', async () => {
    const bridge = await loggedInWithWallet();
    const { preview, outcome } = await send(bridge, { to: DEMO_ADDRESSES.knownMerchant, asset: USDC, amount: usdc(50n) });

    expect(preview.assessment.assessment.band).toBe('Low');
    expect(outcome.ok && outcome.value.kind).toBe('confirmed');
    const wallet = await bridge.getWallet();
    const balance = wallet.ok ? wallet.value.balances.find((b) => b.asset === USDC)?.amount : undefined;
    expect(balance).toBe(usdc(4_950n));
  });

  it('Medium: large amount asks for a standard second confirmation, then goes through', async () => {
    const bridge = await loggedInWithWallet();
    const preview = await bridge.previewSend({ to: NEW_RECIPIENT, asset: USDC, amount: usdc(1_500n) });
    if (!preview.ok) throw new Error('expected preview');

    expect(preview.value.assessment.assessment).toMatchObject({ band: 'Medium', score: 45 });
    const first = await bridge.confirmSend(preview.value.id, { stepUp: false, acceptedRisk: false });
    expect(first.ok && first.value).toEqual({ kind: 'confirmation_required', previewId: preview.value.id, level: 'standard' });
    const second = await bridge.confirmSend(preview.value.id, { stepUp: true, acceptedRisk: false });
    expect(second.ok && second.value.kind).toBe('confirmed');
  });

  it('High: mixer exposure is never blocked, it asks for a high-risk confirmation', async () => {
    const bridge = await loggedInWithWallet();
    const { preview, outcome } = await send(bridge, { to: DEMO_ADDRESSES.mixerExposed, asset: USDC, amount: usdc(100n) });

    expect(preview.assessment.assessment.band).toBe('High');
    expect(outcome.ok && outcome.value).toMatchObject({ kind: 'confirmation_required', level: 'high_risk' });
    const withoutAcceptance = await bridge.confirmSend(preview.id, { stepUp: true, acceptedRisk: false });
    expect(withoutAcceptance.ok && withoutAcceptance.value).toMatchObject({ kind: 'confirmation_required', level: 'high_risk' });
    const second = await bridge.confirmSend(preview.id, { stepUp: true, acceptedRisk: true });
    expect(second.ok && second.value.kind).toBe('confirmed');
  });

  it('Critical without a regulatory reason is still only a warning, not a refusal', async () => {
    const bridge = await loggedInWithWallet();
    const { preview, outcome } = await send(bridge, { to: DEMO_ADDRESSES.mixerExposed, asset: USDC, amount: usdc(1_500n) });

    expect(preview.assessment.assessment).toMatchObject({ band: 'Critical', score: 85 });
    expect(outcome.ok && outcome.value).toMatchObject({ kind: 'confirmation_required', level: 'high_risk' });
  });

  it('Sanctions: refused for a regulatory reason, without disclosing it, even after a second confirmation', async () => {
    const bridge = await loggedInWithWallet();
    const { preview, outcome } = await send(bridge, { to: DEMO_ADDRESSES.sanctioned, asset: USDC, amount: usdc(10n) });

    expect(outcome.ok && outcome.value).toEqual({ kind: 'refused', reason: 'regulatory' });
    const wallet = await bridge.getWallet();
    const usdcBalance = wallet.ok ? wallet.value.balances.find((b) => b.asset === USDC)?.amount : undefined;
    expect(usdcBalance).toBe(usdc(5_000n));
    expect(preview.assessment.assessment.reasons.map((r) => r.code)).toContain('SANCTIONED');
  });
});

describe('FakeBridge validation', () => {
  it('rejects a malformed address', async () => {
    const bridge = await loggedInWithWallet();
    const result = await bridge.previewSend({ to: '0x123', asset: USDC, amount: usdc(1n) });
    expect(!result.ok && result.error.code).toBe('UI_INVALID_ADDRESS');
  });

  it('rejects an amount above the balance', async () => {
    const bridge = await loggedInWithWallet();
    const result = await bridge.previewSend({ to: NEW_RECIPIENT, asset: USDC, amount: usdc(10_000n) });
    expect(!result.ok && result.error.code).toBe('SQ_CHAIN_INSUFFICIENT_BALANCE');
  });

  it('cancels a preview so it can no longer be confirmed', async () => {
    const bridge = await loggedInWithWallet();
    const preview = await bridge.previewSend({ to: DEMO_ADDRESSES.knownMerchant, asset: USDC, amount: usdc(1n) });
    if (!preview.ok) throw new Error('expected preview');

    expect(await bridge.cancelSend(preview.value.id)).toEqual({ ok: true, value: undefined });
    const after = await bridge.confirmSend(preview.value.id, { stepUp: false, acceptedRisk: false });
    expect(!after.ok && after.error.code).toBe('SQ_NOT_FOUND');
  });

  it('cannot confirm the same preview twice', async () => {
    const bridge = await loggedInWithWallet();
    const preview = await bridge.previewSend({ to: DEMO_ADDRESSES.knownMerchant, asset: USDC, amount: usdc(1n) });
    if (!preview.ok) throw new Error('expected preview');

    await bridge.confirmSend(preview.value.id, { stepUp: false, acceptedRisk: false });
    const again = await bridge.confirmSend(preview.value.id, { stepUp: false, acceptedRisk: false });
    expect(!again.ok && again.error.code).toBe('SQ_NOT_FOUND');
  });
});
