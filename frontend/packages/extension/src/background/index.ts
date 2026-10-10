import type { Session } from '@sqw/types/Session';
import { HttpSwissquoteApi } from '@sqw/sdk';
import { uiError } from '../ui/core/errors';
import { err } from '../ui/core/result';
import { isBridgeRequest } from '../ui/services/bridge-protocol';
import { LocalAuditLog, loadState } from './bridge-state';
import { DappRouter } from './dapp/DappRouter';
import { AllowlistApprover, DEFAULT_ALLOWED_ORIGINS } from './dapp/AllowlistApprover';
import { DeviceKeyWrapper, NetworkKeyring } from './dapp/NetworkKeyring';
import { RpcProxy } from './dapp/RpcProxy';
import { DAPP_RPC_URL, ProviderErrors, isDappRequest } from '../dapp/protocol';
import { dispatch } from './dispatch';
import { DevPasskeySigner } from './passkey';
import { ChromeStore } from './storage';
import { SwissquoteBridge } from './SwissquoteBridge';
import { SolanaDevnet } from './testnet/SolanaDevnet';
import { SolanaKeyring } from './testnet/SolanaKeyring';
import { TestnetWallets } from './testnet/TestnetWallets';

// Background service worker (frontend_tasks §2): holds the session token and the SDK, and serves
// the real UiBridge to extension pages over chrome.runtime messaging.

const API_URL = import.meta.env.VITE_SQ_API_URL ?? 'http://localhost:8787';

let token: string | null = null;
const api = new HttpSwissquoteApi({ baseUrl: API_URL, token: () => token });
// One device key seals every network key (Base Sepolia, Solana devnet); see dapp/NetworkKeyring.ts.
const deviceKey = new DeviceKeyWrapper();
const testnet = new TestnetWallets({
  solana: new SolanaKeyring(new ChromeStore(chrome.storage.local), deviceKey),
  devnet: new SolanaDevnet(),
  sync: (request) => api.sync(request),
});
const bridge = new SwissquoteBridge({
  api,
  testnet,
  passkey: new DevPasskeySigner(api),
  store: new ChromeStore(chrome.storage.session),
  auditLog: new LocalAuditLog(new ChromeStore(chrome.storage.local)),
  onSession: (session: Session | null) => {
    token = session?.token ?? null;
  },
});

// Session state (incl. the token) is for extension pages only, never content scripts. This is the
// default; set it explicitly so a future default change cannot widen it.
void chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
// After a worker restart, restore the token before the first request rather than on first use.
void bridge.init();

/** Only our own pages (popup, approval window) may drive the wallet; content scripts and other extensions may not. */
function isTrustedSender(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && (sender.url ?? '').startsWith(chrome.runtime.getURL(''));
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!isBridgeRequest(message)) return false;
  if (!isTrustedSender(sender)) {
    sendResponse(err(uiError('UI_FORBIDDEN')));
    return false;
  }
  dispatch(bridge, message)
    .then(sendResponse)
    .catch((cause: unknown) => {
      console.error('[sqw] bridge call failed', message.method, cause);
      sendResponse(err(uiError('UI_INTERNAL')));
    });
  return true; // keeps the channel open for the async response
});

// dApp pages (content script relay, src/content). Separate channel and router: a page never reaches
// the UiBridge methods above, and its origin is taken from the sender, not from the message.
const sessionStore = new ChromeStore(chrome.storage.session);
const dapps = new DappRouter({
  keyring: new NetworkKeyring(new ChromeStore(chrome.storage.local), deviceKey),
  rpc: new RpcProxy(DAPP_RPC_URL),
  permissions: new ChromeStore(chrome.storage.local),
  approver: new AllowlistApprover(DEFAULT_ALLOWED_ORIGINS),
  walletReady: async () => {
    const state = await loadState(sessionStore);
    return state.session !== null && state.wallet !== null;
  },
});

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!isDappRequest(message)) return false;
  const origin = dappOrigin(sender);
  if (origin === null) {
    sendResponse({ ok: false, error: ProviderErrors.unauthorized });
    return false;
  }
  dapps
    .handle(origin, message.method, message.params)
    .then(sendResponse)
    .catch((cause: unknown) => {
      console.error('[sqw] dapp request failed', message.method, cause);
      sendResponse({ ok: false, error: ProviderErrors.internal });
    });
  return true;
});

/** Our own content script in a web page tab; the origin is the one Chrome reports, not the page's claim. */
function dappOrigin(sender: chrome.runtime.MessageSender): string | null {
  if (sender.id !== chrome.runtime.id || sender.tab === undefined) return null;
  if (sender.origin !== undefined && sender.origin !== 'null') return sender.origin;
  try {
    return sender.url === undefined ? null : new URL(sender.url).origin;
  } catch {
    return null;
  }
}
