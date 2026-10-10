import { css } from 'lit';

// Design tokens as CSS custom properties. Set once on the app shell; they inherit through
// every widget's shadow root, so widgets only ever read var(--sq-*).
export const themeStyles = css`
  :host {
    --sq-font: 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif;
    --sq-font-mono: 'JetBrains Mono', ui-monospace, 'Cascadia Code', monospace;

    --sq-bg: #f6f5f2;
    --sq-surface: #ffffff;
    --sq-surface-sunken: #eeece7;
    --sq-text: #15171c;
    --sq-text-muted: #5f6470;
    --sq-border: #dedbd3;
    --sq-accent: #e8590c;
    --sq-accent-text: #ffffff;
    --sq-focus: #1f6feb;

    --sq-risk-low: #1a7f4b;
    --sq-risk-medium: #b7791f;
    --sq-risk-high: #d1480f;
    --sq-risk-critical: #c0182e;

    --sq-radius-sm: 6px;
    --sq-radius-md: 12px;
    --sq-radius-lg: 18px;
    --sq-space-1: 4px;
    --sq-space-2: 8px;
    --sq-space-3: 12px;
    --sq-space-4: 16px;
    --sq-space-6: 24px;
    --sq-shadow: 0 1px 2px rgb(21 23 28 / 6%), 0 8px 24px rgb(21 23 28 / 8%);

    --sq-duration: 160ms;
    --sq-ease: cubic-bezier(0.16, 1, 0.3, 1);

    color-scheme: light dark;
    font-family: var(--sq-font);
    color: var(--sq-text);
    background: var(--sq-bg);
  }

  @media (prefers-color-scheme: dark) {
    :host {
      --sq-bg: #0f1114;
      --sq-surface: #181b20;
      --sq-surface-sunken: #121418;
      --sq-text: #eceae5;
      --sq-text-muted: #9a9fa9;
      --sq-border: #2a2e35;
      --sq-accent: #f2702a;
      --sq-focus: #58a6ff;
      --sq-risk-low: #3fb37a;
      --sq-risk-medium: #e0a33a;
      --sq-risk-high: #f0753a;
      --sq-risk-critical: #f2555f;
      --sq-shadow: 0 1px 2px rgb(0 0 0 / 40%), 0 8px 24px rgb(0 0 0 / 35%);
    }
  }
`;
