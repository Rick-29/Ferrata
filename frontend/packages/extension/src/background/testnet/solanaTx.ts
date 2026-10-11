import { base58 } from '@scure/base';

// A Solana SystemProgram transfer, serialized by hand in the legacy transaction format: one
// instruction is all a wallet send needs, and it keeps @solana/web3.js (and its Node polyfills)
// out of the service worker. Layout: https://solana.com/docs/core/transactions (legacy message).

const SYSTEM_PROGRAM = base58.decode('11111111111111111111111111111111');
/** SystemInstruction::Transfer. */
const TRANSFER = 2;

/** The bytes the sender signs: header, account keys, recent blockhash, one transfer instruction. */
export function transferMessage(from: string, to: string, lamports: bigint, recentBlockhash: string): Uint8Array {
  const fromKey = key(from);
  const toKey = key(to);
  const blockhash = key(recentBlockhash);
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint32(0, TRANSFER, true);
  view.setBigUint64(4, lamports, true);

  return concat(
    // header: 1 required signature (the sender), 0 read-only signed, 1 read-only unsigned (system program)
    new Uint8Array([1, 0, 1]),
    compactU16(3),
    fromKey, // 0: signer, writable
    toKey, // 1: writable
    SYSTEM_PROGRAM, // 2: read-only program
    blockhash,
    compactU16(1),
    new Uint8Array([2]), // program id index
    compactU16(2),
    new Uint8Array([0, 1]), // accounts: from, to
    compactU16(data.length),
    data,
  );
}

/** Wire format: the signatures (here, one) then the message; base64 for `sendTransaction`. */
export function signedTransaction(signature: Uint8Array, message: Uint8Array): string {
  if (signature.length !== 64) throw new Error('Solana signatures are 64 bytes');
  const bytes = concat(compactU16(1), signature, message);
  return btoa(String.fromCharCode(...bytes));
}

export function isSolanaAddress(text: string): boolean {
  try {
    return base58.decode(text).length === 32;
  } catch {
    return false;
  }
}

function key(text: string): Uint8Array {
  const bytes = base58.decode(text);
  if (bytes.length !== 32) throw new Error(`Not a 32-byte base58 key: ${text}`);
  return bytes;
}

/** Solana's "shortvec" length prefix. */
export function compactU16(value: number): Uint8Array {
  const out: number[] = [];
  let rest = value;
  for (;;) {
    const byte = rest & 0x7f;
    rest >>= 7;
    if (rest === 0) {
      out.push(byte);
      return new Uint8Array(out);
    }
    out.push(byte | 0x80);
  }
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
