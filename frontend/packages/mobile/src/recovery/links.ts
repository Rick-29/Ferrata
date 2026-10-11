import { keccak_256 } from '@noble/hashes/sha3.js';
import type { OwnerKey } from '@sqw/types/OwnerKey';

// What the phone scans (written by the extension, `extension/src/recovery/qr.ts`), and the key
// fingerprint both screens show (same bytes as the extension and the backend's `pairing::fingerprint`).

export type FerrataLink =
  /** Associate this phone as the wallet's recovery phone. */
  | { readonly kind: 'pair'; readonly id: string; readonly address: string }
  /** Approve the recovery started on a new computer. */
  | { readonly kind: 'recover'; readonly id: string };

/**
 * Accepts the app's own `ferrata:pair?…` / `ferrata:recover?…`, and the same as an Expo Go deep
 * link (`exp://host:8081/--/pair?…`), which is what the phone's camera opens the app with.
 */
export function parseFerrataLink(text: string): FerrataLink | null {
  const match = /^(?:ferrata:\/{0,2}|exps?:\/\/[^/?#]+\/--\/)(pair|recover)\?([^#]*)$/.exec(text.trim());
  if (!match) return null;
  const params = queryParams(match[2] ?? '');
  const id = params.get('id');
  if (!id) return null;
  if (match[1] === 'recover') return { kind: 'recover', id };
  const address = params.get('address');
  return address ? { kind: 'pair', id, address } : null;
}

/** Query string → map. Hand-rolled: React Native's URLSearchParams is not complete everywhere. */
function queryParams(query: string): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const part of query.split('&')) {
    const [rawKey, rawValue = ''] = part.split('=');
    if (!rawKey) continue;
    try {
      out.set(decodeURIComponent(rawKey), decodeURIComponent(rawValue.replace(/\+/g, ' ')));
    } catch {
      // A malformed escape: skip that pair.
    }
  }
  return out;
}

/** Short, human-comparable fingerprint of a public key, e.g. `7F3A-91C2`. */
export function keyFingerprint(key: OwnerKey): string {
  const json = JSON.stringify({ kind: key.kind, key: key.key });
  const hex = Array.from(keccak_256(new TextEncoder().encode(json)).slice(0, 4), (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
  return `${hex.slice(0, 4)}-${hex.slice(4)}`;
}

export const shortAddress = (address: string): string => `${address.slice(0, 6)}…${address.slice(-4)}`;
