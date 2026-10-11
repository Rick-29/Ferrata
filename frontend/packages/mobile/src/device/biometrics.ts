import { err, ok, sdkError, type Result, type SdkError } from '@sqw/sdk';
import * as LocalAuthentication from 'expo-local-authentication';

/**
 * REAL device user verification: the OS prompt (Face ID, fingerprint, or the unlock code as a
 * fallback). The biometric is checked by the phone; the app only learns success or failure.
 */
export async function confirmWithBiometrics(reason: string): Promise<Result<void, SdkError>> {
  // No enrolled biometric is fine: with the device fallback the OS accepts the unlock code instead.
  const result = await LocalAuthentication.authenticateAsync({
    promptMessage: reason,
    cancelLabel: 'Annuler',
    fallbackLabel: 'Utiliser le code',
    disableDeviceFallback: false,
  });
  if (result.success) return ok(undefined);
  switch (result.error) {
    case 'user_cancel':
    case 'system_cancel':
    case 'app_cancel':
      return err(sdkError('BIOMETRY_CANCELLED', 'passkey', result.error));
    case 'not_enrolled':
    case 'passcode_not_set':
    case 'not_available':
    case 'lockout':
      return err(sdkError('BIOMETRY_UNAVAILABLE', 'passkey', result.error));
    default:
      return err(sdkError('BIOMETRY_FAILED', 'passkey', result.error));
  }
}
