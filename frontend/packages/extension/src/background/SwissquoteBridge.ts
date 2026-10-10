import type { AccountView } from '@sqw/types/AccountView';
import type { CosignOutcome } from '@sqw/types/CosignOutcome';
import type { LoginRequest } from '@sqw/types/LoginRequest';
import type { OwnerSignature } from '@sqw/types/OwnerSignature';
import type { Session } from '@sqw/types/Session';
import type { TxRequest } from '@sqw/types/TxRequest';
import type { WalletSettings } from '@sqw/types/WalletSettings';
import { encodeErc20Transfer, type Result, type SdkError, type SwissquoteApi } from '@sqw/sdk';
import { uiError, type UiError } from '../ui/core/errors';
import { isAddress } from '../ui/core/format';
import { err, ok } from '../ui/core/result';
import { isValidSettings } from '../ui/core/settings';
import type {
  ActivityFeed,
  ConfirmOptions,
  SendDraft,
  SendOutcome,
  SendPreview,
  SessionView,
  UiBridge,
} from '../ui/services/UiBridge';
import { toUiError } from './bridge-errors';
import {
  EMPTY_STATE,
  loadState,
  saveState,
  type BridgeState,
  type LocalAuditLog,
  type PendingSend,
  type WalletRef,
} from './bridge-state';
import type { PasskeySigner } from './passkey';
import type { KeyValueStore } from './storage';

type UiResult<T> = Promise<Result<T, UiError>>;

/** Demo funding for a brand-new Ferra account (mock faucet, labelled demo): 1 ETH and 5 000 USDC. */
const DEMO_FUNDING = { native: '0xde0b6b3a7640000', usdcWhole: 5_000n } as const;

const UNAUTHORIZED = uiError('SQ_UNAUTHORIZED');
const NO_WALLET = uiError('SQ_NOT_FOUND');
/** The backend answers 401 both for an expired token and for a step-up signature that does not verify. */
const BAD_STEP_UP = uiError('SQ_CHAIN_BAD_OWNER_SIGNATURE');

export interface SwissquoteBridgeDeps {
  readonly api: SwissquoteApi;
  readonly passkey: PasskeySigner;
  /** Session-scoped state (token, wallet, pending sends). */
  readonly store: KeyValueStore;
  readonly auditLog: LocalAuditLog;
  /** Lets the HTTP client read the token this bridge holds. */
  readonly onSession: (session: Session | null) => void;
  /** Which passkey owns the client's wallet. Default: one per Swissquote client. */
  readonly passkeyNameFor?: (clientId: string) => string;
}

const defaultPasskeyName = (clientId: string): string => `passkey-${clientId}`;

interface FailOptions {
  /** A 401 here means "bad signature", not "session expired": keep the session. */
  readonly stepUpSent?: boolean;
}

/**
 * The real `UiBridge`, run in the background service worker (frontend_tasks §2, §4) against the
 * Ferra chain. Holds the session token; the UI only ever gets a `SessionView`.
 *
 * Calls run one at a time (`#serial`): every call reads and writes the same persisted state, and
 * the audit log only accepts one entry at each position.
 */
