import { HttpSwissquoteApi, ok, type SwissquoteApi } from '@sqw/sdk';
import type { OwnerKey } from '@sqw/types/OwnerKey';
import type { RecoveryState } from '@sqw/types/RecoveryState';
import type { KycScript, NewPasskey, RecoveryService, ServiceResult } from './RecoveryService';

/**
 * Recovery against the real backend. The session token lives only in this object's memory:
 * closing the app means logging in again, which is what a recovery device should do.
 */
export class HttpRecoveryService implements RecoveryService {
  readonly #api: SwissquoteApi;
  #token: string | null = null;

  constructor(baseUrl: string) {
    this.#api = new HttpSwissquoteApi({ baseUrl, token: () => this.#token });
  }

  async login(username: string, password: string): ServiceResult<{ readonly displayName: string }> {
    const session = await this.#api.login({ username, password });
    if (!session.ok) return session;
    this.#token = session.value.token;
    return ok({ displayName: session.value.display_name });
  }

  async createPasskey(): ServiceResult<NewPasskey> {
    // Mock passkey from the backend's /dev keyring until WebAuthn is wired; a fresh name per
    // attempt so this phone never reuses the lost device's key.
    const name = `recovery-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const created = await this.#api.devPasskey(name);
    return created.ok ? ok({ name, owner: created.value.owner }) : created;
  }

  start(address: string, newOwner: OwnerKey, kyc: { readonly script: KycScript; readonly fullName: string }): ServiceResult<RecoveryState> {
    return this.#api.startRecovery({ address, new_owner: newOwner, kyc: { script_id: kyc.script, full_name: kyc.fullName } });
  }

  status(id: string): ServiceResult<RecoveryState> {
    return this.#api.recovery(id);
  }

  execute(id: string): ServiceResult<RecoveryState> {
    return this.#api.executeRecovery(id);
  }
}
