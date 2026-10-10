import type { ConnectApprover } from './DappRouter';

/**
 * TEMPORARY until the approval window exists (P2, frontend_tasks §6): connects only the origins on
 * Swissquote's dApp allowlist (fixtures/policy.json `allowlisted_origins`) plus the local DEX demo
 * page, and refuses every other site. Replace with a window that asks the user.
 */
export class AllowlistApprover implements ConnectApprover {
  readonly #allowed: ReadonlySet<string>;

  constructor(origins: readonly string[]) {
    this.#allowed = new Set(origins);
  }

  async approveConnect(origin: string): Promise<boolean> {
    return this.#allowed.has(origin);
  }
}

export const DEFAULT_ALLOWED_ORIGINS: readonly string[] = [
  'https://app.uniswap.org',
  'https://app.aave.com',
  'http://localhost:5174',
];
