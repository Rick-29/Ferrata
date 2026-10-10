import { APP_NAME } from '@sqw/brand';
import { assertionToOwnerSignature, fromBase64Url, fromHex, spkiToOwnerKey, toBase64Url } from './encoding';
import type { CreateResponse, PasskeyErrorCode, PasskeyFailure, SignResponse } from './protocol';

// The real passkey ceremony, run in an extension page (never in the service worker).
// `userVerification: 'required'`: the authenticator must check the user (fingerprint, face,
// device PIN). The biometric never leaves the device; we only receive a signature.

const ES256 = -7;
const CEREMONY_TIMEOUT_MS = 60_000;
const USER_ID_BYTES = 16;
const CREATE_CHALLENGE_BYTES = 32;

const fail = (code: PasskeyErrorCode, message: string): { readonly ok: false; readonly error: PasskeyFailure } => ({
  ok: false,
  error: { code, message },
});

function toFailure(cause: unknown): { readonly ok: false; readonly error: PasskeyFailure } {
  if (cause instanceof DOMException) {
    switch (cause.name) {
      case 'NotAllowedError':
      case 'AbortError':
        return fail('PASSKEY_CANCELLED', cause.message);
      case 'NotSupportedError':
      case 'SecurityError':
        return fail('PASSKEY_UNSUPPORTED', cause.message);
      default:
        return fail('PASSKEY_FAILED', `${cause.name}: ${cause.message}`);
    }
  }
  return fail('PASSKEY_FAILED', cause instanceof Error ? cause.message : String(cause));
}

export async function createPasskey(userName: string): Promise<CreateResponse> {
  if (!('credentials' in navigator) || typeof PublicKeyCredential === 'undefined') {
    return fail('PASSKEY_UNSUPPORTED', 'WebAuthn is not available in this context');
  }
  try {
    const credential = await navigator.credentials.create({
      publicKey: {
        // The ownership proof is a separate, server-issued challenge signed right after creation.
        challenge: crypto.getRandomValues(new Uint8Array(CREATE_CHALLENGE_BYTES)),
        rp: { name: APP_NAME },
        user: { id: crypto.getRandomValues(new Uint8Array(USER_ID_BYTES)), name: userName, displayName: userName },
        pubKeyCredParams: [{ type: 'public-key', alg: ES256 }],
        authenticatorSelection: { userVerification: 'required', residentKey: 'preferred' },
        attestation: 'none',
        timeout: CEREMONY_TIMEOUT_MS,
      },
    });
    if (!(credential instanceof PublicKeyCredential) || !(credential.response instanceof AuthenticatorAttestationResponse)) {
      return fail('PASSKEY_FAILED', 'unexpected credential type');
    }
    const spki = credential.response.getPublicKey();
    if (!spki) return fail('PASSKEY_UNSUPPORTED', 'authenticator did not expose a public key');
    return { ok: true, value: { credentialId: toBase64Url(credential.rawId), owner: await spkiToOwnerKey(spki) } };
  } catch (cause) {
    return toFailure(cause);
  }
}

/** Signs a 32-byte hash: the browser puts base64url(hash) in clientDataJSON.challenge. */
export async function signWithPasskey(credentialId: string, hash: string): Promise<SignResponse> {
  try {
    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge: fromHex(hash),
        allowCredentials: [{ type: 'public-key', id: fromBase64Url(credentialId) }],
        userVerification: 'required',
        timeout: CEREMONY_TIMEOUT_MS,
      },
    });
    if (!(assertion instanceof PublicKeyCredential) || !(assertion.response instanceof AuthenticatorAssertionResponse)) {
      return fail('PASSKEY_FAILED', 'unexpected assertion type');
    }
    const { authenticatorData, clientDataJSON, signature } = assertion.response;
    return { ok: true, value: assertionToOwnerSignature(authenticatorData, clientDataJSON, signature) };
  } catch (cause) {
    return toFailure(cause);
  }
}
