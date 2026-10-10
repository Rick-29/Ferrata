import { svg, type SVGTemplateResult, type TemplateResult } from 'lit';
import { html } from 'lit';

// Stroke icons from the Figma Make design (24×24, 1.8 stroke, currentColor).

export type IconName =
  | 'activity'
  | 'arrowDown'
  | 'arrowUp'
  | 'back'
  | 'check'
  | 'chevron'
  | 'copy'
  | 'fingerprint'
  | 'gear'
  | 'key'
  | 'receive'
  | 'send'
  | 'shield'
  | 'spark'
  | 'wallet'
  | 'alert';

const PATHS: Readonly<Record<IconName, SVGTemplateResult>> = {
  activity: svg`<path d="M4 12h3l2.2-6 4.2 12L16 12h4" />`,
  arrowDown: svg`<path d="M12 4v16m-6-6 6 6 6-6" />`,
  arrowUp: svg`<path d="M12 20V4m-6 6 6-6 6 6" />`,
  back: svg`<path d="m15 18-6-6 6-6" />`,
  check: svg`<path d="m5 12 4 4L19 6" />`,
  chevron: svg`<path d="m9 18 6-6-6-6" />`,
  copy: svg`<rect x="8" y="8" width="11" height="11" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />`,
  fingerprint: svg`<path d="M5 12a7 7 0 0 1 14 0c0 4-1 7-3 9M8 12a4 4 0 0 1 8 0c0 3-.5 5-2 7M11 12a1 1 0 0 1 2 0c0 4-.5 7-2 9M4 16c.5 2 1 3 2 4" />`,
  gear: svg`<circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" />`,
  key: svg`<circle cx="8" cy="15" r="4" /><path d="m11 12 9-9m-3 3 3 3m-6 0 3 3" />`,
  receive: svg`<path d="M12 3v12m-5-5 5 5 5-5M5 21h14" />`,
  send: svg`<path d="m21 3-7.5 18-3.6-6.9L3 10.5 21 3Z" /><path d="m9.9 14.1 4-4" />`,
  shield: svg`<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" /><path d="m9 12 2 2 4-4" />`,
  spark: svg`<path d="m12 3 1.4 4.1L17.5 8l-4.1 1.4L12 13.5l-1.4-4.1L6.5 8l4.1-.9L12 3ZM18 14l.8 2.2L21 17l-2.2.8L18 20l-.8-2.2L15 17l2.2-.8L18 14Z" />`,
  wallet: svg`<path d="M4 6h14a2 2 0 0 1 2 2v11H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12" /><path d="M15 11h6v5h-6a2.5 2.5 0 0 1 0-5Z" />`,
  alert: svg`<path d="M12 3 2 20h20L12 3Z" /><path d="M12 10v4m0 3v.01" />`,
};

export function icon(name: IconName, size = 20): TemplateResult {
  return html`<svg
    aria-hidden="true"
    width=${size}
    height=${size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    style="flex:none"
  >
    ${PATHS[name]}
  </svg>`;
}
