// Standard ERC-20 `transfer(address,uint256)` calldata, the encoding the backend decoder expects.

const TRANSFER_SELECTOR = 'a9059cbb';
const WORD_HEX_CHARS = 64;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const word = (hex: string): string => hex.padStart(WORD_HEX_CHARS, '0');

/** `amount` is base units (bigint). Throws on a malformed address: callers validate first. */
export function encodeErc20Transfer(to: string, amount: bigint): string {
  if (!ADDRESS.test(to)) throw new RangeError(`not an address: ${to}`);
  if (amount < 0n) throw new RangeError('amount must be positive');
  return `0x${TRANSFER_SELECTOR}${word(to.slice(2).toLowerCase())}${word(amount.toString(16))}`;
}
