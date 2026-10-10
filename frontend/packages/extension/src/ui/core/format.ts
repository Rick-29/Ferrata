// Amounts travel as base-unit integers in 0x hex (or decimal) strings, like the API.

const DISPLAY_DECIMALS = 4;
const DECIMAL_INPUT = /^\d+(?:\.\d+)?$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export const isAddress = (value: string): boolean => ADDRESS.test(value);

export const toHexUnits = (value: bigint): string => `0x${value.toString(16)}`;

/** Exact decimal string, no grouping, no rounding: `1500000, 6` → `"1.5"`. */
export function unitsToDecimal(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const fraction = (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${abs / base}${fraction ? `.${fraction}` : ''}`;
}

/** What the user typed (`"12,5"`, `"0.01"`) to base units, or `null` if it is not a valid amount. */
export function toBaseUnits(input: string, decimals: number): bigint | null {
  const normalized = input.trim().replace(',', '.');
  if (!DECIMAL_INPUT.test(normalized)) return null;
  const [whole = '0', fraction = ''] = normalized.split('.');
  if (fraction.length > decimals) return null;
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
}

const UNREADABLE = '—';

/**
 * Display form: thousands grouped with a narrow no-break space. Truncated to four fraction digits
 * for overviews; pass `exact` wherever the user is about to sign, so they see what they sign.
 */
export function formatUnits(value: string, decimals: number, options: { readonly exact?: boolean } = {}): string {
  let units: bigint;
  try {
    units = BigInt(value);
  } catch {
    return UNREADABLE;
  }
  const [whole = '0', fraction = ''] = unitsToDecimal(units, decimals).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const shown = options.exact ? fraction : fraction.slice(0, DISPLAY_DECIMALS);
  return shown ? `${grouped}.${shown}` : grouped;
}

export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

export function formatTime(unixSecs: number): string {
  return new Date(unixSecs * 1000).toLocaleTimeString('fr-CH', { hour: '2-digit', minute: '2-digit' });
}
