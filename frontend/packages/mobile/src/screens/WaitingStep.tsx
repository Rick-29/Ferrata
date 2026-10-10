import type { RecoveryState } from '@sqw/types/RecoveryState';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Defs, LinearGradient, Stop } from 'react-native-svg';
import { Body, Button, Card } from '../ui/components';
import { SIGNATURE_GRADIENT, useTheme } from '../ui/theme';

type Props = {
  readonly recovery: RecoveryState;
  readonly isBusy: boolean;
  readonly onExecute: () => void;
};

const TICK_MS = 1000;
const RING_SIZE = 215;
const RING_RADIUS = 92;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

const nowSecs = (): number => Math.floor(Date.now() / 1000);

function formatRemaining(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Timelock: any device that still holds the old passkey can cancel during this window. */
export function WaitingStep({ recovery, isBusy, onExecute }: Props) {
  const t = useTheme();
  const [now, setNow] = useState(nowSecs);
  useEffect(() => {
    const id = setInterval(() => setNow(nowSecs()), TICK_MS);
    return () => clearInterval(id);
  }, []);

  const unlockAt = recovery.status.state === 'pending' ? recovery.status.unlock_at : now;
  const total = Math.max(1, unlockAt - recovery.started_at);
  const remaining = Math.max(0, unlockAt - now);
  const isUnlocked = remaining === 0;
  const arc = RING_CIRCUMFERENCE * (remaining / total);

  return (
    <>
      <View style={styles.ring}>
        <Svg width={RING_SIZE} height={RING_SIZE} style={styles.svg}>
          <Defs>
            <LinearGradient id="ring" x1="0" y1="0" x2="1" y2="1">
              <Stop offset="0" stopColor={SIGNATURE_GRADIENT[0]} />
              <Stop offset="0.5" stopColor={SIGNATURE_GRADIENT[1]} />
              <Stop offset="1" stopColor={SIGNATURE_GRADIENT[2]} />
            </LinearGradient>
          </Defs>
          <Circle cx={RING_SIZE / 2} cy={RING_SIZE / 2} r={RING_RADIUS} stroke="rgba(255,255,255,0.06)" strokeWidth={8} fill="none" />
          <Circle
            cx={RING_SIZE / 2}
            cy={RING_SIZE / 2}
            r={RING_RADIUS}
            stroke="url(#ring)"
            strokeWidth={8}
            strokeLinecap="round"
            fill="none"
            strokeDasharray={`${arc} ${RING_CIRCUMFERENCE}`}
          />
        </Svg>
        <Text style={[styles.caption, { color: t.muted }]}>{isUnlocked ? 'Délai écoulé' : 'Délai restant'}</Text>
        <Text accessibilityLiveRegion="polite" style={[styles.countdown, { color: isUnlocked ? t.low : t.text }]}>
          {formatRemaining(remaining)}
        </Text>
        <Text style={[styles.caption, { color: t.faint }]}>minutes</Text>
      </View>
      <Body muted>
        Pendant ce délai, vos autres appareils reçoivent une alerte et peuvent annuler s'il ne s'agit pas de vous.
        Swissquote ne peut jamais déplacer vos fonds.
      </Body>
      <Card>
        <Text style={[styles.alertTitle, { color: t.text }]}>Alerte envoyée</Text>
        <Text style={[styles.alertBody, { color: t.muted }]}>Vos autres appareils ont été informés de cette demande.</Text>
      </Card>
      <Button
        label={isUnlocked ? 'Finaliser la récupération' : 'En attente du délai…'}
        isBusy={isBusy}
        isDisabled={!isUnlocked}
        onPress={onExecute}
      />
    </>
  );
}

const styles = StyleSheet.create({
  ring: { width: RING_SIZE, height: RING_SIZE, alignSelf: 'center', alignItems: 'center', justifyContent: 'center' },
  svg: { position: 'absolute', transform: [{ rotate: '-90deg' }] },
  caption: { fontSize: 10, letterSpacing: 1.2, textTransform: 'uppercase' },
  countdown: { fontSize: 46, fontWeight: '600', letterSpacing: -2, fontVariant: ['tabular-nums'], marginVertical: 4 },
  alertTitle: { fontSize: 13, fontWeight: '600' },
  alertBody: { fontSize: 12, lineHeight: 18 },
});
