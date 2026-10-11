import type { AccountView } from '@sqw/types/AccountView';
import type { LoginRequest } from '@sqw/types/LoginRequest';
import type { WalletSettings } from '@sqw/types/WalletSettings';
import { uiError, type UiError } from '../core/errors';
import { err, type Result } from '../core/result';
import { BRIDGE_CHANNEL, type BridgeMethod, type BridgeRequest } from './bridge-protocol';
import type {
  ActivityFeed,
  AirdropOutcome,
  ConfirmOptions,
  SendDraft,
  SendOutcome,
  SendPreview,
  SessionView,
  TestnetNetwork,
  TestnetSendDraft,
  TestnetSendOutcome,
  TestnetWallet,
  UiBridge,
  PairingProgress,
  PhonePairing,
  RecoveryPhoneStatus,
  RecoveryAlert,
  RecoveryView,
} from './UiBridge';

type UiResult<T> = Promise<Result<T, UiError>>;

const UNAVAILABLE = uiError('UI_BACKGROUND_UNAVAILABLE', true);

function isResult(value: unknown): value is { ok: boolean } {
  return typeof value === 'object' && value !== null && 'ok' in value && typeof value.ok === 'boolean';
}

/**
 * The popup's side of the real bridge: forwards each call to the background worker, which holds
 * the session and talks to Swissquote. Holds no state and no secret.
 */
export class RuntimeBridge implements UiBridge {
  login(credentials: LoginRequest): UiResult<SessionView> {
    return call('login', credentials);
  }

  createWallet(): UiResult<AccountView> {
    return call('createWallet');
  }

  getWallet(): UiResult<AccountView> {
    return call('getWallet');
  }

  hasPasskey(): UiResult<boolean> {
    return call('hasPasskey');
  }

  lock(): UiResult<void> {
    return call('lock');
  }

  previewSend(draft: SendDraft): UiResult<SendPreview> {
    return call('previewSend', draft);
  }

  confirmSend(previewId: string, options: ConfirmOptions): UiResult<SendOutcome> {
    return call('confirmSend', previewId, options);
  }

  cancelSend(previewId: string): UiResult<void> {
    return call('cancelSend', previewId);
  }

  getActivity(): UiResult<ActivityFeed> {
    return call('getActivity');
  }

  getSettings(): UiResult<WalletSettings> {
    return call('getSettings');
  }

  saveSettings(settings: WalletSettings): UiResult<WalletSettings> {
    return call('saveSettings', settings);
  }

  getTestnetWallets(): UiResult<readonly TestnetWallet[]> {
    return call('getTestnetWallets');
  }

  requestAirdrop(network: TestnetNetwork): UiResult<AirdropOutcome> {
    return call('requestAirdrop', network);
  }

  sendTestnet(draft: TestnetSendDraft): UiResult<TestnetSendOutcome> {
    return call('sendTestnet', draft);
  }

  getRecoveryPhone(): UiResult<RecoveryPhoneStatus> {
    return call('getRecoveryPhone');
  }

  startPhonePairing(): UiResult<PhonePairing> {
    return call('startPhonePairing');
  }

  pollPhonePairing(pairingId: string): UiResult<PairingProgress> {
    return call('pollPhonePairing', pairingId);
  }

  confirmPhonePairing(pairingId: string): UiResult<RecoveryPhoneStatus> {
    return call('confirmPhonePairing', pairingId);
  }

  listRecoverableWallets(): UiResult<readonly string[]> {
    return call('listRecoverableWallets');
  }

  startRecovery(address: string): UiResult<RecoveryView> {
    return call('startRecovery', address);
  }

  getRecovery(): UiResult<RecoveryView | null> {
    return call('getRecovery');
  }

  finishRecovery(): UiResult<AccountView> {
    return call('finishRecovery');
  }

  abandonRecovery(): UiResult<void> {
    return call('abandonRecovery');
  }

  getRecoveryAlerts(): UiResult<readonly RecoveryAlert[]> {
    return call('getRecoveryAlerts');
  }

  cancelRecovery(id: string): UiResult<void> {
    return call('cancelRecovery', id);
  }
}

async function call<T>(method: BridgeMethod, ...args: readonly unknown[]): UiResult<T> {
  const request: BridgeRequest = { channel: BRIDGE_CHANNEL, method, args };
  try {
    const response: unknown = await chrome.runtime.sendMessage(request);
    // DTO parsing boundary: the background answers with the same Result types (bridge-protocol.ts).
    return isResult(response) ? (response as Result<T, UiError>) : err(UNAVAILABLE);
  } catch {
    // No background (worker crashed or extension reloaded): the UI shows a retryable error.
    return err(UNAVAILABLE);
  }
}
