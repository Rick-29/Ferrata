import type { OwnerKey } from '@sqw/types/OwnerKey';
import type { OwnerSignature } from '@sqw/types/OwnerSignature';

// Byte formats between WebAuthn (browser) and the backend's `verify_owner` (auth.rs):
// owner key = SEC1 P-256 point, signature = DER ECDSA, clientDataJSON.challenge = base64url(hash).
// All bytes travel as 0x-hex strings, like every other DTO field.

const HEX = /^0x([0-9a-fA-F]{2})*$/;

export function toHex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return `0x${Array.from(view, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  if (!HEX.test(hex)) throw new RangeError('not a 0x-hex byte string');
  const body = hex.slice(2);
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(body.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const b of view) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/**
 * WebAuthn gives the credential public key as SPKI (DER). The backend wants the SEC1 point:
 * WebCrypto re-exports it as the 65-byte uncompressed point, no hand-written ASN.1 parsing.
 */
export async function spkiToOwnerKey(spki: ArrayBuffer): Promise<OwnerKey> {
  const key = await crypto.subtle.importKey('spki', spki, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
  const raw = await crypto.subtle.exportKey('raw', key);
  return { kind: 'p256', key: toHex(raw) };
}

/** `navigator.credentials.get` assertion → the backend's `OwnerSignature::WebAuthn`. The signature is already DER. */
export function assertionToOwnerSignature(
  authenticatorData: ArrayBuffer | Uint8Array,
  clientDataJson: ArrayBuffer | Uint8Array,
  derSignature: ArrayBuffer | Uint8Array,
): OwnerSignature {
  return {
    kind: 'webauthn',
    authenticator_data: toHex(authenticatorData),
    client_data_json: toHex(clientDataJson),
    signature: toHex(derSignature),
  };
}
