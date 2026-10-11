import type { IsoDate } from './mrz';

// REAL checks on the data read from the document: age, validity, and whether the document is of
// the type the user picked. Pure functions; `today` is a parameter so tests are deterministic.

export type DocumentType = 'passport' | 'id-card' | 'driver-license';

export const DOCUMENT_LABELS: Readonly<Record<DocumentType, string>> = {
  passport: 'Passeport',
  'id-card': "Carte d'identité",
  'driver-license': 'Permis de conduire',
};

export const ADULT_AGE = 18;

export interface DocumentFacts {
  readonly type: DocumentType;
  readonly holderName: string;
  readonly birthDate: IsoDate;
  /** Null: the document shows no end of validity (Swiss credit-card driving licences). */
  readonly expiryDate: IsoDate | null;
  /** MRZ document code, for passports and ID cards. */
  readonly documentCode?: string;
}

export interface DocumentChecks {
  readonly age: number;
  readonly isAdult: boolean;
  readonly isExpired: boolean;
  readonly matchesType: boolean;
  readonly isBirthPlausible: boolean;
  readonly isValid: boolean;
}

export function ageOn(birthDate: IsoDate, today: Date): number {
  const [y = 0, m = 0, d = 0] = birthDate.split('-').map(Number);
  const months = today.getUTCMonth() + 1;
  const hadBirthday = months > m || (months === m && today.getUTCDate() >= d);
  return today.getUTCFullYear() - y - (hadBirthday ? 0 : 1);
}

const todayIso = (today: Date): IsoDate => today.toISOString().slice(0, 10);

export function checkDocument(facts: DocumentFacts, today: Date): DocumentChecks {
  const age = ageOn(facts.birthDate, today);
  const isBirthPlausible = facts.birthDate <= todayIso(today) && age < 130;
  const isAdult = isBirthPlausible && age >= ADULT_AGE;
  // A document is valid through its expiry day.
  const isExpired = facts.expiryDate !== null && facts.expiryDate < todayIso(today);
  const matchesType = documentCodeMatches(facts.type, facts.documentCode);
  return { age, isAdult, isExpired, matchesType, isBirthPlausible, isValid: isAdult && !isExpired && matchesType };
}

function documentCodeMatches(type: DocumentType, code: string | undefined): boolean {
  if (type === 'driver-license') return code === undefined;
  if (code === undefined) return false;
  return type === 'passport' ? code.startsWith('P') : /^[IAC]/.test(code);
}

/** `JJ.MM.AAAA` (as printed on Swiss documents; `/` and `-` accepted too) to an ISO date. */
export function parseSwissDate(text: string): IsoDate | null {
  const match = /^\s*(\d{1,2})[./-](\d{1,2})[./-](\d{4})\s*$/.exec(text);
  if (!match) return null;
  const [, d = '', m = '', y = ''] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  if (date.getUTCFullYear() !== Number(y) || date.getUTCMonth() !== Number(m) - 1 || date.getUTCDate() !== Number(d)) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

/** `1990-03-14` to `14.03.1990`. */
export function formatSwissDate(date: IsoDate): string {
  const [y = '', m = '', d = ''] = date.split('-');
  return `${d}.${m}.${y}`;
}
