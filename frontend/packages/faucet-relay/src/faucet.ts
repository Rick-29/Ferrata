// Relay logic, independent of HTTP and of the CDP SDK so it is testable offline.
// The CDP API key lives only in this process (see server.ts); callers send an address, nothing else.

export type FaucetNetwork = 'base-sepolia' | 'solana-devnet';

export interface FaucetRequest {
  readonly network: FaucetNetwork;
  readonly address: string;
}

export interface FaucetGrant {
  readonly network: FaucetNetwork;
  /** EVM transaction hash or Solana signature. */
  readonly txId: string;
  /** Base units granted per claim (CDP fixed amounts), decimal string. */
  readonly amount: string;
  readonly symbol: 'ETH' | 'SOL';
  readonly decimals: number;
  readonly explorerUrl: string;
}

export type FaucetErrorCode = 'BAD_REQUEST' | 'COOLDOWN' | 'FAUCET_LIMIT' | 'FAUCET_FORBIDDEN' | 'NOT_CONFIGURED' | 'UPSTREAM';

export interface FaucetError {
  readonly code: FaucetErrorCode;
  readonly message: string;
  readonly status: number;
}

export type FaucetResult = { readonly ok: true; readonly grant: FaucetGrant } | { readonly ok: false; readonly error: FaucetError };

/** What the CDP SDK offers; injected so tests never touch the network or a key. */
export interface CdpFaucets {
  evm(address: string): Promise<{ transactionHash: string }>;
  solana(address: string): Promise<{ signature: string }>;
}

/** CDP per-claim amounts (docs.cdp.coinbase.com/faucets): 0.0001 ETH, 0.00125 SOL. */
const GRANTS = {
  'base-sepolia': { amount: '100000000000000', symbol: 'ETH', decimals: 18 },
  'solana-devnet': { amount: '1250000', symbol: 'SOL', decimals: 9 },
} as const;

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** One claim per address per window, on top of CDP's own daily caps: a stuck button cannot drain the quota. */
export const COOLDOWN_MS = 20_000;

export function parseRequest(body: unknown): FaucetRequest | null {
  if (typeof body !== 'object' || body === null) return null;
  const { network, address } = body as Record<string, unknown>;
  if (typeof address !== 'string') return null;
  if (network === 'base-sepolia' && EVM_ADDRESS.test(address)) return { network, address };
  if (network === 'solana-devnet' && SOLANA_ADDRESS.test(address)) return { network, address };
  return null;
}

export class FaucetRelay {
  readonly #cdp: CdpFaucets | null;
  readonly #now: () => number;
  readonly #lastClaim = new Map<string, number>();

  /** `cdp` null: no API key configured, every request answers NOT_CONFIGURED. */
  constructor(cdp: CdpFaucets | null, now: () => number = Date.now) {
    this.#cdp = cdp;
    this.#now = now;
  }

  async claim(body: unknown): Promise<FaucetResult> {
    const request = parseRequest(body);
    if (request === null) return fail('BAD_REQUEST', 'Expected { network: "base-sepolia" | "solana-devnet", address }.', 400);
    if (this.#cdp === null) return fail('NOT_CONFIGURED', 'CDP_API_KEY_ID / CDP_API_KEY_SECRET missing in .env.', 503);

    const key = `${request.network}:${request.address.toLowerCase()}`;
    const last = this.#lastClaim.get(key);
    if (last !== undefined && this.#now() - last < COOLDOWN_MS) {
      return fail('COOLDOWN', 'One claim per address every 20 seconds.', 429);
    }
    this.#lastClaim.set(key, this.#now());

    try {
      const txId =
        request.network === 'base-sepolia'
          ? (await this.#cdp.evm(request.address)).transactionHash
          : (await this.#cdp.solana(request.address)).signature;
      const grant = GRANTS[request.network];
      return { ok: true, grant: { network: request.network, txId, ...grant, explorerUrl: explorerUrl(request.network, txId) } };
    } catch (cause) {
      this.#lastClaim.delete(key);
      return mapUpstreamError(cause);
    }
  }
}

function explorerUrl(network: FaucetNetwork, txId: string): string {
  return network === 'base-sepolia'
    ? `https://sepolia.basescan.org/tx/${txId}`
    : `https://explorer.solana.com/tx/${txId}?cluster=devnet`;
}

/** CDP APIError carries `statusCode` and `errorType` (faucet_limit_exceeded, forbidden, …). */
function mapUpstreamError(cause: unknown): FaucetResult {
  const e = (typeof cause === 'object' && cause !== null ? cause : {}) as { statusCode?: unknown; errorType?: unknown; message?: unknown };
  const message = typeof e.message === 'string' ? e.message : 'CDP faucet error';
  if (e.statusCode === 429 || e.errorType === 'faucet_limit_exceeded' || e.errorType === 'rate_limit_exceeded') {
    return fail('FAUCET_LIMIT', message, 429);
  }
  if (e.statusCode === 403 || e.errorType === 'forbidden') return fail('FAUCET_FORBIDDEN', message, 403);
  if (e.statusCode === 401 || e.errorType === 'unauthorized') {
    return fail('NOT_CONFIGURED', 'CDP rejected the API key (wrong key, or a key without access to the faucet).', 503);
  }
  return fail('UPSTREAM', message, 502);
}

const fail = (code: FaucetErrorCode, message: string, status: number): FaucetResult => ({ ok: false, error: { code, message, status } });
