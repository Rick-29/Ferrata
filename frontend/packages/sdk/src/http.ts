import type { ApiError } from '@sqw/types/ApiError';
import { UNREACHABLE, err, ok, sdkError, type Result, type SdkError } from './errors';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpClientOptions {
  readonly baseUrl: string;
  /** Returns the current bearer token, if any. Only the background holds it. */
  readonly token: () => string | null;
  readonly fetch?: FetchLike;
}

type Method = 'GET' | 'POST';

/**
 * Thin JSON-over-HTTP client. No retries: writes must never be retried, and reads are cheap to
 * re-trigger from the UI's "Réessayer".
 */
export class HttpClient {
  readonly #baseUrl: string;
  readonly #token: () => string | null;
  readonly #fetch: FetchLike;

  constructor(options: HttpClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#token = options.token;
    // Bound so `fetch` keeps its `this` (required in browsers and service workers).
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  get<T>(path: string): Promise<Result<T, SdkError>> {
    return this.#request<T>('GET', path);
  }

  post<T>(path: string, body?: unknown): Promise<Result<T, SdkError>> {
    return this.#request<T>('POST', path, body);
  }

  async #request<T>(method: Method, path: string, body?: unknown): Promise<Result<T, SdkError>> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    const token = this.#token();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (cause) {
      return err(sdkError(UNREACHABLE, 'network', `Swissquote service unreachable: ${describe(cause)}`));
    }

    const payload = await readJson(response);
    if (!response.ok) return err(toSdkError(payload, response.status));
    // DTO parsing boundary: the backend's types are generated from the same Rust structs (ts-rs).
    return ok(payload as T);
  }
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function isApiError(value: unknown): value is ApiError {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    typeof value.code === 'string' &&
    'message' in value &&
    typeof value.message === 'string'
  );
}

function toSdkError(payload: unknown, status: number): SdkError {
  if (isApiError(payload)) return sdkError(payload.code, 'swissquote', payload.message, status);
  return sdkError(`HTTP_${status}`, 'swissquote', typeof payload === 'string' ? payload : `HTTP ${status}`, status);
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
