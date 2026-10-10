import { APP_FULL_NAME, APP_NAME } from '@sqw/brand';
import { LinearGradient } from 'expo-linear-gradient';
import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import { BRAND_GRADIENT, DANGER_GRADIENT, RADIUS, SPACE, useTheme } from './theme';

export function Eyebrow({ children, color }: { readonly children: ReactNode; readonly color?: string }) {
  const t = useTheme();
  return <Text style={[styles.eyebrow, { color: color ?? t.muted }]}>{children}</Text>;
}

export function Title({ children }: { readonly children: ReactNode }) {
  const t = useTheme();
  return (
    <Text accessibilityRole="header" style={[styles.title, { color: t.text }]}>
      {children}
    </Text>
  );
}

export function Body({ children, muted = false }: { readonly children: ReactNode; readonly muted?: boolean }) {
  const t = useTheme();
  return <Text style={[styles.body, { color: muted ? t.muted : t.text }]}>{children}</Text>;
}

export function Card({ children }: { readonly children: ReactNode }) {
  const t = useTheme();
  return <View style={[styles.card, { backgroundColor: t.glass, borderColor: t.glassEdge }]}>{children}</View>;
}

/** Swissquote mark + product wordmark (APP_NAME) on a white plate (design: .brand-compact-official). */
export function Brand() {
  return (
    <View style={styles.brand} accessibilityRole="image" accessibilityLabel={APP_FULL_NAME}>
      <Svg width={16} height={16} viewBox="0 0 32 32">
        <Circle cx={16} cy={16} r={16} fill="#ff4b1f" />
        <Rect x={8} y={9} width={16} height={3} rx={0.6} fill="#fff" />
        <Path d="M8 14h16v9h-4v-5h-2.5v5h-3v-5H12v5H8z" fill="#fff" />
      </Svg>
      <Text style={styles.brandWord}>{APP_NAME}</Text>
    </View>
  );
}

type ButtonProps = {
  readonly label: string;
  readonly onPress: () => void;
  readonly isBusy?: boolean;
  readonly isDisabled?: boolean;
  readonly variant?: 'primary' | 'secondary' | 'danger';
};

export function Button({ label, onPress, isBusy = false, isDisabled = false, variant = 'primary' }: ButtonProps) {
  const t = useTheme();
  const inactive = isDisabled || isBusy;
  const content = isBusy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonLabel}>{label}</Text>;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: inactive, busy: isBusy }}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => [styles.buttonShell, inactive && styles.inactive, pressed && styles.pressed]}
    >
      {variant === 'secondary' ? (
        <View style={[styles.button, { backgroundColor: t.surfaceHigh, borderColor: t.borderStrong, borderWidth: 1 }]}>
          {content}
        </View>
      ) : (
        <LinearGradient
          colors={variant === 'danger' ? DANGER_GRADIENT : BRAND_GRADIENT}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={[styles.button, variant === 'primary' && styles.glow]}
        >
          {content}
        </LinearGradient>
      )}
    </Pressable>
  );
}

type FieldProps = Omit<TextInputProps, 'style'> & {
  readonly label: string;
  readonly hint?: string;
  readonly mono?: boolean;
};

export function Field({ label, hint, mono = false, ...input }: FieldProps) {
  const t = useTheme();
  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: t.muted }]}>{label}</Text>
      <TextInput
        placeholderTextColor="#565d71"
        autoCapitalize="none"
        autoCorrect={false}
        style={[styles.input, { color: t.text, borderColor: t.borderStrong }, mono && styles.mono]}
        {...input}
      />
      {hint ? <Text style={[styles.hint, { color: t.muted }]}>{hint}</Text> : null}
    </View>
  );
}

export function ErrorBanner({ message }: { readonly message: string | null }) {
  const t = useTheme();
  if (!message) return null;
  return (
    <View accessibilityRole="alert" style={[styles.banner, { borderColor: t.critical }]}>
      <Text style={[styles.body, { color: t.text }]}>{message}</Text>
    </View>
  );
}

/** Numbered dots on a line (design: .recovery-progress). */
export function Steps({ current, labels }: { readonly current: number; readonly labels: readonly string[] }) {
  const t = useTheme();
  return (
    <View style={styles.steps} accessibilityLabel={`Ã‰tape ${current + 1} sur ${labels.length}`}>
      <View style={[styles.stepLine, { backgroundColor: t.borderStrong }]} />
      {labels.map((label, i) => {
        const on = i <= current;
        const dot = <Text style={styles.stepDotText}>{i < current ? 'âœ“' : i + 1}</Text>;
        return (
          <View key={label} style={styles.step}>
            {on ? (
              <LinearGradient colors={BRAND_GRADIENT} style={styles.stepDot}>
                {dot}
              </LinearGradient>
            ) : (
              <View style={[styles.stepDot, { backgroundColor: t.bg, borderColor: t.borderStrong, borderWidth: 1 }]}>
                <Text style={[styles.stepDotText, { color: t.faint }]}>{i + 1}</Text>
              </View>
            )}
            <Text style={[styles.stepLabel, { color: on ? t.text : t.faint }]}>{label}</Text>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  eyebrow: { fontSize: 11, fontWeight: '600', letterSpacing: 1.1, textTransform: 'uppercase' },
  title: { fontSize: 36, fontWeight: '600', letterSpacing: -1.8, lineHeight: 38 },
  body: { fontSize: 14, lineHeight: 21 },
  card: {
    borderWidth: 1,
    borderRadius: 23,
    padding: 17,
    gap: SPACE.md,
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 30,
    shadowOffset: { width: 0, height: 24 },
  },
  brand: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    alignSelf: 'flex-start',
    paddingVertical: 5,
    paddingLeft: 6,
    paddingRight: 9,
    borderRadius: 8,
    backgroundColor: '#fff',
  },
  brandWord: { fontSize: 13, fontWeight: '600', letterSpacing: -0.5, color: '#2b2b2b' },
  buttonShell: { borderRadius: RADIUS.md },
  button: { minHeight: 52, borderRadius: RADIUS.md, alignItems: 'center', justifyContent: 'center', paddingHorizontal: SPACE.lg },
  glow: {
    shadowColor: '#ff4b1f',
    shadowOpacity: 0.3,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 12 },
    elevation: 6,
  },
  buttonLabel: { fontSize: 15, fontWeight: '700', color: '#fff' },
  inactive: { opacity: 0.36 },
  pressed: { transform: [{ scale: 0.98 }] },
  field: { gap: 7 },
  label: { fontSize: 11, fontWeight: '600', letterSpacing: 1, textTransform: 'uppercase' },
  input: {
    height: 53,
    fontSize: 15,
    borderWidth: 1,
    borderRadius: RADIUS.md,
    paddingHorizontal: 14,
    backgroundColor: 'rgba(20,23,38,0.86)',
  },
  mono: { fontFamily: 'monospace', fontSize: 13 },
  hint: { fontSize: 12 },
  banner: { borderWidth: 1, borderLeftWidth: 4, borderRadius: RADIUS.sm, padding: SPACE.md, backgroundColor: '#141726' },
  steps: { flexDirection: 'row', justifyContent: 'space-between', position: 'relative' },
  stepLine: { position: 'absolute', height: 1, top: 13, left: 40, right: 40 },
  step: { flex: 1, alignItems: 'center', gap: 7 },
  stepDot: { width: 27, height: 27, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  stepDotText: { fontSize: 11, fontWeight: '600', color: '#fff' },
  stepLabel: { fontSize: 10 },
});
