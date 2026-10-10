// Where the background keeps its state. MV3 kills an idle service worker after ~30 s, so nothing
// that must survive between two popup clicks may live only in memory.

export interface KeyValueStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

/** Tests and Node scripts. */
export class MemoryStore implements KeyValueStore {
  #data = new Map<string, unknown>();

  async get(key: string): Promise<unknown> {
    return structuredClone(this.#data.get(key));
  }

  async set(key: string, value: unknown): Promise<void> {
    this.#data = new Map([...this.#data, [key, structuredClone(value)]]);
  }

  async remove(key: string): Promise<void> {
    this.#data = new Map([...this.#data].filter(([k]) => k !== key));
  }
}

/**
 * `chrome.storage.session` for secrets-adjacent state (session token): in memory only, cleared
 * when the browser closes, not readable by content scripts. `chrome.storage.local` for the
 * audit log, which must persist.
 */
export class ChromeStore implements KeyValueStore {
  readonly #area: chrome.storage.StorageArea;

  constructor(area: chrome.storage.StorageArea) {
    this.#area = area;
  }

  async get(key: string): Promise<unknown> {
    const items = await this.#area.get(key);
    return items[key];
  }

  async set(key: string, value: unknown): Promise<void> {
    await this.#area.set({ [key]: value });
  }

  async remove(key: string): Promise<void> {
    await this.#area.remove(key);
  }
}
