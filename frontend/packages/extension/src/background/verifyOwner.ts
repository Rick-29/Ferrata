import { ed25519 } from '@noble/curves/ed25519';
import { p256 } from '@noble/curves/p256';
import { sha256 } from '@noble/hashes/sha2';
import type { OwnerKey } from '@sqw/types/OwnerKey';
import type { OwnerSignature } from '@sqw/types/OwnerSignature';

// Client-side twin of the backend's `verify_owner` (sq-adapters/src/chain/auth.rs): checks that the
// owner's passkey really signed `hash`. Used where the background itself must be sure the user
// approved an action (testnet sends), instead of trusting whatever an extension page answered.

export function verifyOwner(owner: OwnerKey, hash: string, signature: OwnerSignature): boolean {
  try {
    const digest = hexToBytes(hash);
    if (owner.kind === 'ed25519' && signature.kind === 'ed25519') {
      return ed25519.verify(hexToBytes(signature.signature), digest, hexToBytes(owner.key));
    }
    if (owner.kind === 'p256' && signature.kind === 'webauthn') {
      const clientData = JSON.parse(new TextDecoder().decode(hexToBytes(signature.client_data_json))) as {
        type?: unknown;
        challenge?: unknown;
      };
      if (clientData.type !== 'webauthn.get' || clientData.challenge !== toBase64Url(digest)) return false;
      const authenticatorData = hexToBytes(signature.authenticator_data);
      // User present (UP, bit 0). Not UV (bit 2): synced passkeys (e.g. Google Password Manager,
      // flags BE|BS) were seen answering UV=0 although the request said `userVerification: 'required'`.
      if (((authenticatorData[32] ?? 0) & 0x01) === 0) return false;
      const signed = concat(authenticatorData, sha256(hexToBytes(signature.client_data_json)));
      return p256.verify(hexToBytes(signature.signature), sha256(signed), hexToBytes(owner.key), {
        format: 'der',
        lowS: false, // authenticators do not normalise S
      });
    }
    return false;
  } catch {
    return false;
  }
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) throw new Error('bad hex');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function toBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
