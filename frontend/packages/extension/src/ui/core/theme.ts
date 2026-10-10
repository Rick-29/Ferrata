import { css } from 'lit';

// Design tokens from the Figma Make design (design system frame "Système visuel"). Set once on
// the app shell; they inherit through every widget's shadow root, so widgets only read var(--sq-*).
// The design is dark-first and has no light variant yet.
export const themeStyles = css`
  :host {
    --sq-font: 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif;
    --sq-font-display: 'Space Grotesk', 'Inter', system-ui, sans-serif;
    --sq-font-mono: ui-monospace, 'Cascadia Code', Menlo, monospace;

    --sq-bg: #0a0c16;
    --sq-surface: #141726;
    --sq-surface-high: #1a1e30;
    --sq-surface-sunken: #10131f;
    --sq-text: #f7f8fc;
    --sq-text-muted: #9198ad;
    --sq-text-faint: #676e83;
    --sq-border: rgba(255, 255, 255, 0.07);
    --sq-border-strong: rgba(255, 255, 255, 0.12);

    --sq-orange: #ff6a1a;
    --sq-accent: #ff4b1f;
    --sq-pink: #ff3d3d;
    --sq-violet: #bd315f;
    --sq-lilac: #7b5cff;
    --sq-accent-text: #ffffff;
    --sq-focus: #ff3d7f;
    --sq-gradient: linear-gradient(118deg, var(--sq-orange), var(--sq-accent) 48%, var(--sq-violet));
    --sq-brand-gradient: linear-gradient(122deg, #ff743d, #ff4b1f 56%, #e93b1b);
    --sq-soft-gradient: linear-gradient(110deg, rgba(255, 61, 127, 0.06), rgba(123, 92, 255, 0.07));

    --sq-risk-low: #2ed598;
    --sq-risk-medium: #ffb547;
    --sq-risk-high: #ff7a3d;
    --sq-risk-critical: #ff4d6a;

    --sq-radius-sm: 12px;
    --sq-radius-md: 16px;
    --sq-radius-lg: 24px;
    --sq-space-1: 4px;
    --sq-space-2: 8px;
    --sq-space-3: 12px;
    --sq-space-4: 16px;
    --sq-space-6: 24px;
    --sq-shadow: 0 22px 55px rgba(0, 0, 0, 0.38);

    --sq-duration: 200ms;
    --sq-ease: cubic-bezier(0.2, 0.8, 0.2, 1);

    color-scheme: dark;
    font-family: var(--sq-font);
    color: var(--sq-text);
    background: var(--sq-bg);
  }
`;
