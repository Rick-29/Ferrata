import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { DOCUMENT_LABELS } from '../identity/checks';
import type { KycScript } from '../recovery/RecoveryService';
import { Body, Button, Card, Eyebrow, Field } from '../ui/components';
import { SPACE, useTheme } from '../ui/theme';
import { DocumentCheck, type DocumentResult } from './document/DocumentCheck';
import { FaceCheck, type FaceCheckResult } from './FaceCheck';

type Props = {
  readonly isBusy: boolean;
  readonly onSubmit: (script: KycScript, fullName: string) => void;
};

/**
 * Identity: the (simulated, optional) face check, then the identity document (real reading and
 * checks, simulated face match and chip), then the mock KYC, clearly labelled as the spec requires
 * ("Simulated video identification").
 */
export function IdentifyStep({ isBusy, onSubmit }: Props) {
  const t = useTheme();
  const [face, setFace] = useState<FaceCheckResult | null>(null);
  const [document, setDocument] = useState<DocumentResult | null>(null);
  const [fullName, setFullName] = useState('');
  const canSubmit = fullName.trim() !== '' && !isBusy;

  if (face === null) return <FaceCheck onDone={setFace} />;
  if (document === null) {
    return (
      <DocumentCheck
        isFaceChecked={face === 'checked'}
        onDone={(result) => {
          setDocument(result);
          setFullName(result.holderName);
        }}
      />
    );
  }

  return (
    <>
      <Body muted>
        {face === 'checked' ? 'Vérification faciale (simulée) faite' : 'Vérification faciale passée'} ·{' '}
        {DOCUMENT_LABELS[document.type]} accepté.
      </Body>
      <Card>
        <Eyebrow color={t.accent}>Identification vidéo simulée</Eyebrow>
        <Body>
          Dans le vrai produit, un conseiller Swissquote vérifie votre identité par appel vidéo. Ici, choisissez l'issue
          de l'appel.
        </Body>
      </Card>
      <Field label="Nom complet (lu sur le document)" value={fullName} onChangeText={setFullName} autoCapitalize="words" />
      <View style={styles.choices}>
        <Button
          label="Je suis le titulaire (documents conformes)"
          isBusy={isBusy}
          isDisabled={!canSubmit}
          onPress={() => onSubmit('kyc-pass', fullName)}
        />
        <Button
          label="Simuler un attaquant (visage ≠ pièce d'identité)"
          variant="secondary"
          isDisabled={!canSubmit}
          onPress={() => onSubmit('kyc-fail', fullName)}
        />
      </View>
    </>
  );
}

const styles = StyleSheet.create({ choices: { gap: SPACE.sm } });
