import type { AccountView } from '@sqw/types/AccountView';
import type { AssessResponse } from '@sqw/types/AssessResponse';
import type { LoginRequest } from '@sqw/types/LoginRequest';
import type { Receipt } from '@sqw/types/Receipt';
import type { Session } from '@sqw/types/Session';
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

/**
 * Swissquote never blocks a transaction because it looks risky: it warns and asks for a double
 * confirmation, and the user decides (see implementation/… Positionnement légal du blocage.md).
 * The only refusal is regulatory (sanctions), and its reason is deliberately not detailed.
 */
export type SendOutcome =
  | { readonly kind: 'confirmed'; readonly txHash: string; readonly receipt: Receipt }
  | { readonly kind: 'confirmation_required'; readonly previewId: string; readonly level: ConfirmationLevel }
  | { readonly kind: 'refused'; readonly reason: 'regulatory' };

/**
 * The only door from the UI to the rest of the system (Frontend Spec: P2 never calls the chain,
 * Rust or Swissquote directly). FakeBridge implements it for now; the real one wraps
 * chrome.runtime messaging to P3's background worker.
 */
export interface UiBridge {
  login(credentials: LoginRequest): Promise<Result<Session, UiError>>;
  createWallet(): Promise<Result<AccountView, UiError>>;
  getWallet(): Promise<Result<AccountView, UiError>>;
  previewSend(draft: SendDraft): Promise<Result<SendPreview, UiError>>;
  /** `stepUp: true` once the user re-confirmed with their passkey after `confirmation_required`. */
  confirmSend(previewId: string, options: { readonly stepUp: boolean }): Promise<Result<SendOutcome, UiError>>;
}
