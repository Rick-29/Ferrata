import type { RecoveryState } from '@sqw/types/RecoveryState';
import { Body, Button, Card, Eyebrow, Title } from '../ui/components';
import { useTheme } from '../ui/theme';

type Props = {
  readonly recovery: RecoveryState;
  readonly onRestart: () => void;
};

interface Outcome {
  readonly tone: 'low' | 'high' | 'critical';
  readonly eyebrow: string;
  readonly title: string;
  readonly body: string;
}

function outcomeOf(recovery: RecoveryState): Outcome {
  switch (recovery.status.state) {
    case 'completed':
      return {
        tone: 'low',
        eyebrow: 'Récupération terminée',
        title: 'Votre wallet est de nouveau accessible',
        body: "La clé de ce téléphone, protégée par sa biométrie, est désormais la clé de votre wallet. L'ancienne ne fonctionne plus.",
      };
    case 'cancelled':
      return {
        tone: 'high',
        eyebrow: 'Récupération annulée',
        title: 'Un de vos appareils a annulé',
        body: "Le titulaire de l'ancienne passkey a refusé cette récupération. Rien n'a changé sur le wallet.",
      };
    case 'rejected':
      return {
        tone: 'critical',
        eyebrow: 'Identification refusée',
        title: "L'identité n'a pas pu être confirmée",
        body: "La récupération n'a pas été lancée et le wallet n'a pas changé.",
      };
    case 'pending':
      return { tone: 'high', eyebrow: 'En cours', title: 'Récupération en cours', body: '' };
  }
}

export function FinishedStep({ recovery, onRestart }: Props) {
  const t = useTheme();
  const outcome = outcomeOf(recovery);
  const color = outcome.tone === 'low' ? t.low : outcome.tone === 'high' ? t.high : t.critical;
  return (
    <>
      <Card>
        <Eyebrow color={color}>{outcome.eyebrow}</Eyebrow>
        <Title>{outcome.title}</Title>
        <Body muted>{outcome.body}</Body>
      </Card>
      <Button label="Recommencer" variant="secondary" onPress={onRestart} />
    </>
  );
}
