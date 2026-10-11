import type { OwnerKey } from '@sqw/types/OwnerKey';
import type { OwnerSignature } from '@sqw/types/OwnerSignature';
import type { Result, SdkError, SwissquoteApi } from '@sqw/sdk';

/** Middleware Spec port `PasskeyAuthenticator`, keyed by a stable name per user. */
export interface PasskeySigner {
  /** Creates (or finds again) the key named `name` and returns its public key. */
  create(name: string): Promise<Result<OwnerKey, SdkError>>;
  sign(name: string, hash: string): Promise<Result<OwnerSignature, SdkError>>;
  /** True when this device already holds the key named `name` (then sign-in unlocks instead of creating). */
  has(name: string): Promise<boolean>;
  /**
   * Recovery: a brand-new key under `name`, even if one is recorded. Absent (dev keyring, which is
   * deterministic per name): the bridge falls back to `create`.
   */
  replace?(name: string): Promise<Result<OwnerKey, SdkError>>;
}

/**
 * Stand-in until WebAuthn is wired (frontend_tasks §3): the backend's `/dev/passkeys` keyring.
 * Deterministic per name, held in server memory, demo only.
 */
export class DevPasskeySigner implements PasskeySigner {
  readonly #api: SwissquoteApi;

  constructor(api: SwissquoteApi) {
    this.#api = api;
  }

  async create(name: string): Promise<Result<OwnerKey, SdkError>> {
    const result = await this.#api.devPasskey(name);
    return result.ok ? { ok: true, value: result.value.owner } : result;
  }

  sign(name: string, hash: string): Promise<Result<OwnerSignature, SdkError>> {
    return this.#api.devSign(name, hash);
  }

  /** The dev keyring lives on the server: from the device's point of view there is never a local key. */
  async has(): Promise<boolean> {
    return false;
  }
}
