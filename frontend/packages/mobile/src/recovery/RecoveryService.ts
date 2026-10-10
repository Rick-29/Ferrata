import type { OwnerKey } from '@sqw/types/OwnerKey';
import type { RecoveryState } from '@sqw/types/RecoveryState';
import type { Result, SdkError } from '@sqw/sdk';

export type ServiceResult<T> = Promise<Result<T, SdkError>>;

/** The two scripted outcomes of `fixtures/kyc-scripts.json` ("Simulated video identification"). */
export type KycScript = 'kyc-pass' | 'kyc-fail';

/**
 * Everything the recovery app needs. One flow only: this phone is the new device of a client who
 * lost access to their wallet. Real implementation over the SDK, fake one for offline demos.
 * The phone's own key is not created here: see device/deviceKey.ts (real key, biometric-gated).
 */
export interface RecoveryService {
  login(username: string, password: string): ServiceResult<{ readonly displayName: string }>;
  start(address: string, newOwner: OwnerKey, kyc: { readonly script: KycScript; readonly fullName: string }): ServiceResult<RecoveryState>;
  status(id: string): ServiceResult<RecoveryState>;
  execute(id: string): ServiceResult<RecoveryState>;
}
