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
  AirdropOutcome,
  ConfirmOptions,
  SendDraft,
  SendOutcome,
  SendPreview,
  SessionView,
  TestnetNetwork,
  TestnetSendDraft,
  TestnetSendOutcome,
  TestnetWallet,
  UiBridge,
  PairingProgress,
  PhonePairing,
  RecoveryPhoneStatus,
  RecoveryAlert,
  RecoveryView,
} from '../ui/services/UiBridge';
import { pairingQr, recoveryQr } from '../recovery/qr';
import { keyFingerprint } from './recovery/fingerprint';
import type { RecoveryState } from '@sqw/types/RecoveryState';
import type { TestnetSender } from './testnet/TestnetSender';
import type { TestnetWallets } from './testnet/TestnetWallets';
import { verifyOwner } from './verifyOwner';
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
const TESTNET_OFF = uiError('TESTNET_UNAVAILABLE');

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
  /** Test-network addresses and faucets (P3). Absent: those calls answer "unavailable". */
  readonly testnet?: TestnetWallets;
  /** Sends from the test-network keys, each one approved by the passkey (P3). */
  readonly testnetSender?: TestnetSender;
  /** Clock and auto-lock delay, injectable for tests. Default: Date.now, 15 minutes of inactivity. */
  readonly now?: () => number;
  readonly lockAfterMs?: number;
}

/** What the website learns at sign-in: never the session token. */
export interface SignedInIdentity {
  readonly address: string;
  readonly clientId: string;
  readonly displayName: string;
}

/**
 * Authentication model (banking apps' norm): the passkey to enter, then auto-lock after 15 minutes
 * of inactivity; and the passkey again for every transaction, since it is what signs it.
 */
