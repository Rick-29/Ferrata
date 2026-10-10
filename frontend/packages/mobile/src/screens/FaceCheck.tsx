import { CameraView, useCameraPermissions } from 'expo-camera';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Body, Button, Card, Eyebrow } from '../ui/components';
import { useTheme } from '../ui/theme';

type Props = {
  readonly onDone: (result: FaceCheckResult) => void;
};

/** `checked`: the user went through the (simulated) face scan. `skipped`: they chose not to. */
export type FaceCheckResult = 'checked' | 'skipped';

type Phase = 'intro' | 'preview' | 'scanning' | 'done';

/** Simulated scan length, long enough to read as a check, short enough for a demo. */
const SCAN_MS = 2_500;

/**
 * Face check, SIMULATED (option B): a live front-camera preview with a face frame and a fake
 * scan. No photo is taken, stored or sent; nothing is compared. It is only ever an extra factor
 * next to the new passkey and the identity check, never the only one (CLAUDE.md rule 5).
 * A real matcher (e.g. InsightFace, non-commercial licence) would sit behind a port later.
 */
export function FaceCheck({ onDone }: Props) {
  const t = useTheme();
  const [permission, requestPermission] = useCameraPermissions();
  const [phase, setPhase] = useState<Phase>('intro');

  useEffect(() => {
    if (phase !== 'scanning') return undefined;
    const id = setTimeout(() => setPhase('done'), SCAN_MS);
    return () => clearTimeout(id);
  }, [phase]);

  const start = async (): Promise<void> => {
    const granted = permission?.granted ?? (await requestPermission()).granted;
    if (granted) setPhase('preview');
  };

  const isDenied = permission !== null && !permission.granted && !permission.canAskAgain;

  return (
    <Card>
      <View style={styles.tagRow}>
        <Eyebrow color={t.medium}>Vérification faciale simulée</Eyebrow>
      </View>
      {phase === 'intro' && (
        <>
          <Body muted>
            Un facteur supplémentaire, en plus de votre nouvelle passkey et de l'identification. Aucune image n'est
            enregistrée ni envoyée : rien ne quitte ce téléphone.
          </Body>
          {isDenied ? (
            <Body muted>L'accès à la caméra est refusé. Vous pouvez continuer sans cette étape.</Body>
          ) : (
            <Button label="Démarrer la vérification faciale" onPress={() => void start()} />
          )}
          <Button label="Continuer sans" variant="secondary" onPress={() => onDone('skipped')} />
        </>
      )}
      {(phase === 'preview' || phase === 'scanning') && (
        <>
          <View style={styles.cameraFrame}>
            <CameraView style={StyleSheet.absoluteFill} facing="front" />
            <View pointerEvents="none" style={[styles.faceOval, { borderColor: phase === 'scanning' ? t.accent : '#ffffff' }]} />
          </View>
          <Text style={[styles.caption, { color: t.muted }]}>
            {phase === 'scanning' ? 'Analyse simulée en cours…' : 'Placez votre visage dans le cadre.'}
          </Text>
          <Button label="Scanner" isBusy={phase === 'scanning'} onPress={() => setPhase('scanning')} />
        </>
      )}
      {phase === 'done' && (
        <>
          <Text style={[styles.done, { color: t.low }]}>✓ Visage détecté (simulé)</Text>
          <Body muted>Aucune comparaison réelle n'a été faite. La caméra est fermée.</Body>
          <Button label="Continuer" onPress={() => onDone('checked')} />
        </>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  tagRow: { flexDirection: 'row' },
  cameraFrame: { height: 300, borderRadius: 20, overflow: 'hidden', backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' },
  faceOval: { width: 170, height: 230, borderRadius: 120, borderWidth: 3 },
  caption: { fontSize: 13, textAlign: 'center' },
  done: { fontSize: 16, fontWeight: '700' },
});
