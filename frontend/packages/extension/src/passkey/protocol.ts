import type { OwnerKey } from '@sqw/types/OwnerKey';
import type { OwnerSignature } from '@sqw/types/OwnerSignature';

// WebAuthn is not available in the MV3 service worker (Middleware Spec, platform constraints):
// the background asks the open extension page (popup / approval window) to run the passkey
// ceremony and gets the result back over chrome.runtime messaging.

export const PASSKEY_CHANNEL = 'sqw-passkey';

export type PasskeyRequest =
  | { readonly channel: typeof PASSKEY_CHANNEL; readonly op: 'create'; readonly userName: string }
  | { readonly channel: typeof PASSKEY_CHANNEL; readonly op: 'sign'; readonly credentialId: string; readonly hash: string };

export interface CreatedPasskey {
  /** base64url credential id, needed to ask for this exact passkey later. */
  readonly credentialId: string;
  readonly owner: OwnerKey;
}

export interface PasskeyFailure {
  readonly code: PasskeyErrorCode;
  readonly message: string;
}

export type PasskeyErrorCode =
  | 'PASSKEY_CANCELLED'
  | 'PASSKEY_UNSUPPORTED'
  | 'PASSKEY_UNAVAILABLE'
  | 'PASSKEY_UNKNOWN'
  | 'PASSKEY_FAILED';

export type PasskeyResponse<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: PasskeyFailure };

export type CreateResponse = PasskeyResponse<CreatedPasskey>;
export type SignResponse = PasskeyResponse<OwnerSignature>;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

export function isPasskeyRequest(v: unknown): v is PasskeyRequest {
  if (!isRecord(v) || v.channel !== PASSKEY_CHANNEL) return false;
  if (v.op === 'create') return typeof v.userName === 'string';
  if (v.op === 'sign') return typeof v.credentialId === 'string' && typeof v.hash === 'string';
  return false;
}

/** Shape check of a page's answer; the background never trusts message payloads blindly. */
export function isPasskeyResponse(v: unknown): v is PasskeyResponse<unknown> {
  if (!isRecord(v) || typeof v.ok !== 'boolean') return false;
  if (v.ok) return 'value' in v;
  return isRecord(v.error) && typeof v.error.code === 'string' && typeof v.error.message === 'string';
}