export const LOCK_AFTER_MS = 15 * 60_000;
const LOCKED = uiError('UI_LOCKED');

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
    return this.#whenUnlocked(() => this.#getWallet());
  }

  /**
   * Who signed in, provided the passkey proved it at or after `since` (epoch ms). Lets the website
   * sign-in (sqw_signIn) accept only a proof made for that request, never an older unlock.
   */
  async identitySince(since: number): Promise<SignedInIdentity | null> {
    const state = await this.#serial(() => this.#load());
    if (!state.session || !state.wallet || (state.provenAt ?? -1) < since) return null;
    return { address: state.wallet.address, clientId: state.session.client_id, displayName: state.session.display_name };
  }

  /** Locks now: every wallet call is refused until the passkey unlocks it again (createWallet). */
  lock(): UiResult<void> {
    return this.#serial(async () => {
      await this.#patch((s) => withoutUnlock(s));
      return ok(undefined);
    });
  }

  /** Whether this device already holds the client's passkey: sign-in then unlocks instead of creating. */
  async hasPasskey(): UiResult<boolean> {
    const { session } = await this.#serial(() => this.#load());
    if (!session) return err(UNAUTHORIZED);
    return ok(await this.#deps.passkey.has((this.#deps.passkeyNameFor ?? defaultPasskeyName)(session.client_id)));
  }

  previewSend(draft: SendDraft): UiResult<SendPreview> {
    return this.#whenUnlocked(() => this.#previewSend(draft));
  }

  confirmSend(previewId: string, options: ConfirmOptions): UiResult<SendOutcome> {
    return this.#whenUnlocked(() => this.#confirmSend(previewId, options));
  }

  cancelSend(previewId: string): UiResult<void> {
    return this.#whenUnlocked(() => this.#cancelSend(previewId));
  }

  getActivity(): UiResult<ActivityFeed> {
    return this.#whenUnlocked(() => this.#getActivity());
  }

  getSettings(): UiResult<WalletSettings> {
    return this.#whenUnlocked(() => this.#getSettings());
  }

  saveSettings(settings: WalletSettings): UiResult<WalletSettings> {
    return this.#whenUnlocked(() => this.#saveSettings(settings));
  }

  async getTestnetWallets(): UiResult<readonly TestnetWallet[]> {
    const gate = await this.#whenUnlocked(async () => ok(undefined));
    if (!gate.ok) return gate;
    const { session, wallet } = await this.#serial(() => this.#load());
    if (!session) return err(UNAUTHORIZED);
    if (!wallet) return err(NO_WALLET);
    return this.#deps.testnet ? this.#deps.testnet.list(wallet.address) : err(TESTNET_OFF);
  }

  /**
   * Not serialised (signing and confirmation take seconds). The passkey signs a hash bound to this
   * transfer and the signature is verified here against the wallet's owner key before anything is
   * signed with the network key: an extension page cannot approve on the user's behalf.
   */
  async sendTestnet(draft: TestnetSendDraft): UiResult<TestnetSendOutcome> {
    const gate = await this.#whenUnlocked(async () => ok(undefined));
    if (!gate.ok) return gate;
    const { session, wallet } = await this.#serial(() => this.#load());
    if (!session) return err(UNAUTHORIZED);
    if (!wallet) return err(NO_WALLET);
    const sender = this.#deps.testnetSender;
    if (!sender) return err(TESTNET_OFF);
    return sender.send(draft, wallet.address, async (hash) => {
      const signed = await this.#deps.passkey.sign(wallet.passkeyName, hash);
      if (!signed.ok) return this.#fail(signed.error);
      return verifyOwner(wallet.owner, hash, signed.value) ? ok(undefined) : err(uiError('PASSKEY_FAILED'));
    });
  }

  // ----- recovery phone (P3): pairing relay + owner-signed registration on the Ferra chain -----

  getRecoveryPhone(): UiResult<RecoveryPhoneStatus> {
    return this.#whenUnlocked(async () => {
      const { wallet } = await this.#load();
      if (!wallet) return err(NO_WALLET);
      const current = await this.#deps.api.recoveryKey(wallet.address);
      if (!current.ok) return this.#fail(current.error);
      return ok({ fingerprint: current.value.key ? keyFingerprint(current.value.key) : null });
    });
  }

  startPhonePairing(): UiResult<PhonePairing> {
    return this.#whenUnlocked(async () => {
      const { wallet } = await this.#load();
      if (!wallet) return err(NO_WALLET);
      const pairing = await this.#deps.api.startPairing(wallet.address);
      if (!pairing.ok) return this.#fail(pairing.error);
      return ok({ pairingId: pairing.value.id, qr: pairingQr(pairing.value.id, wallet.address), expiresAt: pairing.value.expires_at });
    });
  }

  /** The fingerprint is computed here from the key itself, never taken from the server. */
  pollPhonePairing(pairingId: string): UiResult<PairingProgress> {
    return this.#whenUnlocked(async () => {
      const pairing = await this.#deps.api.pairing(pairingId);
      if (!pairing.ok) return this.#fail(pairing.error);
      const { key, device_label } = pairing.value;
      return ok(key ? { status: 'answered', fingerprint: keyFingerprint(key), deviceLabel: device_label } : { status: 'waiting' });
    });
  }

  /** Not serialised (the passkey takes seconds). The owner's passkey signs the phone's key. */
  async confirmPhonePairing(pairingId: string): UiResult<RecoveryPhoneStatus> {
    const gate = await this.#whenUnlocked(async () => ok(undefined));
    if (!gate.ok) return gate;
    const { wallet } = await this.#serial(() => this.#load());
    if (!wallet) return err(NO_WALLET);
    const { api, passkey } = this.#deps;
    const pairing = await api.pairing(pairingId);
    if (!pairing.ok) return this.#fail(pairing.error);
    const key = pairing.value.key;
    if (!key || pairing.value.address.toLowerCase() !== wallet.address.toLowerCase()) return err(uiError('SQ_CONFLICT'));
    const hash = await api.recoveryKeyHash(wallet.address, key);
    if (!hash.ok) return this.#fail(hash.error);
    const signature = await passkey.sign(wallet.passkeyName, hash.value.hash);
    if (!signature.ok) return this.#fail(signature.error);
    const saved = await api.setRecoveryKey(wallet.address, { key, signature: signature.value });
    if (!saved.ok) return this.#fail(saved.error);
    return ok({ fingerprint: keyFingerprint(key) });
  }

  // ----- recovery (P3): new device after a lost passkey; alert + cancel on the existing one -----

  async listRecoverableWallets(): UiResult<readonly string[]> {
    const { session } = await this.#serial(() => this.#load());
    if (!session) return err(UNAUTHORIZED);
    const wallets = await this.#deps.api.recoverableWallets();
    return wallets.ok ? ok(wallets.value) : this.#fail(wallets.error);
  }

  /**
   * Not serialised (the passkey takes seconds). Creates this device's new passkey, then prepares the
   * recovery: the phone signs it and passes the KYC; nothing moves before the timelock is over.
   */
  async startRecovery(address: string): UiResult<RecoveryView> {
    const { session } = await this.#serial(() => this.#load());
    if (!session) return err(UNAUTHORIZED);
    const { api, passkey } = this.#deps;
    const passkeyName = (this.#deps.passkeyNameFor ?? defaultPasskeyName)(session.client_id);
    // This device still holds the passkey: unlock instead, and never overwrite a working one.
    if (await passkey.has(passkeyName)) return err(uiError('RECOVERY_PASSKEY_PRESENT'));
    const owner = passkey.replace ? await passkey.replace(passkeyName) : await passkey.create(passkeyName);
    if (!owner.ok) return this.#fail(owner.error);
    const prepared = await api.prepareRecovery({ address, new_owner: owner.value });
    if (!prepared.ok) return this.#fail(prepared.error);
    await this.#serial(() => this.#patch((s) => ({ ...s, recovery: { id: prepared.value.id, address, passkeyName, owner: owner.value } })));
    return ok(recoveryView(prepared.value, this.#nowSecs()));
  }

  async getRecovery(): UiResult<RecoveryView | null> {
    const { session, recovery } = await this.#serial(() => this.#load());
    if (!session) return err(UNAUTHORIZED);
    if (!recovery) return ok(null);
    const current = await this.#deps.api.recovery(recovery.id);
    if (!current.ok) return this.#fail(current.error);
    return ok(recoveryView(current.value, this.#nowSecs()));
  }

  /** After the timelock: the phone's signature and Swissquote's attestation rotate the owner on-chain. */
  async finishRecovery(): UiResult<AccountView> {
    const { session, recovery } = await this.#serial(() => this.#load());
    if (!session) return err(UNAUTHORIZED);
    if (!recovery) return err(uiError('SQ_NOT_FOUND'));
    const { api } = this.#deps;
    const done = await api.executeRecovery(recovery.id);
    if (!done.ok) return done.error.status === 409 ? err(uiError('RECOVERY_NOT_READY')) : this.#fail(done.error);
    if (done.value.status.state !== 'completed') return err(uiError('RECOVERY_NOT_READY'));
    const info = await api.chainInfo();
    if (!info.ok) return this.#fail(info.error);
    const wallet: WalletRef = { passkeyName: recovery.passkeyName, owner: recovery.owner, address: recovery.address, chainId: info.value.chain_id, tokens: info.value.tokens };
    const now = this.#now();
    await this.#serial(() =>
      this.#patch((s) => {
        const { recovery: _done, ...rest } = s;
        return { ...rest, wallet, pending: {}, unlockedUntil: now + this.#lockAfter(), provenAt: now };
      }),
    );
    return this.getWallet();
  }

  async abandonRecovery(): UiResult<void> {
    await this.#serial(() =>
      this.#patch((s) => {
        const { recovery: _gone, ...rest } = s;
        return rest;
      }),
    );
    return ok(undefined);
  }

  getRecoveryAlerts(): UiResult<readonly RecoveryAlert[]> {
    return this.#whenUnlocked(async () => {
      const { wallet } = await this.#load();
      if (!wallet) return err(NO_WALLET);
      const all = await this.#deps.api.recoveries(wallet.address);
      if (!all.ok) return this.#fail(all.error);
      return ok(
        all.value.flatMap((r): RecoveryAlert[] =>
          r.status.state === 'pending'
            ? [{ id: r.id, unlockAt: r.status.unlock_at, reasons: r.risk?.reasons ?? [], newKeyFingerprint: keyFingerprint(r.new_owner), contested: r.contested }]
            : [],
        ),
      );
    });
  }

  /** Not serialised (the passkey takes seconds). "Ce n'est pas moi": the current passkey cancels. */
  async cancelRecovery(id: string): UiResult<void> {
    const gate = await this.#whenUnlocked(async () => ok(undefined));
    if (!gate.ok) return gate;
    const { wallet } = await this.#serial(() => this.#load());
    if (!wallet) return err(NO_WALLET);
    const { api, passkey } = this.#deps;
    const current = await api.recovery(id);
    if (!current.ok) return this.#fail(current.error);
    if (current.value.address.toLowerCase() !== wallet.address.toLowerCase()) return err(uiError('SQ_NOT_FOUND'));
    if (current.value.contested) return err(uiError('RECOVERY_CONTESTED'));
    const signature = await passkey.sign(wallet.passkeyName, current.value.cancel_hash);
    if (!signature.ok) return this.#fail(signature.error);
    const cancelled = await api.cancelRecovery(id, signature.value);
    return cancelled.ok ? ok(undefined) : this.#fail(cancelled.error);
  }

  #nowSecs(): number {
    return Math.floor(this.#now() / 1000);
  }

  /** Not serialised: the faucet can take tens of seconds and touches no bridge state. */
  async requestAirdrop(network: TestnetNetwork): UiResult<AirdropOutcome> {
    const gate = await this.#whenUnlocked(async () => ok(undefined));
    if (!gate.ok) return gate;
    const { session, wallet } = await this.#serial(() => this.#load());
    if (!session) return err(UNAUTHORIZED);
    if (!wallet) return err(NO_WALLET);
    return this.#deps.testnet ? this.#deps.testnet.airdrop(network, wallet.address) : err(TESTNET_OFF);
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

    // Every sign-in proves possession: the passkey signs a fresh challenge and the backend verifies
    // it (registering is idempotent for an existing account). A known passkey is never reused silently.
    const registered = await this.#register(passkeyName, owner.value);
    if (!registered.ok) return registered;
    const account = registered.value;

    const wallet: WalletRef = {
      passkeyName,
      owner: owner.value,
      address: account.address,
      chainId: info.value.chain_id,
      tokens: info.value.tokens,
    };
    // The passkey just proved it is the owner: unlocked until the auto-lock.
    await this.#patch((s) => ({ ...s, wallet, unlockedUntil: this.#now() + this.#lockAfter(), provenAt: this.#now() }));
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
    // Self-custody: the user chose to go ahead without Swissquote's analysis; the passkey suffices.
    if (options.withoutAnalysis) return this.#submit(wallet, pending, { withoutAnalysis: true });

    let stepUp: OwnerSignature | null = null;
    if (options.stepUp) {
      if (!pending.stepUpHash) return err(uiError('SQ_BAD_REQUEST'));
      const signed = await this.#deps.passkey.sign(wallet.passkeyName, pending.stepUpHash);
      if (!signed.ok) return this.#fail(signed.error);
      stepUp = signed.value;
    }

    // Read the audit-log position now: anything logged since the preview has moved it.
    const position = await this.#deps.api.log(wallet.address);
    if (!position.ok && isUnavailable(position.error)) return err(uiError('SQ_ANALYSIS_UNAVAILABLE', true));
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
    if (!cosigned.ok && isUnavailable(cosigned.error)) return err(uiError('SQ_ANALYSIS_UNAVAILABLE', true));
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

  async #submit(wallet: WalletRef, pending: PendingSend, mode: { withoutAnalysis?: boolean } = {}): UiResult<SendOutcome> {
    if (!mode.withoutAnalysis && (!pending.cosignature || !pending.receipt)) return err(uiError('SQ_BAD_REQUEST'));
    const ownerSig = await this.#deps.passkey.sign(wallet.passkeyName, pending.userOpHash);
    if (!ownerSig.ok) return this.#fail(ownerSig.error);
    const submitted = await this.#deps.api.submit({
      tx: pending.tx,
      nonce: pending.nonce,
      owner_signature: ownerSig.value,
      cosignature: pending.cosignature ?? null,
    });
    if (!submitted.ok) return this.#fail(submitted.error);
    await this.#dropPending(pending.id);
    return ok({ kind: 'confirmed', txHash: submitted.value.tx_hash, receipt: pending.receipt ?? null });
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

  /**
   * Wallet calls run only while unlocked; each one pushes the auto-lock back. With a wallet but
   * past `unlockedUntil`, the call is refused with UI_LOCKED and the UI asks for the passkey.
   * No session or no wallet: the call runs and answers its usual UNAUTHORIZED / NOT_FOUND.
   */
  #whenUnlocked<T>(task: () => UiResult<T>): UiResult<T> {
    return this.#serial(async () => {
      const state = await this.#load();
      if (state.session && state.wallet) {
        if ((state.unlockedUntil ?? 0) <= this.#now()) {
          if (state.unlockedUntil !== undefined) await this.#update(withoutUnlock(state));
          return err(LOCKED);
        }
        await this.#update({ ...state, unlockedUntil: this.#now() + this.#lockAfter() });
      }
      return task();
    });
  }

  #now(): number {
    return (this.#deps.now ?? Date.now)();
  }

  #lockAfter(): number {
    return this.#deps.lockAfterMs ?? LOCK_AFTER_MS;
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

