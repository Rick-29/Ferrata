// Tokens from the Figma Make design (same as the extension's ui/core/theme.ts). Dark-first:
// the design has no light variant yet.

export interface Theme {
  readonly bg: string;
  readonly surface: string;
  readonly surfaceHigh: string;
  /** Translucent card over the blurred backdrop (glass). */
  readonly glass: string;
  readonly glassEdge: string;
  readonly text: string;
  readonly muted: string;
  readonly faint: string;
  readonly border: string;
  readonly borderStrong: string;
  readonly accent: string;
  readonly accentText: string;
  readonly lilac: string;
  readonly low: string;
  readonly medium: string;
  readonly high: string;
  readonly critical: string;
}

const DARK: Theme = {
  bg: '#0a0c16',
  surface: '#141726',
  surfaceHigh: '#1a1e30',
  glass: 'rgba(20,23,38,0.62)',
  glassEdge: 'rgba(255,255,255,0.14)',
  text: '#f7f8fc',
  muted: '#9198ad',
  faint: '#676e83',
  border: 'rgba(255,255,255,0.07)',
  borderStrong: 'rgba(255,255,255,0.12)',
  accent: '#ff4b1f',
  accentText: '#ffffff',
  lilac: '#bdb3ff',
  low: '#2ed598',
  medium: '#ffb547',
  high: '#ff7a3d',
  critical: '#ff4d6a',
};

/** Primary button and progress gradients (design: --brand-gradient / --gradient). */
export const BRAND_GRADIENT = ['#ff743d', '#ff4b1f', '#e93b1b'] as const;
export const SIGNATURE_GRADIENT = ['#ff8a43', '#ff4b1f', '#bd315f'] as const;
export const DANGER_GRADIENT = ['#ff7a3d', '#ff4d6a'] as const;

export const SPACE = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const RADIUS = { sm: 12, md: 16, lg: 24 } as const;

export function useTheme(): Theme {
  return DARK;
}
