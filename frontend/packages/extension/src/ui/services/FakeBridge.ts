import type { AccountView } from '@sqw/types/AccountView';
import type { LoginRequest } from '@sqw/types/LoginRequest';
import type { Session } from '@sqw/types/Session';
import { uiError, type UiError } from '../core/errors';
import { isAddress } from '../core/format';
import { err, ok, type Result } from '../core/result';
import {
  DEMO_CLIENTS,
  DEMO_PASSWORD,
  GENESIS_HEAD,
  actionFor,
  decide,
  fakeHash,
  loggedOutcome,
  newDemoAccount,
  scoreDraft,
  signedEntry,
  toHex,
} from './fake-world';
import type { SendDraft, SendOutcome, SendPreview, UiBridge } from './UiBridge';

export interface FakeBridgeOptions {
  /** Simulated network latency, so loading states are visible. 0 in tests. */
  readonly delayMs?: number;
}

const DEFAULT_DELAY_MS = 450;
const UNAUTHORIZED = uiError('SQ_UNAUTHORIZED');

/**
 * In-memory stand-in for P3's SDK, driven by the same demo world as fixtures/.
 * Mock: swapped for the real bridge in main.ts once P3's background worker exists.
 */
export class FakeBridge implements UiBridge {
  readonly #delayMs: number;
  #session: Session | null = null;
  #account: AccountView | null = null;
  #previews: ReadonlyMap<string, SendPreview> = new Map();
  #head = GENESIS_HEAD;
  #nextSeq = 0;
  #counter = 0;

  constructor(options: FakeBridgeOptions = {}) {
    this.#delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
  }

  async login(credentials: LoginRequest): Promise<Result<Session, UiError>> {
    await this.#latency();
    const client = DEMO_CLIENTS[credentials.username];
    if (!client || credentials.password !== DEMO_PASSWORD) return err(UNAUTHORIZED);
    this.#session = {
      token: `fake-${credentials.username}-${this.#nextId()}`,
      client_id: client.clientId,
      display_name: client.displayName,
    };
    return ok(this.#session);
  }

  async createWallet(): Promise<Result<AccountView, UiError>> {
    await this.#latency();
    if (!this.#session) return err(UNAUTHORIZED);
    this.#account = this.#account ?? newDemoAccount(fakeHash(this.#nextId()));
    return ok(this.#account);
  }

  async getWallet(): Promise<Result<AccountView, UiError>> {
    await this.#latency();
    if (!this.#session) return err(UNAUTHORIZED);
    return this.#account ? ok(this.#account) : err(uiError('SQ_NOT_FOUND'));
  }

  async previewSend(draft: SendDraft): Promise<Result<SendPreview, UiError>> {
    await this.#latency();
    const account = this.#account;
    if (!this.#session || !account) return err(UNAUTHORIZED);
    if (!isAddress(draft.to)) return err(uiError('UI_INVALID_ADDRESS'));

    const amount = parseAmount(draft.amount);
    if (amount === null || amount <= 0n) return err(uiError('UI_INVALID_AMOUNT'));

    const balance = account.balances.find((b) => b.asset === draft.asset);
    if (!balance) return err(uiError('SQ_BAD_REQUEST'));
    const before = BigInt(balance.amount);
    if (amount > before) return err(uiError('SQ_CHAIN_INSUFFICIENT_BALANCE'));

    const { assessment, sanctionsHit, exposureHops } = scoreDraft(draft);
    const action = actionFor(draft);
    const preview: SendPreview = {
      id: `preview-${this.#nextId()}`,
      draft,
      assessment: {
        action,
        assessment,
        signals: {
          sanctions_hit: sanctionsHit,
          exposure_hops: exposureHops,
          simulation: [
            { asset: balance.asset, symbol: balance.symbol, before: balance.amount, after: toHex(before - amount) },
          ],
        },
        prepared: { user_op_hash: fakeHash(this.#nextId()), nonce: account.nonce, action },
        next_seq: this.#nextSeq,
        head: this.#head,
      },
    };
    this.#previews = new Map([...this.#previews, [preview.id, preview]]);
    return ok(preview);
  }

  async confirmSend(previewId: string, options: { readonly stepUp: boolean }): Promise<Result<SendOutcome, UiError>> {
    await this.#latency();
    if (!this.#session || !this.#account) return err(UNAUTHORIZED);
    const preview = this.#previews.get(previewId);
    const prepared = preview?.assessment.prepared;
    if (!preview || !prepared) return err(uiError('SQ_NOT_FOUND'));

    const { assessment, action } = preview.assessment;
    const decision = decide(assessment, options.stepUp);
    if (decision.kind === 'confirm') return ok({ kind: 'confirmation_required', previewId, level: decision.level });

    const entry = signedEntry({
      seq: this.#nextSeq,
      prevHead: this.#head,
      userOpHash: prepared.user_op_hash,
      action,
      assessment,
      outcome: loggedOutcome(decision),
      stepUp: options.stepUp,
    });
    // Every final outcome is logged, so the hash chain advances and the preview is spent.
    this.#head = entry.entry_hash;
    this.#nextSeq += 1;
    this.#previews = new Map([...this.#previews].filter(([id]) => id !== previewId));

    if (decision.kind === 'refuse_regulatory') return ok({ kind: 'refused', reason: 'regulatory' });
    this.#applyTransfer(preview.draft);
    return ok({ kind: 'confirmed', txHash: fakeHash(this.#nextId()), receipt: entry.receipt });
  }

  #applyTransfer(draft: SendDraft): void {
    const account = this.#account;
    if (!account) return;
    this.#account = {
      ...account,
      nonce: account.nonce + 1,
      balances: account.balances.map((b) =>
        b.asset === draft.asset ? { ...b, amount: toHex(BigInt(b.amount) - BigInt(draft.amount)) } : b,
      ),
    };
  }

  #nextId(): number {
    this.#counter += 1;
    return this.#counter;
  }

  #latency(): Promise<void> {
    return this.#delayMs > 0 ? new Promise((resolve) => setTimeout(resolve, this.#delayMs)) : Promise.resolve();
  }
}

function parseAmount(value: string): bigint | null {
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}
