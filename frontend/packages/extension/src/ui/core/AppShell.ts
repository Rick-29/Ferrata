import { provide } from '@lit/context';
import { LitElement, css, html, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';
import type { UiBridge } from '../services/UiBridge';
import { bridgeContext, routerContext } from './contexts';
import { ROUTE_CHANGE, type Router } from './Router';
import { themeStyles } from './theme';

/**
 * Root of a page (popup or approval window): applies the theme, provides the bridge and router
 * to every Screen, and re-renders when the route changes. Built in main.ts with its dependencies.
 */
@customElement('sq-app-shell')
export class AppShell extends LitElement {
  @provide({ context: bridgeContext }) readonly bridge: UiBridge;
  @provide({ context: routerContext }) readonly router: Router;

  static override styles = [
    themeStyles,
    css`
      :host {
        display: block;
        position: relative;
        min-height: 100%;
        overflow: hidden;
        box-sizing: border-box;
      }
      /* Soft blurred glows behind the content (design: .ambient). */
      .ambient {
        position: absolute;
        border-radius: 999px;
        filter: blur(60px);
        pointer-events: none;
      }
      .one {
        width: 210px;
        height: 180px;
        left: -85px;
        top: -90px;
        background: var(--sq-pink);
        opacity: 0.18;
      }
      .two {
        width: 190px;
        height: 180px;
        right: -100px;
        top: 175px;
        background: var(--sq-violet);
        opacity: 0.12;
      }
      main {
        position: relative;
        z-index: 1;
        padding: 20px;
      }
    `,
  ];

  constructor(bridge: UiBridge, router: Router) {
    super();
    this.bridge = bridge;
    this.router = router;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.router.addEventListener(ROUTE_CHANGE, this.#onRouteChange);
  }

  override disconnectedCallback(): void {
    this.router.removeEventListener(ROUTE_CHANGE, this.#onRouteChange);
    super.disconnectedCallback();
  }

  override render(): TemplateResult {
    return html`<div class="ambient one"></div>
      <div class="ambient two"></div>
      <main>${this.router.render()}</main>`;
  }

  readonly #onRouteChange = (): void => {
    this.requestUpdate();
  };
}

declare global {
  interface HTMLElementTagNameMap {
    'sq-app-shell': AppShell;
  }
}
