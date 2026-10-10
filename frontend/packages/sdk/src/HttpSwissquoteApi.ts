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
import type { RegisterWalletRequest } from '@sqw/types/RegisterWalletRequest';
import type { RegisterWalletResponse } from '@sqw/types/RegisterWalletResponse';
import type { Session } from '@sqw/types/Session';
import type { SetSettingsRequest } from '@sqw/types/SetSettingsRequest';
import type { SettingsResponse } from '@sqw/types/SettingsResponse';
import type { SignedUserOp } from '@sqw/types/SignedUserOp';
import type { SubmitResult } from '@sqw/types/SubmitResult';
import type { SyncRequest } from '@sqw/types/SyncRequest';
import type { SyncResponse } from '@sqw/types/SyncResponse';
import type { WalletOverview } from '@sqw/types/WalletOverview';
import type { WalletSettings } from '@sqw/types/WalletSettings';
import type { Result, SdkError } from './errors';
import { HttpClient, type HttpClientOptions } from './http';
import type { SwissquoteApi } from './SwissquoteApi';

type Call<T> = Promise<Result<T, SdkError>>;

const seg = encodeURIComponent;

export class HttpSwissquoteApi implements SwissquoteApi {
  readonly #http: HttpClient;

  constructor(options: HttpClientOptions) {
    this.#http = new HttpClient(options);
  }

  login(credentials: LoginRequest): Call<Session> {
    return this.#http.post('/auth/session', credentials);
  }

  chainInfo(): Call<ChainInfo> {
    return this.#http.get('/chain/info');
  }

  challenge(): Call<ChallengeResponse> {
    return this.#http.get('/ownership/challenge');
  }

  register(request: RegisterWalletRequest): Call<RegisterWalletResponse> {
    return this.#http.post('/wallet/register', request);
  }

  overview(owner: OwnerKey): Call<WalletOverview> {
    return this.#http.post('/wallet/overview', { owner });
  }

  faucet(request: FaucetRequest): Call<SubmitResult> {
    return this.#http.post('/chain/faucet', request);
  }

  assess(request: AssessRequest): Call<AssessResponse> {
    return this.#http.post('/assess', request);
  }

  cosign(request: CosignRequest): Call<CosignOutcome> {
    return this.#http.post('/cosign', request);
  }

  cancelIntent(address: string, intentId: string): Call<IntentState> {
    return this.#http.post(`/intents/${seg(address)}/${seg(intentId)}/cancel`);
  }

  submit(op: SignedUserOp): Call<SubmitResult> {
    return this.#http.post('/chain/submit', op);
  }

  log(address: string): Call<LogResponse> {
    return this.#http.get(`/log/${seg(address)}`);
  }

  history(address: string): Call<HistoryResponse> {
    return this.#http.get(`/chain/history/${seg(address)}`);
  }

  sync(request: SyncRequest): Call<SyncResponse> {
    return this.#http.post('/chain/sync', request);
  }

  settings(address: string): Call<SettingsResponse> {
    return this.#http.get(`/settings/${seg(address)}`);
  }

  settingsHash(address: string, settings: WalletSettings): Call<HashResponse> {
    return this.#http.post(`/settings/${seg(address)}/hash`, { settings });
  }

  setSettings(address: string, request: SetSettingsRequest): Call<SettingsResponse> {
    return this.#http.post(`/settings/${seg(address)}`, request);
  }

  devPasskey(name: string): Call<DevPasskey> {
    return this.#http.post('/dev/passkeys', { name });
  }

  devSign(name: string, hash: string): Call<OwnerSignature> {
    return this.#http.post(`/dev/passkeys/${seg(name)}/sign`, { hash });
  }
}
