// Machine Readable Zone parser (ICAO Doc 9303). REAL: format, field layout and every check digit
// are verified; nothing is guessed. Pure functions, no I/O, so they run in Node tests as well.
// TD3 = passport data page (2 x 44). TD1 = ID card (3 x 30).

export type MrzFormat = 'TD1' | 'TD3';
/** ISO calendar date, `YYYY-MM-DD`. */
export type IsoDate = string;

export interface MrzData {
  readonly format: MrzFormat;
  /** `P` for passports, `I`/`ID`/`A`/`C` for identity cards. */
  readonly documentCode: string;
  readonly issuingState: string;
  readonly documentNumber: string;
  readonly surname: string;
  readonly givenNames: string;
  readonly nationality: string;
  readonly birthDate: IsoDate;
  readonly sex: 'F' | 'M' | 'X';
  readonly expiryDate: IsoDate;
}

export type MrzErrorCode = 'MRZ_FORMAT' | 'MRZ_CHECKSUM' | 'MRZ_DATE';
export interface MrzError {
  readonly code: MrzErrorCode;
  /** Which field failed, for the message ("numéro du document", …). */
  readonly field?: MrzField;
}
export type MrzField = 'documentNumber' | 'birthDate' | 'expiryDate' | 'optional' | 'composite';

export type MrzResult = { readonly ok: true; readonly value: MrzData } | { readonly ok: false; readonly error: MrzError };

const TD3_LINE = 44;
const TD1_LINE = 30;
const WEIGHTS = [7, 3, 1] as const;
const VALID_LINE = /^[A-Z0-9<]+$/;

/** ICAO 9303 check digit: weights 7-3-1, digits as is, A-Z = 10-35, filler `<` = 0. */
export function checkDigit(field: string): number {
  let sum = 0;
  for (let i = 0; i < field.length; i += 1) {
    const c = field.charCodeAt(i);
    const value = c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 90 ? c - 55 : 0;
    sum += value * (WEIGHTS[i % 3] ?? 1);
  }
  return sum % 10;
}

/**
 * Cleans text typed or captured by the phone's text scanner: upper case, no spaces, and the
 * look-alikes OCR tends to produce for the filler (`«` for `<<`, `‹` for `<`).
 */
export function normalizeMrz(text: string): string[] {
  const lines = text
    .toUpperCase()
    .replace(/«/g, '<<')
    .replace(/[‹〈]/g, '<')
    .split(/\r?\n/)
    .map((line) => line.replace(/\s/g, ''))
    .filter((line) => line !== '');
  if (lines.length !== 1) return lines;
  const single = lines[0] ?? '';
  // Pasted as one line: split by the known line lengths.
  if (single.length === TD3_LINE * 2) return [single.slice(0, TD3_LINE), single.slice(TD3_LINE)];
  if (single.length === TD1_LINE * 3) {
    return [single.slice(0, TD1_LINE), single.slice(TD1_LINE, TD1_LINE * 2), single.slice(TD1_LINE * 2)];
  }
  return lines;
}

export function parseMrz(text: string, today: Date): MrzResult {
  const lines = normalizeMrz(text);
  if (!lines.every((line) => VALID_LINE.test(line))) return fail('MRZ_FORMAT');
  if (lines.length === 2 && lines.every((line) => line.length === TD3_LINE)) return parseTd3(lines, today);
  if (lines.length === 3 && lines.every((line) => line.length === TD1_LINE)) return parseTd1(lines, today);
  return fail('MRZ_FORMAT');
}

function parseTd3(lines: readonly string[], today: Date): MrzResult {
  const [l1 = '', l2 = ''] = lines;
  if (l1[0] !== 'P') return fail('MRZ_FORMAT');
  const checked = verify([
    ['documentNumber', l2.slice(0, 9), l2[9]],
    ['birthDate', l2.slice(13, 19), l2[19]],
    ['expiryDate', l2.slice(21, 27), l2[27]],
    ['optional', l2.slice(28, 42), l2[42], true],
    ['composite', l2.slice(0, 10) + l2.slice(13, 20) + l2.slice(21, 43), l2[43]],
  ]);
  if (checked) return checked;
  return build('TD3', {
    documentCode: l1.slice(0, 2),
    issuingState: l1.slice(2, 5),
    names: l1.slice(5),
    documentNumber: l2.slice(0, 9),
    nationality: l2.slice(10, 13),
    birth: l2.slice(13, 19),
    sex: l2[20] ?? '<',
    expiry: l2.slice(21, 27),
    today,
  });
}

