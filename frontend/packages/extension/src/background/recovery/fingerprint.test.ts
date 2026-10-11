// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { keyFingerprint } from './fingerprint';

// Same vector as backend `pairing::tests::fingerprint_matches_the_extension`.
const KEY = { kind: 'ed25519' as const, key: `0x${'11'.repeat(32)}` };

describe('keyFingerprint', () => {
  it('is the backend fingerprint of the same key', () => {
    expect(keyFingerprint(KEY)).toBe('5FA8-122B');
  });
});
