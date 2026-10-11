import type { RiskBand } from '@sqw/types/RiskBand';
import type { AccountView } from '@sqw/types/AccountView';
import type { AssessResponse } from '@sqw/types/AssessResponse';
import type { ChainTx } from '@sqw/types/ChainTx';
import type { LoginRequest } from '@sqw/types/LoginRequest';
import type { Receipt } from '@sqw/types/Receipt';
import type { Session } from '@sqw/types/Session';
import type { TokenInfo } from '@sqw/types/TokenInfo';
import type { WalletSettings } from '@sqw/types/WalletSettings';
import type { UiError } from '../core/errors';
import type { Result } from '../core/result';

/** What the user typed on the Send screen. `asset: null` is the native asset; `amount` is base units, 0x hex. */
export interface SendDraft {
  readonly to: string;
  readonly asset: string | null;
  readonly amount: string;
}

/** Everything the Confirm screen shows, keyed by `id` so the confirmation refers to exactly what was previewed. */
export interface SendPreview {
  readonly id: string;
  readonly draft: SendDraft;
  readonly assessment: AssessResponse;
}

/**
 * `standard`: a second passkey confirmation (e.g. large amount).
 * `high_risk`: the user is warned and must explicitly accept the risk before confirming again.
 */
export type ConfirmationLevel = 'standard' | 'high_risk';

/** What the UI may know about the session: never the bearer token, which stays in the background. */
export type SessionView = Omit<Session, 'token'>;

export interface ActivityFeed {
  readonly address: string;
  /** Newest last, as the chain returns them. */
  readonly txs: readonly ChainTx[];
  /** `user_op_hash` of every audit-log entry: an event with one of these has a signed receipt. */
  readonly receiptHashes: readonly string[];
  /** To format token amounts. */
  readonly tokens: readonly TokenInfo[];
}

export interface ConfirmOptions {
  readonly stepUp: boolean;
  readonly acceptedRisk: boolean;
  /**
   * Self-custody: send with the passkey alone, without Swissquote's analysis (used when the
   * analysis is unreachable and the user chose to go ahead). The chain accepts the owner's signature.
   */
  readonly withoutAnalysis?: boolean;
}

/**
 * Self-custody: Swissquote never blocks a transaction, not even for sanctions. It warns, explains
 * and asks for a double confirmation; the user decides. `refused` is kept only for older backends.
 * `receipt` is null when the transfer went through without Swissquote's analysis.
 */
export type SendOutcome =
  | { readonly kind: 'confirmed'; readonly txHash: string; readonly receipt: Receipt | null }
  | { readonly kind: 'confirmation_required'; readonly previewId: string; readonly level: ConfirmationLevel }
  | { readonly kind: 'refused'; readonly reason: 'regulatory' };

/** The wallet's recovery phone: the fingerprint of its key registered on the Ferra chain, or null. */
export interface RecoveryPhoneStatus {
  readonly fingerprint: string | null;
}

/** A pairing in progress: `qr` is what the phone scans (`ferrata:pair?…`). */
export interface PhonePairing {
  readonly pairingId: string;
  readonly qr: string;
  readonly expiresAt: number;
}

export type PairingProgress =
  | { readonly status: 'waiting' }
  /** The phone answered: compare `fingerprint` with the one shown on the phone before confirming. */
  | { readonly status: 'answered'; readonly fingerprint: string; readonly deviceLabel: string | null };

/** Where a recovery started on this device stands (new device, after losing the passkey). */
export type RecoveryPhase =
  /** Waiting for the recovery phone to scan the QR, sign, and pass the KYC. */
  | 'waiting_phone'
  /** Started: the smart-delay timelock runs; the current passkey may still cancel (unless contested). */
  | 'pending'
  | 'rejected'
  | 'cancelled'
  | 'expired'
  | 'completed';

export interface RecoveryView {
  readonly id: string;
  readonly address: string;
  /** What the phone scans: `ferrata:recover?id=…`. */
  readonly qr: string;
  /** Fingerprint of this device's new passkey: the phone shows it too, the user compares. */
  readonly newKeyFingerprint: string;
  readonly phase: RecoveryPhase;
  /** Epoch seconds when it can be finalised (`pending`). */
  readonly unlockAt: number | null;
  /** The smart delay's reasons, in plain language. */
  readonly reasons: readonly string[];
  readonly band: RiskBand | null;
  readonly contested: boolean;
  /** Why it was rejected, if it was. */
  readonly detail: string | null;
}

/** A recovery of this wallet started elsewhere: the existing device warns and can cancel. */
export interface RecoveryAlert {
  readonly id: string;
  readonly unlockAt: number;
  readonly reasons: readonly string[];
  readonly newKeyFingerprint: string;
  /** A contested recovery can no longer be cancelled by the passkey alone. */
  readonly contested: boolean;
}

/**
 * Public test networks the wallet holds an address on (testnet_plan M3, M8). `base-sepolia-usdc` is
 * the wallet's ERC-4337 smart account on Base Sepolia: USDC transfers with gas paid by a paymaster.
 */
export type TestnetNetwork = 'solana-devnet' | 'base-sepolia' | 'eth-sepolia' | 'base-sepolia-usdc';

