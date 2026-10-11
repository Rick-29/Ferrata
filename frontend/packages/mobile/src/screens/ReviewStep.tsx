import type { RecoveryState } from '@sqw/types/RecoveryState';
import { StyleSheet, Text } from 'react-native';
import { shortAddress } from '../recovery/links';
import { Body, Button, Card, Eyebrow } from '../ui/components';
import { useTheme } from '../ui/theme';

type Props = {
  readonly recovery: RecoveryState;
  readonly newKeyFingerprint: string;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
};

/** Before approving: which wallet, and which new passkey (compared with the computer's screen). */
export function ReviewStep({ recovery, newKeyFingerprint, onConfirm, onCancel }: Props) {
  const t = useTheme();
  return (
    <>
      <Card>
        <Eyebrow color={t.accent}>Récupération demandée</Eyebrow>
        <Body>Wallet {shortAddress(recovery.address)}. Une nouvelle passkey en deviendra la clé :</Body>
        <Text style={[styles.fingerprint, { color: t.text }]}>{newKeyFingerprint}</Text>
        <Body>
          Vérifiez que l’ordinateur affiche exactement cette empreinte. Si ce n’est pas vous qui avez lancé cette
          récupération, refusez.
        </Body>
      </Card>
      <Card>
        <Body muted>
          Ensuite : vérification de votre identité, puis votre biométrie pour signer. Un délai de sécurité suivra ; votre
          ancienne passkey pourra encore annuler.
        </Body>
      </Card>
      <Button label="C’est bien moi, continuer" onPress={onConfirm} />
      <Button label="Refuser" variant="secondary" onPress={onCancel} />
    </>
  );
}

const styles = StyleSheet.create({
  fingerprint: { fontSize: 30, fontWeight: '700', letterSpacing: 3, textAlign: 'center', fontVariant: ['tabular-nums'] },
});
