import type { OwnerSignature } from '@sqw/types/OwnerSignature';
import type { Result, SdkError } from '@sqw/sdk';
import { toWebAuthnAccount, type WebAuthnAccount } from 'viem/account-abstraction';

// The client's passkey as the owner of the ERC-4337 smart account on Base Sepolia (Coinbase Smart
// Wallet accepts a WebAuthn P-256 key as an owner and verifies it on chain, with RIP-7212 on Base).
// viem builds and verifies everything; only the WebAuthn ceremony is routed: the background cannot
// call navigator.credentials, so `getFn` asks the open extension page (WebAuthnPasskeySigner) to sign
// the challenge viem chose, and hands the assertion back in the shape viem/ox expect.

export interface PasskeyCredential {
  /** base64url credential id, as stored by WebAuthnPasskeySigner. */
  readonly credentialId: string;
  /** Uncompressed P-256 public key, `0x04‖x‖y`. */
  readonly publicKey: string;
}

/** Signs `hash` (0x…, 32 bytes) with the passkey: challenge = the hash bytes. */
export type SignHash = (hash: string) => Promise<Result<OwnerSignature, SdkError>>;

/** Thrown inside viem when the passkey did not sign; `code` is the passkey error (e.g. PASSKEY_CANCELLED). */
export class PasskeyOwnerError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export function passkeyOwner(credential: PasskeyCredential, signHash: SignHash): WebAuthnAccount {
  const raw = credential.publicKey.replace(/^0x/, '');
  // viem/Coinbase take the 64-byte x‖y point; WebAuthnPasskeySigner stores the 65-byte uncompressed form.
  const point = raw.length === 130 && raw.startsWith('04') ? raw.slice(2) : raw;
  return toWebAuthnAccount({
    credential: { id: credential.credentialId, publicKey: `0x${point}` },
    // Ignored by our getFn (the page uses its own RP id); set so ox never reads window.location.
    rpId: 'ferrata-extension',
    getFn: async (options) => {
      const challenge = options?.publicKey?.challenge;
      if (!challenge) throw new PasskeyOwnerError('PASSKEY_FAILED', 'no challenge to sign');
      const signed = await signHash(toHex(challenge as ArrayBuffer | ArrayBufferView));
      if (!signed.ok) throw new PasskeyOwnerError(signed.error.code, signed.error.message);
      if (signed.value.kind !== 'webauthn') throw new PasskeyOwnerError('PASSKEY_FAILED', 'not a WebAuthn signature');
      // The fields ox reads from a PublicKeyCredential (it copies them right away).
      return {
        id: credential.credentialId,
        type: 'public-key',
        response: {
          authenticatorData: toBuffer(signed.value.authenticator_data),
          clientDataJSON: toBuffer(signed.value.client_data_json),
          signature: toBuffer(signed.value.signature),
        },
      } as unknown as Credential;
    },
  });
}

function toHex(source: ArrayBuffer | ArrayBufferView): string {
  const bytes = source instanceof ArrayBuffer ? new Uint8Array(source) : new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

function toBuffer(hex: string): ArrayBuffer {
  const clean = hex.replace(/^0x/, '');
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return bytes.buffer;
}
