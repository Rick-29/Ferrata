import type { UiBridge } from './UiBridge';

// The message format between extension pages (popup, approval window) and the background worker.
// Results are plain JSON (`Result<T, UiError>`), so they cross `chrome.runtime` messaging as-is.

export const BRIDGE_CHANNEL = 'sqw-ui-bridge';

export type BridgeMethod = keyof UiBridge;

export interface BridgeRequest {
  readonly channel: typeof BRIDGE_CHANNEL;
  readonly method: BridgeMethod;
  readonly args: readonly unknown[];
}

const METHODS: ReadonlySet<string> = new Set<BridgeMethod>([
  'login',
  'createWallet',
  'getWallet',
  'hasPasskey',
  'lock',
  'previewSend',
  'confirmSend',
  'cancelSend',
  'getActivity',
  'getSettings',
  'saveSettings',
  'getTestnetWallets',
  'requestAirdrop',
  'sendTestnet',
  'getRecoveryPhone',
  'startPhonePairing',
  'pollPhonePairing',
  'confirmPhonePairing',
  'listRecoverableWallets',
  'startRecovery',
  'getRecovery',
  'finishRecovery',
  'abandonRecovery',
  'getRecoveryAlerts',
  'cancelRecovery',
]);

export function isBridgeRequest(message: unknown): message is BridgeRequest {
  return (
    typeof message === 'object' &&
    message !== null &&
    'channel' in message &&
    message.channel === BRIDGE_CHANNEL &&
    'method' in message &&
    typeof message.method === 'string' &&
    METHODS.has(message.method) &&
    'args' in message &&
    Array.isArray(message.args)
  );
}
