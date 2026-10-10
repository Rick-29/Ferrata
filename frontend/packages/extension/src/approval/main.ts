import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-700.css';
import '@fontsource/space-grotesk/latin-500.css';
import '@fontsource/space-grotesk/latin-600.css';
import { APP_NAME } from '@sqw/brand';
import { LitElement, html } from 'lit';
import { customElement } from 'lit/decorators.js';

// Placeholder root: replaced by the Router once ui/core lands.
@customElement('sq-approval-app')
export class ApprovalApp extends LitElement {
  override render() {
    return html`<h1>Approbation</h1>`;
  }
}

document.title = APP_NAME;
