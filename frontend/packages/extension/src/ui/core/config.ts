// Build-time switches (Vite env). Read here once so widgets and the background agree.

/**
 * `webauthn` (default): real passkeys, verified by the device (fingerprint, face, PIN).
 * `dev`: the backend's /dev keyring, a SIMULATED passkey for tests and machines without an authenticator.
 */
export const PASSKEY_MODE: 'webauthn' | 'dev' = import.meta.env.VITE_PASSKEY === 'dev' ? 'dev' : 'webauthn';

export const isSimulatedPasskey = PASSKEY_MODE === 'dev';
