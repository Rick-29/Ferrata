import type { OwnerKey } from '@sqw/types/OwnerKey';
import type { OwnerSignature } from '@sqw/types/OwnerSignature';
import { err, ok, sdkError, type Result, type SdkError } from '@sqw/sdk';
import {
  PASSKEY_CHANNEL,
  isPasskeyResponse,
  type CreatedPasskey,
  type PasskeyRequest,
  type PasskeyResponse,
} from '../passkey/protocol';
import type { PasskeySigner } from './passkey';
import type { KeyValueStore } from './storage';

/** Sends a request to the open extension page and returns its raw answer (chrome.runtime.sendMessage). */
export type PageMessenger = (request: PasskeyRequest) => Promise<unknown>;

const credentialKey = (name: string): string => `sqw-passkey:${name}`;

function isCreatedPasskey(v: unknown): v is CreatedPasskey {
  return (
    typeof v === 'object' &&
    v !== null &&
    'credentialId' in v &&
    typeof v.credentialId === 'string' &&
    'owner' in v &&
    typeof v.owner === 'object' &&
    v.owner !== null
  );
}

const HEX = /^0x[0-9a-fA-F]*$/;
const isHexField = (v: Record<string, unknown>, key: string): boolean => typeof v[key] === 'string' && HEX.test(String(v[key]));

/** What the page built with assertionToOwnerSignature; the backend verifies the bytes. */
function isWebAuthnSignature(v: unknown): v is OwnerSignature {
  if (typeof v !== 'object' || v === null) return false;
  const r: Record<string, unknown> = { ...v };
  return r['kind'] === 'webauthn' && isHexField(r, 'authenticator_data') && isHexField(r, 'client_data_json') && isHexField(r, 'signature');
}

/**
 * Real passkeys (frontend_tasks §3): the ceremony runs in the popup, this class only routes it
 * and remembers which credential belongs to which wallet. Stores the credential id and public
 * key (not secrets) in chrome.storage.local so the wallet is found again after a restart.
 */
export class WebAuthnPasskeySigner implements PasskeySigner {
  readonly #send: PageMessenger;
  readonly #store: KeyValueStore;

  constructor(send: PageMessenger, store: KeyValueStore) {
    this.#send = send;
    this.#store = store;
  }

  async create(name: string): Promise<Result<OwnerKey, SdkError>> {
    // One passkey per wallet: reuse it instead of creating a new key (and a new account) each login.
    const known = await this.#credential(name);
    if (known) return ok(known.owner);
    const created = await this.#ask({ channel: PASSKEY_CHANNEL, op: 'create', userName: name });
    if (!created.ok) return created;
    if (!isCreatedPasskey(created.value)) return err(sdkError('PASSKEY_FAILED', 'passkey', 'malformed passkey'));
    await this.#store.set(credentialKey(name), created.value);
    return ok(created.value.owner);
  }

  async sign(name: string, hash: string): Promise<Result<OwnerSignature, SdkError>> {
    const known = await this.#credential(name);
    if (!known) return err(sdkError('PASSKEY_UNKNOWN', 'passkey', `no passkey for ${name}`));
    const signed = await this.#ask({ channel: PASSKEY_CHANNEL, op: 'sign', credentialId: known.credentialId, hash });
    if (!signed.ok) return signed;
    if (!isWebAuthnSignature(signed.value)) return err(sdkError('PASSKEY_FAILED', 'passkey', 'malformed signature'));
    return ok(signed.value);
  }

  async #credential(name: string): Promise<CreatedPasskey | null> {
    const stored = await this.#store.get(credentialKey(name));
    return isCreatedPasskey(stored) ? stored : null;
  }

  async #ask(request: PasskeyRequest): Promise<Result<unknown, SdkError>> {
    let answer: unknown;
    try {
      answer = await this.#send(request);
    } catch {
      return err(sdkError('PASSKEY_UNAVAILABLE', 'passkey', 'no extension page open to run the passkey'));
    }
    if (!isPasskeyResponse(answer)) {
      return err(sdkError('PASSKEY_UNAVAILABLE', 'passkey', 'no extension page answered the passkey request'));
    }
    const response: PasskeyResponse<unknown> = answer;
    return response.ok ? ok(response.value) : err(sdkError(response.error.code, 'passkey', response.error.message));
  }
}
