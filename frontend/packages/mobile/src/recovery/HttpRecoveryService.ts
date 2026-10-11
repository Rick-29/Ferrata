import { HttpSwissquoteApi, ok, type SwissquoteApi } from '@sqw/sdk';
import type { OwnerKey } from '@sqw/types/OwnerKey';
import type { OwnerSignature } from '@sqw/types/OwnerSignature';
import type { PairingState } from '@sqw/types/PairingState';
import type { RecoveryState } from '@sqw/types/RecoveryState';
import type { KycScript, RecoveryService, ServiceResult } from './RecoveryService';

/**
 * Recovery phone against the real backend. The session token lives only in this object's memory:
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

  offerPairingKey(pairingId: string, key: OwnerKey, deviceLabel: string): ServiceResult<PairingState> {
    return this.#api.offerPairingKey(pairingId, { key, device_label: deviceLabel });
  }

  recovery(id: string): ServiceResult<RecoveryState> {
    return this.#api.recovery(id);
  }

  startRecovery(id: string, signature: OwnerSignature, kyc: { readonly script: KycScript; readonly fullName: string }): ServiceResult<RecoveryState> {
    return this.#api.startRecovery({ id, recovery_signature: signature, kyc: { script_id: kyc.script, full_name: kyc.fullName } });
  }
}
