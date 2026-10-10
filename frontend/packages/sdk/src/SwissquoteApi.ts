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
import type { RecoveryState } from '@sqw/types/RecoveryState';
import type { RegisterWalletRequest } from '@sqw/types/RegisterWalletRequest';
import type { RegisterWalletResponse } from '@sqw/types/RegisterWalletResponse';
import type { Session } from '@sqw/types/Session';
import type { SetSettingsRequest } from '@sqw/types/SetSettingsRequest';
import type { SettingsResponse } from '@sqw/types/SettingsResponse';
import type { SignedUserOp } from '@sqw/types/SignedUserOp';
import type { StartRecoveryRequest } from '@sqw/types/StartRecoveryRequest';
import type { SubmitResult } from '@sqw/types/SubmitResult';
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

  settings(address: string): Call<SettingsResponse>;
  settingsHash(address: string, settings: WalletSettings): Call<HashResponse>;
  setSettings(address: string, request: SetSettingsRequest): Call<SettingsResponse>;

  /** Device recovery: new passkey + simulated KYC → timelock → execute (or cancel from an existing device). */
  startRecovery(request: StartRecoveryRequest): Call<RecoveryState>;
  recovery(id: string): Call<RecoveryState>;
  cancelRecovery(id: string, signature: OwnerSignature): Call<RecoveryState>;
  executeRecovery(id: string): Call<RecoveryState>;

  /** Mock passkeys under `/dev` until WebAuthn is wired. Deterministic per name, labelled dev. */
  devPasskey(name: string): Call<DevPasskey>;
  devSign(name: string, hash: string): Call<OwnerSignature>;
}
