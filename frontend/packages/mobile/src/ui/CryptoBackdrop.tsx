import { BlurView } from 'expo-blur';
import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, StyleSheet, useWindowDimensions, View } from 'react-native';
import Svg, { Circle, Defs, G, LinearGradient, Path, RadialGradient, Stop, Text as SvgText } from 'react-native-svg';

// Decorative background: soft colour glows and crypto coins drifting behind a frosted blur.
// Purely visual (hidden from screen readers); motion stops when the OS asks to reduce motion.

type CoinKind = 'btc' | 'eth' | 'usdc' | 'sol' | 'usdt' | 'ferra';

interface Coin {
  readonly kind: CoinKind;
  /** Position as a fraction of the screen. */
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly periodMs: number;
  readonly delayMs: number;
}

const COINS: readonly Coin[] = [
  { kind: 'btc', x: 0.78, y: 0.06, size: 74, periodMs: 7_000, delayMs: 0 },
  { kind: 'eth', x: 0.04, y: 0.2, size: 58, periodMs: 8_200, delayMs: 900 },
  { kind: 'sol', x: 0.82, y: 0.38, size: 46, periodMs: 6_400, delayMs: 400 },
  { kind: 'usdc', x: 0.1, y: 0.55, size: 52, periodMs: 7_600, delayMs: 1_500 },
  { kind: 'ferra', x: 0.7, y: 0.66, size: 64, periodMs: 9_000, delayMs: 700 },
  { kind: 'usdt', x: 0.2, y: 0.84, size: 44, periodMs: 6_800, delayMs: 1_100 },
  { kind: 'eth', x: 0.86, y: 0.88, size: 38, periodMs: 7_200, delayMs: 2_000 },
  { kind: 'btc', x: 0.42, y: 0.3, size: 32, periodMs: 8_800, delayMs: 2_600 },
];

const FLOAT_PX = 18;
const TILT_DEG = 14;
const BLUR_INTENSITY = 28;

function useReducedMotion(): boolean {
  const [isReduced, setReduced] = useState(false);
  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setReduced);
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => sub.remove();
  }, []);
  return isReduced;
}

export function CryptoBackdrop() {
  const { width, height } = useWindowDimensions();
  const isReduced = useReducedMotion();
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Glows width={width} height={height} />
      {COINS.map((coin, i) => (
        <FloatingCoin key={`${coin.kind}-${i}`} coin={coin} left={coin.x * width} top={coin.y * height} isStill={isReduced} />
      ))}
      <BlurView style={StyleSheet.absoluteFill} intensity={BLUR_INTENSITY} tint="dark" blurMethod="dimezisBlurViewSdk31Plus" />
    </View>
  );
}

function Glows({ width, height }: { readonly width: number; readonly height: number }) {
  return (
    <Svg width={width} height={height} style={StyleSheet.absoluteFill}>
      <Defs>
        <RadialGradient id="glowOrange" cx="50%" cy="50%" r="50%">
          <Stop offset="0" stopColor="#ff4b1f" stopOpacity="0.45" />
          <Stop offset="1" stopColor="#ff4b1f" stopOpacity="0" />
        </RadialGradient>
        <RadialGradient id="glowViolet" cx="50%" cy="50%" r="50%">
          <Stop offset="0" stopColor="#7b5cff" stopOpacity="0.35" />
          <Stop offset="1" stopColor="#7b5cff" stopOpacity="0" />
        </RadialGradient>
      </Defs>
      <Circle cx={width * 0.95} cy={height * 0.02} r={width * 0.7} fill="url(#glowOrange)" />
      <Circle cx={0} cy={height * 0.62} r={width * 0.75} fill="url(#glowViolet)" />
      <Circle cx={width} cy={height} r={width * 0.55} fill="url(#glowOrange)" />
    </Svg>
  );
}

type FloatingProps = { readonly coin: Coin; readonly left: number; readonly top: number; readonly isStill: boolean };

function FloatingCoin({ coin, left, top, isStill }: FloatingProps) {
  const phase = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (isStill) return undefined;
    const half = coin.periodMs / 2;
    const ease = Easing.inOut(Easing.sin);
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(phase, { toValue: 1, duration: half, easing: ease, useNativeDriver: true }),
        Animated.timing(phase, { toValue: 0, duration: half, easing: ease, useNativeDriver: true }),
      ]),
    );
    const id = setTimeout(() => loop.start(), coin.delayMs);
    return () => {
      clearTimeout(id);
      loop.stop();
    };
  }, [coin, isStill, phase]);

  const translateY = phase.interpolate({ inputRange: [0, 1], outputRange: [-FLOAT_PX, FLOAT_PX] });
  const rotate = phase.interpolate({ inputRange: [0, 1], outputRange: [`-${TILT_DEG}deg`, `${TILT_DEG}deg`] });

  return (
    <Animated.View style={[styles.coin, { left, top, opacity: 0.85, transform: [{ translateY }, { rotate }] }]}>
      <CoinIcon kind={coin.kind} size={coin.size} />
    </Animated.View>
  );
}

const COIN_COLORS: Readonly<Record<CoinKind, readonly [string, string]>> = {
  btc: ['#ffb347', '#f7931a'],
  eth: ['#8a9cf0', '#4f63d2'],
  usdc: ['#4a90e2', '#2775ca'],
  sol: ['#2a2440', '#14121f'],
  usdt: ['#3cc8a0', '#26a17b'],
  ferra: ['#ff743d', '#e93b1b'],
};

/** Simplified coin marks drawn here (no third-party artwork bundled). */
function CoinIcon({ kind, size }: { readonly kind: CoinKind; readonly size: number }) {
  const [from, to] = COIN_COLORS[kind];
  const id = `coin-${kind}`;
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64">
      <Defs>
        <LinearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor={from} />
          <Stop offset="1" stopColor={to} />
        </LinearGradient>
        <LinearGradient id="solBars" x1="0" y1="0" x2="1" y2="0">
          <Stop offset="0" stopColor="#9945ff" />
          <Stop offset="1" stopColor="#14f195" />
        </LinearGradient>
      </Defs>
      <Circle cx={32} cy={32} r={31} fill={`url(#${id})`} />
      <Circle cx={32} cy={32} r={27} fill="none" stroke="#ffffff" strokeOpacity={0.25} strokeWidth={1.5} />
      <Glyph kind={kind} />
    </Svg>
  );
}

const TEXT_GLYPHS: Readonly<Record<CoinKind, string>> = { btc: '₿', usdc: '$', usdt: '₮', ferra: 'F', eth: '', sol: '' };

function Glyph({ kind }: { readonly kind: CoinKind }) {
  switch (kind) {
    case 'eth':
      return (
        <G fill="#ffffff">
          <Path d="M32 12 L44 32 L32 39 L20 32 Z" fillOpacity={0.95} />
          <Path d="M32 42 L44 35 L32 52 L20 35 Z" fillOpacity={0.75} />
        </G>
      );
    case 'sol':
      return (
        <G fill="url(#solBars)">
          <Path d="M22 22 H46 L42 27 H18 Z" />
          <Path d="M18 30 H42 L46 35 H22 Z" />
          <Path d="M22 38 H46 L42 43 H18 Z" />
        </G>
      );
    default:
      return (
        <SvgText x={32} y={43} fontSize={30} fontWeight="700" fill="#ffffff" textAnchor="middle">
          {TEXT_GLYPHS[kind]}
        </SvgText>
      );
  }
}

const styles = StyleSheet.create({ coin: { position: 'absolute' } });
