// Messages from the background (which holds the session and builds what to sign) to an extension
// page (popup or approval window), which alone can run WebAuthn: browsers do not expose
// navigator.credentials in a service worker (Middleware Spec, platform constraints).

export const PASSKEY_CHANNEL = 'sqw-passkey';

export type PasskeyRequest =
  | { readonly channel: typeof PASSKEY_CHANNEL; readonly op: 'create'; readonly userName: string }
  | { readonly channel: typeof PASSKEY_CHANNEL; readonly op: 'sign'; readonly credentialId: string; readonly hash: string };

/** What a new credential gives back: its id (base64url) and the uncompressed P-256 public key (0x04…, hex). */
export interface CreatedPasskey {
  readonly credentialId: string;
  readonly publicKey: string;
}

/** Raw `navigator.credentials.get` output, hex, as the backend's WebAuthn verifier expects it. */
export interface PasskeyAssertion {
  readonly authenticator_data: string;
  readonly client_data_json: string;
  /** DER-encoded ECDSA signature. */
  readonly signature: string;
}

export type PasskeyErrorCode = 'PASSKEY_CANCELLED' | 'PASSKEY_UNSUPPORTED' | 'PASSKEY_UNAVAILABLE' | 'PASSKEY_FAILED';

export type PasskeyResponse<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: PasskeyErrorCode; readonly message: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

export function isPasskeyRequest(v: unknown): v is PasskeyRequest {
  if (!isRecord(v) || v.channel !== PASSKEY_CHANNEL) return false;
  if (v.op === 'create') return typeof v.userName === 'string';
  if (v.op === 'sign') return typeof v.credentialId === 'string' && typeof v.hash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v.hash);
  return false;
}
