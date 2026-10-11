import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keyFingerprint, parseFerrataLink } from './links.ts';

// Same vector as the extension (background/recovery/fingerprint.test.ts) and the backend (pairing.rs).
test('the fingerprint matches the extension and the backend', () => {
  assert.equal(keyFingerprint({ kind: 'ed25519', key: '0x' + '11'.repeat(32) }), '5FA8-122B');
});

test('reads the codes the extension shows, and nothing else', () => {
  assert.deepEqual(parseFerrataLink('ferrata:pair?v=1&id=pair_1&address=0xabc'), { kind: 'pair', id: 'pair_1', address: '0xabc' });
  assert.deepEqual(parseFerrataLink('ferrata:recover?v=1&id=rec_1'), { kind: 'recover', id: 'rec_1' });
  assert.equal(parseFerrataLink('https://evil.example/?id=1'), null);
  assert.equal(parseFerrataLink('ferrata:pair?id=pair_1'), null);
});

test('reads the same codes as Expo Go deep links (the camera opens the app with them)', () => {
  assert.deepEqual(parseFerrataLink('exp://128.179.162.183:8081/--/pair?v=1&id=pair_1&address=0xabc'), { kind: 'pair', id: 'pair_1', address: '0xabc' });
  assert.deepEqual(parseFerrataLink('exp://192.168.1.20:8081/--/recover?v=1&id=rec_1'), { kind: 'recover', id: 'rec_1' });
  assert.equal(parseFerrataLink('exp://128.179.162.183:8081'), null, 'opening the app without a code is not a code');
  assert.equal(parseFerrataLink('exp://host:8081/--/steal?id=1'), null);
});
