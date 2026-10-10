import { LitElement, html, type TemplateResult } from 'lit';
import { property } from 'lit/decorators.js';
import type { UiError } from './errors';
import { emitWidgetEvent, type WidgetEventName, type WidgetEvents } from './events';
import '../widgets/skeleton/Skeleton';
import '../widgets/error-panel/ErrorPanel';

export type WidgetState<T> =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly data: T }
  | { readonly kind: 'error'; readonly error: UiError };

/**
 * Base for every visible element. Data comes in through `state`, user intent goes out through
 * typed events; widgets never call services themselves.
 */
export abstract class Widget<T> extends LitElement {
  @property({ attribute: false }) state: WidgetState<T> = { kind: 'idle' };

  protected abstract renderReady(data: T): TemplateResult;

  protected renderLoading(): TemplateResult {
    return html`<sq-skeleton></sq-skeleton>`;
  }

  protected renderError(error: UiError): TemplateResult {
    return html`<sq-error-panel .error=${error}></sq-error-panel>`;
  }

  protected emit<E extends WidgetEventName>(name: E, detail: WidgetEvents[E]): void {
    emitWidgetEvent(this, name, detail);
  }

  override render(): TemplateResult {
    switch (this.state.kind) {
      case 'idle':
        return html``;
      case 'loading':
        return this.renderLoading();
      case 'ready':
        return this.renderReady(this.state.data);
      case 'error':
        return this.renderError(this.state.error);
    }
  }
}

export const idle = { kind: 'idle' } as const;
export const loading = { kind: 'loading' } as const;
export const ready = <T>(data: T): WidgetState<T> => ({ kind: 'ready', data });
export const failed = (error: UiError): WidgetState<never> => ({ kind: 'error', error });
