import { StyleSheet, Text } from 'react-native';
import { shortAddress } from '../recovery/links';
import { Body, Button, Card, Eyebrow } from '../ui/components';
import { useTheme } from '../ui/theme';

type Props = {
  readonly fingerprint: string;
  readonly address: string;
  readonly onDone: () => void;
};

/** The phone sent its public key: the user compares the fingerprint, then confirms on the computer. */
export function PairedStep({ fingerprint, address, onDone }: Props) {
  const t = useTheme();
  return (
    <>
      <Card>
        <Eyebrow color={t.accent}>Empreinte de la clé de ce téléphone</Eyebrow>
        <Text style={[styles.fingerprint, { color: t.text }]}>{fingerprint}</Text>
        <Body>
          Vérifiez que l’extension affiche exactement la même empreinte, puis confirmez-y avec votre passkey. Ce téléphone
          deviendra le téléphone de secours du wallet {shortAddress(address)}.
        </Body>
        <Body muted>Si l’empreinte est différente, annulez dans l’extension.</Body>
      </Card>
      <Button label="Terminé" onPress={onDone} />
    </>
  );
}

const styles = StyleSheet.create({
  fingerprint: { fontSize: 30, fontWeight: '700', letterSpacing: 3, textAlign: 'center', fontVariant: ['tabular-nums'] },
});
