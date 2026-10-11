import type { ChainTx } from '@sqw/types/ChainTx';
import { describe, expect, it } from 'vitest';
import { DEMO_TOKENS, USDC, chainTx } from '../services/fake-world';
import type { ActivityFeed } from '../services/UiBridge';
import { toActivityRows } from './activity';

const ME = '0x5a11e7000000000000000000000000000000a11c';
const OTHER = `0x${'12'.repeat(20)}`;

function send(block: number, userOpHash: string): ChainTx {
  return chainTx({
    kind: 'cosigned',
    from: ME,
    to: OTHER,
    action: { kind: 'erc20_transfer', token: USDC, to: OTHER, amount: '0x2faf080' },
    band: 'Medium',
    userOpHash,
    block,
  });
}

const feed = (txs: readonly ChainTx[], receiptHashes: readonly string[] = []): ActivityFeed => ({
  address: ME,
  txs,
  receiptHashes,
  tokens: DEMO_TOKENS,
});

describe('toActivityRows', () => {
  it('lists newest first, formats token amounts and marks outgoing sends', () => {
    const rows = toActivityRows(feed([send(1, '0xa'), send(2, '0xb')]));
    expect(rows.map((r) => r.key)).toEqual([send(2, '0xb').hash, send(1, '0xa').hash]);
    expect(rows[0]).toMatchObject({ label: 'Envoi signé par Swissquote', amount: '50 USDC', direction: 'out', riskLevel: 'Medium' });
  });

  it('marks the events that carry a Swissquote receipt', () => {
    const rows = toActivityRows(feed([send(1, '0xAA'), send(2, '0xbb')], ['0xaa']));
    expect(rows.find((r) => r.key === send(1, '0xAA').hash)?.hasReceipt).toBe(true);
    expect(rows.find((r) => r.key === send(2, '0xbb').hash)?.hasReceipt).toBe(false);
  });

  it('hides internal bookkeeping events', () => {
    const intent = { ...send(3, '0xc'), kind: 'intent' as const };
    expect(toActivityRows(feed([intent, send(1, '0xa')]))).toHaveLength(1);
  });

  it('reads external events from extra.external and only keeps https explorer links', () => {
    const external = (url: string): ChainTx => ({
      ...send(4, '0xd'),
      kind: 'external',
      from: OTHER,
      network: { family: 'bitcoin', name: 'bitcoin-testnet', chain_id: null },
      extra: { external: { amount: '150000', asset_symbol: 'BTC', decimals: 8, to_raw: 'tb1qxyz', explorer_url: url } },
    });

    const [safe] = toActivityRows(feed([external('https://mempool.space/testnet/tx/1')]));
    expect(safe).toMatchObject({ amount: '0.0015 BTC', network: 'bitcoin-testnet', direction: 'in' });
    expect(safe?.explorerUrl).toBe('https://mempool.space/testnet/tx/1');

    const [unsafe] = toActivityRows(feed([external('javascript:alert(1)')]));
    expect(unsafe?.explorerUrl).toBeNull();
  });
});