function parseTd1(lines: readonly string[], today: Date): MrzResult {
  const [l1 = '', l2 = '', l3 = ''] = lines;
  if (!'IAC'.includes(l1[0] ?? '')) return fail('MRZ_FORMAT');
  const checked = verify([
    ['documentNumber', l1.slice(5, 14), l1[14]],
    ['birthDate', l2.slice(0, 6), l2[6]],
    ['expiryDate', l2.slice(8, 14), l2[14]],
    ['composite', l1.slice(5, 30) + l2.slice(0, 7) + l2.slice(8, 15) + l2.slice(18, 29), l2[29]],
  ]);
  if (checked) return checked;
  return build('TD1', {
    documentCode: l1.slice(0, 2),
    issuingState: l1.slice(2, 5),
    names: l3,
    documentNumber: l1.slice(5, 14),
    nationality: l2.slice(15, 18),
    birth: l2.slice(0, 6),
    sex: l2[7] ?? '<',
    expiry: l2.slice(8, 14),
    today,
  });
}

/** `[field, data, check character, may be all fillers]`. Returns the first failure, if any. */
type Check = readonly [MrzField, string, string | undefined, boolean?];

function verify(checks: readonly Check[]): MrzResult | null {
  for (const [field, data, check, isOptional] of checks) {
    // An unused optional field may be filled with `<`, check digit included.
    if (isOptional === true && /^<*$/.test(data) && (check === '<' || check === '0')) continue;
    if (check === undefined || !/^\d$/.test(check) || checkDigit(data) !== Number(check)) {
      return fail('MRZ_CHECKSUM', field);
    }
  }
  return null;
}

interface RawFields {
  readonly documentCode: string;
  readonly issuingState: string;
  readonly names: string;
  readonly documentNumber: string;
  readonly nationality: string;
  readonly birth: string;
  readonly sex: string;
  readonly expiry: string;
  readonly today: Date;
}

function build(format: MrzFormat, raw: RawFields): MrzResult {
  const birthDate = mrzDate(raw.birth, raw.today, 'past');
  const expiryDate = mrzDate(raw.expiry, raw.today, 'future');
  if (birthDate === null) return fail('MRZ_DATE', 'birthDate');
  if (expiryDate === null) return fail('MRZ_DATE', 'expiryDate');
  const [surname = '', given = ''] = raw.names.split('<<');
  return {
    ok: true,
    value: {
      format,
      documentCode: raw.documentCode.replace(/</g, ''),
      issuingState: raw.issuingState.replace(/</g, ''),
      documentNumber: raw.documentNumber.replace(/</g, ''),
      surname: words(surname),
      givenNames: words(given),
      nationality: raw.nationality.replace(/</g, ''),
      birthDate,
      sex: raw.sex === 'F' || raw.sex === 'M' ? raw.sex : 'X',
      expiryDate,
    },
  };
}

const words = (field: string): string => field.split('<').filter((w) => w !== '').join(' ');

/**
 * `YYMMDD` to an ISO date. The MRZ has no century: a birth date is the latest one not in the
 * future; an expiry date is taken in this century (documents last at most a few decades).
 */
function mrzDate(yymmdd: string, today: Date, kind: 'past' | 'future'): IsoDate | null {
  if (!/^\d{6}$/.test(yymmdd)) return null;
  const yy = Number(yymmdd.slice(0, 2));
  const mm = Number(yymmdd.slice(2, 4));
  const dd = Number(yymmdd.slice(4, 6));
  const thisYear = today.getUTCFullYear();
  let year = 2000 + yy;
  if (kind === 'past' && year > thisYear) year -= 100;
  return isoDate(year, mm, dd);
}

/** Builds `YYYY-MM-DD`, or null when the day does not exist (31 April, 30 February…). */
export function isoDate(year: number, month: number, day: number): IsoDate | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function fail(code: MrzErrorCode, field?: MrzField): MrzResult {
  return { ok: false, error: field === undefined ? { code } : { code, field } };
}
