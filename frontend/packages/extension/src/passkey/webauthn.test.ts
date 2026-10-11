// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpSwissquoteApi } from '@sqw/sdk';
import { MemoryStore } from '../background/storage';
import { verifyOwner } from '../background/verifyOwner';
import { WebAuthnPasskeySigner } from '../background/WebAuthnPasskeySigner';
import { isPasskeyRequest, PASSKEY_CHANNEL, type PasskeyRequest } from './protocol';
import { createPasskey, fromBase64Url, hexToBytes, signWithPasskey, toBase64Url, toHex, type CredentialsApi } from './webauthn';

/**
 * A software authenticator: a real P-256 key in WebCrypto, answering create/get with the exact
 * structures a platform authenticator returns (SPKI public key, authenticatorData, clientDataJSON,
 * DER signature over authenticatorData ‖ SHA-256(clientDataJSON)).
 */
class FakeCredential {}
Object.setPrototypeOf(FakeCredential.prototype, Object.prototype);

class SoftAuthenticator implements CredentialsApi {
  #keys = new Map<string, CryptoKeyPair>();
  dismissed = false;

  async create(): Promise<Credential | null> {
    if (this.dismissed) throw new DOMException('dismissed', 'NotAllowedError');
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const rawId = crypto.getRandomValues(new Uint8Array(16));
    this.#keys.set(toBase64Url(rawId), pair);
    const spki = await crypto.subtle.exportKey('spki', pair.publicKey);
    return credential(rawId, { getPublicKey: () => spki, getPublicKeyAlgorithm: () => -7 });
  }

  async get(options: CredentialRequestOptions): Promise<Credential | null> {
    if (this.dismissed) throw new DOMException('dismissed', 'NotAllowedError');
    const pk = options.publicKey;
    const id = toBase64Url(new Uint8Array(pk?.allowCredentials?.[0]?.id as ArrayBuffer));
    const pair = this.#keys.get(id);
    if (!pair || !pk) throw new DOMException('unknown credential', 'NotAllowedError');
    const challenge = toBase64Url(new Uint8Array(pk.challenge as ArrayBuffer));
    const clientDataJSON = new TextEncoder().encode(
      JSON.stringify({ type: 'webauthn.get', challenge, origin: 'chrome-extension://test', crossOrigin: false }),
    );
    // rpIdHash (32) ‖ flags (UP|UV) ‖ signCount (4)
    const authenticatorData = new Uint8Array(37);
    authenticatorData.set(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('test'))));
    authenticatorData[32] = 0x05;
    const clientHash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientDataJSON));
    const signed = new Uint8Array([...authenticatorData, ...clientHash]);
    const p1363 = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, signed));
    return credential(fromBase64Url(id), {
      authenticatorData: authenticatorData.buffer,
      clientDataJSON: clientDataJSON.buffer,
      signature: p1363ToDer(p1363).buffer,
    });
  }
}

function credential(rawId: Uint8Array, response: object): Credential {
  return Object.assign(Object.create(PublicKeyCredential.prototype) as object, { rawId: rawId.buffer, response }) as unknown as Credential;
}

/** Authenticators return DER; WebCrypto returns r ‖ s. */
function p1363ToDer(sig: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    const v = b.slice(i);
    return (v[0] ?? 0) & 0x80 ? new Uint8Array([0, ...v]) : v;
  };
  const r = int(sig.slice(0, 32));
  const s = int(sig.slice(32));
  return new Uint8Array([0x30, r.length + s.length + 4, 0x02, r.length, ...r, 0x02, s.length, ...s]);
}

