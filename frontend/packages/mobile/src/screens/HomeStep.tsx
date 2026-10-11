import { Body, Button, Card, Eyebrow } from '../ui/components';
import { useTheme } from '../ui/theme';

type Props = {
  readonly displayName: string;
  readonly hasKey: boolean;
  readonly onScan: () => void;
};

/** What this phone is for: be the wallet's recovery phone, and approve a recovery when one is needed. */
export function HomeStep({ displayName, hasKey, onScan }: Props) {
  const t = useTheme();
  return (
    <>
      <Body muted>Bonjour {displayName}.</Body>
      <Card>
        <Eyebrow color={t.accent}>Téléphone de secours</Eyebrow>
        <Body>
          {hasKey
            ? 'Ce téléphone détient une clé de secours. Si vous perdez votre passkey, il approuvera la récupération de votre wallet.'
            : 'Ce téléphone n’est pas encore associé. Dans l’extension : Réglages → Téléphone de secours, puis scannez le code.'}
        </Body>
      </Card>
      <Card>
        <Eyebrow color={t.accent}>Scanner un code Ferrata</Eyebrow>
        <Body muted>
          Le code de l’extension sert à associer ce téléphone ; celui d’un nouvel ordinateur, à approuver la récupération
          de votre wallet. Ce téléphone ne peut jamais déplacer vos fonds.
        </Body>
      </Card>
      <Button label="Scanner un code" onPress={onScan} />
    </>
  );
}
