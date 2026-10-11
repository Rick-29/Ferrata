import { css, html, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { renderSVG } from 'uqr';
import { Widget } from '../../core/Widget';

/** A QR code for the phone to scan. Only ever renders text the wallet itself produced. */
@customElement('sq-qr-code')
export class QrCode extends Widget<string> {
  static override styles = css`
    div {
      width: 168px;
      height: 168px;
      margin: 0 auto;
      padding: 8px;
      border-radius: 14px;
      background: #fff;
      box-sizing: border-box;
    }
    div svg {
      display: block;
      width: 100%;
      height: 100%;
    }
    code {
      display: block;
      margin-top: 6px;
      font: 9px/1.4 var(--sq-font-mono, monospace);
      color: var(--sq-text-muted, #9aa);
      text-align: center;
      word-break: break-all;
      user-select: all;
    }
  `;

  protected override renderReady(text: string): TemplateResult {
    return html`<div role="img" aria-label="QR code à scanner avec votre téléphone">${unsafeHTML(renderSVG(text, { border: 1 }))}</div>
      <code title="Le même code, à copier si le scan ne marche pas">${text}</code>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'sq-qr-code': QrCode;
  }
}
