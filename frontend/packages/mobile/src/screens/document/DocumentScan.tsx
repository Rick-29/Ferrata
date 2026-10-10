import { useEffect, useState } from 'react';
import { ActivityIndicator, Image, StyleSheet, Text, View } from 'react-native';
import { ADULT_AGE, formatSwissDate, type DocumentChecks, type DocumentFacts } from '../../identity/checks';
import { Body, Button, Card, Eyebrow } from '../../ui/components';
import { SPACE, useTheme } from '../../ui/theme';

export type ChipRead = 'read' | 'skipped' | 'none';

type Props = {
  readonly facts: DocumentFacts;
  readonly checks: DocumentChecks;
  readonly images: readonly string[];
  readonly isFaceChecked: boolean;
  readonly chip: ChipRead;
  readonly onDone: () => void;
  readonly onRetry: () => void;
};

type Status = 'ok' | 'fail' | 'skipped';
interface Row {
  readonly label: string;
  readonly detail: string;
  readonly status: Status;
  /** REAL: computed from the document data. SIMULATED: shown for the experience only. */
  readonly isSimulated: boolean;
}

const ROW_MS = 650;

function buildRows({ facts, checks, isFaceChecked, chip }: Props): Row[] {
  const hasMrz = facts.type !== 'driver-license';
  return [
    { label: 'Détection du document', detail: 'bords, reflets, netteté', status: 'ok', isSimulated: true },
    hasMrz
      ? { label: 'Bande MRZ', detail: 'chiffres de contrôle ICAO valides', status: 'ok', isSimulated: false }
      : { label: 'Données du permis', detail: 'saisies par le titulaire', status: 'ok', isSimulated: false },
    {
      label: 'Type de document',
      detail: checks.matchesType ? 'conforme au choix' : 'ne correspond pas au type choisi',
      status: checks.matchesType ? 'ok' : 'fail',
      isSimulated: false,
    },
    {
      label: 'Photo du document ↔ votre visage',
      detail: isFaceChecked ? 'correspondance (démo)' : 'non faite : vérification faciale passée',
      status: isFaceChecked ? 'ok' : 'skipped',
      isSimulated: true,
    },
    ...(hasMrz
      ? [
          {
            label: 'Puce NFC',
            detail: chip === 'read' ? 'signature de l’émetteur (démo)' : 'non lue',
            status: chip === 'read' ? ('ok' as const) : ('skipped' as const),
            isSimulated: true,
          },
        ]
      : []),
    {
      label: `Âge (${ADULT_AGE} ans minimum)`,
      detail: checks.isBirthPlausible ? `${checks.age} ans, né·e le ${formatSwissDate(facts.birthDate)}` : 'date impossible',
      status: checks.isAdult ? 'ok' : 'fail',
      isSimulated: false,
    },
    {
      label: 'Validité',
      detail: facts.expiryDate === null ? 'sans date d’expiration' : `jusqu’au ${formatSwissDate(facts.expiryDate)}`,
      status: checks.isExpired ? 'fail' : 'ok',
      isSimulated: false,
    },
  ];
}

const ICON: Readonly<Record<Status, string>> = { ok: '✓', fail: '✕', skipped: '–' };

/** The "scanner": each check appears in turn, then the verdict (which only the REAL checks decide). */
export function DocumentScan(props: Props) {
  const t = useTheme();
  const rows = buildRows(props);
  const [shown, setShown] = useState(0);
  const isDone = shown >= rows.length;

  useEffect(() => {
    if (isDone) return undefined;
    const id = setTimeout(() => setShown((n) => n + 1), ROW_MS);
    return () => clearTimeout(id);
  }, [isDone, shown]);

  const color: Readonly<Record<Status, string>> = { ok: t.low, fail: t.critical, skipped: t.faint };

  return (
    <Card>
      <Eyebrow color={t.accent}>Analyse du document</Eyebrow>
      <View style={styles.thumbs}>
        {props.images.map((uri) => (
          <Image key={uri} source={{ uri }} style={[styles.thumb, { borderColor: t.borderStrong }]} />
        ))}
      </View>
      {rows.slice(0, shown).map((row) => (
        <View key={row.label} style={styles.row}>
          <Text style={[styles.icon, { color: color[row.status] }]}>{ICON[row.status]}</Text>
          <View style={styles.rowText}>
            <Text style={[styles.label, { color: t.text }]}>
              {row.label} <Text style={{ color: row.isSimulated ? t.medium : t.lilac }}>{row.isSimulated ? '· simulé' : '· réel'}</Text>
            </Text>
            <Text style={[styles.detail, { color: t.muted }]}>{row.detail}</Text>
          </View>
        </View>
      ))}
      {!isDone ? <ActivityIndicator color={t.accent} /> : null}
      {isDone && props.checks.isValid ? (
        <>
          <Text style={[styles.verdict, { color: t.low }]}>✓ Document accepté · {props.facts.holderName}</Text>
          <Body muted>Les photos du document vont être effacées de ce téléphone. Rien n’a été envoyé.</Body>
          <Button label="Continuer" onPress={props.onDone} />
        </>
      ) : null}
      {isDone && !props.checks.isValid ? (
        <>
          <Text style={[styles.verdict, { color: t.critical }]}>Document refusé</Text>
          <Body muted>Un contrôle réel n’est pas passé (voir ci-dessus). Essayez avec un autre document.</Body>
          <Button label="Recommencer" onPress={props.onRetry} />
        </>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  thumbs: { flexDirection: 'row', gap: SPACE.sm },
  thumb: { width: 96, height: 62, borderRadius: SPACE.sm, borderWidth: 1 },
  row: { flexDirection: 'row', gap: SPACE.md, alignItems: 'flex-start' },
  icon: { fontSize: 18, fontWeight: '700', width: 20, textAlign: 'center' },
  rowText: { flex: 1, gap: 2 },
  label: { fontSize: 15, fontWeight: '600' },
  detail: { fontSize: 13 },
  verdict: { fontSize: 17, fontWeight: '700', marginTop: SPACE.sm },
});
