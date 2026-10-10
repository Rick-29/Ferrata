import { html, nothing, type TemplateResult } from 'lit';
import { icon } from './icons';

export interface HeaderOptions {
  readonly title: string;
  readonly onBack?: () => void;
  readonly backDisabled?: boolean;
  readonly action?: TemplateResult;
}

/** Screen header (design: .screen-header): round back button, centred title, optional action. Uses screenStyles. */
export function screenHeader({ title, onBack, backDisabled = false, action }: HeaderOptions): TemplateResult {
  return html`
    <header class="topbar">
      ${onBack
        ? html`<button type="button" class="icon-button" aria-label="Retour" ?disabled=${backDisabled} @click=${onBack}>
            ${icon('back')}
          </button>`
        : html`<span></span>`}
      <h1 class="title">${title}</h1>
      ${action ?? html`<span>${nothing}</span>`}
    </header>
  `;
}
