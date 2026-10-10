import type { ChainTx } from '@sqw/types/ChainTx';
import type { Flag } from '@sqw/types/Flag';
import type { RiskBand } from '@sqw/types/RiskBand';
import type { TokenInfo } from '@sqw/types/TokenInfo';
import type { TxKind } from '@sqw/types/TxKind';
import type { ActivityFeed } from '../services/UiBridge';
import { formatUnits } from './format';

const NATIVE = { symbol: 'ETH', decimals: 18 } as const;

export interface ActivityRow {
  readonly key: string;
  readonly kind: TxKind;
  readonly label: string;
  readonly network: string;
  readonly timestamp: number;
  /** Already formatted with its symbol, `null` when the event moves no value. */
  readonly amount: string | null;
  readonly direction: 'in' | 'out' | 'none';
  readonly counterparty: string | null;
  readonly riskLevel: RiskBand | null;
  readonly reviewedRisk: RiskBand | null;
  readonly flags: readonly Flag[];
  /** Swissquote signed a receipt for this event (an audit-log entry with the same user_op_hash). */
  readonly hasReceipt: boolean;
  readonly explorerUrl: string | null;
}

const KIND_LABELS: Readonly<Record<TxKind, string>> = {
  account_created: 'Compte créé',
  faucet: 'Fonds de démo reçus',
  cosigned: 'Envoi co-signé',
  escape_start: 'Sortie de secours lancée',
  escape_cancel: 'Sortie de secours annulée',
  escape_exit: 'Sortie de secours exécutée',
  owner_rotation: 'Passkey remplacée',
  anchor: 'Journal ancré',
  flag: 'Signalement',
  external: 'Transaction externe',
  settings_changed: 'Réglages modifiés',
  intent: 'Transaction préparée',
  intent_outcome: 'Suite de transaction',
};

/** Internal bookkeeping events the user does not need to see one by one. */
const HIDDEN_KINDS: ReadonlySet<TxKind> = new Set<TxKind>(['intent', 'intent_outcome', 'anchor']);

/** Newest first, one row per user-visible event. */
export function toActivityRows(feed: ActivityFeed): readonly ActivityRow[] {
  const receipts = new Set(feed.receiptHashes.map((h) => h.toLowerCase()));
  return [...feed.txs]
    .filter((tx) => !HIDDEN_KINDS.has(tx.kind))
    .sort((a, b) => b.block_number - a.block_number)
    .map((tx) => toRow(tx, feed.tokens, receipts, feed.address.toLowerCase()));
}

function toRow(tx: ChainTx, tokens: readonly TokenInfo[], receipts: ReadonlySet<string>, own: string): ActivityRow {
  const external = externalRef(tx);
  const transfer = external ? externalTransfer(external) : transferOf(tx, tokens);
  const outgoing = tx.from.toLowerCase() === own && tx.kind !== 'faucet';
  return {
    key: tx.hash,
    kind: tx.kind,
    label: KIND_LABELS[tx.kind],
    network: tx.network.name,
    timestamp: tx.timestamp,
    amount: transfer?.amount ?? null,
    direction: transfer ? (outgoing ? 'out' : 'in') : 'none',
    counterparty: transfer?.counterparty ?? null,
    riskLevel: tx.risk_level,
    reviewedRisk: tx.reviewed_risk,
    flags: tx.flags,
    hasReceipt: receipts.has(tx.user_op_hash.toLowerCase()),
    explorerUrl: external?.explorerUrl ?? null,
  };
}

interface Transfer {
  readonly amount: string;
  readonly counterparty: string;
}

function transferOf(tx: ChainTx, tokens: readonly TokenInfo[]): Transfer | null {
  const action = tx.action;
  switch (action.kind) {
    case 'native_transfer':
      return { amount: `${formatUnits(action.amount, NATIVE.decimals)} ${NATIVE.symbol}`, counterparty: action.to };
    case 'erc20_transfer': {
      const token = tokens.find((t) => t.address.toLowerCase() === action.token.toLowerCase());
      const amount = token ? `${formatUnits(action.amount, token.decimals)} ${token.symbol}` : 'Montant inconnu';
      return { amount, counterparty: action.to };
    }
    default:
      return null;
  }
}

interface ExternalInfo {
  readonly amount: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly counterparty: string;
  readonly explorerUrl: string | null;
}

/** `extra.external` is untyped JSON on `ChainTx`: read only what we use, defensively. */
function externalRef(tx: ChainTx): ExternalInfo | null {
  if (tx.kind !== 'external') return null;
  const ref = tx.extra['external'];
  if (typeof ref !== 'object' || ref === null) return null;
  const read = (key: string): unknown => (key in ref ? Reflect.get(ref, key) : undefined);
  const amount = read('amount');
  const symbol = read('asset_symbol');
  const decimals = read('decimals');
  const to = read('to_raw');
  const url = read('explorer_url');
  if (typeof amount !== 'string' || typeof symbol !== 'string' || typeof decimals !== 'number') return null;
  return {
    amount,
    symbol,
    decimals,
    counterparty: typeof to === 'string' ? to : '',
    explorerUrl: typeof url === 'string' && url.startsWith('https://') ? url : null,
  };
}

function externalTransfer(ref: ExternalInfo): Transfer {
  return { amount: `${formatUnits(ref.amount, ref.decimals)} ${ref.symbol}`, counterparty: ref.counterparty };
}