beforeAll(() => {
  (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential ??= FakeCredential;
});
afterAll(() => {
  if ((globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential === FakeCredential) {
    delete (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential;
  }
});

/** The signer as wired in the background, with the page side run in-process on the soft authenticator. */
function signerWith(authenticator: SoftAuthenticator) {
  const sent: PasskeyRequest[] = [];
  const signer = new WebAuthnPasskeySigner(new MemoryStore(), async (request) => {
    sent.push(request);
    return request.op === 'create'
      ? createPasskey(request.userName, authenticator)
      : signWithPasskey(request.credentialId, request.hash, authenticator);
  });
  return { signer, sent };
}

const HASH = `0x${'ab'.repeat(32)}`;

describe('WebAuthn passkey', () => {
  it('creates a P-256 owner key (uncompressed SEC1) and reuses it for the same name', async () => {
    const { signer, sent } = signerWith(new SoftAuthenticator());
    const first = await signer.create('passkey-SQ-1');
    expect(first.ok && first.value.kind).toBe('p256');
    expect(first.ok && first.value.key).toMatch(/^0x04[0-9a-f]{128}$/);
    const again = await signer.create('passkey-SQ-1');
    expect(again).toEqual(first);
    expect(sent.filter((r) => r.op === 'create')).toHaveLength(1);
  });

  it('signs with a WebAuthn assertion whose challenge is the hash', async () => {
    const { signer } = signerWith(new SoftAuthenticator());
    await signer.create('p');
    const signed = await signer.sign('p', HASH);
    expect(signed.ok && signed.value.kind).toBe('webauthn');
    if (!signed.ok || signed.value.kind !== 'webauthn') return;
    const clientData = JSON.parse(new TextDecoder().decode(hexToBytes(signed.value.client_data_json))) as { challenge: string };
    expect(clientData.challenge).toBe(toBase64Url(hexToBytes(HASH)));
    expect(signed.value.signature.startsWith('0x30')).toBe(true); // DER
  });

  it('reports a dismissed prompt as PASSKEY_CANCELLED', async () => {
    const authenticator = new SoftAuthenticator();
    const { signer } = signerWith(authenticator);
    authenticator.dismissed = true;
    const result = await signer.create('p');
    expect(!result.ok && result.error).toMatchObject({ code: 'PASSKEY_CANCELLED', source: 'passkey' });
  });

  it('refuses to sign without a passkey on this device, and when no window answers', async () => {
    const { signer } = signerWith(new SoftAuthenticator());
    const none = await signer.sign('unknown', HASH);
    expect(!none.ok && none.error.code).toBe('PASSKEY_UNAVAILABLE');

    const closed = new WebAuthnPasskeySigner(new MemoryStore(), async () => {
      throw new Error('Could not establish connection. Receiving end does not exist.');
    });
    const result = await closed.create('p');
    expect(!result.ok && result.error.code).toBe('PASSKEY_UNAVAILABLE');
  });

  it('only accepts well-formed requests from the background', () => {
    expect(isPasskeyRequest({ channel: PASSKEY_CHANNEL, op: 'sign', credentialId: 'x', hash: HASH })).toBe(true);
    expect(isPasskeyRequest({ channel: PASSKEY_CHANNEL, op: 'sign', credentialId: 'x', hash: '0x12' })).toBe(false);
    expect(isPasskeyRequest({ channel: PASSKEY_CHANNEL, op: 'export' })).toBe(false);
    expect(isPasskeyRequest({ channel: 'other', op: 'create', userName: 'a' })).toBe(false);
  });

  it('hex and base64url helpers round-trip', () => {
    const bytes = new Uint8Array([0, 1, 254, 255, 62, 63]);
    expect(Array.from(fromBase64Url(toBase64Url(bytes)))).toEqual(Array.from(bytes));
    expect(Array.from(hexToBytes(toHex(bytes)))).toEqual(Array.from(bytes));
  });
});

describe('verifyOwner on real WebAuthn assertions (background-side check for testnet sends)', () => {
  it('accepts the owner passkey signature of this hash, and nothing else', async () => {
    const { signer } = signerWith(new SoftAuthenticator());
    const owner = await signer.create('p');
    const signed = await signer.sign('p', HASH);
    if (!owner.ok || !signed.ok) throw new Error('passkey');
    expect(verifyOwner(owner.value, HASH, signed.value)).toBe(true);
    expect(verifyOwner(owner.value, `0x${'cd'.repeat(32)}`, signed.value)).toBe(false); // another transfer

    const other = await signerWith(new SoftAuthenticator()).signer.create('q');
    if (!other.ok) throw new Error('passkey');
    expect(verifyOwner(other.value, HASH, signed.value)).toBe(false); // someone else's passkey
  });

  it('refuses an assertion made without user verification (no biometric / PIN)', async () => {
    const { signer } = signerWith(new SoftAuthenticator());
    const owner = await signer.create('p');
    const signed = await signer.sign('p', HASH);
    if (!owner.ok || !signed.ok || signed.value.kind !== 'webauthn') throw new Error('passkey');
    const data = signed.value.authenticator_data;
    // flags byte (offset 32): clear UV (0x04). The signature no longer matches either, both checks must hold.
    const flags = parseInt(data.slice(2 + 64, 2 + 66), 16) & ~0x04;
    const noUv = { ...signed.value, authenticator_data: `${data.slice(0, 66)}${flags.toString(16).padStart(2, '0')}${data.slice(68)}` };
    expect(verifyOwner(owner.value, HASH, noUv)).toBe(false);
  });
});

// The proof that matters: the live backend accepts these passkey signatures. Skipped unless SQW_E2E=1.
const E2E = process.env['SQW_E2E'] === '1';
const API_URL = process.env['SQW_API_URL'] ?? 'http://localhost:8787';

describe.skipIf(!E2E)('WebAuthn passkey against the real backend', () => {
  it('registers a wallet whose owner is the passkey (ownership proof verified server-side)', async () => {
    let token: string | null = null;
    const api = new HttpSwissquoteApi({ baseUrl: API_URL, token: () => token });
    const session = await api.login({ username: 'alice', password: 'demo' });
    if (!session.ok) throw new Error(session.error.message);
    token = session.value.token;

    const { signer } = signerWith(new SoftAuthenticator());
    const name = 'passkey-e2e-owner';
    const realOwner = await signer.create(name);
    if (!realOwner.ok) throw new Error(realOwner.error.message);
    const fresh = await api.challenge();
    if (!fresh.ok) throw new Error(fresh.error.message);
    const signature = await signer.sign(name, fresh.value.challenge);
    if (!signature.ok) throw new Error(signature.error.message);

    const registered = await api.register({ owner: realOwner.value, challenge: fresh.value.challenge, signature: signature.value });
    expect(registered.ok).toBe(true);

    // And a forged signature (one byte changed) is refused.
    const again = await api.challenge();
    if (!again.ok) throw new Error(again.error.message);
    const good = await signer.sign(name, again.value.challenge);
    if (!good.ok || good.value.kind !== 'webauthn') throw new Error('sign failed');
    const sig = good.value.signature;
    const tampered = { ...good.value, signature: `${sig.slice(0, -2)}${sig.endsWith('00') ? '01' : '00'}` };
    const refused = await api.register({ owner: realOwner.value, challenge: again.value.challenge, signature: tampered });
    expect(refused.ok).toBe(false);
  });
});
