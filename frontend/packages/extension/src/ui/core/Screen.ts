import { consume } from '@lit/context';
import { LitElement } from 'lit';
import type { UiBridge } from '../services/UiBridge';
import { bridgeContext, routerContext } from './contexts';
import type { UiError } from './errors';
import type { Result } from './result';
import type { Router } from './Router';
import { failed, ready, type WidgetState } from './Widget';

/** Base for screens: owns data loading and wires widget events to the bridge. Only layout markup. */
export abstract class Screen extends LitElement {
  @consume({ context: bridgeContext }) protected bridge!: UiBridge;
  @consume({ context: routerContext }) protected router!: Router;
}

/** Turns a bridge Result into the state a widget renders. */
export function toWidgetState<T>(result: Result<T, UiError>): WidgetState<T> {
  return result.ok ? ready(result.value) : failed(result.error);
}
