import type { AccountView } from '@sqw/types/AccountView';
import type { LoginRequest } from '@sqw/types/LoginRequest';
import type { ChainTx } from '@sqw/types/ChainTx';
import type { Session } from '@sqw/types/Session';
import type { WalletSettings } from '@sqw/types/WalletSettings';
import { uiError, type UiError } from '../core/errors';
import { isAddress } from '../core/format';
import { isValidSettings } from '../core/settings';
import { err, ok, type Result } from '../core/result';
import {
  DEFAULT_SETTINGS,
  DEMO_CLIENTS,
  DEMO_PASSWORD,
  DEMO_TOKENS,
  USDC,
  chainTx,
  type ChainEvent,
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
import type {
  ActivityFeed,
  AirdropOutcome,
  ConfirmOptions,
  SendDraft,
  SendOutcome,
  SendPreview,
  SessionView,
  TestnetNetwork,
  TestnetWallet,
  UiBridge,
} from './UiBridge';

/** Mock devnet wallet for offline demos and UI tests (labelled fake, never a real address). */
const FAKE_SOLANA_WALLET: Omit<TestnetWallet, 'balance'> = {
  network: 'solana-devnet',
  label: 'Solana devnet',
  address: 'FakeDevnetAddress1111111111111111111111111',
  symbol: 'SOL',
  decimals: 9,
  explorerUrl: 'https://explorer.solana.com/?cluster=devnet',
};

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
  #history: readonly ChainTx[] = [];
  #receiptHashes: readonly string[] = [];
  #settings: WalletSettings = DEFAULT_SETTINGS;
  #head = GENESIS_HEAD;
  #solLamports = 0n;
  #nextSeq = 0;
  #counter = 0;

  constructor(options: FakeBridgeOptions = {}) {
    this.#delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
  }

  async login(credentials: LoginRequest): Promise<Result<SessionView, UiError>> {
    await this.#latency();
    const client = DEMO_CLIENTS[credentials.username];
    if (!client || credentials.password !== DEMO_PASSWORD) return err(UNAUTHORIZED);
    this.#session = {
      token: `fake-${credentials.username}-${this.#nextId()}`,
      client_id: client.clientId,
      display_name: client.displayName,
    };
    return ok({ client_id: this.#session.client_id, display_name: this.#session.display_name });
  }

  async createWallet(): Promise<Result<AccountView, UiError>> {
    await this.#latency();
    if (!this.#session) return err(UNAUTHORIZED);
    if (!this.#account) {
      const account = newDemoAccount(fakeHash(this.#nextId()));
      this.#account = account;
      // The demo faucet, as the real bridge funds a new account.
      this.#record({
        kind: 'faucet',
        from: account.address,
        to: account.address,
        action: { kind: 'erc20_transfer', token: USDC, to: account.address, amount: account.balances[1]?.amount ?? '0x0' },
        band: null,
        userOpHash: fakeHash(this.#nextId()),
      });
    }
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
        intent_id: `intent-${this.#nextId()}`,
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

  async confirmSend(previewId: string, options: ConfirmOptions): Promise<Result<SendOutcome, UiError>> {
    await this.#latency();
    if (!this.#session || !this.#account) return err(UNAUTHORIZED);
    const preview = this.#previews.get(previewId);
    const prepared = preview?.assessment.prepared;
    if (!preview || !prepared) return err(uiError('SQ_NOT_FOUND'));

    const { assessment, action } = preview.assessment;
    const decision = decide(assessment, options.stepUp, options.acceptedRisk);
    if (decision.kind === 'confirm') return ok({ kind: 'confirmation_required', previewId, level: decision.level });

    const entry = signedEntry({
      seq: this.#nextSeq,
      prevHead: this.#head,
      userOpHash: prepared.user_op_hash,
      action,
      assessment,
      outcome: loggedOutcome(decision),
      stepUp: options.stepUp,
      riskAccepted: decision.kind === 'cosign' && options.stepUp && options.acceptedRisk,
    });
    // Every final outcome is logged, so the hash chain advances and the preview is spent.
    this.#head = entry.entry_hash;
    this.#nextSeq += 1;
    this.#previews = new Map([...this.#previews].filter(([id]) => id !== previewId));

    this.#receiptHashes = [...this.#receiptHashes, prepared.user_op_hash];
    if (decision.kind === 'refuse_regulatory') return ok({ kind: 'refused', reason: 'regulatory' });
    this.#applyTransfer(preview.draft);
    this.#record({
      kind: 'cosigned',
      from: this.#account.address,
      to: preview.draft.to,
      action,
      band: assessment.band,
      userOpHash: prepared.user_op_hash,
    });
    return ok({ kind: 'confirmed', txHash: fakeHash(this.#nextId()), receipt: entry.receipt });
  }

  async cancelSend(previewId: string): Promise<Result<void, UiError>> {
    await this.#latency();
    if (!this.#session) return err(UNAUTHORIZED);
    if (!this.#previews.has(previewId)) return err(uiError('SQ_NOT_FOUND'));
    this.#previews = new Map([...this.#previews].filter(([id]) => id !== previewId));
    return ok(undefined);
  }

  async getActivity(): Promise<Result<ActivityFeed, UiError>> {
    await this.#latency();
    if (!this.#session) return err(UNAUTHORIZED);
    if (!this.#account) return err(uiError('SQ_NOT_FOUND'));
    return ok({ address: this.#account.address, txs: this.#history, receiptHashes: this.#receiptHashes, tokens: DEMO_TOKENS });
  }

  async getSettings(): Promise<Result<WalletSettings, UiError>> {
    await this.#latency();
    if (!this.#session) return err(UNAUTHORIZED);
    return ok(this.#settings);
  }

  async saveSettings(settings: WalletSettings): Promise<Result<WalletSettings, UiError>> {
    await this.#latency();
    if (!this.#session) return err(UNAUTHORIZED);
    if (!isValidSettings(settings)) return err(uiError('UI_INVALID_SETTINGS'));
    this.#settings = settings;
    return ok(settings);
  }

  async getTestnetWallets(): Promise<Result<readonly TestnetWallet[], UiError>> {
    await this.#latency();
    if (!this.#session) return err(UNAUTHORIZED);
    return ok([{ ...FAKE_SOLANA_WALLET, balance: this.#solLamports.toString() }]);
  }

  async requestAirdrop(network: TestnetNetwork): Promise<Result<AirdropOutcome, UiError>> {
    await this.#latency();
    if (!this.#session) return err(UNAUTHORIZED);
    const amount = 1_000_000_000n;
    this.#solLamports += amount;
    const signature = `fakeAirdrop${this.#nextId()}`;
    return ok({
      network,
      signature,
      amount: amount.toString(),
      explorerUrl: `https://explorer.solana.com/tx/${signature}?cluster=devnet`,
      recordedOnFerra: 1,
    });
  }

  #record(event: Omit<ChainEvent, 'block'>): void {
    this.#history = [...this.#history, chainTx({ ...event, block: this.#history.length + 1 })];
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
