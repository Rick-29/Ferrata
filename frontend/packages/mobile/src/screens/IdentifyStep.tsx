import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import type { KycScript } from '../recovery/RecoveryService';
import { Body, Button, Card, Eyebrow, Field } from '../ui/components';
import { SPACE, useTheme } from '../ui/theme';

type Props = {
  readonly isBusy: boolean;
  readonly onSubmit: (script: KycScript, fullName: string) => void;
};

/** Mock KYC, clearly labelled: the spec requires "Simulated video identification". */
export function IdentifyStep({ isBusy, onSubmit }: Props) {
  const t = useTheme();
  const [fullName, setFullName] = useState('');
  const canSubmit = fullName.trim() !== '' && !isBusy;
  return (
    <>
      <Card>
        <Eyebrow color={t.accent}>Identification vidéo simulée</Eyebrow>
        <Body>
          Dans le vrai produit, un conseiller Swissquote vérifie votre identité par appel vidéo. Ici, choisissez l'issue
          de l'appel.
        </Body>
      </Card>
      <Field label="Nom complet" value={fullName} onChangeText={setFullName} autoCapitalize="words" textContentType="name" />
      <View style={styles.choices}>
        <Button label="Je suis le titulaire (documents conformes)" isBusy={isBusy} isDisabled={!canSubmit} onPress={() => onSubmit('kyc-pass', fullName)} />
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
