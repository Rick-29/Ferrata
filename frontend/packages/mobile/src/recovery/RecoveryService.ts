import type { OwnerKey } from '@sqw/types/OwnerKey';
import type { OwnerSignature } from '@sqw/types/OwnerSignature';
import type { PairingState } from '@sqw/types/PairingState';
import type { RecoveryState } from '@sqw/types/RecoveryState';
import type { Result, SdkError } from '@sqw/sdk';

export type ServiceResult<T> = Promise<Result<T, SdkError>>;

/** The two scripted outcomes of `fixtures/kyc-scripts.json` ("Simulated video identification"). */
export type KycScript = 'kyc-pass' | 'kyc-fail';

/**
 * Everything the recovery phone needs. Two jobs: be associated as the wallet's recovery phone
 * (pairing), and approve a recovery started on a new computer (signature + KYC). The phone never
 * becomes the wallet's owner and never moves funds. Real implementation over the SDK, fake one
 * for offline demos. The phone's key itself lives in device/deviceKey.ts (biometric-gated).
 */
export interface RecoveryService {
  login(username: string, password: string): ServiceResult<{ readonly displayName: string }>;
  /** Pairing: drop this phone's public key on the extension's pairing. */
  offerPairingKey(pairingId: string, key: OwnerKey, deviceLabel: string): ServiceResult<PairingState>;
  /** The recovery the new computer prepared (wallet, its new passkey, what to sign). */
  recovery(id: string): ServiceResult<RecoveryState>;
  /** Approve it: the recovery key's signature over `recovery_hash`, and the identity check. */
  startRecovery(id: string, signature: OwnerSignature, kyc: { readonly script: KycScript; readonly fullName: string }): ServiceResult<RecoveryState>;
}
