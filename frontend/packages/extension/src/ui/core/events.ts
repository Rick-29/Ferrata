import type { LoginRequest } from '@sqw/types/LoginRequest';
import type { WalletSettings } from '@sqw/types/WalletSettings';

// Every event a widget can emit, with its payload. Adding an event means adding it here,
// so a typo in a name or a wrong payload fails compilation.
export interface WidgetEvents {
  retry: undefined;
  'login-submitted': LoginRequest;
  'passkey-requested': undefined;
  'send-requested': undefined;
  'address-changed': string;
  'amount-changed': string;
  'max-requested': undefined;
  /** Asset contract address, `null` for the native asset. */
  'asset-selected': string | null;
  'consent-changed': boolean;
  'settings-submitted': WalletSettings;
  confirm: undefined;
  reject: undefined;
  done: undefined;
}

export type WidgetEventName = keyof WidgetEvents;

export type WidgetEvent<E extends WidgetEventName> = CustomEvent<WidgetEvents[E]>;

/** Bubbles and crosses shadow roots so the owning Screen hears it. */
export function emitWidgetEvent<E extends WidgetEventName>(target: EventTarget, name: E, detail: WidgetEvents[E]): void {
  target.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
}
