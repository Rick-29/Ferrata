import { SwissquoteProvider } from './provider';

// Runs in the page's own JavaScript world (manifest: world MAIN), before the dApp's scripts.
// Announces the wallet with EIP-6963 so dApps list it next to MetaMask, and only claims
// `window.ethereum` when no other wallet did.

const ICON =
  'data:image/svg+xml;base64,' +
  btoa(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#e3001b"/>' +
      '<text x="16" y="22" font-family="Arial" font-size="16" font-weight="bold" fill="#fff" text-anchor="middle">SQ</text></svg>',
  );

const provider = new SwissquoteProvider(window, window.location.origin);

const info = Object.freeze({
  uuid: crypto.randomUUID(),
  name: 'Swissquote Wallet',
  icon: ICON,
  rdns: 'com.swissquote.wallet',
});

function announce(): void {
  window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
}

window.addEventListener('eip6963:requestProvider', announce);
announce();

const host = window as unknown as { ethereum?: unknown };
if (host.ethereum === undefined) {
  Object.defineProperty(window, 'ethereum', { value: provider, configurable: true, writable: false });
}
