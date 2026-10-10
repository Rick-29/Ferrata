import { CONTENT_TO_PAGE, PAGE_TO_CONTENT, ProviderErrors, isPageResponse, type PageRequest, type ProviderError } from '../dapp/protocol';

// The EIP-1193 provider a dApp sees. It holds nothing secret and decides nothing: every call is
// forwarded to the background through the content script, which answers or asks the user.

export interface RequestArguments {
  readonly method: string;
  readonly params?: readonly unknown[] | object;
}

type Listener = (...args: unknown[]) => void;

/** What EIP-1193 rejects with: an Error carrying the numeric code dApps switch on. */
export class ProviderRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderRpcError';
  }
}

export interface MessagePort {
  postMessage(message: unknown, targetOrigin: string): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

export class SwissquoteProvider {
  readonly isSwissquoteWallet = true;
  readonly #port: MessagePort;
  readonly #origin: string;
  readonly #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: ProviderRpcError) => void }>();
  readonly #listeners = new Map<string, Set<Listener>>();
  #nextId = 1;
  #accounts: readonly string[] = [];

  constructor(port: MessagePort, origin: string) {
    this.#port = port;
    this.#origin = origin;
    port.addEventListener('message', (event) => this.#onMessage(event));
  }

  request(args: RequestArguments): Promise<unknown> {
    if (typeof args !== 'object' || args === null || typeof args.method !== 'string') {
      return Promise.reject(toRpcError(ProviderErrors.invalidParams));
    }
    const params = Array.isArray(args.params) ? args.params : args.params === undefined ? [] : [args.params];
    const id = this.#nextId++;
    const message: PageRequest = { target: PAGE_TO_CONTENT, id, method: args.method, params };
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#port.postMessage(message, this.#origin);
    }).then((result) => {
      if (args.method === 'eth_requestAccounts' || args.method === 'eth_accounts') this.#updateAccounts(result);
      return result;
    });
  }

  on(event: string, listener: Listener): this {
    const set = this.#listeners.get(event) ?? new Set<Listener>();
    set.add(listener);
    this.#listeners.set(event, set);
    return this;
  }

  removeListener(event: string, listener: Listener): this {
    this.#listeners.get(event)?.delete(listener);
    return this;
  }

  #emit(event: string, ...args: unknown[]): void {
    for (const listener of this.#listeners.get(event) ?? []) listener(...args);
  }

  #updateAccounts(result: unknown): void {
    if (!Array.isArray(result)) return;
    const next = result.filter((a): a is string => typeof a === 'string');
    const changed = next.length !== this.#accounts.length || next.some((a, i) => a !== this.#accounts[i]);
    this.#accounts = next;
    if (changed) this.#emit('accountsChanged', next);
  }

  #onMessage(event: MessageEvent): void {
    const data: unknown = event.data;
    if (!isPageResponse(data) || data.target !== CONTENT_TO_PAGE) return;
    const pending = this.#pending.get(data.id);
    if (pending === undefined) return;
    this.#pending.delete(data.id);
    if (data.response.ok) pending.resolve(data.response.result);
    else pending.reject(toRpcError(data.response.error));
  }
}

const toRpcError = (e: ProviderError): ProviderRpcError => new ProviderRpcError(e.code, e.message);