/** The analysis could not be reached (down, offline, 5xx): self-custody lets the user go ahead. */
function isUnavailable(error: SdkError): boolean {
  return error.code === 'UNREACHABLE' || (error.status !== undefined && error.status >= 500);
}

/** What the new device shows: the server's recovery, in the UI's words. */
function recoveryView(r: RecoveryState, nowSecs: number): RecoveryView {
  const base = {
    id: r.id,
    address: r.address,
    qr: recoveryQr(r.id),
    newKeyFingerprint: keyFingerprint(r.new_owner),
    reasons: r.risk?.reasons ?? [],
    band: r.risk?.band ?? null,
    contested: r.contested,
  };
  switch (r.status.state) {
    case 'prepared':
      return { ...base, phase: r.status.expires_at < nowSecs ? 'expired' : 'waiting_phone', unlockAt: null, detail: null };
    case 'pending':
      return { ...base, phase: 'pending', unlockAt: r.status.unlock_at, detail: null };
    case 'rejected':
      return { ...base, phase: 'rejected', unlockAt: null, detail: r.status.reason };
    case 'cancelled':
      return { ...base, phase: 'cancelled', unlockAt: null, detail: null };
    case 'completed':
      return { ...base, phase: 'completed', unlockAt: null, detail: null };
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

/** The same state, locked. */
function withoutUnlock(state: BridgeState): BridgeState {
  const { unlockedUntil: _locked, ...rest } = state;
  return rest;
}
