import type { WalletSettings } from '@sqw/types/WalletSettings';
import { isAddress } from './format';

const PERCENT_MAX = 100;

const isWhole = (n: number): boolean => Number.isInteger(n) && n >= 0;

/**
 * Same bounds as the backend's `set_settings`, checked before anything is signed. Settings are
 * guard-rails: a value that silently disables one (e.g. a step-up threshold of 10 000 %) is rejected.
 */
export function isValidSettings(s: WalletSettings): boolean {
  return (
    isWhole(s.version) &&
    isWhole(s.per_tx_limit_pct) &&
    s.per_tx_limit_pct <= PERCENT_MAX &&
    isWhole(s.step_up_above_pct) &&
    s.step_up_above_pct <= PERCENT_MAX &&
    isWhole(s.daily_limit) &&
    isWhole(s.intent_timeout_secs) &&
    isWhole(s.hold_timeout_secs) &&
    s.allowlist.every(isAddress)
  );
}
