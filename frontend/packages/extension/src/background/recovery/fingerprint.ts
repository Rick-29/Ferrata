import { keccak_256 } from '@noble/hashes/sha3';
import type { OwnerKey } from '@sqw/types/OwnerKey';

/**
 * Short, human-comparable fingerprint of a public key (e.g. `7F3A-91C2`), shown on the computer and
 * on the phone during pairing. Same bytes as the backend's `pairing::fingerprint`: keccak-256 of the
 * key's JSON (`{"kind":…,"key":…}`, serde's field order), first 4 bytes, upper-case hex.
 * Computed here from the key itself, never taken from the server.
 */
export function keyFingerprint(key: OwnerKey): string {
  const json = JSON.stringify({ kind: key.kind, key: key.key });
  const hex = Array.from(keccak_256(new TextEncoder().encode(json)).slice(0, 4), (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
  return `${hex.slice(0, 4)}-${hex.slice(4)}`;
}
