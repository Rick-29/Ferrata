import { html } from 'lit';
import { describe, expect, it, vi } from 'vitest';
import { errorMessage, uiError } from './errors';
import { FakeBridge } from '../services/FakeBridge';
import { formatUnits, isAddress, shortAddress, toBaseUnits, unitsToDecimal } from './format';
import { ROUTE_CHANGE, Router } from './Router';

describe('formatUnits', () => {
  it('formats USDC base units from hex with thousands grouping', () => {
    expect(formatUnits('0x12a05f200', 6)).toBe('5 000');
  });

  it('keeps up to four fraction digits and trims trailing zeros', () => {
    expect(formatUnits('1234567', 6)).toBe('1.2345');
    expect(formatUnits('1500000', 6)).toBe('1.5');
  });

  it('formats one ETH', () => {
    expect(formatUnits('0xde0b6b3a7640000', 18)).toBe('1');
  });
});

describe('toBaseUnits', () => {
  it('parses whole and fractional amounts, with dot or comma', () => {
    expect(toBaseUnits('12', 6)).toBe(12_000_000n);
    expect(toBaseUnits('12.5', 6)).toBe(12_500_000n);
    expect(toBaseUnits(' 0,000001 ', 6)).toBe(1n);
  });

  it('rejects garbage and more decimals than the asset has', () => {
    expect(toBaseUnits('abc', 6)).toBeNull();
    expect(toBaseUnits('-1', 6)).toBeNull();
    expect(toBaseUnits('1.0000001', 6)).toBeNull();
    expect(toBaseUnits('', 6)).toBeNull();
  });

  it('round-trips with unitsToDecimal', () => {
    expect(unitsToDecimal(toBaseUnits('4950.25', 6) ?? 0n, 6)).toBe('4950.25');
    expect(unitsToDecimal(5_000_000_000n, 6)).toBe('5000');
  });
});

describe('address helpers', () => {
  it('validates 20-byte hex addresses', () => {
    expect(isAddress('0x000000000000000000000000000000000000dead')).toBe(true);
    expect(isAddress('0xdead')).toBe(false);
  });

  it('keeps the start and end of an address', () => {
    expect(shortAddress('0x000000000000000000000000000000000000dead')).toBe('0x0000…dead');
  });
});

describe('errorMessage', () => {
  it('maps known codes and falls back for unknown ones', () => {
    expect(errorMessage(uiError('SQ_UNAUTHORIZED'))).toContain('Identifiants');
    expect(errorMessage(uiError('SOMETHING_NEW'))).toBe('Une erreur inattendue est survenue.');
  });
});

describe('Router', () => {
  it('notifies on every navigation and tracks the current route', () => {
    const router = new Router({ home: () => html`home` }, 'home');
    const listener = vi.fn();
    router.addEventListener(ROUTE_CHANGE, listener);

    router.go('send', undefined);
    router.go('send', undefined);

    expect(listener).toHaveBeenCalledTimes(2);
    expect(router.current).toBe('send');
  });

  it('passes route params to the screen factory', async () => {
    const bridge = new FakeBridge({ delayMs: 0 });
    await bridge.login({ username: 'alice', password: 'demo' });
    const wallet = await bridge.createWallet();
    const asset = wallet.ok ? wallet.value.balances[1] : undefined;
    const preview = await bridge.previewSend({ to: `0x${'12'.repeat(20)}`, asset: asset?.asset ?? null, amount: '0x1' });
    if (!asset || !preview.ok) throw new Error('setup failed');
    const confirm = vi.fn(() => html`confirm`);
    const router = new Router({ confirm }, 'home');

    router.go('confirm', { preview: preview.value, asset });
    router.render();

    expect(confirm).toHaveBeenCalledWith({ preview: preview.value, asset });
  });

  it('renders a placeholder for a screen that is not registered yet', () => {
    const router = new Router({}, 'settings');
    expect(router.render().strings.join('')).toContain('pas encore disponible');
  });
});
