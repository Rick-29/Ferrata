import { html } from 'lit';
import { afterEach, describe, expect, it } from 'vitest';
import { AppShell } from '../core/AppShell';
import { emitWidgetEvent } from '../core/events';
import { Router } from '../core/Router';
import { DEMO_ADDRESSES, USDC } from '../services/fake-world';
import { FakeBridge } from '../services/FakeBridge';
import type { SendDraft } from '../services/UiBridge';
import { deepQuery, deepText, mount, settle } from '../testing/dom';
import './confirm/ConfirmScreen';
import './home/HomeScreen';
import './onboarding/OnboardingScreen';
import './send/SendScreen';

// End-to-end through the real shell, router and screens, against the FakeBridge with no latency.

const usdc = (whole: bigint): string => `0x${(whole * 10n ** 6n).toString(16)}`;

function popupRouter(): Router {
  return new Router(
    {
      onboarding: () => html`<sq-onboarding-screen></sq-onboarding-screen>`,
      home: () => html`<sq-home-screen></sq-home-screen>`,
      send: () => html`<sq-send-screen></sq-send-screen>`,
      confirm: ({ preview, asset }) => html`<sq-confirm-screen .preview=${preview} .asset=${asset}></sq-confirm-screen>`,
    },
    'onboarding',
  );
}

async function signedInBridge(): Promise<FakeBridge> {
  const bridge = new FakeBridge({ delayMs: 0 });
  await bridge.login({ username: 'alice', password: 'demo' });
  await bridge.createWallet();
  return bridge;
}

/** Opens Confirm for `draft` the way Send does, and returns the shell. */
async function openConfirm(draft: SendDraft): Promise<{ shell: AppShell; router: Router }> {
  const bridge = await signedInBridge();
  const router = popupRouter();
  const shell = await mount(new AppShell(bridge, router));
  const preview = await bridge.previewSend(draft);
  const wallet = await bridge.getWallet();
  const asset = wallet.ok ? wallet.value.balances.find((b) => b.asset === draft.asset) : undefined;
  if (!preview.ok || !asset) throw new Error('setup failed');
  router.go('confirm', { preview: preview.value, asset });
  await settle();
  return { shell, router };
}

async function tick(shell: AppShell, selector: string): Promise<void> {
  const el = deepQuery(shell, selector);
  if (!el) throw new Error(`no ${selector}`);
  emitWidgetEvent(el, 'consent-changed', true);
  await settle();
}

function passkeyButtonDisabled(shell: AppShell): boolean {
  const button = deepQuery(deepQuery(shell, 'sq-passkey-prompt') ?? shell, 'sq-button');
  return button instanceof HTMLElement && button.hasAttribute('disabled');
}

