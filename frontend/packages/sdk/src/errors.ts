// Middleware Spec, error model: one code travels from where it happens to the screen.

export type Result<T, E> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export type SdkErrorSource = 'core' | 'swissquote' | 'passkey' | 'bundler' | 'chain' | 'network' | 'internal';

/**
 * `code` is the backend's `ApiError.code` for `source: 'swissquote'` (e.g. `UNAUTHORIZED`,
 * `CHAIN_INSUFFICIENT_BALANCE`); the UI prefixes it with `SQ_` for its message table.
 * Plain data (no class) so it crosses `chrome.runtime` messaging unchanged.
 */
export interface SdkError {
  readonly code: string;
  readonly source: SdkErrorSource;
  readonly message: string;
  readonly status?: number;
}

export const sdkError = (code: string, source: SdkErrorSource, message: string, status?: number): SdkError =>
  status === undefined ? { code, source, message } : { code, source, message, status };

/** The service could not be reached at all (server down, offline, CORS). Safe to retry reads. */
export const UNREACHABLE = 'UNREACHABLE';
