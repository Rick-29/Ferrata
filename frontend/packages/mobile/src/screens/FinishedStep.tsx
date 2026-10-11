import type { RecoveryState } from '@sqw/types/RecoveryState';
import { Body, Button, Card, Eyebrow, Title } from '../ui/components';
import { useTheme } from '../ui/theme';

type Props = {
  readonly recovery: RecoveryState;
  readonly onDone: () => void;
};

/** After this phone approved: the smart delay and its reasons; the computer finalises. */
export function FinishedStep({ recovery, onDone }: Props) {
  const t = useTheme();
  const status = recovery.status;
  if (status.state !== 'pending') {
    return (
      <>
        <Card>
          <Eyebrow color={t.critical}>Identification refusée</Eyebrow>
          <Title>L’identité n’a pas pu être confirmée</Title>
          <Body muted>La récupération n’a pas été lancée et le wallet n’a pas changé.</Body>
        </Card>
        <Button label="Retour" variant="secondary" onPress={onDone} />
      </>
    );
  }
  const minutes = Math.max(1, Math.round((recovery.risk?.delay_secs ?? 0) / 60));
  return (
    <>
      <Card>
        <Eyebrow color={t.low}>Récupération approuvée</Eyebrow>
        <Title>Délai de sécurité : environ {minutes} min</Title>
        <Body>Terminez sur l’ordinateur une fois le délai écoulé. Ce téléphone a fini son rôle.</Body>
        {(recovery.risk?.reasons ?? []).map((reason) => (
          <Body key={reason} muted>
            · {reason}
          </Body>
        ))}
        <Body muted>
          {recovery.contested
            ? 'Récupération contestée : l’ancienne passkey ne peut plus l’annuler.'
            : 'Pendant ce délai, l’ancienne passkey peut encore annuler.'}
        </Body>
        <Body muted>Après la récupération, associez à nouveau un téléphone de secours depuis l’extension.</Body>
      </Card>
      <Button label="Terminé" onPress={onDone} />
    </>
  );
}
