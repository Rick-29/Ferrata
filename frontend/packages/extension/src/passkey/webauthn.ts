import { APP_NAME } from '@sqw/brand';
import type { CreatedPasskey, PasskeyAssertion, PasskeyErrorCode, PasskeyResponse } from './protocol';

// The real passkey (frontend_tasks §3, testnet_plan M4): a P-256 key created and kept by the
// platform authenticator (Windows Hello, Touch ID, a security key). The private key never leaves
// it; we only get the public key once, then signatures. Runs in extension pages only.

/** Injected so tests can stand in for the browser's authenticator. */
export interface CredentialsApi {
  create(options: CredentialCreationOptions): Promise<Credential | null>;
  get(options: CredentialRequestOptions): Promise<Credential | null>;
}

const ES256 = -7;

export async function createPasskey(
  userName: string,
  credentials: CredentialsApi = navigator.credentials,
): Promise<PasskeyResponse<CreatedPasskey>> {
  if (typeof PublicKeyCredential === 'undefined') return fail('PASSKEY_UNSUPPORTED', 'WebAuthn is not available here.');
  try {
    const credential = await credentials.create({
      publicKey: {
        // rp.id defaults to this page's origin: the extension id, so no other site can use the key.
        rp: { name: APP_NAME },
        user: { id: crypto.getRandomValues(new Uint8Array(16)), name: userName, displayName: userName },
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        pubKeyCredParams: [{ type: 'public-key', alg: ES256 }],
        authenticatorSelection: { userVerification: 'required', residentKey: 'preferred' },
        attestation: 'none',
        timeout: 120_000,
      },
    });
    if (!(credential instanceof PublicKeyCredential)) return fail('PASSKEY_FAILED', 'No credential returned.');
    const response = credential.response as AuthenticatorAttestationResponse;
    const spki = response.getPublicKey();
    if (spki === null || response.getPublicKeyAlgorithm() !== ES256) {
      return fail('PASSKEY_UNSUPPORTED', 'The authenticator did not create a P-256 (ES256) key.');
    }
    return { ok: true, value: { credentialId: toBase64Url(new Uint8Array(credential.rawId)), publicKey: spkiToRawP256(new Uint8Array(spki)) } };
  } catch (error) {
    return fromDomException(error);
  }
}

/** Signs `hash` (0x…, 32 bytes): WebAuthn signs authenticatorData ‖ SHA-256(clientDataJSON), whose challenge is `hash`. */
export async function signWithPasskey(
  credentialId: string,
  hash: string,
  credentials: CredentialsApi = navigator.credentials,
): Promise<PasskeyResponse<PasskeyAssertion>> {
  if (typeof PublicKeyCredential === 'undefined') return fail('PASSKEY_UNSUPPORTED', 'WebAuthn is not available here.');
  try {
    const credential = await credentials.get({
      publicKey: {
        challenge: hexToBytes(hash),
        allowCredentials: [{ type: 'public-key', id: fromBase64Url(credentialId) }],
        userVerification: 'required',
        timeout: 120_000,
      },
    });
    if (!(credential instanceof PublicKeyCredential)) return fail('PASSKEY_FAILED', 'No assertion returned.');
    const response = credential.response as AuthenticatorAssertionResponse;
    return {
      ok: true,
      value: {
        authenticator_data: toHex(new Uint8Array(response.authenticatorData)),
        client_data_json: toHex(new Uint8Array(response.clientDataJSON)),
        signature: toHex(new Uint8Array(response.signature)),
      },
    };
  } catch (error) {
    return fromDomException(error);
  }
}

/**
 * SubjectPublicKeyInfo for a P-256 key ends with the 65-byte uncompressed point (0x04 ‖ X ‖ Y),
 * which is the form the backend's verifier takes (SEC1).
 */
export function spkiToRawP256(spki: Uint8Array): string {
  const point = spki.slice(spki.length - 65);
  if (point.length !== 65 || point[0] !== 0x04) throw new Error('Unexpected P-256 public key encoding');
  return toHex(point);
}

function fromDomException(error: unknown): PasskeyResponse<never> {
  const name = error instanceof DOMException ? error.name : '';
  // NotAllowedError: the user dismissed the prompt or it timed out.
  if (name === 'NotAllowedError' || name === 'AbortError') return fail('PASSKEY_CANCELLED', 'Passkey prompt dismissed.');
  if (name === 'NotSupportedError' || name === 'SecurityError') return fail('PASSKEY_UNSUPPORTED', `${name}: passkeys are not available here.`);
  return fail('PASSKEY_FAILED', error instanceof Error ? error.message : 'Passkey operation failed.');
}

const fail = (code: PasskeyErrorCode, message: string): PasskeyResponse<never> => ({ ok: false, code, message });

export function toHex(bytes: Uint8Array): string {
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function toBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}
