import type { AccountView } from '@sqw/types/AccountView';
import type { AssessResponse } from '@sqw/types/AssessResponse';
import type { CosignOutcome } from '@sqw/types/CosignOutcome';
import type { CosignRequest } from '@sqw/types/CosignRequest';
import type { Session } from '@sqw/types/Session';
import type { SignedEntry } from '@sqw/types/SignedEntry';
import { err, ok, sdkError, type SwissquoteApi } from '@sqw/sdk';
import { describe, expect, it, vi } from 'vitest';
import { USDC, signedEntry } from '../ui/services/fake-world';
import { LocalAuditLog } from './bridge-state';
import { DevPasskeySigner } from './passkey';
import { MemoryStore } from './storage';
import { SwissquoteBridge } from './SwissquoteBridge';

// The real bridge against a scripted API: a recorded /assess → /cosign → /chain/submit sequence,
// with hooks to inject the failures the review found.

const ADDRESS = '0x5a11e7000000000000000000000000000000a11c';
const RECIPIENT = `0x${'12'.repeat(20)}`;
const USER_OP = `0x${'ab'.repeat(32)}`;
const OWNER = { kind: 'ed25519', key: '0x01' } as const;
const SIG = { kind: 'ed25519', signature: '0xsig' } as const;

const account: AccountView = {
  address: ADDRESS,
  owner: OWNER,
  cosigner: 'cc',
  nonce: 0,
  balances: [{ asset: USDC, symbol: 'USDC', decimals: 6, amount: '0x12a05f200' }],
  escape: { state: 'inactive' },
  created_block: 1,
  flags: [],
};

const entry = (seq: number, outcome: SignedEntry['entry']['outcome']): SignedEntry =>
  signedEntry({
    seq,
    prevHead: `0x${'0'.repeat(64)}`,
    userOpHash: USER_OP,
    action: { kind: 'erc20_transfer', token: USDC, to: RECIPIENT, amount: '0x1' },
    assessment: { score: 0, band: 'Low', reasons: [] },
    outcome,
    stepUp: false,
    riskAccepted: false,
  });

const assessed: AssessResponse = {
  intent_id: 'intent-1',
  action: { kind: 'erc20_transfer', token: USDC, to: RECIPIENT, amount: '0x1' },
  assessment: { score: 0, band: 'Low', reasons: [] },
  signals: { sanctions_hit: false, exposure_hops: null, simulation: [] },
  prepared: { user_op_hash: USER_OP, nonce: 0, action: { kind: 'erc20_transfer', token: USDC, to: RECIPIENT, amount: '0x1' } },
  next_seq: 0,
  head: `0x${'0'.repeat(64)}`,
};

function scriptedApi(overrides: Partial<SwissquoteApi> = {}): SwissquoteApi {
  const session: Session = { token: 'secret-token', client_id: 'SQ-100001', display_name: 'Alice' };
  return {
    login: vi.fn(async () => ok(session)),
    chainInfo: vi.fn(async () =>
      ok({ chain_id: 84532, latest_block: 0, cosigner: 'cc', escape_delay_secs: 120, tokens: [{ address: USDC, symbol: 'USDC', decimals: 6 }] } as never),
    ),
    challenge: vi.fn(async () => ok({ challenge: '0xch', expires_at: 0 })),
    register: vi.fn(async () => ok({ address: ADDRESS, account, accounts: [account] })),
    overview: vi.fn(async () => ok({ owner: OWNER, accounts: [account] })),
    faucet: vi.fn(async () => ok({ tx_hash: '0xf', block_number: 1, kind: 'faucet' as const })),
    assess: vi.fn(async () => ok(assessed)),
    cosign: vi.fn(async () => ok<CosignOutcome>({ kind: 'cosigned', entry: entry(0, 'cosigned'), cosignature: '0xcosig' })),
    cancelIntent: vi.fn(async () => ok({ intent: {} as never, outcome: 'cancelled' as const })),
    submit: vi.fn(async () => ok({ tx_hash: '0xtx', block_number: 2, kind: 'cosigned' as const })),
    log: vi.fn(async () => ok({ address: ADDRESS, head: `0x${'7'.repeat(64)}`, next_seq: 7, entries: [] })),
    history: vi.fn(async () => ok({ address: ADDRESS, txs: [] })),
    sync: vi.fn(async () =>
      ok({ network: { family: 'solana', name: 'solana-devnet', chain_id: null }, fetched: 0, recorded: 0, skipped_existing: 0, next_cursor: null } as never),
    ),
    settings: vi.fn(async () => err(sdkError('NOT_FOUND', 'swissquote', 'n/a', 404))),
    settingsHash: vi.fn(async () => ok({ hash: '0xh', nonce: 0 })),
    setSettings: vi.fn(async () => err(sdkError('NOT_FOUND', 'swissquote', 'n/a', 404))),
    startRecovery: vi.fn(async () => err(sdkError('NOT_FOUND', 'swissquote', 'n/a', 404))),
    recovery: vi.fn(async () => err(sdkError('NOT_FOUND', 'swissquote', 'n/a', 404))),
    cancelRecovery: vi.fn(async () => err(sdkError('NOT_FOUND', 'swissquote', 'n/a', 404))),
    executeRecovery: vi.fn(async () => err(sdkError('NOT_FOUND', 'swissquote', 'n/a', 404))),
    devPasskey: vi.fn(async () => ok({ name: 'p', owner: OWNER, address: ADDRESS })),
    devSign: vi.fn(async () => ok(SIG)),
    ...overrides,
  };
}

