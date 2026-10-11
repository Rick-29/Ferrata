import type { DocumentType } from './checks';

// FICTIONAL demo data (the account holder of the demo world, Alice Keller), with valid ICAO check
// digits so the real parser accepts it. Not a real person or document: no personal data in Git.

export const DEMO_MRZ: Readonly<Record<Exclude<DocumentType, 'driver-license'>, string>> = {
  passport: ['P<CHEKELLER<<ALICE<<<<<<<<<<<<<<<<<<<<<<<<<<', 'X0000000<1CHE9003141F3306301<<<<<<<<<<<<<<<8'].join('\n'),
  'id-card': ['IDCHEC0000000<4<<<<<<<<<<<<<<<', '9003141F3306301CHE<<<<<<<<<<<2', 'KELLER<<ALICE<<<<<<<<<<<<<<<<<'].join(
    '\n',
  ),
};

export const DEMO_LICENSE = { holderName: 'Alice Keller', birthDate: '14.03.1990', expiryDate: '' } as const;
