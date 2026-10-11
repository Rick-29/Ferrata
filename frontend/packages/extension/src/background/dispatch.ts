import type { LoginRequest } from '@sqw/types/LoginRequest';
import type { WalletSettings } from '@sqw/types/WalletSettings';
import type { Result } from '@sqw/sdk';
import { uiError, type UiError } from '../ui/core/errors';
import { err } from '../ui/core/result';
import { isValidSettings } from '../ui/core/settings';
import type { BridgeRequest } from '../ui/services/bridge-protocol';
import type { ConfirmOptions, SendDraft, TestnetSendDraft, UiBridge } from '../ui/services/UiBridge';

// Messages cross a process boundary: every argument is checked before it reaches the bridge.

const BAD_REQUEST = uiError('UI_BAD_REQUEST');

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isString = (v: unknown): v is string => typeof v === 'string';
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function isLoginRequest(v: unknown): v is LoginRequest {
  return isRecord(v) && isString(v.username) && isString(v.password);
}

function isSendDraft(v: unknown): v is SendDraft {
  return isRecord(v) && isString(v.to) && (v.asset === null || isString(v.asset)) && isString(v.amount);
}

function isConfirmOptions(v: unknown): v is ConfirmOptions {
  return isRecord(v) && typeof v.stepUp === 'boolean' && typeof v.acceptedRisk === 'boolean';
}

function isWalletSettings(v: unknown): v is WalletSettings {
  return (
    isRecord(v) &&
    isNumber(v.version) &&
    isNumber(v.per_tx_limit_pct) &&
    isNumber(v.daily_limit) &&
    isNumber(v.step_up_above_pct) &&
    isNumber(v.intent_timeout_secs) &&
    isNumber(v.hold_timeout_secs) &&
    Array.isArray(v.allowlist) &&
    v.allowlist.every(isString) &&
    isRecord(v.extra)
  );
}

const TESTNET_NETWORKS: ReadonlySet<unknown> = new Set(['solana-devnet', 'base-sepolia', 'eth-sepolia']);

function isTestnetSendDraft(v: unknown): v is TestnetSendDraft {
  return isRecord(v) && TESTNET_NETWORKS.has(v.network) && isString(v.to) && isString(v.amount);
}

/** Shape first (untrusted message), then the same bounds the bridge enforces before signing. */
const isAcceptableSettings = (v: unknown): v is WalletSettings => isWalletSettings(v) && isValidSettings(v);

/** Routes one validated request to the bridge. Unknown shapes get a typed error, never a throw. */
export function dispatch(bridge: UiBridge, request: BridgeRequest): Promise<Result<unknown, UiError>> {
  const [a, b] = request.args;
  switch (request.method) {
    case 'login':
      return isLoginRequest(a) ? bridge.login(a) : rejected();
    case 'createWallet':
      return bridge.createWallet();
    case 'getWallet':
      return bridge.getWallet();
    case 'hasPasskey':
      return bridge.hasPasskey();
    case 'lock':
      return bridge.lock();
    case 'previewSend':
      return isSendDraft(a) ? bridge.previewSend(a) : rejected();
    case 'confirmSend':
      return isString(a) && isConfirmOptions(b) ? bridge.confirmSend(a, b) : rejected();
    case 'cancelSend':
      return isString(a) ? bridge.cancelSend(a) : rejected();
    case 'getActivity':
      return bridge.getActivity();
    case 'getSettings':
      return bridge.getSettings();
    case 'saveSettings':
      return isAcceptableSettings(a) ? bridge.saveSettings(a) : rejected();
    case 'getTestnetWallets':
      return bridge.getTestnetWallets();
    case 'requestAirdrop':
      return a === 'solana-devnet' ? bridge.requestAirdrop(a) : rejected();
    case 'sendTestnet':
      return isTestnetSendDraft(a) ? bridge.sendTestnet(a) : rejected();
    case 'getRecoveryPhone':
      return bridge.getRecoveryPhone();
    case 'startPhonePairing':
      return bridge.startPhonePairing();
    case 'pollPhonePairing':
      return isString(a) ? bridge.pollPhonePairing(a) : rejected();
    case 'confirmPhonePairing':
      return isString(a) ? bridge.confirmPhonePairing(a) : rejected();
    case 'listRecoverableWallets':
      return bridge.listRecoverableWallets();
    case 'startRecovery':
      return isString(a) ? bridge.startRecovery(a) : rejected();
    case 'getRecovery':
      return bridge.getRecovery();
    case 'finishRecovery':
      return bridge.finishRecovery();
    case 'abandonRecovery':
      return bridge.abandonRecovery();
    case 'getRecoveryAlerts':
      return bridge.getRecoveryAlerts();
    case 'cancelRecovery':
      return isString(a) ? bridge.cancelRecovery(a) : rejected();
  }
}

const rejected = (): Promise<Result<never, UiError>> => Promise.resolve(err(BAD_REQUEST));
