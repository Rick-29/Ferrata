import Constants from 'expo-constants';
import { FakeRecoveryService } from './recovery/FakeRecoveryService';
import { HttpRecoveryService } from './recovery/HttpRecoveryService';
import type { RecoveryService } from './recovery/RecoveryService';

const BACKEND_PORT = 8787;

/**
 * On a phone, `localhost` is the phone itself. In Expo Go the dev server's host (`hostUri`,
 * e.g. "192.168.1.20:8081") is the PC on the same Wi-Fi, which is also where the backend runs.
 * EXPO_PUBLIC_SQ_API_URL overrides it.
 */
function backendUrl(): string {
  const explicit = process.env.EXPO_PUBLIC_SQ_API_URL;
  if (explicit) return explicit;
  const host = Constants.expoConfig?.hostUri?.split(':')[0];
  return `http://${host ?? 'localhost'}:${BACKEND_PORT}`;
}

/** EXPO_PUBLIC_BRIDGE=fake runs offline on simulated data (no backend needed). */
export const isFake = process.env.EXPO_PUBLIC_BRIDGE === 'fake';

export const apiUrl = isFake ? null : backendUrl();

export function createRecoveryService(): RecoveryService {
  return apiUrl ? new HttpRecoveryService(apiUrl) : new FakeRecoveryService();
}