/** The wallet's address on a test network. Created by the background on first use, key never exposed. */
export interface TestnetWallet {
  readonly network: TestnetNetwork;
  readonly label: string;
  readonly address: string;
  readonly symbol: string;
  readonly decimals: number;
  /** Base units as a decimal string; null when the network could not be read. */
  readonly balance: string | null;
  readonly explorerUrl: string;
  /** True when `requestAirdrop` can fund this address from inside the wallet (public faucet API). */
  readonly inWalletAirdrop: boolean;
  /** Web faucet to open when there is no in-wallet airdrop, or when the faucet API refuses. */
  readonly faucetUrl: string;
  /** True when sends from this address need no native gas token (ERC-4337 + paymaster). */
  readonly gasless?: boolean;
}

export interface AirdropOutcome {
  readonly network: TestnetNetwork;
  readonly signature: string;
  /** Base units as a decimal string. */
  readonly amount: string;
  readonly explorerUrl: string;
  /** Events the Ferra chain recorded from that network right after the airdrop (0 if the sync failed). */
  readonly recordedOnFerra: number;
}

/** A transfer of test coins typed on the Testnet tab. `amount` is decimal (e.g. "0.05"). */
export interface TestnetSendDraft {
  readonly network: TestnetNetwork;
  readonly to: string;
  readonly amount: string;
}

export interface TestnetSendOutcome {
  readonly network: TestnetNetwork;
  /** Transaction hash (EVM) or signature (Solana). */
  readonly txId: string;
  /** Base units as a decimal string. */
  readonly amount: string;
  readonly explorerUrl: string;
  /** Events the Ferra chain recorded from that network right after the send (0 if the sync failed). */
  readonly recordedOnFerra: number;
}

/**
 * The only door from the UI to the rest of the system (Frontend Spec: P2 never calls the chain,
 * Rust or Swissquote directly). FakeBridge implements it for now; the real one wraps
 * chrome.runtime messaging to P3's background worker.
 */
export interface UiBridge {
  login(credentials: LoginRequest): Promise<Result<SessionView, UiError>>;
  createWallet(): Promise<Result<AccountView, UiError>>;
  getWallet(): Promise<Result<AccountView, UiError>>;
  /** After login: true when this device already holds the client's passkey (unlock), false to create one. */
  hasPasskey(): Promise<Result<boolean, UiError>>;
  /** Locks the wallet now. It also locks itself after 15 minutes of inactivity (UI_LOCKED). */
  lock(): Promise<Result<void, UiError>>;
  previewSend(draft: SendDraft): Promise<Result<SendPreview, UiError>>;
  /**
   * `stepUp: true` once the user re-confirmed with their passkey after `confirmation_required`;
   * `acceptedRisk: true` only when they ticked "Je comprends les risques" (`high_risk` level).
   */
  confirmSend(previewId: string, options: ConfirmOptions): Promise<Result<SendOutcome, UiError>>;
  /** The user backed out before the transaction went through. Recorded by Swissquote. */
  cancelSend(previewId: string): Promise<Result<void, UiError>>;

  /** On-chain history of the account plus which events carry a Swissquote receipt (Activity screen). */
  getActivity(): Promise<Result<ActivityFeed, UiError>>;
  /** The owner's own guard-rails, stored on the Ferra chain. */
  getSettings(): Promise<Result<WalletSettings, UiError>>;
  /** Signed with the passkey; returns the settings as now recorded on-chain. */
  saveSettings(settings: WalletSettings): Promise<Result<WalletSettings, UiError>>;

  /** The wallet's test-network addresses and balances (P3). */
  getTestnetWallets(): Promise<Result<readonly TestnetWallet[], UiError>>;
  /** Asks that network's public faucet for test coins, then records the transfer on the Ferra chain. */
  requestAirdrop(network: TestnetNetwork): Promise<Result<AirdropOutcome, UiError>>;
  /** Sends test coins: the passkey approves this exact transfer, then the network key signs and broadcasts. */
  sendTestnet(draft: TestnetSendDraft): Promise<Result<TestnetSendOutcome, UiError>>;

  /** Recovery phone (P3): which phone is registered as the wallet's recovery key, if any. */
  getRecoveryPhone(): Promise<Result<RecoveryPhoneStatus, UiError>>;
  /** Opens a pairing shown as a QR for the phone to scan. */
  startPhonePairing(): Promise<Result<PhonePairing, UiError>>;
  pollPhonePairing(pairingId: string): Promise<Result<PairingProgress, UiError>>;
  /** The passkey signs the phone's key: it becomes the wallet's recovery key on the Ferra chain. */
  confirmPhonePairing(pairingId: string): Promise<Result<RecoveryPhoneStatus, UiError>>;

  /** New device, passkey lost: the client's wallets (after the Swissquote login). */
  listRecoverableWallets(): Promise<Result<readonly string[], UiError>>;
  /** Creates this device's new passkey and prepares the recovery; the phone does the rest. */
  startRecovery(address: string): Promise<Result<RecoveryView, UiError>>;
  /** The recovery started on this device, if any. */
  getRecovery(): Promise<Result<RecoveryView | null, UiError>>;
  /** After the timelock: the new passkey becomes the owner; the wallet opens. */
  finishRecovery(): Promise<Result<AccountView, UiError>>;
  /** Forget the recovery started on this device (it expires on the server). */
  abandonRecovery(): Promise<Result<void, UiError>>;
  /** Existing device: recoveries of this wallet started elsewhere. */
  getRecoveryAlerts(): Promise<Result<readonly RecoveryAlert[], UiError>>;
  /** Existing device: "ce n'est pas moi", signed with the current passkey. */
  cancelRecovery(id: string): Promise<Result<void, UiError>>;
}
