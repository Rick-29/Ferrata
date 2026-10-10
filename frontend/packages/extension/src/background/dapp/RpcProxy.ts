import { ProviderErrors, type DappResponse } from '../../dapp/protocol';

// Read-only JSON-RPC calls a dApp makes to render itself (balances, quotes, receipts) go straight
// to the public node. A closed list: anything that signs, sends or touches accounts is not here.

export const READ_METHODS: ReadonlySet<string> = new Set([
  'eth_blockNumber',
  'eth_call',
  'eth_estimateGas',
  'eth_feeHistory',
  'eth_gasPrice',
  'eth_getBalance',
  'eth_getBlockByHash',
  'eth_getBlockByNumber',
  'eth_getCode',
  'eth_getLogs',
  'eth_getStorageAt',
  'eth_getTransactionByHash',
  'eth_getTransactionCount',
  'eth_getTransactionReceipt',
  'eth_maxPriorityFeePerGas',
]);

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export class RpcProxy {
  readonly #url: string;
  readonly #fetch: FetchLike;
  #id = 1;

  constructor(url: string, fetchFn: FetchLike = (i, init) => fetch(i, init)) {
    this.#url = url;
    this.#fetch = fetchFn;
  }

  async forward(method: string, params: readonly unknown[]): Promise<DappResponse> {
    if (!READ_METHODS.has(method)) return { ok: false, error: ProviderErrors.unsupportedMethod };
    let body: unknown;
    try {
      const response = await this.#fetch(this.#url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: this.#id++, method, params }),
      });
      body = await response.json();
    } catch {
      return { ok: false, error: { code: -32603, message: 'Base Sepolia RPC unreachable.' } };
    }
    if (typeof body !== 'object' || body === null) return { ok: false, error: ProviderErrors.internal };
    if ('error' in body && typeof body.error === 'object' && body.error !== null) {
      const e = body.error as { code?: unknown; message?: unknown };
      return {
        ok: false,
        error: { code: typeof e.code === 'number' ? e.code : -32603, message: typeof e.message === 'string' ? e.message : 'RPC error' },
      };
    }
    return 'result' in body ? { ok: true, result: body.result } : { ok: false, error: ProviderErrors.internal };
  }
}
