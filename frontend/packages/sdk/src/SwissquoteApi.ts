import type { AssessRequest } from '@sqw/types/AssessRequest';
import type { AssessResponse } from '@sqw/types/AssessResponse';
import type { ChainInfo } from '@sqw/types/ChainInfo';
import type { ChallengeResponse } from '@sqw/types/ChallengeResponse';
import type { CosignOutcome } from '@sqw/types/CosignOutcome';
import type { CosignRequest } from '@sqw/types/CosignRequest';
import type { DevPasskey } from '@sqw/types/DevPasskey';
import type { FaucetRequest } from '@sqw/types/FaucetRequest';
import type { HashResponse } from '@sqw/types/HashResponse';
import type { HistoryResponse } from '@sqw/types/HistoryResponse';
import type { IntentState } from '@sqw/types/IntentState';
import type { LoginRequest } from '@sqw/types/LoginRequest';
import type { LogResponse } from '@sqw/types/LogResponse';
import type { OwnerKey } from '@sqw/types/OwnerKey';
import type { OwnerSignature } from '@sqw/types/OwnerSignature';
import type { PairingKeyRequest } from '@sqw/types/PairingKeyRequest';
import type { PairingState } from '@sqw/types/PairingState';
import type { PrepareRecoveryRequest } from '@sqw/types/PrepareRecoveryRequest';
import type { RecoveryKeyResponse } from '@sqw/types/RecoveryKeyResponse';
import type { RecoveryState } from '@sqw/types/RecoveryState';
import type { SetRecoveryKeyRequest } from '@sqw/types/SetRecoveryKeyRequest';
import type { RegisterWalletRequest } from '@sqw/types/RegisterWalletRequest';
import type { RegisterWalletResponse } from '@sqw/types/RegisterWalletResponse';
import type { Session } from '@sqw/types/Session';
import type { SetSettingsRequest } from '@sqw/types/SetSettingsRequest';
import type { SettingsResponse } from '@sqw/types/SettingsResponse';
import type { SignedUserOp } from '@sqw/types/SignedUserOp';
import type { StartRecoveryRequest } from '@sqw/types/StartRecoveryRequest';
import type { SubmitResult } from '@sqw/types/SubmitResult';
import type { SyncRequest } from '@sqw/types/SyncRequest';
import type { SyncResponse } from '@sqw/types/SyncResponse';
import type { WalletOverview } from '@sqw/types/WalletOverview';
import type { WalletSettings } from '@sqw/types/WalletSettings';
import type { Result, SdkError } from './errors';

type Call<T> = Promise<Result<T, SdkError>>;

/**
 * Port for P1's Axum service (Middleware Spec, ports). One method per endpoint the extension
 * uses today; `HttpSwissquoteApi` is the only implementation that talks HTTP.
 *
 * Not yet here because the backend does not serve them: `linkAddress` (B2), `ingest` with
 * `linked` (B4), `assessExternal` (B6), the events stream (B8).
 */
export interface SwissquoteApi {
  login(credentials: LoginRequest): Call<Session>;
  chainInfo(): Call<ChainInfo>;

  challenge(): Call<ChallengeResponse>;
  register(request: RegisterWalletRequest): Call<RegisterWalletResponse>;
  overview(owner: OwnerKey): Call<WalletOverview>;
  /** Demo funding on the Ferra chain. Public endpoint. */
  faucet(request: FaucetRequest): Call<SubmitResult>;

  assess(request: AssessRequest): Call<AssessResponse>;
  cosign(request: CosignRequest): Call<CosignOutcome>;
  cancelIntent(address: string, intentId: string): Call<IntentState>;
  submit(op: SignedUserOp): Call<SubmitResult>;

  log(address: string): Call<LogResponse>;
  history(address: string): Call<HistoryResponse>;
  /** Pull one page of another network's history for `address_raw` onto the Ferra chain. Public endpoint. */
  sync(request: SyncRequest): Call<SyncResponse>;

  settings(address: string): Call<SettingsResponse>;
  settingsHash(address: string, settings: WalletSettings): Call<HashResponse>;
  setSettings(address: string, request: SetSettingsRequest): Call<SettingsResponse>;

  /** The account's recovery key (the user's phone), registered by the owner on the Ferra chain. */
  recoveryKey(address: string): Call<RecoveryKeyResponse>;
  recoveryKeyHash(address: string, key: OwnerKey): Call<HashResponse>;
  setRecoveryKey(address: string, request: SetRecoveryKeyRequest): Call<RecoveryKeyResponse>;

  /** Pairing relay for the recovery phone: the extension opens it, the phone drops its public key. */
  startPairing(address: string): Call<PairingState>;
  pairing(id: string): Call<PairingState>;
  offerPairingKey(id: string, request: PairingKeyRequest): Call<PairingState>;

  /**
   * Recovery (KYC mandatory): `prepare` on the new device (new passkey) → the phone signs
   * `recovery_hash` and passes KYC in `start` → smart-delay timelock → `execute`, or `cancel`
   * from the current passkey (not for a contested recovery).
   */
  /** The wallets of the signed-in client: the new device picks the one to recover. */
  recoverableWallets(): Call<readonly string[]>;
  prepareRecovery(request: PrepareRecoveryRequest): Call<RecoveryState>;
  startRecovery(request: StartRecoveryRequest): Call<RecoveryState>;
  /** Recoveries of a wallet, newest first (the existing device's alert). */
  recoveries(address: string): Call<readonly RecoveryState[]>;
  recovery(id: string): Call<RecoveryState>;
  cancelRecovery(id: string, signature: OwnerSignature): Call<RecoveryState>;
  executeRecovery(id: string): Call<RecoveryState>;

  /** Mock passkeys under `/dev` until WebAuthn is wired. Deterministic per name, labelled dev. */
  devPasskey(name: string): Call<DevPasskey>;
  devSign(name: string, hash: string): Call<OwnerSignature>;
}
