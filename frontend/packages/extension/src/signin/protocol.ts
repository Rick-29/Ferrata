// Website sign-in through the extension (option A): the Ferrata website asks `sqw_signIn`, the
// background opens the approval window, which runs the usual login + passkey unlock, then reports
// back on this channel. Only extension pages use it; web pages go through the dApp provider.

export const SIGNIN_CHANNEL = 'sqw-signin';

export type SignInMessage =
  /** The approval window asks which site is signing in (to show it). */
  | { readonly channel: typeof SIGNIN_CHANNEL; readonly op: 'details'; readonly id: string }
  /** The passkey unlocked the wallet in the approval window: answer the site. */
  | { readonly channel: typeof SIGNIN_CHANNEL; readonly op: 'complete'; readonly id: string }
  | { readonly channel: typeof SIGNIN_CHANNEL; readonly op: 'cancel'; readonly id: string };

export interface SignInDetails {
  readonly origin: string;
}

/** What the website receives. Never the session token. */
export interface SignInResult {
  readonly address: string;
  readonly clientId: string;
  readonly displayName: string;
}

export function isSignInMessage(v: unknown): v is SignInMessage {
  if (typeof v !== 'object' || v === null) return false;
  const m = v as Record<string, unknown>;
  return m.channel === SIGNIN_CHANNEL && typeof m.id === 'string' && (m.op === 'details' || m.op === 'complete' || m.op === 'cancel');
}

/** Query parameter carrying the request id to the approval window. */
export const SIGNIN_PARAM = 'signin';
