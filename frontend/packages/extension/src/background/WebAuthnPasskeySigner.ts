import type { OwnerKey } from '@sqw/types/OwnerKey';
import type { OwnerSignature } from '@sqw/types/OwnerSignature';
import { err, ok, sdkError, type Result, type SdkError } from '@sqw/sdk';
import { PASSKEY_CHANNEL, type CreatedPasskey, type PasskeyAssertion, type PasskeyRequest, type PasskeyResponse } from '../passkey/protocol';
import type { PasskeySigner } from './passkey';
import type { KeyValueStore } from './storage';

// The real PasskeySigner (testnet_plan M4): the background decides what to sign, an open extension
// page (popup, approval window) runs WebAuthn and returns the result. Stored here per passkey name:
// the credential id and the public key only. The private key stays in the authenticator.

/** Sends one request to whichever extension page answers; injected so tests need no chrome API. */
export type PageMessenger = (request: PasskeyRequest) => Promise<unknown>;

interface StoredPasskey {
  readonly credentialId: string;
  readonly publicKey: string;
}

const KEY = 'sqw-passkeys';

export class WebAuthnPasskeySigner implements PasskeySigner {
  readonly #store: KeyValueStore;
  readonly #send: PageMessenger;

  constructor(store: KeyValueStore, send: PageMessenger) {
    this.#store = store;
    this.#send = send;
  }

  /** Finds the passkey already created for `name` on this device, else asks the user to create one. */
  async create(name: string): Promise<Result<OwnerKey, SdkError>> {
    const known = (await this.#all())[name];
    if (known) return ok({ kind: 'p256', key: known.publicKey });

    const created = await this.#ask<CreatedPasskey>({ channel: PASSKEY_CHANNEL, op: 'create', userName: name });
    if (!created.ok) return created;
    await this.#store.set(KEY, { ...(await this.#all()), [name]: created.value });
    return ok({ kind: 'p256', key: created.value.publicKey });
  }

  /** Recovery: always a brand-new passkey under `name` (the old one is lost), replacing the record. */
  async replace(name: string): Promise<Result<OwnerKey, SdkError>> {
    const created = await this.#ask<CreatedPasskey>({ channel: PASSKEY_CHANNEL, op: 'create', userName: name });
    if (!created.ok) return created;
    await this.#store.set(KEY, { ...(await this.#all()), [name]: created.value });
    return ok({ kind: 'p256', key: created.value.publicKey });
  }

  /** The credential id and public key recorded for `name` (never a secret), or null. */
  async credential(name: string): Promise<{ readonly credentialId: string; readonly publicKey: string } | null> {
    return (await this.#all())[name] ?? null;
  }

  async has(name: string): Promise<boolean> {
    return (await this.#all())[name] !== undefined;
  }

  async sign(name: string, hash: string): Promise<Result<OwnerSignature, SdkError>> {
    const known = (await this.#all())[name];
    if (!known) return err(sdkError('PASSKEY_UNAVAILABLE', 'passkey', `No passkey on this device for ${name}.`));
    const signed = await this.#ask<PasskeyAssertion>({ channel: PASSKEY_CHANNEL, op: 'sign', credentialId: known.credentialId, hash });
    return signed.ok ? ok({ kind: 'webauthn', ...signed.value }) : signed;
  }

  async #ask<T>(request: PasskeyRequest): Promise<Result<T, SdkError>> {
    let response: unknown;
    try {
      response = await this.#send(request);
    } catch {
      // No page listening: the popup was closed before the prompt could open.
      return err(sdkError('PASSKEY_UNAVAILABLE', 'passkey', 'Open the wallet window to use your passkey.'));
    }
    if (!isResponse<T>(response)) return err(sdkError('PASSKEY_UNAVAILABLE', 'passkey', 'No wallet window answered.'));
    return response.ok ? ok(response.value) : err(sdkError(response.code, 'passkey', response.message));
  }

  async #all(): Promise<Readonly<Record<string, StoredPasskey>>> {
    const raw = await this.#store.get(KEY);
    if (typeof raw !== 'object' || raw === null) return {};
    return Object.fromEntries(Object.entries(raw).filter((e): e is [string, StoredPasskey] => isStored(e[1])));
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

function isStored(v: unknown): v is StoredPasskey {
  return isRecord(v) && typeof v.credentialId === 'string' && typeof v.publicKey === 'string';
}

function isResponse<T>(v: unknown): v is PasskeyResponse<T> {
  return isRecord(v) && (v.ok === true ? 'value' in v : v.ok === false && typeof v.code === 'string');
}
