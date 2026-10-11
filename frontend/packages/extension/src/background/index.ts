import type { Session } from '@sqw/types/Session';
import { HttpSwissquoteApi } from '@sqw/sdk';
import { uiError } from '../ui/core/errors';
import { err } from '../ui/core/result';
import { isBridgeRequest } from '../ui/services/bridge-protocol';
import { LocalAuditLog, loadState } from './bridge-state';
import { DappRouter } from './dapp/DappRouter';
import { AllowlistApprover, DEFAULT_ALLOWED_ORIGINS, FIRST_PARTY_ORIGINS } from './dapp/AllowlistApprover';
import type { DappResponse } from '../dapp/protocol';
import { readForSite } from './site/SiteReader';
import { SignInBroker } from './signin/SignInBroker';
import { isSignInMessage } from '../signin/protocol';
import { DeviceKeyWrapper, NetworkKeyring } from './dapp/NetworkKeyring';
import { RpcProxy } from './dapp/RpcProxy';
import { DAPP_RPC_URL, ProviderErrors, isDappRequest } from '../dapp/protocol';
import { dispatch } from './dispatch';
import { isSimulatedPasskey } from '../ui/core/config';
import { DevPasskeySigner, type PasskeySigner } from './passkey';
import { WebAuthnPasskeySigner } from './WebAuthnPasskeySigner';
import { ChromeStore } from './storage';
import { SwissquoteBridge } from './SwissquoteBridge';
import { SolanaDevnet } from './testnet/SolanaDevnet';
import { SolanaKeyring } from './testnet/SolanaKeyring';
import { TestnetWallets } from './testnet/TestnetWallets';
import { TestnetSender, type EvmSend } from './testnet/TestnetSender';
import { BASE_SEPOLIA_USDC, GaslessUsdc, type SmartAccountOwner } from './testnet/GaslessUsdc';
import { passkeyOwner } from './testnet/PasskeyOwner';
import { createWalletClient, createPublicClient, http } from 'viem';
import { baseSepolia, sepolia } from 'viem/chains';

// Background service worker (frontend_tasks §2): holds the session token and the SDK, and serves
// the real UiBridge to extension pages over chrome.runtime messaging.

const API_URL = import.meta.env.VITE_SQ_API_URL ?? 'http://localhost:8787';

let token: string | null = null;
const api = new HttpSwissquoteApi({ baseUrl: API_URL, token: () => token });
// One device key seals every network key (Base Sepolia, Solana devnet); see dapp/NetworkKeyring.ts.
const deviceKey = new DeviceKeyWrapper();
// One Base Sepolia key and node for both the dApp provider and the testnet panel.
const evmKeyring = new NetworkKeyring(new ChromeStore(chrome.storage.local), deviceKey);
const baseRpc = new RpcProxy(DAPP_RPC_URL);
const sepoliaRpc = new RpcProxy('https://ethereum-sepolia-rpc.publicnode.com');
// Gasless USDC: the EVM key owns an ERC-4337 smart account, Pimlico's paymaster pays the gas.
// Set VITE_PIMLICO_API_KEY (frontend/packages/extension/.env.local) to turn it on.
const gasless = new GaslessUsdc({ pimlicoApiKey: import.meta.env.VITE_PIMLICO_API_KEY ?? null, rpcUrl: DAPP_RPC_URL });
/** The wallet's passkey signer (one instance: the bridge and the smart account share it). */
const passkeys = passkeySigner();
/**
 * The smart account's owner: this wallet's passkey (recorded at creation, or replaced by a recovery).
 * Null with the simulated dev keyring (not a WebAuthn key) or before a wallet exists on this device.
 */
async function smartOwner(): Promise<SmartAccountOwner | null> {
  if (!(passkeys instanceof WebAuthnPasskeySigner)) return null;
  const name = (await loadState(new ChromeStore(chrome.storage.session))).wallet?.passkeyName;
  if (!name) return null;
  const credential = await passkeys.credential(name);
  return credential === null ? null : passkeyOwner(credential, (hash) => passkeys.sign(name, hash));
}
const testnet = new TestnetWallets({
  solana: new SolanaKeyring(new ChromeStore(chrome.storage.local), deviceKey),
  devnet: new SolanaDevnet(),
  evm: evmKeyring,
  gasless,
  smartOwner,
  evmBalance: async (network, address) => {
    const rpc = network === 'base-sepolia' ? baseRpc : sepoliaRpc;
    const response = await rpc.forward('eth_getBalance', [address, 'latest']);
    return response.ok && typeof response.result === 'string' ? BigInt(response.result).toString() : null;
  },
  sync: (request) => api.sync(request),
});
/**
 * Real passkey (WebAuthn, P-256) by default: the key lives in the device's authenticator and every
 * signature needs the user (Windows Hello, Touch ID…). VITE_PASSKEY=dev falls back to the backend's
 * mock keyring (/dev/passkeys, server-held keys: demo only, not self-custody).
 */
