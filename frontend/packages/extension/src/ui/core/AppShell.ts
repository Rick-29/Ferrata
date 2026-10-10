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
        min-height: 100%;
        padding: var(--sq-space-4);
        box-sizing: border-box;
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
    return html`<main>${this.router.render()}</main>`;
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
