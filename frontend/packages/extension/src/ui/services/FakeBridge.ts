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
  TestnetSendDraft,
  TestnetSendOutcome,
  TestnetWallet,
  UiBridge,
  PairingProgress,
  PhonePairing,
  RecoveryPhoneStatus,
  RecoveryAlert,
  RecoveryView,
} from './UiBridge';
import { pairingQr, recoveryQr } from '../../recovery/qr';

const FAKE_PHONE_FINGERPRINT = '5FA8-122B';
const FAKE_RECOVERABLE_ADDRESS = '0x5a11e7000000000000000000000000000000a11c';

/** Mock test-network wallets for offline demos and UI tests (labelled fake, never real addresses). */
const FAKE_SOLANA_WALLET: Omit<TestnetWallet, 'balance'> = {
  network: 'solana-devnet',
  label: 'Solana devnet',
  address: 'FakeDevnetAddress1111111111111111111111111',
  symbol: 'SOL',
  decimals: 9,
  explorerUrl: 'https://explorer.solana.com/?cluster=devnet',
  inWalletAirdrop: true,
  faucetUrl: 'https://faucet.solana.com',
};
const FAKE_BASE_WALLET: TestnetWallet = {
  network: 'base-sepolia',
  label: 'Base Sepolia',
  address: '0x000000000000000000000000000000000000fa4e',
  symbol: 'ETH',
  decimals: 18,
  balance: '50000000000000000',
  explorerUrl: 'https://sepolia.basescan.org',
  inWalletAirdrop: false,
  faucetUrl: 'https://portal.cdp.coinbase.com/products/faucet',
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

  async lock(): Promise<Result<void, UiError>> {
    await this.#latency();
    return ok(undefined);
  }

  async hasPasskey(): Promise<Result<boolean, UiError>> {
    await this.#latency();
    if (!this.#session) return err(UNAUTHORIZED);
    return ok(this.#account !== null);
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
    if (options.withoutAnalysis) {
      // Self-custody: the passkey alone, no analysis and so no receipt.
      this.#previews = new Map([...this.#previews].filter(([id]) => id !== previewId));
      this.#applyTransfer(preview.draft);
      this.#record({ kind: 'cosigned', from: this.#account.address, to: preview.draft.to, action, band: assessment.band, userOpHash: prepared.user_op_hash });
      return ok({ kind: 'confirmed', txHash: fakeHash(this.#nextId()), receipt: null });
    }
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
    return ok([
      { ...FAKE_SOLANA_WALLET, balance: this.#solLamports.toString() },
      FAKE_BASE_WALLET,
      { ...FAKE_BASE_WALLET, network: 'eth-sepolia', label: 'Ethereum Sepolia', balance: '0', faucetUrl: 'https://sepolia-faucet.pk910.de/' },
      {
        ...FAKE_BASE_WALLET,
        network: 'base-sepolia-usdc',
        label: 'Base Sepolia · USDC sans gas',
        address: '0x00000000000000000000000000000000005a4a11',
        symbol: 'USDC',
        decimals: 6,
        balance: '25000000',
        faucetUrl: 'https://faucet.circle.com',
        gasless: true,
      },
    ]);
  }

  async sendTestnet(draft: TestnetSendDraft): Promise<Result<TestnetSendOutcome, UiError>> {
    await this.#latency();
    if (!this.#session) return err(UNAUTHORIZED);
    const txId = `fakeSend${this.#nextId()}`;
    return ok({ network: draft.network, txId, amount: draft.amount, explorerUrl: 'https://explorer.solana.com/?cluster=devnet', recordedOnFerra: 1 });
  }

  async requestAirdrop(network: TestnetNetwork): Promise<Result<AirdropOutcome, UiError>> {
    await this.#latency();
    if (!this.#session) return err(UNAUTHORIZED);
    if (network !== 'solana-devnet') return err(uiError('TESTNET_NO_FAUCET_API'));
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

  // Recovery phone: the fake phone answers on the second poll.
  #phoneFingerprint: string | null = null;
  #pairingPolls = 0;

  async getRecoveryPhone(): Promise<Result<RecoveryPhoneStatus, UiError>> {
    await this.#latency();
    if (!this.#session) return err(UNAUTHORIZED);
    return ok({ fingerprint: this.#phoneFingerprint });
  }

  async startPhonePairing(): Promise<Result<PhonePairing, UiError>> {
    await this.#latency();
    if (!this.#session || !this.#account) return err(UNAUTHORIZED);
    this.#pairingPolls = 0;
    const pairingId = `pair_fake${this.#nextId()}`;
    return ok({ pairingId, qr: pairingQr(pairingId, this.#account.address), expiresAt: Math.floor(Date.now() / 1000) + 600 });
  }

  async pollPhonePairing(_pairingId: string): Promise<Result<PairingProgress, UiError>> {
    await this.#latency();
    if (!this.#session) return err(UNAUTHORIZED);
    this.#pairingPolls += 1;
    return ok(this.#pairingPolls < 2 ? { status: 'waiting' } : { status: 'answered', fingerprint: FAKE_PHONE_FINGERPRINT, deviceLabel: 'iPhone de démo' });
  }

  async confirmPhonePairing(_pairingId: string): Promise<Result<RecoveryPhoneStatus, UiError>> {
    await this.#latency();
    if (!this.#session) return err(UNAUTHORIZED);
    this.#phoneFingerprint = FAKE_PHONE_FINGERPRINT;
    return ok({ fingerprint: this.#phoneFingerprint });
  }

  // Recovery on a new device: the fake phone signs on the first poll, the timelock is 30 s.
  #recovery: { view: RecoveryView; polls: number } | null = null;
  #alerts: RecoveryAlert[] = [];

  async listRecoverableWallets(): Promise<Result<readonly string[], UiError>> {
    await this.#latency();
    if (!this.#session) return err(UNAUTHORIZED);
    return ok([this.#account?.address ?? FAKE_RECOVERABLE_ADDRESS]);
  }

  async startRecovery(address: string): Promise<Result<RecoveryView, UiError>> {
    await this.#latency();
    if (!this.#session) return err(UNAUTHORIZED);
    const id = `rec_fake${this.#nextId()}`;
    const view: RecoveryView = {
      id,
      address,
      qr: recoveryQr(id),
      newKeyFingerprint: 'A1B2-C3D4',
      phase: 'waiting_phone',
      unlockAt: null,
      reasons: [],
      band: null,
      contested: false,
      detail: null,
    };
    this.#recovery = { view, polls: 0 };
    return ok(view);
  }

  async getRecovery(): Promise<Result<RecoveryView | null, UiError>> {
    await this.#latency();
    if (!this.#session) return err(UNAUTHORIZED);
    const current = this.#recovery;
    if (!current) return ok(null);
    current.polls += 1;
    if (current.view.phase === 'waiting_phone' && current.polls >= 1) {
      current.view = {
        ...current.view,
        phase: 'pending',
        unlockAt: Math.floor(Date.now() / 1000) + 30,
        reasons: ['Aucun signal particulier : délai minimal.'],
        band: 'Low',
      };
    }
    return ok(current.view);
  }

  async finishRecovery(): Promise<Result<AccountView, UiError>> {
    await this.#latency();
    const current = this.#recovery;
    if (!this.#session || !current) return err(UNAUTHORIZED);
    if (current.view.phase !== 'pending' || (current.view.unlockAt ?? 0) > Math.floor(Date.now() / 1000)) return err(uiError('SQ_CONFLICT'));
    this.#recovery = null;
    if (!this.#account) this.#account = newDemoAccount(fakeHash(this.#nextId()));
    return ok(this.#account);
  }

  async abandonRecovery(): Promise<Result<void, UiError>> {
    await this.#latency();
    this.#recovery = null;
    return ok(undefined);
  }

  /** Demo hook: a recovery of this wallet started elsewhere (the existing device's alert). */
  simulateRecoveryElsewhere(contested = false): void {
    this.#alerts = [
      {
        id: `rec_other${this.#nextId()}`,
        unlockAt: Math.floor(Date.now() / 1000) + 90,
        reasons: ['Votre passkey actuelle a signé il y a moins de 24 h : pourquoi récupérer un accès encore utilisé ?'],
        newKeyFingerprint: 'E5F6-0718',
        contested,
      },
    ];
  }

  async getRecoveryAlerts(): Promise<Result<readonly RecoveryAlert[], UiError>> {
    await this.#latency();
    if (!this.#session) return err(UNAUTHORIZED);
    return ok(this.#alerts);
  }

  async cancelRecovery(id: string): Promise<Result<void, UiError>> {
    await this.#latency();
    if (!this.#session) return err(UNAUTHORIZED);
    const alert = this.#alerts.find((a) => a.id === id);
    if (!alert) return err(uiError('SQ_NOT_FOUND'));
    if (alert.contested) return err(uiError('SQ_CONFLICT'));
    this.#alerts = this.#alerts.filter((a) => a.id !== id);
    return ok(undefined);
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
