// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { WebAuthnPasskeySigner } from '../background/WebAuthnPasskeySigner';
import { MemoryStore } from '../background/storage';
import { fromBase64Url, fromHex, spkiToOwnerKey, toBase64Url, toHex } from './encoding';
import type { PasskeyRequest } from './protocol';
import { SoftwareAuthenticator } from './software-authenticator';

const HASH = `0x${'ab'.repeat(32)}`;

describe('passkey encoding', () => {
  it('round-trips hex and base64url', () => {
    const bytes = Uint8Array.from([0, 1, 254, 255, 62, 63]);
    expect(fromHex(toHex(bytes))).toEqual(bytes);
    expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
    expect(toBase64Url(bytes)).not.toMatch(/[+/=]/);
  });

  it('rejects malformed hex instead of guessing', () => {
    expect(() => fromHex('0xabc')).toThrow(RangeError);
    expect(() => fromHex('abcd')).toThrow(RangeError);
  });

  it('turns a WebAuthn SPKI public key into the SEC1 point the backend expects', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
    const owner = await spkiToOwnerKey(await crypto.subtle.exportKey('spki', pair.publicKey));
    expect(owner.kind).toBe('p256');
    expect(owner.key).toMatch(/^0x04[0-9a-f]{128}$/); // uncompressed point, 65 bytes
  });
});

describe('WebAuthnPasskeySigner', () => {
  it('creates one passkey per wallet and reuses it afterwards', async () => {
    const authenticator = new SoftwareAuthenticator();
    const send = vi.fn((request: PasskeyRequest) => authenticator.answer(request));
    const signer = new WebAuthnPasskeySigner(send, new MemoryStore());

    const first = await signer.create('alice');
    const again = await signer.create('alice');

    expect(first.ok && again.ok && first.value).toEqual(again.ok && again.value);
    expect(send).toHaveBeenCalledOnce();
  });

  it('signs with the stored credential and returns a WebAuthn signature', async () => {
    const authenticator = new SoftwareAuthenticator();
    const signer = new WebAuthnPasskeySigner((r) => authenticator.answer(r), new MemoryStore());
    await signer.create('alice');

    const signed = await signer.sign('alice', HASH);

    expect(signed.ok && signed.value.kind).toBe('webauthn');
  });

  it('refuses to sign for a wallet it has no passkey for', async () => {
    const signer = new WebAuthnPasskeySigner(async () => ({}), new MemoryStore());
    const signed = await signer.sign('nobody', HASH);
    expect(!signed.ok && signed.error.code).toBe('PASSKEY_UNKNOWN');
  });

  it('reports a closed popup as unavailable, not as a crash', async () => {
    const signer = new WebAuthnPasskeySigner(async () => {
      throw new Error('Could not establish connection. Receiving end does not exist.');
    }, new MemoryStore());
    const created = await signer.create('alice');
    expect(!created.ok && created.error).toMatchObject({ code: 'PASSKEY_UNAVAILABLE', source: 'passkey' });
  });

  it('passes the user cancelling the biometric prompt through as PASSKEY_CANCELLED', async () => {
    const signer = new WebAuthnPasskeySigner(
      async () => ({ ok: false, error: { code: 'PASSKEY_CANCELLED', message: 'NotAllowedError' } }),
      new MemoryStore(),
    );
    const created = await signer.create('alice');
    expect(!created.ok && created.error.code).toBe('PASSKEY_CANCELLED');
  });

  it('rejects a malformed answer from a page', async () => {
    const authenticator = new SoftwareAuthenticator();
    let created = false;
    const signer = new WebAuthnPasskeySigner(async (request) => {
      if (request.op === 'create' && !created) {
        created = true;
        return authenticator.answer(request);
      }
      return { ok: true, value: { kind: 'webauthn', signature: 'not-hex' } };
    }, new MemoryStore());
    await signer.create('alice');
    const signed = await signer.sign('alice', HASH);
    expect(!signed.ok && signed.error.code).toBe('PASSKEY_FAILED');
  });
});
