import { p256 } from '@noble/curves/nist.js';
import { sha256 } from '@noble/hashes/sha2.js';
import type { OwnerSignature } from '@sqw/types/OwnerSignature';

// Pure part of the recovery phone's signature (no Expo import, so it also runs in Node for the
// cross-check with the backend: `backend/sq-adapters/src/chain/auth.rs`, test
// `recovery_phone_assertion_verifies`).

export const toHex = (bytes: Uint8Array): string => `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
export const fromHex = (hex: string): Uint8Array => Uint8Array.from((hex.replace(/^0x/, '').match(/../g) ?? []).map((b) => parseInt(b, 16)));

/**
 * What the phone sends to approve `hash` (the backend's `recovery_hash`). Shaped like a WebAuthn
 * assertion, which is what the backend verifies for a P-256 key: `clientDataJSON` carries the
 * hash as challenge, the signature is DER ECDSA over SHA-256(authenticatorData ‖ SHA-256(clientDataJSON)).
 * Flags: user present + user verified (the biometric check happened before this is called).
 */
export function recoveryAssertion(secret: Uint8Array, hash: string): OwnerSignature {
  const challenge = base64Url(fromHex(hash));
  const clientData = new TextEncoder().encode(JSON.stringify({ type: 'webauthn.get', challenge, origin: 'ferrata-recovery-phone' }));
  const authenticatorData = new Uint8Array(37);
  authenticatorData.set(sha256(new TextEncoder().encode('ferrata-recovery-phone')), 0);
  authenticatorData[32] = 0x05; // UP | UV
  const signed = new Uint8Array([...authenticatorData, ...sha256(clientData)]);
  const signature = p256.sign(signed, secret, { format: 'der' });
  return { kind: 'webauthn', authenticator_data: toHex(authenticatorData), client_data_json: toHex(clientData), signature: toHex(signature) };
}

function base64Url(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = i + 2 < bytes.length ? 4 : i + 1 < bytes.length ? 3 : 2;
    for (let c = 0; c < chars; c++) out += alphabet[(n >> (18 - 6 * c)) & 63];
  }
  return out;
}