export class SwissquoteBridge implements UiBridge {
  readonly #deps: SwissquoteBridgeDeps;
  #state: BridgeState | null = null;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(deps: SwissquoteBridgeDeps) {
    this.#deps = deps;
  }

  /** Restores the session from storage right away, so the HTTP client has the token after a worker restart. */
  async init(): Promise<void> {
    await this.#serial(() => this.#load());
  }

  login(credentials: LoginRequest): UiResult<SessionView> {
    return this.#serial(() => this.#login(credentials));
  }

  createWallet(): UiResult<AccountView> {
    return this.#serial(() => this.#createWallet());
  }

  getWallet(): UiResult<AccountView> {
    return this.#serial(() => this.#getWallet());
  }

  previewSend(draft: SendDraft): UiResult<SendPreview> {
    return this.#serial(() => this.#previewSend(draft));
  }

  confirmSend(previewId: string, options: ConfirmOptions): UiResult<SendOutcome> {
    return this.#serial(() => this.#confirmSend(previewId, options));
  }

  cancelSend(previewId: string): UiResult<void> {
    return this.#serial(() => this.#cancelSend(previewId));
  }

  getActivity(): UiResult<ActivityFeed> {
    return this.#serial(() => this.#getActivity());
  }

  getSettings(): UiResult<WalletSettings> {
    return this.#serial(() => this.#getSettings());
  }

  saveSettings(settings: WalletSettings): UiResult<WalletSettings> {
    return this.#serial(() => this.#saveSettings(settings));
  }

  async #login(credentials: LoginRequest): UiResult<SessionView> {
    const result = await this.#deps.api.login(credentials);
    if (!result.ok) return this.#fail(result.error);
    const previous = await this.#load();
    const sameClient = previous.session?.client_id === result.value.client_id;
    await this.#update({ session: result.value, wallet: sameClient ? previous.wallet : null, pending: {} });
    return ok({ client_id: result.value.client_id, display_name: result.value.display_name });
  }

  async #createWallet(): UiResult<AccountView> {
    const state = await this.#load();
    if (!state.session) return err(UNAUTHORIZED);
    const { api, passkey } = this.#deps;

    const passkeyName = (this.#deps.passkeyNameFor ?? defaultPasskeyName)(state.session.client_id);
    const owner = await passkey.create(passkeyName);
    if (!owner.ok) return this.#fail(owner.error);
    const info = await api.chainInfo();
    if (!info.ok) return this.#fail(info.error);

    // Same passkey, same account: if it is already registered, pick it up instead of registering again.
    const existing = await api.overview(owner.value);
    if (!existing.ok) return this.#fail(existing.error);
    let account = existing.value.accounts[0];
    if (!account) {
      const registered = await this.#register(passkeyName, owner.value);
      if (!registered.ok) return registered;
      account = registered.value;
    }

    const wallet: WalletRef = {
      passkeyName,
      owner: owner.value,
      address: account.address,
      chainId: info.value.chain_id,
      tokens: info.value.tokens,
    };
    await this.#patch((s) => ({ ...s, wallet }));
    if (account.balances.every((b) => BigInt(b.amount) === 0n)) {
      const funded = await this.#fundForDemo(wallet);
      if (!funded.ok) return funded;
      return this.#getWallet();
    }
    return ok(account);
  }

  async #getWallet(): UiResult<AccountView> {
    const { session, wallet } = await this.#load();
    if (!session) return err(UNAUTHORIZED);
    if (!wallet) return err(NO_WALLET);
    const result = await this.#deps.api.overview(wallet.owner);
    if (!result.ok) return this.#fail(result.error);
    const account = result.value.accounts.find((a) => sameAddress(a.address, wallet.address));
    return account ? ok(account) : err(NO_WALLET);
  }

  async #previewSend(draft: SendDraft): UiResult<SendPreview> {
    if (!isAddress(draft.to)) return err(uiError('UI_INVALID_ADDRESS'));
    const amount = parseUnits(draft.amount);
    if (amount === null || amount <= 0n) return err(uiError('UI_INVALID_AMOUNT'));

    const account = await this.#getWallet();
    if (!account.ok) return account;
    const balance = account.value.balances.find((b) => b.asset === draft.asset);
    if (!balance) return err(uiError('SQ_BAD_REQUEST'));
    if (amount > BigInt(balance.amount)) return err(uiError('SQ_CHAIN_INSUFFICIENT_BALANCE'));

    const { wallet } = await this.#load();
    if (!wallet) return err(NO_WALLET);
    const tx = buildTx(wallet, draft, amount);
    const assessed = await this.#deps.api.assess({ tx, account: null });
    if (!assessed.ok) return this.#fail(assessed.error);
    const { prepared } = assessed.value;
    if (!prepared) return err(NO_WALLET);

    const id = assessed.value.intent_id ?? `local-${prepared.user_op_hash}`;
    const pending: PendingSend = {
      id,
      draft,
      tx,
      intentId: assessed.value.intent_id,
      userOpHash: prepared.user_op_hash,
      nonce: prepared.nonce,
      stepUpHash: null,
      cosignature: null,
      receipt: null,
      assessment: assessed.value,
    };
    // One send at a time: a new preview replaces any older one, so nothing stale lingers.
    await this.#patch((s) => ({ ...s, pending: { [id]: pending } }));
    return ok({ id, draft, assessment: assessed.value });
  }

  async #confirmSend(previewId: string, options: ConfirmOptions): UiResult<SendOutcome> {
    const { session, wallet, pending: all } = await this.#load();
    if (!session || !wallet) return err(UNAUTHORIZED);
    const pending = all[previewId];
    if (!pending) return err(uiError('SQ_NOT_FOUND'));

    // Already co-signed earlier (the submit failed): resume at submit, never co-sign twice.
    if (pending.cosignature && pending.receipt) return this.#submit(wallet, pending);

    let stepUp: OwnerSignature | null = null;
    if (options.stepUp) {
      if (!pending.stepUpHash) return err(uiError('SQ_BAD_REQUEST'));
      const signed = await this.#deps.passkey.sign(wallet.passkeyName, pending.stepUpHash);
      if (!signed.ok) return this.#fail(signed.error);
      stepUp = signed.value;
    }

    // Read the audit-log position now: anything logged since the preview has moved it.
    const position = await this.#deps.api.log(wallet.address);
    if (!position.ok) return this.#fail(position.error);

    const cosigned = await this.#deps.api.cosign({
      tx: pending.tx,
      user_op_hash: pending.userOpHash,
      seq: position.value.next_seq,
      prev_head: position.value.head,
      step_up: stepUp,
      accepted_risk: options.acceptedRisk,
      account: null,
    });
    if (!cosigned.ok) return this.#fail(cosigned.error, { stepUpSent: stepUp !== null });
    // Every outcome is a signed log entry: keep our copy.
    await this.#deps.auditLog.append(wallet.address, cosigned.value.entry);
    return this.#settle(wallet, pending, cosigned.value);
  }

  async #settle(wallet: WalletRef, pending: PendingSend, outcome: CosignOutcome): UiResult<SendOutcome> {
    switch (outcome.kind) {
      case 'step_up':
        await this.#savePending({ ...pending, stepUpHash: outcome.step_up_hash });
        return ok({ kind: 'confirmation_required', previewId: pending.id, level: outcome.level });
      case 'refused':
        await this.#dropPending(pending.id);
        return ok({ kind: 'refused', reason: 'regulatory' });
      case 'cosigned': {
        const cosigned: PendingSend = { ...pending, cosignature: outcome.cosignature, receipt: outcome.entry.receipt };
        // Persist before the next steps: if signing or submitting fails, a retry resumes here.
        await this.#savePending(cosigned);
        return this.#submit(wallet, cosigned);
      }
    }
  }

  async #submit(wallet: WalletRef, pending: PendingSend): UiResult<SendOutcome> {
    if (!pending.cosignature || !pending.receipt) return err(uiError('SQ_BAD_REQUEST'));
    const ownerSig = await this.#deps.passkey.sign(wallet.passkeyName, pending.userOpHash);
    if (!ownerSig.ok) return this.#fail(ownerSig.error);
    const submitted = await this.#deps.api.submit({
      tx: pending.tx,
      nonce: pending.nonce,
      owner_signature: ownerSig.value,
      cosignature: pending.cosignature,
    });
    if (!submitted.ok) return this.#fail(submitted.error);
    await this.#dropPending(pending.id);
    return ok({ kind: 'confirmed', txHash: submitted.value.tx_hash, receipt: pending.receipt });
  }

  async #cancelSend(previewId: string): UiResult<void> {
    const { wallet, pending: all } = await this.#load();
    const pending = all[previewId];
    if (!pending) return ok(undefined);
    await this.#dropPending(previewId);
    if (!pending.intentId || !wallet) return ok(undefined);
    const result = await this.#deps.api.cancelIntent(wallet.address, pending.intentId);
    return result.ok ? ok(undefined) : this.#fail(result.error);
  }

  async #getActivity(): UiResult<ActivityFeed> {
    const { session, wallet } = await this.#load();
    if (!session) return err(UNAUTHORIZED);
    if (!wallet) return err(NO_WALLET);
    const [history, log] = await Promise.all([this.#deps.api.history(wallet.address), this.#deps.api.log(wallet.address)]);
    if (!history.ok) return this.#fail(history.error);
    if (!log.ok) return this.#fail(log.error);
    return ok({
      address: wallet.address,
      txs: history.value.txs,
      receiptHashes: log.value.entries.map((e) => e.entry.user_op_hash),
      tokens: wallet.tokens,
    });
  }

  async #getSettings(): UiResult<WalletSettings> {
    const { session, wallet } = await this.#load();
    if (!session) return err(UNAUTHORIZED);
    if (!wallet) return err(NO_WALLET);
    const result = await this.#deps.api.settings(wallet.address);
    return result.ok ? ok(result.value.settings) : this.#fail(result.error);
  }

  async #saveSettings(settings: WalletSettings): UiResult<WalletSettings> {
    const { session, wallet } = await this.#load();
    if (!session) return err(UNAUTHORIZED);
    if (!wallet) return err(NO_WALLET);
    if (!isValidSettings(settings)) return err(uiError('UI_INVALID_SETTINGS'));
    const { api, passkey } = this.#deps;
    // The owner signs the settings bound to the account nonce; Swissquote only records them.
    const hash = await api.settingsHash(wallet.address, settings);
    if (!hash.ok) return this.#fail(hash.error);
    const signature = await passkey.sign(wallet.passkeyName, hash.value.hash);
    if (!signature.ok) return this.#fail(signature.error);
    const saved = await api.setSettings(wallet.address, { settings, signature: signature.value });
    return saved.ok ? ok(saved.value.settings) : this.#fail(saved.error);
  }

  async #register(passkeyName: string, owner: WalletRef['owner']): UiResult<AccountView> {
    const { api, passkey } = this.#deps;
    const challenge = await api.challenge();
    if (!challenge.ok) return this.#fail(challenge.error);
    const proof = await passkey.sign(passkeyName, challenge.value.challenge);
    if (!proof.ok) return this.#fail(proof.error);
    const registered = await api.register({ owner, challenge: challenge.value.challenge, signature: proof.value });
    return registered.ok ? ok(registered.value.account) : this.#fail(registered.error);
  }

  async #fundForDemo(wallet: WalletRef): UiResult<void> {
    const base = { chain_id: wallet.chainId, address: wallet.address };
    const usdc = wallet.tokens.find((t) => t.symbol === 'USDC');
    const requests = [
      { ...base, asset: null, amount: DEMO_FUNDING.native },
      ...(usdc ? [{ ...base, asset: usdc.address, amount: toHex(DEMO_FUNDING.usdcWhole * 10n ** BigInt(usdc.decimals)) }] : []),
    ];
    for (const request of requests) {
      const funded = await this.#deps.api.faucet(request);
      if (!funded.ok) return this.#fail(funded.error);
    }
    return ok(undefined);
  }

  /** Runs `task` after every earlier call has finished, whatever their outcome. */
  #serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task, task);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #load(): Promise<BridgeState> {
    if (!this.#state) {
      this.#state = await loadState(this.#deps.store);
      this.#deps.onSession(this.#state.session);
    }
    return this.#state;
  }

  async #update(next: BridgeState): Promise<void> {
    this.#state = next;
    this.#deps.onSession(next.session);
    await saveState(this.#deps.store, next);
  }

  /** Applies `change` to the current state, never to a snapshot taken before an await. */
  async #patch(change: (state: BridgeState) => BridgeState): Promise<void> {
    await this.#update(change(await this.#load()));
  }

  #savePending(pending: PendingSend): Promise<void> {
    return this.#patch((s) => ({ ...s, pending: { ...s.pending, [pending.id]: pending } }));
  }

  #dropPending(id: string): Promise<void> {
    return this.#patch((s) => ({ ...s, pending: without(s.pending, id) }));
  }

  /** An expired or unknown token (e.g. the backend restarted) drops the session so the UI logs in again. */
  async #fail<T>(error: SdkError, options: FailOptions = {}): UiResult<T> {
    const unauthorized = error.source === 'swissquote' && error.code === 'UNAUTHORIZED';
    if (unauthorized && options.stepUpSent) return err(BAD_STEP_UP);
    if (unauthorized) await this.#update(EMPTY_STATE);
    return err(toUiError(error));
  }
}

function buildTx(wallet: WalletRef, draft: SendDraft, amount: bigint): TxRequest {
  const base = { chain_id: wallet.chainId, from: wallet.address, origin: null };
  return draft.asset === null
    ? { ...base, to: draft.to, value: toHex(amount), data: '0x' }
    : { ...base, to: draft.asset, value: '0x0', data: encodeErc20Transfer(draft.to, amount) };
}

function parseUnits(value: string): bigint | null {
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

const toHex = (value: bigint): string => `0x${value.toString(16)}`;

const sameAddress = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

function without<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([k]) => k !== key));
}
