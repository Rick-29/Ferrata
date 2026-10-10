import { ed25519 } from '@noble/curves/ed25519';
import { base58 } from '@scure/base';
import type { KeyValueStore } from '../storage';
import type { Bytes, KeyWrapper } from '../dapp/NetworkKeyring';

// The wallet's Solana devnet key (frontend_tasks §3, testnet_plan M3): Ed25519, generated and kept
// in the background, sealed at rest with the same wrapper as the Base Sepolia key. The address is
// the base58 public key; the secret never leaves this file except to sign (later).

interface StoredKey {
  readonly address: string;
  readonly sealed: { iv: string; data: string };
}

const KEY = 'sqw-network-key:solana-devnet';

export class SolanaKeyring {
  readonly #store: KeyValueStore;
  readonly #wrapper: KeyWrapper;

  constructor(store: KeyValueStore, wrapper: KeyWrapper) {
    this.#store = store;
    this.#wrapper = wrapper;
  }

  /** Base58 address, or null before the key exists. Never decrypts. */
  async address(): Promise<string | null> {
    return (await this.#load())?.address ?? null;
  }

  /** Returns the address, generating and sealing a new key the first time. */
  async ensure(): Promise<string> {
    const existing = await this.#load();
    if (existing !== null) return existing.address;
    const secret: Bytes = new Uint8Array(ed25519.utils.randomPrivateKey());
    const address = base58.encode(ed25519.getPublicKey(secret));
    await this.#store.set(KEY, { address, sealed: await this.#wrapper.wrap(secret) } satisfies StoredKey);
    return address;
  }

  /** Signs `message` with the devnet key. For the background only; nothing is cached. */
  async sign(message: Uint8Array): Promise<Uint8Array | null> {
    const stored = await this.#load();
    if (stored === null) return null;
    const secret = await this.#wrapper.unwrap(stored.sealed);
    return ed25519.sign(message, secret);
  }

  async #load(): Promise<StoredKey | null> {
    const raw = await this.#store.get(KEY);
    return isStoredKey(raw) ? raw : null;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

function isStoredKey(v: unknown): v is StoredKey {
  return (
    isRecord(v) &&
    typeof v.address === 'string' &&
    isRecord(v.sealed) &&
    typeof v.sealed.iv === 'string' &&
    typeof v.sealed.data === 'string'
  );
}
