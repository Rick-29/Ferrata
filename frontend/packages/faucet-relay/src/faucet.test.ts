import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COOLDOWN_MS, FaucetRelay, parseRequest, type CdpFaucets } from './faucet.ts';

const EVM = '0x742d35Cc6634C0532925a3b844Bc454e4438f44e';
const SOL = 'J1nWcQxUpfKmNVYVFdHPpKNqU8ARMQ2JYEf2SS7nCF2G';

function fakeCdp(overrides: Partial<CdpFaucets> = {}): CdpFaucets & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    evm: async (address) => {
      calls.push(`evm:${address}`);
      return { transactionHash: '0xabc' };
    },
    solana: async (address) => {
      calls.push(`sol:${address}`);
      return { signature: '5sig' };
    },
    ...overrides,
  };
}

test('accepts only well-formed addresses for the right network', () => {
  assert.deepEqual(parseRequest({ network: 'base-sepolia', address: EVM }), { network: 'base-sepolia', address: EVM });
  assert.deepEqual(parseRequest({ network: 'solana-devnet', address: SOL }), { network: 'solana-devnet', address: SOL });
  assert.equal(parseRequest({ network: 'base-sepolia', address: SOL }), null);
  assert.equal(parseRequest({ network: 'solana-devnet', address: EVM }), null);
  assert.equal(parseRequest({ network: 'ethereum', address: EVM }), null);
  assert.equal(parseRequest('nope'), null);
});

test('claims ETH on Base Sepolia and SOL on devnet with CDP amounts', async () => {
  const cdp = fakeCdp();
  const relay = new FaucetRelay(cdp);

  const eth = await relay.claim({ network: 'base-sepolia', address: EVM });
  assert.deepEqual(eth, {
    ok: true,
    grant: { network: 'base-sepolia', txId: '0xabc', amount: '100000000000000', symbol: 'ETH', decimals: 18, explorerUrl: 'https://sepolia.basescan.org/tx/0xabc' },
  });
  const sol = await relay.claim({ network: 'solana-devnet', address: SOL });
  assert.equal(sol.ok && sol.grant.amount, '1250000');
  assert.deepEqual(cdp.calls, [`evm:${EVM}`, `sol:${SOL}`]);
});

test('refuses a second claim for the same address within the cooldown, then allows it', async () => {
  let now = 1_000_000;
  const relay = new FaucetRelay(fakeCdp(), () => now);
  assert.equal((await relay.claim({ network: 'base-sepolia', address: EVM })).ok, true);
  const again = await relay.claim({ network: 'base-sepolia', address: EVM.toLowerCase() });
  assert.equal(!again.ok && again.error.code, 'COOLDOWN');
  now += COOLDOWN_MS;
  assert.equal((await relay.claim({ network: 'base-sepolia', address: EVM })).ok, true);
});

test('answers NOT_CONFIGURED without a key, and never calls CDP', async () => {
  const result = await new FaucetRelay(null).claim({ network: 'base-sepolia', address: EVM });
  assert.equal(!result.ok && result.error.code, 'NOT_CONFIGURED');
});

test('maps CDP errors: daily limit, forbidden address, bad key', async () => {
  const failing = (statusCode: number, errorType: string) =>
    new FaucetRelay(
      fakeCdp({
        evm: async () => {
          throw Object.assign(new Error(errorType), { statusCode, errorType });
        },
      }),
    );
  const limit = await failing(429, 'faucet_limit_exceeded').claim({ network: 'base-sepolia', address: EVM });
  assert.equal(!limit.ok && limit.error.code, 'FAUCET_LIMIT');
  const forbidden = await failing(403, 'forbidden').claim({ network: 'base-sepolia', address: EVM });
  assert.equal(!forbidden.ok && forbidden.error.code, 'FAUCET_FORBIDDEN');
  const badKey = await failing(401, 'unauthorized').claim({ network: 'base-sepolia', address: EVM });
  assert.equal(!badKey.ok && badKey.error.code, 'NOT_CONFIGURED');
});

test('a failed claim does not consume the cooldown', async () => {
  let fail = true;
  const relay = new FaucetRelay(
    fakeCdp({
      evm: async () => {
        if (fail) throw Object.assign(new Error('boom'), { statusCode: 500, errorType: 'internal' });
        return { transactionHash: '0xok' };
      },
    }),
  );
  assert.equal((await relay.claim({ network: 'base-sepolia', address: EVM })).ok, false);
  fail = false;
  assert.equal((await relay.claim({ network: 'base-sepolia', address: EVM })).ok, true);
});