async function readyBridge(api: SwissquoteApi): Promise<SwissquoteBridge> {
  const bridge = new SwissquoteBridge({
    api,
    passkey: new DevPasskeySigner(api),
    store: new MemoryStore(),
    auditLog: new LocalAuditLog(new MemoryStore()),
    onSession: () => undefined,
  });
  await bridge.login({ username: 'alice', password: 'demo' });
  await bridge.createWallet();
  return bridge;
}

const draft = { to: RECIPIENT, asset: USDC, amount: '0x1' } as const;
const NO_STEP_UP = { stepUp: false, acceptedRisk: false } as const;

describe('SwissquoteBridge', () => {
  it('never hands the bearer token to the UI', async () => {
    const bridge = await readyBridge(scriptedApi());
    const session = await bridge.login({ username: 'alice', password: 'demo' });
    expect(session).toEqual({ ok: true, value: { client_id: 'SQ-100001', display_name: 'Alice' } });
    expect(JSON.stringify(session)).not.toContain('secret-token');
  });

  it('co-signs at the audit-log position read just before, not the one from the preview', async () => {
    const api = scriptedApi();
    const bridge = await readyBridge(api);
    const preview = await bridge.previewSend(draft);
    if (!preview.ok) throw new Error('preview');

    await bridge.confirmSend(preview.value.id, NO_STEP_UP);

    const request = vi.mocked(api.cosign).mock.calls[0]?.[0] as CosignRequest | undefined;
    expect(request).toMatchObject({ seq: 7, prev_head: `0x${'7'.repeat(64)}` });
  });

  it('after a failed submit, a retry resubmits without co-signing again', async () => {
    const submit = vi
      .fn<SwissquoteApi['submit']>()
      .mockResolvedValueOnce(err(sdkError('UNREACHABLE', 'network', 'down')))
      .mockResolvedValueOnce(ok({ tx_hash: '0xtx', block_number: 2, kind: 'cosigned' }));
    const api = scriptedApi({ submit });
    const bridge = await readyBridge(api);
    const preview = await bridge.previewSend(draft);
    if (!preview.ok) throw new Error('preview');

    const first = await bridge.confirmSend(preview.value.id, NO_STEP_UP);
    expect(!first.ok && first.error).toEqual({ code: 'CHAIN_UNAVAILABLE', retryable: true });
    const retry = await bridge.confirmSend(preview.value.id, NO_STEP_UP);

    expect(retry.ok && retry.value.kind).toBe('confirmed');
    expect(api.cosign).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it('a rejected step-up signature is a signing error, not a logout', async () => {
    const cosign = vi
      .fn<SwissquoteApi['cosign']>()
      .mockResolvedValueOnce(
        ok({ kind: 'step_up', entry: entry(0, 'step_up'), step_up_hash: '0xstep', level: 'standard' }),
      )
      .mockResolvedValueOnce(err(sdkError('UNAUTHORIZED', 'swissquote', 'bad step-up', 401)));
    const bridge = await readyBridge(scriptedApi({ cosign }));
    const preview = await bridge.previewSend(draft);
    if (!preview.ok) throw new Error('preview');
    await bridge.confirmSend(preview.value.id, NO_STEP_UP);

    const second = await bridge.confirmSend(preview.value.id, { stepUp: true, acceptedRisk: false });

    expect(!second.ok && second.error.code).toBe('SQ_CHAIN_BAD_OWNER_SIGNATURE');
    expect((await bridge.getWallet()).ok).toBe(true);
  });

  it('an expired token does log out', async () => {
    const overview = vi
      .fn<SwissquoteApi['overview']>()
      .mockResolvedValueOnce(ok({ owner: OWNER, accounts: [account] }))
      .mockResolvedValueOnce(err(sdkError('UNAUTHORIZED', 'swissquote', 'expired', 401)));
    const bridge = await readyBridge(scriptedApi({ overview }));

    expect((await bridge.getWallet()).ok).toBe(false);
    expect(await bridge.getWallet()).toEqual({ ok: false, error: { code: 'SQ_UNAUTHORIZED', retryable: false } });
  });

  it('a double click confirms once', async () => {
    const api = scriptedApi();
    const bridge = await readyBridge(api);
    const preview = await bridge.previewSend(draft);
    if (!preview.ok) throw new Error('preview');

    const [a, b] = await Promise.all([
      bridge.confirmSend(preview.value.id, NO_STEP_UP),
      bridge.confirmSend(preview.value.id, NO_STEP_UP),
    ]);

    expect(a.ok && a.value.kind).toBe('confirmed');
    expect(!b.ok && b.error.code).toBe('SQ_NOT_FOUND');
    expect(api.cosign).toHaveBeenCalledTimes(1);
  });

  it('refuses out-of-range settings before asking for a signature', async () => {
    const api = scriptedApi({ settings: vi.fn(async () => ok({ address: ADDRESS, settings: {} as never, tx: null })) });
    const bridge = await readyBridge(api);
    const result = await bridge.saveSettings({
      version: 1,
      per_tx_limit_pct: 0,
      daily_limit: 0,
      step_up_above_pct: 10_000,
      intent_timeout_secs: 600,
      hold_timeout_secs: 0,
      allowlist: [],
      extra: {},
    });
    expect(!result.ok && result.error.code).toBe('UI_INVALID_SETTINGS');
    expect(api.settingsHash).not.toHaveBeenCalled();
  });
});
