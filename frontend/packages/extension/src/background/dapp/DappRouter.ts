import { DAPP_CHAIN_ID, DAPP_CHAIN_ID_HEX, ProviderErrors, type DappResponse } from '../../dapp/protocol';
import type { KeyValueStore } from '../storage';
import type { NetworkKeyring } from './NetworkKeyring';
import type { RpcProxy } from './RpcProxy';

// Answers EIP-1193 requests from dApp pages (frontend_tasks §5). The origin comes from the
// message sender, so a page cannot speak for another site.

/** Asks the user whether `origin` may see the wallet address. */
export interface ConnectApprover {
  approveConnect(origin: string): Promise<boolean>;
}

/** Methods that sign or send: they need the approval window and Swissquote's attestation (next step). */
const SIGNING_METHODS: ReadonlySet<string> = new Set([
  'eth_sendTransaction',
  'eth_signTypedData_v4',
  'personal_sign',
]);

export interface DappRouterDeps {
  readonly keyring: NetworkKeyring;
  readonly rpc: RpcProxy;
  /** Connected origins, persisted (chrome.storage.local). */
  readonly permissions: KeyValueStore;
  readonly approver: ConnectApprover;
  /** True once the client is logged in and has a wallet (popup onboarding done). */
  readonly walletReady: () => Promise<boolean>;
  /**
   * Website sign-in through the extension (`sqw_signIn`): login + passkey in the approval window.
   * Offered only to `firstPartyOrigins` (Ferrata's own website), refused to every other site.
   */
  readonly signIn?: (origin: string) => Promise<DappResponse>;
  readonly firstPartyOrigins?: readonly string[];
}

const PERMISSIONS_KEY = 'sqw-dapp-connected-origins';

export class DappRouter {
  readonly #deps: DappRouterDeps;

  constructor(deps: DappRouterDeps) {
    this.#deps = deps;
  }

  async handle(origin: string, method: string, params: readonly unknown[]): Promise<DappResponse> {
    switch (method) {
      case 'eth_chainId':
        return ok(DAPP_CHAIN_ID_HEX);
      case 'net_version':
        return ok(String(DAPP_CHAIN_ID));
      case 'eth_accounts':
        return ok(await this.#accounts(origin));
      case 'eth_requestAccounts':
        return this.#requestAccounts(origin);
      case 'wallet_switchEthereumChain':
        return this.#switchChain(params);
      case 'sqw_signIn':
        return this.#signIn(origin);
      default:
        if (SIGNING_METHODS.has(method)) return this.#signing(origin);
        return this.#deps.rpc.forward(method, params);
    }
  }

  async connectedOrigins(): Promise<readonly string[]> {
    const raw = await this.#deps.permissions.get(PERMISSIONS_KEY);
    return Array.isArray(raw) ? raw.filter((o): o is string => typeof o === 'string') : [];
  }

  async disconnect(origin: string): Promise<void> {
    const rest = (await this.connectedOrigins()).filter((o) => o !== origin);
    await this.#deps.permissions.set(PERMISSIONS_KEY, rest);
  }

  async #accounts(origin: string): Promise<readonly string[]> {
    if (!(await this.#isConnected(origin))) return [];
    const address = await this.#deps.keyring.address();
    return address === null ? [] : [address];
  }

  async #requestAccounts(origin: string): Promise<DappResponse> {
    if (!(await this.#deps.walletReady())) {
      return fail({ code: 4100, message: 'Open Swissquote Wallet and sign in first.' });
    }
    if (!(await this.#isConnected(origin))) {
      if (!(await this.#deps.approver.approveConnect(origin))) return fail(ProviderErrors.userRejected);
      await this.#deps.permissions.set(PERMISSIONS_KEY, [...(await this.connectedOrigins()), origin]);
    }
    return ok([await this.#deps.keyring.ensure()]);
  }

  #switchChain(params: readonly unknown[]): DappResponse {
    const first = params[0];
    const chainId = typeof first === 'object' && first !== null && 'chainId' in first ? first.chainId : undefined;
    if (typeof chainId !== 'string') return fail(ProviderErrors.invalidParams);
    return chainId.toLowerCase() === DAPP_CHAIN_ID_HEX ? ok(null) : fail(ProviderErrors.unknownChain);
  }

  #signIn(origin: string): Promise<DappResponse> | DappResponse {
    const { signIn, firstPartyOrigins = [] } = this.#deps;
    if (!signIn || !firstPartyOrigins.includes(origin)) return fail(ProviderErrors.unsupportedMethod);
    return signIn(origin);
  }

  async #signing(origin: string): Promise<DappResponse> {
    if (!(await this.#isConnected(origin))) return fail(ProviderErrors.unauthorized);
    // Next step: /assess → approval window → passkey + Swissquote attestation → sign and broadcast.
    return fail({ code: 4200, message: 'Signing from dApps is not available yet in Swissquote Wallet.' });
  }

  async #isConnected(origin: string): Promise<boolean> {
    return (await this.connectedOrigins()).includes(origin);
  }
}

const ok = (result: unknown): DappResponse => ({ ok: true, result });
const fail = (error: { code: number; message: string }): DappResponse => ({ ok: false, error });
