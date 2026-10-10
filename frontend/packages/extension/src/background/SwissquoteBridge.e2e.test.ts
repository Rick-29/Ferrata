// @vitest-environment node
import type { Session } from '@sqw/types/Session';
import { HttpSwissquoteApi } from '@sqw/sdk';
import { beforeAll, describe, expect, it } from 'vitest';
import type { UiBridge } from '../ui/services/UiBridge';
import { LocalAuditLog } from './bridge-state';
import { DevPasskeySigner } from './passkey';
import { MemoryStore } from './storage';
import { SwissquoteBridge } from './SwissquoteBridge';

// Runs the real UiBridge against a running backend (`cargo run -p sq-services`), i.e. the exact
// code path the extension uses, minus chrome.runtime. Opt-in: `npm run test:e2e` (backend running).

const API_URL = process.env['SQW_API_URL'] ?? 'http://localhost:8787';
const USDC = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const NEW_RECIPIENT = `0x${'12'.repeat(20)}`;
const SANCTIONED = '0x000000000000000000000000000000000000dead';
const MIXER = '0x0000000000000000000000000000000000c0ffee';
const RUN_ID = Date.now().toString(36);
const usdc = (whole: bigint): string => `0x${(whole * 10n ** 6n).toString(16)}`;

function realBridge(): { bridge: UiBridge; log: LocalAuditLog } {
  let token: string | null = null;
  const api = new HttpSwissquoteApi({ baseUrl: API_URL, token: () => token });
  const log = new LocalAuditLog(new MemoryStore());
  const bridge = new SwissquoteBridge({
    api,
    passkey: new DevPasskeySigner(api),
    store: new MemoryStore(),
    auditLog: log,
    onSession: (s: Session | null) => {
      token = s?.token ?? null;
    },
    // A fresh account per run: earlier runs make recipients "known" and change the risk scores.
    passkeyNameFor: (clientId) => `e2e-${clientId}-${RUN_ID}`,
  });
  return { bridge, log };
}

const E2E = process.env['SQW_E2E'] === '1' || import.meta.env.MODE === 'e2e';

describe.skipIf(!E2E)('SwissquoteBridge against the real backend', () => {
  let bridge: UiBridge;
  let log: LocalAuditLog;
  let address = '';

  beforeAll(async () => {
    ({ bridge, log } = realBridge());
    const session = await bridge.login({ username: 'alice', password: 'demo' });
    expect(session.ok).toBe(true);
    const wallet = await bridge.createWallet();
    if (!wallet.ok) throw new Error(`createWallet: ${wallet.error.code}`);
    address = wallet.value.address;
    expect(wallet.value.balances.some((b) => BigInt(b.amount) > 0n)).toBe(true);
  });

  it('Low or Medium: co-signs and submits on the Ferra chain', async () => {
    const preview = await bridge.previewSend({ to: NEW_RECIPIENT, asset: USDC, amount: usdc(5n) });
    if (!preview.ok) throw new Error(`preview: ${preview.error.code}`);
    let outcome = await bridge.confirmSend(preview.value.id, { stepUp: false, acceptedRisk: false });
    if (outcome.ok && outcome.value.kind === 'confirmation_required') {
      outcome = await bridge.confirmSend(preview.value.id, { stepUp: true, acceptedRisk: false });
    }
    expect(outcome.ok && outcome.value.kind).toBe('confirmed');
  });

  it('High: asks for a high-risk confirmation, refuses to go through without acceptance, then goes through', async () => {
    const preview = await bridge.previewSend({ to: MIXER, asset: USDC, amount: usdc(10n) });
    if (!preview.ok) throw new Error(`preview: ${preview.error.code}`);
    const first = await bridge.confirmSend(preview.value.id, { stepUp: false, acceptedRisk: false });
    expect(first.ok && first.value).toMatchObject({ kind: 'confirmation_required', level: 'high_risk' });

    const notAccepted = await bridge.confirmSend(preview.value.id, { stepUp: true, acceptedRisk: false });
    expect(notAccepted.ok && notAccepted.value).toMatchObject({ kind: 'confirmation_required', level: 'high_risk' });

    const accepted = await bridge.confirmSend(preview.value.id, { stepUp: true, acceptedRisk: true });
    expect(accepted.ok && accepted.value.kind).toBe('confirmed');
  });

  it('Sanctions: regulatory refusal', async () => {
    const preview = await bridge.previewSend({ to: SANCTIONED, asset: USDC, amount: usdc(1n) });
    if (!preview.ok) throw new Error(`preview: ${preview.error.code}`);
    const outcome = await bridge.confirmSend(preview.value.id, { stepUp: false, acceptedRisk: false });
    expect(outcome.ok && outcome.value).toEqual({ kind: 'refused', reason: 'regulatory' });
  });

  it('Cancel: records the cancelled intent', async () => {
    const preview = await bridge.previewSend({ to: NEW_RECIPIENT, asset: USDC, amount: usdc(1n) });
    if (!preview.ok) throw new Error(`preview: ${preview.error.code}`);
    expect((await bridge.cancelSend(preview.value.id)).ok).toBe(true);
  });

  it('Activity: shows the co-signed sends with receipts, and the local log kept every entry', async () => {
    const activity = await bridge.getActivity();
    if (!activity.ok) throw new Error(`activity: ${activity.error.code}`);
    const cosigned = activity.value.txs.filter((t) => t.kind === 'cosigned');
    expect(cosigned.length).toBeGreaterThanOrEqual(2);
    expect(cosigned.every((t) => activity.value.receiptHashes.includes(t.user_op_hash))).toBe(true);
    expect((await log.entries(address)).length).toBeGreaterThanOrEqual(4);
  });

  it('Settings: owner-signed change is recorded on-chain', async () => {
    const current = await bridge.getSettings();
    if (!current.ok) throw new Error(`settings: ${current.error.code}`);
    const saved = await bridge.saveSettings({ ...current.value, step_up_above_pct: 30 });
    expect(saved.ok && saved.value.step_up_above_pct).toBe(30);
    const reread = await bridge.getSettings();
    expect(reread.ok && reread.value.step_up_above_pct).toBe(30);
  });
});
