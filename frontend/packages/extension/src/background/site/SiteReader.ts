import type { DappResponse, ProviderError } from '../../dapp/protocol';
import type { UiError } from '../../ui/core/errors';
import { toActivityRows, type ActivityRow } from '../../ui/core/activity';
import { formatUnits } from '../../ui/core/format';
import type { RecoveryAlert, TestnetNetwork, UiBridge } from '../../ui/services/UiBridge';

// Read-only wallet data for Ferrata's own website (its dashboard), answered by the extension (P3).
// First-party origins only (see DappRouter). Plain JSON, already formatted: the website never sees
// a key, a session token, or anything it could sign with. Locked wallet → code 4100, "locked".

export const SITE_READS = ['sqw_wallet', 'sqw_activity', 'sqw_testnet', 'sqw_recovery'] as const;
export type SiteRead = (typeof SITE_READS)[number];

export const isSiteRead = (method: string): method is SiteRead => (SITE_READS as readonly string[]).includes(method);

export interface SiteBalance {
  readonly symbol: string;
  readonly decimals: number;
  /** Base units, decimal string. */
  readonly amount: string;
  readonly formatted: string;
}

export interface SiteWallet {
  readonly address: string;
  readonly network: string;
  readonly balances: readonly SiteBalance[];
}

export interface SiteTestnetWallet {
  readonly network: TestnetNetwork;
  readonly label: string;
  readonly symbol: string;
  readonly address: string;
  /** Formatted, or null when the network could not be read. */
  readonly balance: string | null;
  readonly explorerUrl: string;
}

export interface SiteRecovery {
  /** Fingerprint of the recovery phone's key on the Ferra chain, or null when none is associated. */
  readonly phoneFingerprint: string | null;
  /** Recoveries of this wallet started elsewhere. */
  readonly alerts: readonly RecoveryAlert[];
}

export type SiteActivityRow = ActivityRow;

/** What the extension answers the website for one read. */
export async function readForSite(bridge: UiBridge, method: SiteRead): Promise<DappResponse> {
  switch (method) {
    case 'sqw_wallet': {
      const wallet = await bridge.getWallet();
      if (!wallet.ok) return failed(wallet.error);
      const balances = wallet.value.balances.map((b) => {
        const amount = toDecimal(b.amount);
        return { symbol: b.symbol, decimals: b.decimals, amount, formatted: formatUnits(amount, b.decimals) };
      });
      return answer<SiteWallet>({ address: wallet.value.address, network: 'Ferra chain', balances });
    }
    case 'sqw_activity': {
      const feed = await bridge.getActivity();
      return feed.ok ? answer<readonly SiteActivityRow[]>(toActivityRows(feed.value)) : failed(feed.error);
    }
    case 'sqw_testnet': {
      const wallets = await bridge.getTestnetWallets();
      if (!wallets.ok) return failed(wallets.error);
      return answer<readonly SiteTestnetWallet[]>(
        wallets.value.map((w) => ({
          network: w.network,
          label: w.label,
          symbol: w.symbol,
          address: w.address,
          balance: w.balance === null ? null : formatUnits(w.balance, w.decimals),
          explorerUrl: w.explorerUrl,
        })),
      );
    }
    case 'sqw_recovery': {
      const [phone, alerts] = await Promise.all([bridge.getRecoveryPhone(), bridge.getRecoveryAlerts()]);
      if (!phone.ok) return failed(phone.error);
      if (!alerts.ok) return failed(alerts.error);
      return answer<SiteRecovery>({ phoneFingerprint: phone.value.fingerprint, alerts: alerts.value });
    }
  }
}

const answer = <T>(result: T): DappResponse => ({ ok: true, result });

/** Locked → "locked", signed out / no wallet → "signed_out": the site then offers to open Ferrata. */
function failed(error: UiError): DappResponse {
  const providerError: ProviderError =
    error.code === 'UI_LOCKED'
      ? { code: 4100, message: 'locked' }
      : error.code === 'SQ_UNAUTHORIZED' || error.code === 'UI_NO_WALLET' || error.code === 'SQ_NOT_FOUND'
        ? { code: 4100, message: 'signed_out' }
        : { code: -32603, message: error.code };
  return { ok: false, error: providerError };
}

/** Balances come as hex (U256) from the backend, or decimal: always hand out decimal. */
function toDecimal(amount: string): string {
  try {
    return BigInt(amount).toString();
  } catch {
    return '0';
  }
}
