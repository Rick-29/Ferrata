import { err, ok, sdkError } from '@sqw/sdk';
import type { OwnerKey } from '@sqw/types/OwnerKey';
import type { RecoveryState } from '@sqw/types/RecoveryState';
import type { KycScript, RecoveryService, ServiceResult } from './RecoveryService';

/** Shorter than the backend's 120 s so an offline demo does not drag. */
const FAKE_TIMELOCK_SECS = 30;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const nowSecs = (): number => Math.floor(Date.now() / 1000);

/** Offline stand-in mirroring `backend/sq-services/src/recovery.rs`. Demo only. */
export class FakeRecoveryService implements RecoveryService {
  #loggedIn = false;
  #recoveries: ReadonlyMap<string, RecoveryState> = new Map();

  async login(username: string, password: string): ServiceResult<{ readonly displayName: string }> {
    if (!['alice', 'mallory'].includes(username) || password !== 'demo') {
      return err(sdkError('UNAUTHORIZED', 'swissquote', 'bad credentials', 401));
    }
    this.#loggedIn = true;
    return ok({ displayName: username === 'alice' ? 'Alice Keller' : 'Mallory (attacker persona)' });
  }

  async start(address: string, newOwner: OwnerKey, kyc: { readonly script: KycScript; readonly fullName: string }): ServiceResult<RecoveryState> {
    if (!this.#loggedIn) return err(sdkError('UNAUTHORIZED', 'swissquote', 'login first', 401));
    if (!ADDRESS.test(address)) return err(sdkError('BAD_REQUEST', 'swissquote', 'bad address', 400));
    const started = nowSecs();
    const passed = kyc.script === 'kyc-pass';
    const id = `rec-${started.toString(36)}`;
    const state: RecoveryState = {
      id,
      address,
      new_owner: newOwner,
      status: passed
        ? { state: 'pending', unlock_at: started + FAKE_TIMELOCK_SECS }
        : { state: 'rejected', reason: 'simulated video identification failed: face does not match ID' },
      started_at: started,
      kyc_passed: passed,
      cancel_hash: `0x${'0'.repeat(64)}`,
    };
    this.#recoveries = new Map([...this.#recoveries, [id, state]]);
    return ok(state);
  }

  async status(id: string): ServiceResult<RecoveryState> {
    const state = this.#recoveries.get(id);
    return state ? ok(state) : err(sdkError('NOT_FOUND', 'swissquote', id, 404));
  }

  async execute(id: string): ServiceResult<RecoveryState> {
    const state = this.#recoveries.get(id);
    if (!state) return err(sdkError('NOT_FOUND', 'swissquote', id, 404));
    if (state.status.state !== 'pending' || nowSecs() < state.status.unlock_at) {
      return err(sdkError('CONFLICT', 'swissquote', 'timelock active', 409));
    }
    const done: RecoveryState = { ...state, status: { state: 'completed', at: nowSecs(), tx_hash: `0x${'ab'.repeat(32)}` } };
    this.#recoveries = new Map([...this.#recoveries, [id, done]]);
    return ok(done);
  }
}
