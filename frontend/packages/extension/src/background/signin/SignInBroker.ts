import { ProviderErrors, type DappResponse } from '../../dapp/protocol';
import { SIGNIN_PARAM, type SignInDetails, type SignInMessage, type SignInResult } from '../../signin/protocol';

// Website sign-in (option A): one pending request per `sqw_signIn` call. The approval window does
// the login and the passkey unlock; the broker answers the site only if the passkey proof was made
// after the request (identitySince), so an earlier unlock can never be replayed into a sign-in.

export interface SignInBrokerDeps {
  /** Opens the approval window on `query` (e.g. `signin=<id>`); resolves with its window id. */
  readonly openWindow: (query: string) => Promise<number | undefined>;
  readonly closeWindow: (windowId: number) => void;
  /** The signed-in identity if the passkey proved it at or after `since`. */
  readonly identitySince: (since: number) => Promise<SignInResult | null>;
  readonly now?: () => number;
  readonly newId?: () => string;
  /** A request nobody completes in this time is refused (user walked away). */
  readonly timeoutMs?: number;
}

interface Pending {
  readonly origin: string;
  readonly createdAt: number;
  windowId: number | undefined;
  readonly resolve: (response: DappResponse) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_TIMEOUT_MS = 3 * 60_000;

export class SignInBroker {
  readonly #deps: SignInBrokerDeps;
  readonly #pending = new Map<string, Pending>();

  constructor(deps: SignInBrokerDeps) {
    this.#deps = deps;
  }

  /** Called by the dApp router for `sqw_signIn`; resolves when the window completes or goes away. */
  request(origin: string): Promise<DappResponse> {
    const id = (this.#deps.newId ?? (() => crypto.randomUUID()))();
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.#finish(id, { ok: false, error: ProviderErrors.userRejected }), this.#deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      this.#pending.set(id, { origin, createdAt: this.#now(), windowId: undefined, resolve, timer });
      this.#deps.openWindow(`${SIGNIN_PARAM}=${encodeURIComponent(id)}`).then(
        (windowId) => {
          const pending = this.#pending.get(id);
          if (pending) pending.windowId = windowId;
        },
        () => this.#finish(id, { ok: false, error: ProviderErrors.internal }),
      );
    });
  }

  /** Messages from the approval window. Returns what to answer it. */
  async handle(message: SignInMessage): Promise<{ ok: true; value?: SignInDetails } | { ok: false; code: string }> {
    const pending = this.#pending.get(message.id);
    if (!pending) return { ok: false, code: 'SIGNIN_UNKNOWN' };
    switch (message.op) {
      case 'details':
        return { ok: true, value: { origin: pending.origin } };
      case 'cancel':
        this.#finish(message.id, { ok: false, error: ProviderErrors.userRejected });
        return { ok: true };
      case 'complete': {
        const identity = await this.#deps.identitySince(pending.createdAt);
        if (identity === null) return { ok: false, code: 'SIGNIN_NOT_PROVEN' };
        this.#finish(message.id, { ok: true, result: identity });
        return { ok: true };
      }
    }
  }

  /** The user closed the approval window: the site's request is refused. */
  onWindowClosed(windowId: number): void {
    for (const [id, pending] of this.#pending) {
      if (pending.windowId === windowId) this.#finish(id, { ok: false, error: ProviderErrors.userRejected }, false);
    }
  }

  #finish(id: string, response: DappResponse, closeWindow = true): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    pending.resolve(response);
    if (closeWindow && pending.windowId !== undefined) this.#deps.closeWindow(pending.windowId);
  }

  #now(): number {
    return (this.#deps.now ?? Date.now)();
  }
}
