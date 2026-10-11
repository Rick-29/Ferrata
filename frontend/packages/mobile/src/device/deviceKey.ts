import { p256 } from '@noble/curves/nist.js';
import { err, ok, sdkError, type Result, type SdkError } from '@sqw/sdk';
import type { OwnerKey } from '@sqw/types/OwnerKey';
import { getRandomBytes } from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { confirmWithBiometrics } from './biometrics';

// The phone's own wallet key (recovery: it becomes the account owner). REAL, not simulated:
// a P-256 key generated on the phone (@noble/curves, randomness from the OS via expo-crypto),
// kept in the OS secure storage (iOS Keychain / Android Keystore), never sent anywhere, and
// only created or used after a biometric / unlock-code check. Not a FIDO passkey (Expo Go
// cannot create those), but the same curve and the format the backend already verifies.

const STORE_KEY = 'ferrata.device-key.v1';
const SEED_BYTES = 48; // ≥ 40 bytes so the scalar is uniformly distributed (noble randomSecretKey)

export interface DeviceKey {
  readonly owner: OwnerKey;
}

const toHex = (bytes: Uint8Array): string => `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;

/** Creates a fresh key for this recovery, after the user confirms with Face ID / fingerprint / code. */
export async function createDeviceKey(): Promise<Result<DeviceKey, SdkError>> {
  const confirmed = await confirmWithBiometrics('Créer la clé de ce téléphone');
  if (!confirmed.ok) return confirmed;
  try {
    const secret = p256.utils.randomSecretKey(getRandomBytes(SEED_BYTES));
    await SecureStore.setItemAsync(STORE_KEY, toHex(secret).slice(2), {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
    return ok({ owner: { kind: 'p256', key: toHex(p256.getPublicKey(secret, false)) } });
  } catch (cause) {
    return err(sdkError('DEVICE_KEY_FAILED', 'passkey', cause instanceof Error ? cause.message : String(cause)));
  }
}
