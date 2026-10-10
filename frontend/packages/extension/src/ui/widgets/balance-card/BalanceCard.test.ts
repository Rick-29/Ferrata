import { afterEach, describe, expect, it, vi } from 'vitest';
import { uiError } from '../../core/errors';
import { failed, loading, ready } from '../../core/Widget';
import { newDemoAccount } from '../../services/fake-world';
import { deepQuery, deepText, mount } from '../../testing/dom';
import './BalanceCard';

const card = (): HTMLElementTagNameMap['sq-balance-card'] => document.createElement('sq-balance-card');

afterEach(() => {
  document.body.innerHTML = '';
});

describe('sq-balance-card (Widget states)', () => {
  it('renders nothing when idle', async () => {
    const el = await mount(card());
    expect(deepText(el)).toBe('');
  });

  it('renders a skeleton while loading', async () => {
    const el = card();
    el.state = loading;
    await mount(el);
    expect(el.shadowRoot?.querySelector('sq-skeleton')).not.toBeNull();
  });

  it('headlines the USDC balance and shows the address', async () => {
    const el = card();
    el.state = ready(newDemoAccount('0xabc'));
    await mount(el);
    const text = deepText(el);
    expect(text).toMatch(/5\s000 USDC/);
    expect(text).toContain('0x5a11…a11c');
  });

  it('renders the error panel and bubbles retry', async () => {
    const el = card();
    el.state = failed(uiError('CHAIN_UNAVAILABLE', true));
    await mount(el);
    const panel = el.shadowRoot?.querySelector('sq-error-panel');
    await panel?.updateComplete;
    const onRetry = vi.fn();
    el.addEventListener('retry', onRetry);

    deepQuery<HTMLButtonElement>(el.shadowRoot ?? el, 'button')?.click();

    expect(deepText(el)).toContain('Réseau indisponible');
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
