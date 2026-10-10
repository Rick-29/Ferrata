import { css } from 'lit';

// Shared building blocks so widgets don't each re-declare the same surfaces and text styles.
// Values follow the Figma Make design (index.css).

export const textStyles = css`
  .eyebrow {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    color: var(--sq-text-muted);
  }
  .muted {
    color: var(--sq-text-muted);
  }
  .mono {
    font-family: var(--sq-font-mono);
    font-size: 11px;
    word-break: break-all;
  }
  h1,
  h2,
  p {
    margin: 0;
  }
  h1 {
    font: 600 25px/1.12 var(--sq-font-display);
    letter-spacing: -0.04em;
  }
  h2 {
    font: 600 14px/1.3 var(--sq-font-display);
    letter-spacing: -0.02em;
  }
`;

export const surfaceStyles = css`
  .card {
    padding: 14px;
    border-radius: 20px;
    background: var(--sq-surface);
    border: 1px solid var(--sq-border);
    box-shadow: var(--sq-shadow);
  }
  .inset {
    padding: var(--sq-space-3);
    border-radius: var(--sq-radius-sm);
    background: rgba(255, 255, 255, 0.035);
  }
`;

export const fieldStyles = css`
  .field {
    display: grid;
    gap: 7px;
  }
  label {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    color: var(--sq-text-muted);
  }
  input {
    font: inherit;
    font-size: 13px;
    height: 45px;
    padding: 0 14px;
    border-radius: 14px;
    border: 1px solid var(--sq-border-strong);
    background: rgba(20, 23, 38, 0.86);
    color: var(--sq-text);
    transition:
      border-color var(--sq-duration) var(--sq-ease),
      box-shadow var(--sq-duration) var(--sq-ease);
    min-width: 0;
    box-sizing: border-box;
  }
  input::placeholder {
    color: #565d71;
  }
  input:focus-visible {
    outline: none;
    border-color: rgba(255, 61, 127, 0.65);
    box-shadow: 0 0 0 2px rgba(255, 61, 127, 0.1);
  }
  input[aria-invalid='true'] {
    border-color: var(--sq-risk-critical);
  }
  input:disabled {
    opacity: 0.6;
  }
  .hint {
    font-size: 10px;
    color: var(--sq-text-muted);
  }
  .field-error {
    font-size: 10px;
    color: var(--sq-risk-critical);
  }
`;

/** Screen layout: vertical stack, header with a round back button and a centred title. */
export const screenStyles = css`
  :host {
    display: grid;
    gap: var(--sq-space-4);
    animation: enter 420ms var(--sq-ease);
  }
  .topbar {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    gap: var(--sq-space-2);
    min-height: 30px;
  }
  .topbar > :first-child {
    justify-self: start;
  }
  .topbar > :last-child {
    justify-self: end;
  }
  .topbar .title {
    font: 600 15px var(--sq-font-display);
    letter-spacing: -0.02em;
  }
  .icon-button {
    width: 30px;
    height: 30px;
    display: grid;
    place-items: center;
    padding: 0;
    border: 0;
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.04);
    color: var(--sq-text-muted);
    cursor: pointer;
    transition: color var(--sq-duration) var(--sq-ease);
  }
  .icon-button:hover {
    color: var(--sq-text);
  }
  .icon-button:focus-visible {
    outline: 2px solid var(--sq-focus);
    outline-offset: 2px;
  }
  .icon-button:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .actions {
    display: grid;
    gap: var(--sq-space-2);
  }
  @keyframes enter {
    from {
      opacity: 0.2;
      transform: translateX(24px) scale(0.985);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    :host {
      animation: none;
    }
  }
`;
