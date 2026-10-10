import type { SdkError } from '@sqw/sdk';
import { uiError, type UiError } from '../ui/core/errors';

const SERVER_ERROR = 500;

/** SdkError → UiError: backend codes get the `SQ_` prefix the UI message table expects. */
export function toUiError(error: SdkError): UiError {
  switch (error.source) {
    case 'network':
      return uiError('CHAIN_UNAVAILABLE', true);
    case 'swissquote':
      return uiError(`SQ_${error.code}`, (error.status ?? 0) >= SERVER_ERROR);
    case 'passkey':
      return uiError(error.code.startsWith('PASSKEY_') ? error.code : 'PASSKEY_CANCELLED');
    default:
      return uiError(error.code);
  }
}
