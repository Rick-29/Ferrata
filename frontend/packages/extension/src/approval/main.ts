import { LitElement, html } from 'lit';
import { customElement } from 'lit/decorators.js';

// Placeholder root: replaced by the Router once ui/core lands.
@customElement('sq-approval-app')
export class ApprovalApp extends LitElement {
  override render() {
    return html`<h1>Approbation</h1>`;
  }
}
