// Minimal JSON-RPC client for Solana devnet: balance, faucet airdrop, confirmation. No SDK: three
// calls do not justify @solana/web3.js (and its Node polyfills) in a service worker.

export const SOLANA_DEVNET_RPC = 'https://api.devnet.solana.com';
export const LAMPORTS_PER_SOL = 1_000_000_000n;

export type DevnetError =
  /** The public faucet refused: too many requests from this IP/address, or daily cap reached. */
  | { readonly kind: 'rate_limited'; readonly message: string }
  | { readonly kind: 'unavailable'; readonly message: string }
  | { readonly kind: 'rpc'; readonly message: string };

export type DevnetResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: DevnetError };

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;
type Sleep = (ms: number) => Promise<void>;

export class SolanaDevnet {
  readonly #url: string;
  readonly #fetch: FetchLike;
  readonly #sleep: Sleep;
  #id = 1;

  constructor(
    url = SOLANA_DEVNET_RPC,
    fetchFn: FetchLike = (i, init) => fetch(i, init),
    sleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {
    this.#url = url;
    this.#fetch = fetchFn;
    this.#sleep = sleep;
  }

  /** Lamports, as a decimal string (u64 does not fit a JS number). */
  async balance(address: string): Promise<DevnetResult<string>> {
    const result = await this.#call('getBalance', [address, { commitment: 'confirmed' }]);
    if (!result.ok) return result;
    const value = isRecord(result.value) ? result.value.value : undefined;
    return typeof value === 'number' ? ok(BigInt(value).toString()) : rpcError('unexpected getBalance result');
  }

  /** Asks the devnet faucet for `lamports`; returns the transaction signature. */
  async requestAirdrop(address: string, lamports: bigint): Promise<DevnetResult<string>> {
    const result = await this.#call('requestAirdrop', [address, Number(lamports)]);
    // The public faucet answers a JSON-RPC error when it is dry or rate-limiting, often a bare
    // "Internal error" (-32603): for the user every refusal here means "faucet unavailable now".
    if (!result.ok && result.error.kind === 'rpc') return { ok: false, error: { kind: 'rate_limited', message: result.error.message } };
    if (!result.ok) return result;
    return typeof result.value === 'string' ? ok(result.value) : rpcError('unexpected requestAirdrop result');
  }

  /** A recent blockhash: every Solana transaction must reference one (expires after ~1 minute). */
  async latestBlockhash(): Promise<DevnetResult<string>> {
    const result = await this.#call('getLatestBlockhash', [{ commitment: 'confirmed' }]);
    if (!result.ok) return result;
    const value = isRecord(result.value) && isRecord(result.value.value) ? result.value.value.blockhash : undefined;
    return typeof value === 'string' ? ok(value) : rpcError('unexpected getLatestBlockhash result');
  }

  /** Broadcasts a signed transaction (base64); returns its signature. */
  async sendTransaction(base64: string): Promise<DevnetResult<string>> {
    const result = await this.#call('sendTransaction', [base64, { encoding: 'base64', preflightCommitment: 'confirmed' }]);
    if (!result.ok) return result;
    return typeof result.value === 'string' ? ok(result.value) : rpcError('unexpected sendTransaction result');
  }

  /** Polls until the signature is confirmed (or fails), up to `attempts` × `intervalMs`. */
  async waitForConfirmation(signature: string, attempts = 30, intervalMs = 1_000): Promise<DevnetResult<'confirmed'>> {
    for (let i = 0; i < attempts; i++) {
      const result = await this.#call('getSignatureStatuses', [[signature], { searchTransactionHistory: true }]);
      if (!result.ok) return result;
      const status = isRecord(result.value) && Array.isArray(result.value.value) ? result.value.value[0] : null;
      if (isRecord(status)) {
        if (status.err !== null && status.err !== undefined) return rpcError(`airdrop failed: ${JSON.stringify(status.err)}`);
        if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') return ok('confirmed');
      }
      await this.#sleep(intervalMs);
    }
    return { ok: false, error: { kind: 'unavailable', message: 'airdrop not confirmed in time' } };
  }

  async #call(method: string, params: unknown[]): Promise<DevnetResult<unknown>> {
    let response: Response;
    try {
      response = await this.#fetch(this.#url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: this.#id++, method, params }),
      });
    } catch {
      return { ok: false, error: { kind: 'unavailable', message: 'Solana devnet RPC unreachable' } };
    }
    if (response.status === 429) return { ok: false, error: { kind: 'rate_limited', message: 'HTTP 429' } };
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { ok: false, error: { kind: 'unavailable', message: `HTTP ${response.status}` } };
    }
    if (isRecord(body) && isRecord(body.error)) {
      const message = typeof body.error.message === 'string' ? body.error.message : 'RPC error';
      // The faucet reports its limits as JSON-RPC errors ("airdrop limit", "Too many requests", …).
      return /limit|too many|429|rate/i.test(message)
        ? { ok: false, error: { kind: 'rate_limited', message } }
        : rpcError(message);
    }
    return isRecord(body) && 'result' in body ? ok(body.result) : rpcError('malformed RPC response');
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const ok = <T>(value: T): DevnetResult<T> => ({ ok: true, value });
const rpcError = (message: string): DevnetResult<never> => ({ ok: false, error: { kind: 'rpc', message } });
