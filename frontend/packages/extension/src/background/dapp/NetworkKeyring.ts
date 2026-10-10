import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import type { KeyValueStore } from '../storage';

// The wallet's Base Sepolia key (frontend_tasks §3, testnet_plan M3). The honest shortcut until a
// smart account exists: a secp256k1 key generated and kept in the background, encrypted at rest,
// never logged, rendered or sent. The Ferra account owner stays the passkey.

/** Bytes backed by a plain ArrayBuffer, which is what WebCrypto accepts. */
export type Bytes = Uint8Array<ArrayBuffer>;

/** Encrypts the key at rest. Today a device key; later a key derived from the passkey (WebAuthn PRF). */
export interface KeyWrapper {
  wrap(plain: Bytes): Promise<{ iv: string; data: string }>;
  unwrap(sealed: { iv: string; data: string }): Promise<Bytes>;
}

interface StoredKey {
  readonly address: string;
  readonly sealed: { iv: string; data: string };
}

const KEY = 'sqw-network-key:base-sepolia';

export class NetworkKeyring {
  readonly #store: KeyValueStore;
  readonly #wrapper: KeyWrapper;

  constructor(store: KeyValueStore, wrapper: KeyWrapper) {
    this.#store = store;
    this.#wrapper = wrapper;
  }

  /** The public address, or null before the key exists. Never decrypts. */
  async address(): Promise<string | null> {
    return (await this.#load())?.address ?? null;
  }

  /** Returns the address, generating and sealing a new key the first time. */
  async ensure(): Promise<string> {
    const existing = await this.#load();
    if (existing !== null) return existing.address;
    const privateKey = generatePrivateKey();
    const address = privateKeyToAccount(privateKey).address;
    const sealed = await this.#wrapper.wrap(hexToBytes(privateKey));
    await this.#store.set(KEY, { address, sealed } satisfies StoredKey);
    return address;
  }

  /** Signing account, for the background only. Decrypts on every call; nothing is cached. */
  async account(): Promise<PrivateKeyAccount | null> {
    const stored = await this.#load();
    if (stored === null) return null;
    const plain = await this.#wrapper.unwrap(stored.sealed);
    return privateKeyToAccount(bytesToHex(plain));
  }

  async #load(): Promise<StoredKey | null> {
    const raw = await this.#store.get(KEY);
    return isStoredKey(raw) ? raw : null;
  }
}

/**
 * AES-GCM with a non-extractable device key held in IndexedDB: the raw key material never exists
 * in JavaScript, so neither chrome.storage nor a memory dump of our code reveals it. Demo-grade:
 * anyone running code inside the extension can still ask it to decrypt (labelled in the UI).
 */
export class DeviceKeyWrapper implements KeyWrapper {
  #key: Promise<CryptoKey> | null = null;

  async wrap(plain: Bytes): Promise<{ iv: string; data: string }> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await this.#deviceKey(), plain);
    return { iv: toBase64(iv), data: toBase64(new Uint8Array(data)) };
  }

  async unwrap(sealed: { iv: string; data: string }): Promise<Bytes> {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(sealed.iv) },
      await this.#deviceKey(),
      fromBase64(sealed.data),
    );
    return new Uint8Array(plain);
  }

  #deviceKey(): Promise<CryptoKey> {
    this.#key ??= loadOrCreateDeviceKey();
    return this.#key;
  }
}

const DB = 'sqw-keys';
const STORE = 'device';
const DEVICE_KEY_ID = 'aes-gcm-v1';

async function loadOrCreateDeviceKey(): Promise<CryptoKey> {
  const db = await openDb();
  const existing = await idbGet<CryptoKey>(db, DEVICE_KEY_ID);
  if (existing !== undefined) return existing;
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  await idbPut(db, DEVICE_KEY_ID, key);
  return key;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet<T>(db: IDBDatabase, id: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(id);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(db: IDBDatabase, id: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
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

function hexToBytes(hex: Hex): Bytes {
  const clean = hex.slice(2);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): Hex {
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

const toBase64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const fromBase64 = (s: string): Bytes => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
