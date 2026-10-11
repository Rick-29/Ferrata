import type { AssetBalance } from '@sqw/types/AssetBalance';
import { html, type TemplateResult } from 'lit';
import type { SendPreview } from '../services/UiBridge';

/** Every screen in the Frontend Spec with what it needs to open. `void` routes take nothing. */
export interface RouteParams {
  onboarding: void;
  home: void;
  send: void;
  confirm: { readonly preview: SendPreview; readonly asset: AssetBalance };
  'recovery-start': void;
  'recovery-phone': void;
  'security-alert': void;
  activity: void;
  settings: void;
}

export type RouteName = keyof RouteParams;

export type RouteTable = { readonly [K in RouteName]?: (params: RouteParams[K]) => TemplateResult };

type ParamlessRoute = { [K in RouteName]: RouteParams[K] extends void ? K : never }[RouteName];

export const ROUTE_CHANGE = 'route-change';

const placeholder = (route: RouteName): TemplateResult =>
  html`<p role="alert">Écran « ${route} » pas encore disponible.</p>`;

/** Minimal in-memory router: popups have no URL bar, so there is no history to sync. */
export class Router extends EventTarget {
  readonly #routes: RouteTable;
  #current: RouteName;
  #view: () => TemplateResult;

  constructor(routes: RouteTable, initial: ParamlessRoute) {
    super();
    this.#routes = routes;
    this.#current = initial;
    this.#view = this.#viewFor(initial, undefined);
  }

  get current(): RouteName {
    return this.#current;
  }

  /** Always re-renders, so going to the same route with new params refreshes it. */
  go<K extends RouteName>(route: K, params: RouteParams[K]): void {
    this.#current = route;
    this.#view = this.#viewFor(route, params);
    this.dispatchEvent(new Event(ROUTE_CHANGE));
  }

  render(): TemplateResult {
    return this.#view();
  }

  #viewFor<K extends RouteName>(route: K, params: RouteParams[K]): () => TemplateResult {
    const screen = this.#routes[route];
    return screen ? () => screen(params) : () => placeholder(route);
  }
}