async function signWithPasskey(shell: AppShell): Promise<void> {
  const prompt = deepQuery(shell, 'sq-passkey-prompt');
  if (!prompt) throw new Error('no passkey prompt');
  emitWidgetEvent(prompt, 'passkey-requested', undefined);
  await settle();
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('Onboarding', () => {
  it('logs in, creates the passkey wallet and lands on Home with the balance', async () => {
    const router = popupRouter();
    const shell = await mount(new AppShell(new FakeBridge({ delayMs: 0 }), router));

    const form = deepQuery(shell, 'sq-login-form');
    if (!form) throw new Error('no login form');
    emitWidgetEvent(form, 'login-submitted', { username: 'alice', password: 'demo' });
    await settle();
    expect(deepText(shell)).toContain('Créer ma passkey');
    expect(deepText(shell)).toContain('ne les bloque pas');

    await signWithPasskey(shell);
    expect(router.current).toBe('onboarding');

    await tick(shell, 'sq-consent-checkbox');
    await signWithPasskey(shell);

    expect(router.current).toBe('home');
    expect(deepText(shell)).toMatch(/5\s000 USDC/);
  });

  it('keeps the user on the login step with a message when credentials are wrong', async () => {
    const shell = await mount(new AppShell(new FakeBridge({ delayMs: 0 }), popupRouter()));
    const form = deepQuery(shell, 'sq-login-form');
    if (!form) throw new Error('no login form');

    emitWidgetEvent(form, 'login-submitted', { username: 'alice', password: 'wrong' });
    await settle();

    expect(deepText(shell)).toContain('Identifiants invalides');
    expect(deepQuery(shell, 'sq-passkey-prompt')).toBeNull();
  });
});

describe('Send', () => {
  it('previews a valid transfer and opens Confirm', async () => {
    const bridge = await signedInBridge();
    const router = popupRouter();
    router.go('send', undefined);
    const shell = await mount(new AppShell(bridge, router));
    await settle();

    const addressInput = deepQuery(shell, 'sq-address-input');
    const amountInput = deepQuery(shell, 'sq-amount-input');
    if (!addressInput || !amountInput) throw new Error('form not rendered');
    emitWidgetEvent(addressInput, 'address-changed', DEMO_ADDRESSES.knownMerchant);
    emitWidgetEvent(amountInput, 'amount-changed', '25');
    await settle();
    const submit = Array.from(deepQuery(shell, 'sq-send-screen')?.shadowRoot?.querySelectorAll('sq-button') ?? []).at(-1);
    submit?.click();
    await settle();

    expect(router.current).toBe('confirm');
    expect(deepText(shell)).toContain('Aucun signal détecté');
  });
});

describe('Send (review regressions)', () => {
  async function filledSend(): Promise<{ shell: AppShell; router: Router }> {
    const bridge = await signedInBridge();
    const router = popupRouter();
    router.go('send', undefined);
    const shell = await mount(new AppShell(bridge, router));
    await settle();
    const addressInput = deepQuery(shell, 'sq-address-input');
    const amountInput = deepQuery(shell, 'sq-amount-input');
    if (!addressInput || !amountInput) throw new Error('form not rendered');
    emitWidgetEvent(addressInput, 'address-changed', DEMO_ADDRESSES.knownMerchant);
    emitWidgetEvent(amountInput, 'amount-changed', '25');
    await settle();
    return { shell, router };
  }

  it('does not yank the user to Confirm if they left while the preview was loading', async () => {
    const { shell, router } = await filledSend();
    Array.from(deepQuery(shell, 'sq-send-screen')?.shadowRoot?.querySelectorAll('sq-button') ?? []).at(-1)?.click();
    router.go('home', undefined);
    await settle();
    expect(router.current).toBe('home');
  });

  it('defaults to USDC, not the native asset', async () => {
    const { shell } = await filledSend();
    expect(deepText(shell)).toMatch(/Disponible : 5\s000 USDC/);
  });
});

describe('Confirm', () => {
  it('shows the exact amount being signed, not a rounded one', async () => {
    const { shell } = await openConfirm({ to: DEMO_ADDRESSES.knownMerchant, asset: USDC, amount: '0x112480' }); // 1.123456 USDC
    expect(deepText(shell)).toContain('1.123456 USDC');
  });

  it('lets the user cancel out of the second confirmation', async () => {
    const { shell, router } = await openConfirm({
      to: '0x1234567890123456789012345678901234567890',
      asset: USDC,
      amount: usdc(1_500n),
    });
    await signWithPasskey(shell);
    expect(deepText(shell)).toContain('Confirmation supplémentaire');

    deepQuery(shell, 'sq-button.cancel')?.click();
    await settle();
    expect(router.current).toBe('send');
  });

  it('Low: signs and shows the co-signed receipt', async () => {
    const { shell } = await openConfirm({ to: DEMO_ADDRESSES.knownMerchant, asset: USDC, amount: usdc(50n) });
    expect(deepText(shell)).toContain('Aucun signal');
    expect(deepText(shell)).toContain('ne garantit pas la détection');

    await signWithPasskey(shell);

    expect(deepText(shell)).toContain('Transaction envoyée');
    expect(deepText(shell)).toContain('Reçu n° 0');
  });

  it('Medium: asks for a second passkey confirmation, then goes through', async () => {
    const { shell } = await openConfirm({
      to: '0x1234567890123456789012345678901234567890',
      asset: USDC,
      amount: usdc(1_500n),
    });

    await signWithPasskey(shell);
    expect(deepText(shell)).toContain('Confirmation supplémentaire');
    expect(deepQuery(shell, 'sq-risk-warning')).toBeNull();

    await signWithPasskey(shell);
    expect(deepText(shell)).toContain('Transaction envoyée');
  });

  it('High: warns, requires the user to accept the risk, then sends — never blocks', async () => {
    const { shell } = await openConfirm({ to: DEMO_ADDRESSES.mixerExposed, asset: USDC, amount: usdc(100n) });
    await signWithPasskey(shell);

    expect(deepText(shell)).toContain('Risque élevé détecté');
    expect(deepText(shell)).toContain('Swissquote ne bloque pas cette transaction');
    expect(passkeyButtonDisabled(shell)).toBe(true);

    await signWithPasskey(shell);
    expect(deepText(shell)).not.toContain('Transaction envoyée');

    await tick(shell, 'sq-risk-warning');
    expect(passkeyButtonDisabled(shell)).toBe(false);
    await signWithPasskey(shell);
    expect(deepText(shell)).toContain('Transaction envoyée');
  });

  it('Sanctions: refused for regulatory reasons without naming them, funds untouched', async () => {
    const { shell, router } = await openConfirm({ to: DEMO_ADDRESSES.sanctioned, asset: USDC, amount: usdc(10n) });
    expect(deepText(shell)).toContain('Motif réglementaire');
    expect(deepText(shell)).not.toMatch(/sanction/i);

    await signWithPasskey(shell);
    expect(deepText(shell)).toContain('Transaction refusée');
    expect(deepText(shell)).toContain('raisons réglementaires');

    const panel = deepQuery(shell, 'sq-outcome-panel');
    if (!panel) throw new Error('no outcome panel');
    emitWidgetEvent(panel, 'done', undefined);
    await settle();
    expect(router.current).toBe('home');
  });
});
