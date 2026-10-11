import { isPasskeyRequest } from './protocol';
import { createPasskey, signWithPasskey } from './webauthn';

// Side-effect module for extension pages (popup, approval window): answers the background's
// passkey requests by running WebAuthn here, where the browser allows it.

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!isPasskeyRequest(message)) return false;
  // Only our own background may ask: same extension, and not a content script (those come from a tab).
  if (sender.id !== chrome.runtime.id || sender.tab !== undefined) return false;

  const work = message.op === 'create' ? createPasskey(message.userName) : signWithPasskey(message.credentialId, message.hash);
  work.then(sendResponse, (error: unknown) =>
    sendResponse({ ok: false, code: 'PASSKEY_FAILED', message: error instanceof Error ? error.message : 'Passkey failed' }),
  );
  return true; // async response
});
