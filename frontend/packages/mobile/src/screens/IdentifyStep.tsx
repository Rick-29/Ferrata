import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import type { KycScript } from '../recovery/RecoveryService';
import { Body, Button, Card, Eyebrow, Field } from '../ui/components';
import { SPACE, useTheme } from '../ui/theme';
import { FaceCheck, type FaceCheckResult } from './FaceCheck';

type Props = {
  readonly isBusy: boolean;
  readonly onSubmit: (script: KycScript, fullName: string) => void;
};

/**
 * Identity: first the (simulated, optional) face check, then the mock KYC, clearly labelled as the
 * spec requires ("Simulated video identification").
 */
export function IdentifyStep({ isBusy, onSubmit }: Props) {
  const t = useTheme();
  const [fullName, setFullName] = useState('');
  const [face, setFace] = useState<FaceCheckResult | null>(null);
  const canSubmit = fullName.trim() !== '' && !isBusy;

  if (face === null) return <FaceCheck onDone={setFace} />;

  return (
    <>
      <Body muted>{face === 'checked' ? 'Vérification faciale (simulée) faite.' : 'Vérification faciale passée.'}</Body>
      <Card>
        <Eyebrow color={t.accent}>Identification vidéo simulée</Eyebrow>
        <Body>
          Dans le vrai produit, un conseiller Swissquote vérifie votre identité par appel vidéo. Ici, choisissez l'issue
          de l'appel.
        </Body>
      </Card>
      <Field label="Nom complet" value={fullName} onChangeText={setFullName} autoCapitalize="words" textContentType="name" />
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
