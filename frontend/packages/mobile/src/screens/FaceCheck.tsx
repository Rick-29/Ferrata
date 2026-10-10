import { CameraView, useCameraPermissions } from 'expo-camera';
import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import { Body, Button, Card, Eyebrow } from '../ui/components';
import { useTheme } from '../ui/theme';

type Props = {
  readonly onDone: (result: FaceCheckResult) => void;
};

/** `checked`: the user went through the face check. `skipped`: they chose not to. */
export type FaceCheckResult = 'checked' | 'skipped';

type Phase = 'intro' | 'scanning' | 'done';

/** Guided liveness prompts, as a real check would ask; each is shown for STEP_MS. */
const LIVENESS_STEPS = [
  'Regardez droit vers la caméra',
  'Tournez légèrement la tête à gauche',
  'Puis à droite',
  'Clignez des yeux',
] as const;
const STEP_MS = 1_600;
const FRAME_HEIGHT = 320;
const SCAN_SWEEP_MS = 1_400;

/**
 * Face check (option B). REAL: the front camera, live. SIMULATED: the analysis — Expo Go ships no
 * face model, so the guided liveness prompts and the scan only show the experience. No photo is
 * taken, stored or sent, and nothing is compared. Always an extra factor next to the phone's
 * biometric-protected key and the identity check, never the only one (CLAUDE.md rule 5).
 * A real matcher (e.g. InsightFace, non-commercial licence) would sit behind a port later.
 */
export function FaceCheck({ onDone }: Props) {
  const t = useTheme();
  const [permission, requestPermission] = useCameraPermissions();
  const [phase, setPhase] = useState<Phase>('intro');
  const [stepIndex, setStepIndex] = useState(0);
  const sweep = useRef(new Animated.Value(0)).current;

  // Advance through the liveness prompts while scanning.
  useEffect(() => {
    if (phase !== 'scanning') return undefined;
    if (stepIndex >= LIVENESS_STEPS.length) {
      setPhase('done');
      return undefined;
    }
    const id = setTimeout(() => setStepIndex((i) => i + 1), STEP_MS);
    return () => clearTimeout(id);
  }, [phase, stepIndex]);

  // Scan line sweeping over the face frame.
  useEffect(() => {
    if (phase !== 'scanning') return undefined;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(sweep, { toValue: 1, duration: SCAN_SWEEP_MS, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(sweep, { toValue: 0, duration: SCAN_SWEEP_MS, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [phase, sweep]);

  const start = async (): Promise<void> => {
    const granted = permission?.granted ?? (await requestPermission()).granted;
    if (!granted) return;
    setStepIndex(0);
    setPhase('scanning');
  };

  const isDenied = permission !== null && !permission.granted && !permission.canAskAgain;
  const progress = Math.min(stepIndex, LIVENESS_STEPS.length) / LIVENESS_STEPS.length;
  const prompt = LIVENESS_STEPS[Math.min(stepIndex, LIVENESS_STEPS.length - 1)] ?? '';
  const sweepY = sweep.interpolate({ inputRange: [0, 1], outputRange: [20, FRAME_HEIGHT - 20] });

  return (
    <Card>
      <Eyebrow color={t.medium}>Vérification faciale · analyse simulée</Eyebrow>
      {phase === 'intro' && (
        <>
          <Body muted>
            Un contrôle de présence avec la caméra, en plus de la clé de ce téléphone et de l'identification. La caméra
            est réelle ; l'analyse est simulée dans cette démo. Aucune image n'est enregistrée ni envoyée.
          </Body>
          {isDenied ? (
            <Body muted>L'accès à la caméra est refusé dans les réglages. Vous pouvez continuer sans cette étape.</Body>
          ) : (
            <Button label="Démarrer la vérification faciale" onPress={() => void start()} />
          )}
          <Button label="Continuer sans" variant="secondary" onPress={() => onDone('skipped')} />
        </>
      )}
      {phase === 'scanning' && (
        <>
          <View style={styles.frame}>
            <CameraView style={StyleSheet.absoluteFill} facing="front" />
            <View pointerEvents="none" style={[styles.oval, { borderColor: t.accent }]} />
            <Animated.View pointerEvents="none" style={[styles.sweep, { backgroundColor: t.accent, transform: [{ translateY: sweepY }] }]} />
          </View>
          <Text accessibilityLiveRegion="polite" style={[styles.prompt, { color: t.text }]}>
            {prompt}
          </Text>
          <View style={[styles.track, { backgroundColor: t.border }]}>
            <View style={[styles.fill, { width: `${Math.round(progress * 100)}%`, backgroundColor: t.accent }]} />
          </View>
          <Text style={[styles.caption, { color: t.muted }]}>
            Étape {Math.min(stepIndex + 1, LIVENESS_STEPS.length)} sur {LIVENESS_STEPS.length} · analyse simulée
          </Text>
        </>
      )}
      {phase === 'done' && (
        <>
          <Text style={[styles.done, { color: t.low }]}>✓ Contrôle de présence terminé</Text>
          <Body muted>
            Démo : aucune comparaison réelle avec votre pièce d'identité n'a été faite. La caméra est fermée et aucune
            image n'a été conservée.
          </Body>
          <Button label="Continuer" onPress={() => onDone('checked')} />
        </>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  frame: {
    height: FRAME_HEIGHT,
    borderRadius: 20,
    overflow: 'hidden',
    backgroundColor: '#000',
    alignItems: 'center',
    justifyContent: 'center',
  },
  oval: { width: 180, height: 240, borderRadius: 120, borderWidth: 3 },
  sweep: { position: 'absolute', top: 0, left: 24, right: 24, height: 2, opacity: 0.85 },
  prompt: { fontSize: 17, fontWeight: '600', textAlign: 'center' },
  track: { height: 4, borderRadius: 2, overflow: 'hidden' },
  fill: { height: 4, borderRadius: 2 },
  caption: { fontSize: 12, textAlign: 'center' },
  done: { fontSize: 17, fontWeight: '700' },
});