function passkeySigner(): PasskeySigner {
  if (isSimulatedPasskey) return new DevPasskeySigner(api);
  return new WebAuthnPasskeySigner(new ChromeStore(chrome.storage.local), (request) => chrome.runtime.sendMessage(request));
}

/** Sends ETH on an EVM test network with the wallet's network key, then waits for the receipt. */
const evmSend: EvmSend = async (network, to, valueWei) => {
  const account = await evmKeyring.account();
  if (account === null) return { ok: false, message: 'no EVM key on this device' };
  const chain = network === 'base-sepolia' ? baseSepolia : sepolia;
  const transport = http(network === 'base-sepolia' ? DAPP_RPC_URL : 'https://ethereum-sepolia-rpc.publicnode.com');
  try {
    const hash = await createWalletClient({ account, chain, transport }).sendTransaction({ to: to as `0x${string}`, value: valueWei });
    const receipt = await createPublicClient({ chain, transport }).waitForTransactionReceipt({ hash, timeout: 90_000 });
    return receipt.status === 'success' ? { ok: true, hash } : { ok: false, message: 'reverted' };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'send failed' };
  }
};
const testnetSender = new TestnetSender({
  solana: new SolanaKeyring(new ChromeStore(chrome.storage.local), deviceKey),
  devnet: new SolanaDevnet(),
  evm: evmKeyring,
  evmSend,
  gasless,
  smartOwner,
  sync: (request) => api.sync(request),
});

const bridge = new SwissquoteBridge({
  api,
  testnet,
  testnetSender,
  gasless: {
    enabled: gasless.enabled,
    usdc: BASE_SEPOLIA_USDC,
    explorerTx: (hash) => `https://sepolia.basescan.org/tx/${hash}`,
    address: async () => {
      const owner = await smartOwner();
      return owner === null ? null : gasless.address(owner);
    },
    balance: (address) => gasless.balance(address),
    send: async (to, amount) => {
      const owner = await smartOwner();
      if (owner === null) return { ok: false, message: 'no passkey on this device' };
      return gasless.send(owner, to, amount);
    },
  },
  passkey: passkeys,
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

// Website sign-in (sqw_signIn): a small approval window runs login + passkey, then reports here.
const signIns = new SignInBroker({
  openWindow: async (query) => {
    const created = await chrome.windows.create({
      url: chrome.runtime.getURL(`src/approval/index.html?${query}`),
      type: 'popup',
      width: 400,
      height: 640,
      focused: true,
    });
    return created?.id;
  },
  closeWindow: (windowId) => void chrome.windows.remove(windowId).catch(() => undefined),
  identitySince: (since) => bridge.identitySince(since),
});
chrome.windows.onRemoved.addListener((windowId) => signIns.onWindowClosed(windowId));

// Website "Send" (sqw_openSend): the extension's own Send → Confirm screens in a window; the site
// only learns when it closes (then it refreshes). Nothing is signed outside the extension.
const sendWindows = new Map<number, () => void>();
chrome.windows.onRemoved.addListener((windowId) => {
  sendWindows.get(windowId)?.();
  sendWindows.delete(windowId);
});
async function openSendWindow(preset: { readonly to: string; readonly amount: string }): Promise<DappResponse> {
  const query = new URLSearchParams({ send: '1', to: preset.to, amount: preset.amount }).toString();
  const created = await chrome.windows.create({
    url: chrome.runtime.getURL(`src/approval/index.html?${query}`),
    type: 'popup',
    width: 400,
    height: 640,
    focused: true,
  });
  const id = created?.id;
  if (id === undefined) return { ok: false, error: { code: -32603, message: 'could not open the Ferrata window' } };
  return new Promise((resolve) => sendWindows.set(id, () => resolve({ ok: true, result: { closed: true } })));
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!isSignInMessage(message)) return false;
  // Only our own extension pages (the approval window), never a content script or another extension.
  if (!isTrustedSender(sender)) {
    sendResponse({ ok: false, code: 'UI_FORBIDDEN' });
    return false;
  }
  signIns.handle(message).then(sendResponse, () => sendResponse({ ok: false, code: 'UI_INTERNAL' }));
  return true;
});

const dapps = new DappRouter({
  keyring: evmKeyring,
  rpc: baseRpc,
  permissions: new ChromeStore(chrome.storage.local),
  approver: new AllowlistApprover(DEFAULT_ALLOWED_ORIGINS),
  signIn: (origin) => signIns.request(origin),
  siteRead: (method) => readForSite(bridge, method),
  openSend: (preset) => openSendWindow(preset),
  firstPartyOrigins: FIRST_PARTY_ORIGINS,
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
