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
}

/**
 * Swissquote never blocks a transaction because it looks risky: it warns and asks for a double
 * confirmation, and the user decides (see implementation/… Positionnement légal du blocage.md).
 * The only refusal is regulatory (sanctions), and its reason is deliberately not detailed.
 */
export type SendOutcome =
  | { readonly kind: 'confirmed'; readonly txHash: string; readonly receipt: Receipt }
  | { readonly kind: 'confirmation_required'; readonly previewId: string; readonly level: ConfirmationLevel }
  | { readonly kind: 'refused'; readonly reason: 'regulatory' };

/** Public test networks the wallet holds an address on (testnet_plan M3, M8). */
export type TestnetNetwork = 'solana-devnet' | 'base-sepolia' | 'eth-sepolia';

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
}
