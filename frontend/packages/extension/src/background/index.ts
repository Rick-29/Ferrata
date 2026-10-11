import type { Session } from '@sqw/types/Session';
import { HttpSwissquoteApi } from '@sqw/sdk';
import { uiError } from '../ui/core/errors';
import { err } from '../ui/core/result';
import { isBridgeRequest } from '../ui/services/bridge-protocol';
import { LocalAuditLog } from './bridge-state';
import { dispatch } from './dispatch';
import { isSimulatedPasskey } from '../ui/core/config';
import { DevPasskeySigner } from './passkey';
import { ChromeStore } from './storage';
import { SwissquoteBridge } from './SwissquoteBridge';
import { WebAuthnPasskeySigner } from './WebAuthnPasskeySigner';

// Background service worker (frontend_tasks §2): holds the session token and the SDK, and serves
// the real UiBridge to extension pages over chrome.runtime messaging.

const API_URL = import.meta.env.VITE_SQ_API_URL ?? 'http://localhost:8787';

let token: string | null = null;
const api = new HttpSwissquoteApi({ baseUrl: API_URL, token: () => token });
const bridge = new SwissquoteBridge({
  api,
  passkey: isSimulatedPasskey
    ? new DevPasskeySigner(api)
    : new WebAuthnPasskeySigner((request) => chrome.runtime.sendMessage(request), new ChromeStore(chrome.storage.local)),
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
