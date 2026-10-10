import type { AssessResponse } from '@sqw/types/AssessResponse';
import type { OwnerKey } from '@sqw/types/OwnerKey';
import type { Receipt } from '@sqw/types/Receipt';
import type { Session } from '@sqw/types/Session';
import type { SignedEntry } from '@sqw/types/SignedEntry';
import type { TokenInfo } from '@sqw/types/TokenInfo';
import type { TxRequest } from '@sqw/types/TxRequest';
import type { SendDraft } from '../ui/services/UiBridge';
import type { KeyValueStore } from './storage';

export interface WalletRef {
  /** Name of the passkey that owns the account (dev keyring name until WebAuthn). */
  readonly passkeyName: string;
  readonly owner: OwnerKey;
  readonly address: string;
  readonly chainId: number;
  readonly tokens: readonly TokenInfo[];
}

/**
 * One send between `previewSend` and its final outcome. The audit-log position is never cached
 * here: it is re-read right before each `/cosign`, so it cannot go stale.
 */
export interface PendingSend {
  readonly id: string;
  readonly draft: SendDraft;
  readonly tx: TxRequest;
  readonly intentId: string | null;
  readonly userOpHash: string;
  readonly nonce: number;
  readonly stepUpHash: string | null;
  /** Set as soon as Swissquote co-signs, so a failed submit is retried without co-signing again. */
  readonly cosignature: string | null;
  readonly receipt: Receipt | null;
  readonly assessment: AssessResponse;
}

export interface BridgeState {
  readonly session: Session | null;
  readonly wallet: WalletRef | null;
  readonly pending: Readonly<Record<string, PendingSend>>;
}

export const EMPTY_STATE: BridgeState = { session: null, wallet: null, pending: {} };

const STATE_KEY = 'sqw-bridge-state';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** Shallow shape check of what we wrote ourselves; anything else resets to an empty state. */
function isBridgeState(v: unknown): v is BridgeState {
  return isRecord(v) && 'session' in v && 'wallet' in v && 'pending' in v && isRecord(v.pending);
}

export async function loadState(store: KeyValueStore): Promise<BridgeState> {
  const raw = await store.get(STATE_KEY);
  return isBridgeState(raw) ? raw : EMPTY_STATE;
}

export async function saveState(store: KeyValueStore, state: BridgeState): Promise<void> {
  await store.set(STATE_KEY, state);
}

/** Client-side copy of the audit log (frontend_tasks §1): every `SignedEntry` `/cosign` returns. */
export class LocalAuditLog {
  readonly #store: KeyValueStore;

  constructor(store: KeyValueStore) {
    this.#store = store;
  }

  async entries(address: string): Promise<readonly SignedEntry[]> {
    const raw = await this.#store.get(logKey(address));
    return Array.isArray(raw) ? raw.filter(isSignedEntry) : [];
  }

  async append(address: string, entry: SignedEntry): Promise<void> {
    const current = await this.entries(address);
    if (current.some((e) => e.entry_hash === entry.entry_hash)) return;
    await this.#store.set(logKey(address), [...current, entry]);
  }
}

const logKey = (address: string): string => `sqw-audit-log:${address.toLowerCase()}`;

function isSignedEntry(v: unknown): v is SignedEntry {
  return isRecord(v) && typeof v.entry_hash === 'string' && isRecord(v.entry) && isRecord(v.receipt);
}
