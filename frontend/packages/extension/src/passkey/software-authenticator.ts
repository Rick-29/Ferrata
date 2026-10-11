import { assertionToOwnerSignature, spkiToOwnerKey, toBase64Url } from './encoding';
import type { CreateResponse, PasskeyRequest, PasskeyResponse, SignResponse } from './protocol';

// TEST ONLY. A software stand-in for a platform authenticator that produces byte-for-byte what a
// browser returns (clientDataJSON, authenticatorData, DER signature), so the WebAuthn path can be
// checked against the real backend without a fingerprint reader. Never bundled in the extension.

const ORIGIN = 'chrome-extension://software-authenticator-test';
const FLAG_USER_PRESENT_AND_VERIFIED = 0x05;

/** ASN.1 DER for an ECDSA (r, s) pair, as authenticators return it. */
function rawToDer(raw: Uint8Array): Uint8Array {
  const integer = (bytes: Uint8Array): number[] => {
    let i = 0;
    while (i < bytes.length - 1 && bytes[i] === 0) i += 1;
    const trimmed = Array.from(bytes.slice(i));
    return (trimmed[0] ?? 0) & 0x80 ? [0, ...trimmed] : trimmed;
  };
  const r = integer(raw.slice(0, 32));
  const s = integer(raw.slice(32));
  return Uint8Array.from([0x30, r.length + s.length + 4, 0x02, r.length, ...r, 0x02, s.length, ...s]);
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(data)));
}

function hexToBytes(hex: string): Uint8Array {
  const body = hex.replace(/^0x/, '');
  return Uint8Array.from({ length: body.length / 2 }, (_, i) => parseInt(body.slice(i * 2, i * 2 + 2), 16));
}

export class SoftwareAuthenticator {
  readonly #keys = new Map<string, CryptoKeyPair>();

  /** Plays the role of the extension page answering the background's passkey requests. */
  readonly answer = async (request: PasskeyRequest): Promise<PasskeyResponse<unknown>> =>
    request.op === 'create' ? this.#create() : this.#sign(request.credentialId, request.hash);

  async #create(): Promise<CreateResponse> {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const credentialId = toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
    this.#keys.set(credentialId, pair);
    const spki = await crypto.subtle.exportKey('spki', pair.publicKey);
    return { ok: true, value: { credentialId, owner: await spkiToOwnerKey(spki) } };
  }

  async #sign(credentialId: string, hash: string): Promise<SignResponse> {
    const pair = this.#keys.get(credentialId);
    if (!pair) return { ok: false, error: { code: 'PASSKEY_UNKNOWN', message: 'unknown credential' } };
    const clientData = new TextEncoder().encode(
      JSON.stringify({ type: 'webauthn.get', challenge: toBase64Url(hexToBytes(hash)), origin: ORIGIN }),
    );
    const rpIdHash = await sha256(new TextEncoder().encode('software-authenticator-test'));
    const authData = Uint8Array.from([...rpIdHash, FLAG_USER_PRESENT_AND_VERIFIED, 0, 0, 0, 1]);
    const signed = Uint8Array.from([...authData, ...(await sha256(clientData))]);
    const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, signed));
    return { ok: true, value: assertionToOwnerSignature(authData, clientData, rawToDer(raw)) };
  }
}
