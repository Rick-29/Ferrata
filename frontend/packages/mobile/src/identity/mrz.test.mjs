// Run: npm test (node --test). Imports the TypeScript sources through Node's type stripping.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ageOn, checkDocument, parseSwissDate } from './checks.ts';
import { checkDigit, parseMrz } from './mrz.ts';
import { DEMO_MRZ } from './specimens.ts';

const TODAY = new Date(Date.UTC(2026, 9, 11));

// Public ICAO Doc 9303 specimens (fictional holder "Anna Maria Eriksson", state "UTO").
const ICAO_TD3 = 'P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<\nL898902C36UTO7408122F1204159ZE184226B<<<<<10';
const ICAO_TD1 = 'I<UTOD231458907<<<<<<<<<<<<<<<\n7408122F1204159UTO<<<<<<<<<<<6\nERIKSSON<<ANNA<MARIA<<<<<<<<<<';

test('check digit matches the ICAO worked example', () => {
  assert.equal(checkDigit('L898902C3'), 6);
  assert.equal(checkDigit('740812'), 2);
  assert.equal(checkDigit('ZE184226B<<<<<'), 1);
});

test('parses the ICAO passport specimen', () => {
  const r = parseMrz(ICAO_TD3, TODAY);
  assert.ok(r.ok);
  assert.equal(r.value.format, 'TD3');
  assert.equal(r.value.surname, 'ERIKSSON');
  assert.equal(r.value.givenNames, 'ANNA MARIA');
  assert.equal(r.value.documentNumber, 'L898902C3');
  assert.equal(r.value.birthDate, '1974-08-12');
  assert.equal(r.value.expiryDate, '2012-04-15');
});

test('parses the ICAO ID card specimen', () => {
  const r = parseMrz(ICAO_TD1, TODAY);
  assert.ok(r.ok);
  assert.equal(r.value.format, 'TD1');
  assert.equal(r.value.documentNumber, 'D23145890');
  assert.equal(r.value.sex, 'F');
});

test('rejects a tampered birth date through its check digit', () => {
  const r = parseMrz(ICAO_TD3.replace('7408122F', '7508122F'), TODAY);
  assert.deepEqual(r, { ok: false, error: { code: 'MRZ_CHECKSUM', field: 'birthDate' } });
});

test('rejects text that is not an MRZ', () => {
  assert.deepEqual(parseMrz('hello', TODAY), { ok: false, error: { code: 'MRZ_FORMAT' } });
});

test('accepts scanner noise: spaces, lower case, « for <<, one pasted line', () => {
  const noisy = ICAO_TD3.toLowerCase().replace('<<anna', '«anna').replace('\n', '').replace('L898', 'L 898');
  assert.ok(parseMrz(noisy.replace(' ', ''), TODAY).ok);
});

test('demo specimens are valid, adult and not expired', () => {
  for (const [type, text] of Object.entries(DEMO_MRZ)) {
    const r = parseMrz(text, TODAY);
    assert.ok(r.ok, type);
    const checks = checkDocument(
      { type, holderName: 'x', birthDate: r.value.birthDate, expiryDate: r.value.expiryDate, documentCode: r.value.documentCode },
      TODAY,
    );
    assert.ok(checks.isValid, type);
    assert.equal(checks.age, 36);
  }
});

test('age changes on the birthday, not before', () => {
  assert.equal(ageOn('2008-10-11', TODAY), 18);
  assert.equal(ageOn('2008-10-12', TODAY), 17);
});

test('flags minors, expired documents and the wrong document type', () => {
  const base = { type: 'passport', holderName: 'x', birthDate: '1990-01-01', expiryDate: '2030-01-01', documentCode: 'P' };
  assert.equal(checkDocument({ ...base, birthDate: '2010-01-01' }, TODAY).isAdult, false);
  assert.equal(checkDocument({ ...base, expiryDate: '2026-10-10' }, TODAY).isExpired, true);
  assert.equal(checkDocument({ ...base, expiryDate: '2026-10-11' }, TODAY).isExpired, false);
  assert.equal(checkDocument({ ...base, type: 'id-card' }, TODAY).matchesType, false);
  assert.equal(checkDocument({ ...base, type: 'driver-license', documentCode: undefined, expiryDate: null }, TODAY).isValid, true);
});

test('parses Swiss dates and rejects impossible ones', () => {
  assert.equal(parseSwissDate('14.03.1990'), '1990-03-14');
  assert.equal(parseSwissDate('1/2/2000'), '2000-02-01');
  assert.equal(parseSwissDate('31.04.2000'), null);
  assert.equal(parseSwissDate('1990-03-14'), null);
});
