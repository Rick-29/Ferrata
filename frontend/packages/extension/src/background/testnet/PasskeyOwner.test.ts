// @vitest-environment node
import { p256 } from '@noble/curves/p256';
import { sha256 } from '@noble/hashes/sha2';
import { ok } from '@sqw/sdk';
import type { OwnerSignature } from '@sqw/types/OwnerSignature';
import { createPublicClient, http } from 'viem';
import { toCoinbaseSmartAccount } from 'viem/account-abstraction';
import { baseSepolia } from 'viem/chains';
import { describe, expect, it } from 'vitest';
import { passkeyOwner, type SignHash } from './PasskeyOwner';

const hex = (b: Uint8Array): string => `0x${Buffer.from(b).toString('hex')}`;

/** A software stand-in for the authenticator: what the extension page returns for `hash`. */
function softPasskey() {
  const secret = p256.utils.randomPrivateKey();
  const credential = { credentialId: Buffer.from('ferrata-test-credential').toString('base64url'), publicKey: hex(p256.getPublicKey(secret, false)) };
  const signHash: SignHash = async (hash) => {
    const clientData = Buffer.from(
      JSON.stringify({ type: 'webauthn.get', challenge: Buffer.from(hash.slice(2), 'hex').toString('base64url'), origin: 'chrome-extension://test', crossOrigin: false }),
    );
    const authenticatorData = new Uint8Array(37);
    authenticatorData.set(sha256(new TextEncoder().encode('test')), 0);
    authenticatorData[32] = 0x05;
    const signed = new Uint8Array([...authenticatorData, ...sha256(clientData)]);
    const der = p256.sign(sha256(signed), secret).toDERRawBytes();
    const signature: OwnerSignature = { kind: 'webauthn', authenticator_data: hex(authenticatorData), client_data_json: hex(clientData), signature: hex(der) };
    return ok(signature);
  };
  return { credential, signHash };
}

describe('passkeyOwner', () => {
  it('turns the page’s WebAuthn answer into a viem WebAuthn signature for the challenge viem chose', async () => {
    const { credential, signHash } = softPasskey();
    const owner = passkeyOwner(credential, signHash);
    expect(owner.publicKey).toHaveLength(2 + 128);
    const { webauthn, signature } = await owner.sign({ hash: `0x${'ab'.repeat(32)}` });
    expect(JSON.parse(webauthn.clientDataJSON).challenge).toBe(Buffer.from('ab'.repeat(32), 'hex').toString('base64url'));
    expect(signature).toMatch(/^0x[0-9a-f]+$/);
  });
});

// Live: the Coinbase Smart Wallet contracts on Base Sepolia accept the passkey-owned signature
// (ERC-6492: the account is not deployed, viem validates it deploylessly). Skipped unless SQW_BASE=1.
describe.skipIf(process.env['SQW_BASE'] !== '1')('passkey-owned smart account on Base Sepolia', () => {
  it('signs a message that the smart account verifies on chain', async () => {
    const { credential, signHash } = softPasskey();
    const client = createPublicClient({ chain: baseSepolia, transport: http('https://sepolia.base.org') });
    const account = await toCoinbaseSmartAccount({ client, owners: [passkeyOwner(credential, signHash)], version: '1.1' });
    const message = 'Ferrata: the passkey owns this account';
    const signature = await account.signMessage({ message });
    expect(await client.verifyMessage({ address: account.address, message, signature })).toBe(true);
    expect(await client.verifyMessage({ address: account.address, message: 'something else', signature })).toBe(false);
  }, 60_000);
});
