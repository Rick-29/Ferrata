import { css } from 'lit';

// Shared building blocks so widgets don't each re-declare the same surfaces and text styles.

export const textStyles = css`
  .eyebrow {
    font-size: 11px;
    font-weight: 650;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--sq-text-muted);
  }
  .muted {
    color: var(--sq-text-muted);
  }
  .mono {
    font-family: var(--sq-font-mono);
    font-size: 12px;
    word-break: break-all;
  }
  h1,
  h2,
  p {
    margin: 0;
  }
  h1 {
    font-size: 22px;
    font-weight: 700;
    letter-spacing: -0.02em;
    line-height: 1.15;
  }
  h2 {
    font-size: 15px;
    font-weight: 650;
  }
`;

export const surfaceStyles = css`
  .card {
    padding: var(--sq-space-4);
    border-radius: var(--sq-radius-lg);
    background: var(--sq-surface);
    box-shadow: var(--sq-shadow);
  }
  .inset {
    padding: var(--sq-space-3);
    border-radius: var(--sq-radius-md);
    background: var(--sq-surface-sunken);
  }
`;

export const fieldStyles = css`
  .field {
    display: grid;
    gap: 6px;
  }
  label {
    font-size: 13px;
    font-weight: 600;
  }
  input {
    font: inherit;
    font-size: 15px;
    padding: 11px 12px;
    border-radius: var(--sq-radius-md);
    border: 1px solid var(--sq-border);
    background: var(--sq-surface);
    color: var(--sq-text);
    transition: border-color var(--sq-duration) var(--sq-ease);
    min-width: 0;
  }
  input:hover {
    border-color: color-mix(in srgb, var(--sq-text) 30%, var(--sq-border));
  }
  input:focus-visible {
    outline: 2px solid var(--sq-focus);
    outline-offset: 1px;
    border-color: transparent;
  }
  input[aria-invalid='true'] {
    border-color: var(--sq-risk-critical);
  }
  .hint {
    font-size: 12px;
    color: var(--sq-text-muted);
  }
  .field-error {
    font-size: 12px;
    color: var(--sq-risk-critical);
  }
`;

/** Screen layout: vertical stack with a sticky-feeling footer for the main action. */
export const screenStyles = css`
  :host {
    display: grid;
    gap: var(--sq-space-4);
    animation: enter var(--sq-duration) var(--sq-ease);
  }
  .topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sq-space-2);
  }
  .actions {
    display: grid;
    gap: var(--sq-space-2);
  }
  @keyframes enter {
    from {
      opacity: 0;
      transform: translateY(4px);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    :host {
      animation: none;
    }
  }
`;
