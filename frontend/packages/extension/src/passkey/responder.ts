import { isPasskeyRequest } from './protocol';
import { createPasskey, signWithPasskey } from './webauthn';

/**
 * Lets the background ask this page (popup or approval window) for a passkey ceremony.
 * Only the background of this extension may ask, and only the focused page answers, so the
 * user never gets two prompts at once.
 */
export function startPasskeyResponder(): void {
  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (!isPasskeyRequest(message)) return false;
    // The service worker has no tab; content scripts and web pages always do.
    if (sender.id !== chrome.runtime.id || sender.tab) return false;
    if (!document.hasFocus()) return false;

    const ceremony = message.op === 'create' ? createPasskey(message.userName) : signWithPasskey(message.credentialId, message.hash);
    void ceremony.then(sendResponse);
    return true; // async response
  });
}
