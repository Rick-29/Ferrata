import { err, ok, sdkError } from '@sqw/sdk';
import type { OwnerKey } from '@sqw/types/OwnerKey';
import type { OwnerSignature } from '@sqw/types/OwnerSignature';
import type { PairingState } from '@sqw/types/PairingState';
import type { RecoveryState } from '@sqw/types/RecoveryState';
import type { KycScript, RecoveryService, ServiceResult } from './RecoveryService';

/** The fake world's timelock (the backend's demo base is 30 s). */
const FAKE_TIMELOCK_SECS = 30;
const DEMO_ADDRESS = '0x5a11e7000000000000000000000000000000a11c';
const DEMO_NEW_OWNER: OwnerKey = { kind: 'ed25519', key: `0x${'22'.repeat(32)}` };

const nowSecs = (): number => Math.floor(Date.now() / 1000);

/** Offline stand-in mirroring `backend/sq-services/src/{pairing,recovery}.rs`. Demo only. */
export class FakeRecoveryService implements RecoveryService {
  #loggedIn = false;

  async login(username: string, password: string): ServiceResult<{ readonly displayName: string }> {
    if (!['alice', 'mallory'].includes(username) || password !== 'demo') {
      return err(sdkError('UNAUTHORIZED', 'swissquote', 'bad credentials', 401));
    }
    this.#loggedIn = true;
    return ok({ displayName: username === 'alice' ? 'Alice Keller' : 'Mallory (attacker persona)' });
  }

  async offerPairingKey(pairingId: string, key: OwnerKey, deviceLabel: string): ServiceResult<PairingState> {
    if (!this.#loggedIn) return err(sdkError('UNAUTHORIZED', 'swissquote', 'login first', 401));
    return ok({ id: pairingId, address: DEMO_ADDRESS, expires_at: nowSecs() + 600, key, fingerprint: null, device_label: deviceLabel });
  }

  async recovery(id: string): ServiceResult<RecoveryState> {
    if (!this.#loggedIn) return err(sdkError('UNAUTHORIZED', 'swissquote', 'login first', 401));
    return ok(this.#state(id, { state: 'prepared', expires_at: nowSecs() + 900 }, false));
  }

  async startRecovery(id: string, _signature: OwnerSignature, kyc: { readonly script: KycScript; readonly fullName: string }): ServiceResult<RecoveryState> {
    if (!this.#loggedIn) return err(sdkError('UNAUTHORIZED', 'swissquote', 'login first', 401));
    const passed = kyc.script === 'kyc-pass';
    return ok(
      this.#state(
        id,
        passed ? { state: 'pending', unlock_at: nowSecs() + FAKE_TIMELOCK_SECS } : { state: 'rejected', reason: 'identity check failed: face does not match ID' },
        passed,
      ),
    );
  }

  #state(id: string, status: RecoveryState['status'], passed: boolean): RecoveryState {
    return {
      id,
      address: DEMO_ADDRESS,
      new_owner: DEMO_NEW_OWNER,
      status,
      started_at: nowSecs(),
      kyc_passed: passed,
      cancel_hash: `0x${'0'.repeat(64)}`,
      recovery_hash: `0x${'d'.repeat(64)}`,
      recovery_signature: null,
      risk: passed ? { score: 0, band: 'Low', reasons: ['Aucun signal particulier : délai minimal.'], delay_secs: FAKE_TIMELOCK_SECS } : null,
      contested: false,
    };
  }
}
