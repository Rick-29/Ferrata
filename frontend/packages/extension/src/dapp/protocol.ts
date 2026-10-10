// Messages between a dApp page and the background (Middleware Spec §5, frontend_tasks §5):
//
//   page (inpage.ts, MAIN world) ──window.postMessage──► content.ts (ISOLATED) ──chrome.runtime──► background
//
// Separate from the popup's `sqw-ui-bridge` channel: a page can never reach login, createWallet, …
// The background takes the origin from the message sender, never from the payload.

/** Base Sepolia, the demo network (validated with Swissquote). */
export const DAPP_CHAIN_ID = 84532;
export const DAPP_CHAIN_ID_HEX = '0x14a34';
export const DAPP_RPC_URL = 'https://sepolia.base.org';

/** page → content script */
export const PAGE_TO_CONTENT = 'sqw-dapp:request';
/** content script → page */
export const CONTENT_TO_PAGE = 'sqw-dapp:response';
/** content script → background */
export const DAPP_CHANNEL = 'sqw-dapp';

export interface PageRequest {
  readonly target: typeof PAGE_TO_CONTENT;
  readonly id: number;
  readonly method: string;
  readonly params: readonly unknown[];
}

export interface PageResponse {
  readonly target: typeof CONTENT_TO_PAGE;
  readonly id: number;
  readonly response: DappResponse;
}

export interface DappRequest {
  readonly channel: typeof DAPP_CHANNEL;
  readonly method: string;
  readonly params: readonly unknown[];
}

export type DappResponse = { readonly ok: true; readonly result: unknown } | { readonly ok: false; readonly error: ProviderError };

/** EIP-1193 / EIP-1474 error shape, plain data so it crosses messaging unchanged. */
export interface ProviderError {
  readonly code: number;
  readonly message: string;
}

export const ProviderErrors = {
  userRejected: { code: 4001, message: 'User rejected the request.' },
  unauthorized: { code: 4100, message: 'The requested account has not been authorized by the user.' },
  unsupportedMethod: { code: 4200, message: 'The wallet does not support this method.' },
  disconnected: { code: 4900, message: 'The wallet is not connected.' },
  unknownChain: { code: 4902, message: 'Only Base Sepolia (0x14a34) is supported.' },
  invalidParams: { code: -32602, message: 'Invalid method parameters.' },
  internal: { code: -32603, message: 'Internal wallet error.' },
} as const satisfies Record<string, ProviderError>;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

export function isPageRequest(v: unknown): v is PageRequest {
  return (
    isRecord(v) &&
    v.target === PAGE_TO_CONTENT &&
    typeof v.id === 'number' &&
    typeof v.method === 'string' &&
    Array.isArray(v.params)
  );
}

export function isPageResponse(v: unknown): v is PageResponse {
  return isRecord(v) && v.target === CONTENT_TO_PAGE && typeof v.id === 'number' && isRecord(v.response);
}

export function isDappRequest(v: unknown): v is DappRequest {
  return isRecord(v) && v.channel === DAPP_CHANNEL && typeof v.method === 'string' && Array.isArray(v.params);
}

export function isDappResponse(v: unknown): v is DappResponse {
  return isRecord(v) && (v.ok === true ? 'result' in v : v.ok === false && isRecord(v.error));
}
