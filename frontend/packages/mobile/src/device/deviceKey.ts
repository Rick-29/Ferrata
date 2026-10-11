import { p256 } from '@noble/curves/nist.js';
import { err, ok, sdkError, type Result, type SdkError } from '@sqw/sdk';
import type { OwnerKey } from '@sqw/types/OwnerKey';
import type { OwnerSignature } from '@sqw/types/OwnerSignature';
import { fromHex, recoveryAssertion, toHex } from './assertion';
import { getRandomBytes } from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { confirmWithBiometrics } from './biometrics';

// The phone's recovery key: registered on the Ferra chain by the wallet's owner (their passkey
// signs it), it approves a recovery, never a payment. REAL, not simulated: a P-256 key generated
// on the phone (@noble/curves, randomness from the OS via expo-crypto), kept in the OS secure
// storage (iOS Keychain / Android Keystore), never sent anywhere, and only created or used after
// a biometric / unlock-code check. Not a FIDO passkey (Expo Go cannot create those): it answers in
// the WebAuthn assertion format the backend verifies for P-256 owners (see `signAsRecoveryKey`).

const STORE_KEY = 'ferrata.device-key.v1';
const SEED_BYTES = 48; // ≥ 40 bytes so the scalar is uniformly distributed (noble randomSecretKey)

export interface DeviceKey {
  readonly owner: OwnerKey;
}

const failed = (cause: unknown): SdkError => sdkError('DEVICE_KEY_FAILED', 'passkey', cause instanceof Error ? cause.message : String(cause));

async function readSecret(): Promise<Uint8Array | null> {
  const stored = await SecureStore.getItemAsync(STORE_KEY);
  return stored ? fromHex(stored) : null;
}

const ownerOf = (secret: Uint8Array): DeviceKey => ({ owner: { kind: 'p256', key: toHex(p256.getPublicKey(secret, false)) } });

/** The phone's key if it already has one (public part only; no biometric needed to read it). */
export async function loadDeviceKey(): Promise<DeviceKey | null> {
  try {
    const secret = await readSecret();
    return secret ? ownerOf(secret) : null;
  } catch {
    return null;
  }
}

/** Creates the phone's key, after the user confirms with Face ID / fingerprint / code. Replaces any older one. */
export async function createDeviceKey(): Promise<Result<DeviceKey, SdkError>> {
  const confirmed = await confirmWithBiometrics('Créer la clé de secours de ce téléphone');
  if (!confirmed.ok) return confirmed;
  try {
    const secret = p256.utils.randomSecretKey(getRandomBytes(SEED_BYTES));
    await SecureStore.setItemAsync(STORE_KEY, toHex(secret).slice(2), {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
    return ok(ownerOf(secret));
  } catch (cause) {
    return err(failed(cause));
  }
}

/**
 * Approves a recovery: signs `hash` (the backend's `recovery_hash`) after a biometric check.
 * Shaped like a WebAuthn assertion, which is what the backend verifies for a P-256 key:
 * `clientDataJSON` carries the hash as challenge, the signature is DER ECDSA over
 * SHA-256(authenticatorData ‖ SHA-256(clientDataJSON)). Flags: user present + user verified.
 */
export async function signAsRecoveryKey(hash: string): Promise<Result<OwnerSignature, SdkError>> {
  const confirmed = await confirmWithBiometrics('Approuver la récupération du wallet');
  if (!confirmed.ok) return confirmed;
  try {
    const secret = await readSecret();
    if (!secret) return err(sdkError('DEVICE_KEY_MISSING', 'passkey', 'no recovery key on this phone'));
    return ok(recoveryAssertion(secret, hash));
  } catch (cause) {
    return err(failed(cause));
  }
}
