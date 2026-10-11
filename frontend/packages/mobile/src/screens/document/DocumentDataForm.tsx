import { useState } from 'react';
import { Platform } from 'react-native';
import { parseSwissDate, type DocumentFacts, type DocumentType } from '../../identity/checks';
import { parseMrz, type MrzError, type MrzField } from '../../identity/mrz';
import { DEMO_LICENSE, DEMO_MRZ } from '../../identity/specimens';
import { Body, Button, Card, ErrorBanner, Eyebrow, Field } from '../../ui/components';
import { useTheme } from '../../ui/theme';

type Props = {
  readonly type: DocumentType;
  readonly onRead: (facts: DocumentFacts) => void;
};

const FIELD_NAMES: Readonly<Record<MrzField, string>> = {
  documentNumber: 'du numéro du document',
  birthDate: 'de la date de naissance',
  expiryDate: "de la date d'expiration",
  optional: 'des données complémentaires',
  composite: "de l'ensemble de la bande",
};

function mrzMessage(error: MrzError): string {
  switch (error.code) {
    case 'MRZ_FORMAT':
      return 'Ce n’est pas une bande MRZ complète : 2 lignes de 44 caractères (passeport) ou 3 lignes de 30 (carte).';
    case 'MRZ_CHECKSUM':
      return `Le chiffre de contrôle ${error.field ? FIELD_NAMES[error.field] : ''} ne correspond pas : erreur de lecture ou document modifié.`;
    case 'MRZ_DATE':
      return 'Une date de la bande MRZ est impossible.';
  }
}

const SCAN_TIP =
  Platform.OS === 'ios'
    ? 'Astuce iPhone : touchez le champ, puis « Scanner le texte » pour lire la bande avec l’appareil photo.'
    : 'Astuce : selon votre clavier, l’icône « Scanner le texte » lit la bande avec l’appareil photo. Sinon, recopiez-la.';

/**
 * Reads the document data. Passport / ID card: the MRZ (the lines of `<` at the bottom), checked
 * for real with its ICAO check digits. Driving licence: Swiss licences have no MRZ, so the holder
 * types the printed fields. There is no on-device OCR engine in Expo Go; the phone's own text
 * scanner (Live Text) can fill the field.
 */
export function DocumentDataForm({ type, onRead }: Props) {
  return type === 'driver-license' ? <LicenseForm onRead={onRead} /> : <MrzForm type={type} onRead={onRead} />;
}

function MrzForm({ type, onRead }: Props & { readonly type: Exclude<DocumentType, 'driver-license'> }) {
  const t = useTheme();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = (): void => {
    const result = parseMrz(text, new Date());
    if (!result.ok) {
      setError(mrzMessage(result.error));
      return;
    }
    const { value } = result;
    onRead({
      type,
      holderName: `${value.givenNames} ${value.surname}`.trim(),
      birthDate: value.birthDate,
      expiryDate: value.expiryDate,
      documentCode: value.documentCode,
    });
  };

  return (
    <Card>
      <Eyebrow color={t.accent}>Zone de lecture automatique (MRZ)</Eyebrow>
      <Body muted>
        Les lignes avec des « &lt; » en bas {type === 'passport' ? 'de la page photo' : 'du verso'}. Leurs chiffres de
        contrôle sont vérifiés pour de vrai.
      </Body>
      <Field
        label="Bande MRZ"
        value={text}
        onChangeText={(value) => {
          setText(value);
          setError(null);
        }}
        mono
        multiline
        autoCapitalize="characters"
        hint={SCAN_TIP}
      />
      <ErrorBanner message={error} />
      <Button label="Vérifier la bande" isDisabled={text.trim() === ''} onPress={submit} />
      <Button label="Remplir avec un exemple fictif (démo)" variant="secondary" onPress={() => setText(DEMO_MRZ[type])} />
    </Card>
  );
}

function LicenseForm({ onRead }: Pick<Props, 'onRead'>) {
  const t = useTheme();
  const [name, setName] = useState('');
  const [birth, setBirth] = useState('');
  const [expiry, setExpiry] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = (): void => {
    const birthDate = parseSwissDate(birth);
    const expiryDate = expiry.trim() === '' ? null : parseSwissDate(expiry);
    if (name.trim() === '') return setError('Indiquez le nom tel qu’il figure sur le permis.');
    if (birthDate === null) return setError('Date de naissance invalide (format JJ.MM.AAAA).');
    if (expiry.trim() !== '' && expiryDate === null) return setError('Date d’expiration invalide (format JJ.MM.AAAA).');
    onRead({ type: 'driver-license', holderName: name.trim(), birthDate, expiryDate });
  };

  const fill = (): void => {
    setName(DEMO_LICENSE.holderName);
    setBirth(DEMO_LICENSE.birthDate);
    setExpiry(DEMO_LICENSE.expiryDate);
  };

  return (
    <Card>
      <Eyebrow color={t.accent}>Données du permis</Eyebrow>
      <Body muted>Le permis suisse n’a pas de bande MRZ : recopiez les champs imprimés (rubriques 1, 2, 3 et 4b).</Body>
      <Field label="Nom et prénom" value={name} onChangeText={setName} autoCapitalize="words" />
      <Field label="Date de naissance" value={birth} onChangeText={setBirth} placeholder="JJ.MM.AAAA" keyboardType="numbers-and-punctuation" />
      <Field
        label="Valable jusqu’au (vide si aucune date)"
        value={expiry}
        onChangeText={setExpiry}
        placeholder="JJ.MM.AAAA"
        keyboardType="numbers-and-punctuation"
      />
      <ErrorBanner message={error} />
      <Button label="Vérifier" onPress={submit} />
      <Button label="Remplir avec un exemple fictif (démo)" variant="secondary" onPress={fill} />
    </Card>
  );
}
