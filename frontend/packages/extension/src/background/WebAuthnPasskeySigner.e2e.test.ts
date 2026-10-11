// @vitest-environment node
import type { Session } from '@sqw/types/Session';
import { HttpSwissquoteApi } from '@sqw/sdk';
import { describe, expect, it } from 'vitest';
import { SoftwareAuthenticator } from '../passkey/software-authenticator';
import { LocalAuditLog } from './bridge-state';
import { MemoryStore } from './storage';
import { SwissquoteBridge } from './SwissquoteBridge';
import { WebAuthnPasskeySigner } from './WebAuthnPasskeySigner';

// The real WebAuthn signing path (signer → page protocol → browser byte formats) against the
// running backend, with a software authenticator in place of the fingerprint reader.
// Opt-in like the other e2e: `npm run test:e2e` (backend running).

const API_URL = process.env['SQW_API_URL'] ?? 'http://localhost:8787';
const E2E = process.env['SQW_E2E'] === '1' || import.meta.env.MODE === 'e2e';
const NEW_RECIPIENT = `0x${'34'.repeat(20)}`;
const MIXER = '0x0000000000000000000000000000000000c0ffee';
const usdc = (whole: bigint): string => `0x${(whole * 10n ** 6n).toString(16)}`;

describe.skipIf(!E2E)('WebAuthn passkeys against the real backend', () => {
  it('creates a P-256 passkey wallet, sends, confirms a high risk and saves settings, all signed with WebAuthn', async () => {
    let token: string | null = null;
    const api = new HttpSwissquoteApi({ baseUrl: API_URL, token: () => token });
    const authenticator = new SoftwareAuthenticator();
    const bridge = new SwissquoteBridge({
      api,
      passkey: new WebAuthnPasskeySigner((request) => authenticator.answer(request), new MemoryStore()),
      store: new MemoryStore(),
      auditLog: new LocalAuditLog(new MemoryStore()),
      onSession: (s: Session | null) => {
        token = s?.token ?? null;
      },
      passkeyNameFor: (clientId) => `webauthn-e2e-${clientId}-${Date.now().toString(36)}`,
    });

    expect((await bridge.login({ username: 'alice', password: 'demo' })).ok).toBe(true);
    const wallet = await bridge.createWallet(); // registration: WebAuthn signature over the ownership challenge
    if (!wallet.ok) throw new Error(`createWallet: ${wallet.error.code}`);
    expect(wallet.value.owner.kind).toBe('p256');

    const usdcAsset = wallet.value.balances.find((b) => b.symbol === 'USDC')?.asset ?? null;
    const low = await bridge.previewSend({ to: NEW_RECIPIENT, asset: usdcAsset, amount: usdc(3n) });
    if (!low.ok) throw new Error(`preview: ${low.error.code}`);
    let sent = await bridge.confirmSend(low.value.id, { stepUp: false, acceptedRisk: false });
    if (sent.ok && sent.value.kind === 'confirmation_required') {
      sent = await bridge.confirmSend(low.value.id, { stepUp: true, acceptedRisk: false });
    }
    expect(sent.ok && sent.value.kind).toBe('confirmed'); // submit: WebAuthn signature over user_op_hash

    const high = await bridge.previewSend({ to: MIXER, asset: usdcAsset, amount: usdc(2n) });
    if (!high.ok) throw new Error(`preview: ${high.error.code}`);
    await bridge.confirmSend(high.value.id, { stepUp: false, acceptedRisk: false });
    const accepted = await bridge.confirmSend(high.value.id, { stepUp: true, acceptedRisk: true }); // step-up: WebAuthn
    expect(accepted.ok && accepted.value.kind).toBe('confirmed');

    const settings = await bridge.getSettings();
    if (!settings.ok) throw new Error(`settings: ${settings.error.code}`);
    const saved = await bridge.saveSettings({ ...settings.value, per_tx_limit_pct: 40 }); // settings: WebAuthn
    expect(saved.ok && saved.value.per_tx_limit_pct).toBe(40);
  }, 60_000);
});
