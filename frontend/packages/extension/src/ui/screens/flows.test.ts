import { html } from 'lit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from '../core/AppShell';
import { emitWidgetEvent } from '../core/events';
import { Router } from '../core/Router';
import { DEMO_ADDRESSES, USDC } from '../services/fake-world';
import { FakeBridge } from '../services/FakeBridge';
import type { SendDraft } from '../services/UiBridge';
import { deepQuery, deepText, mount, settle } from '../testing/dom';
import './activity/ActivityScreen';
import './confirm/ConfirmScreen';
import './home/HomeScreen';
import './onboarding/OnboardingScreen';
import './recovery/RecoveryPhoneScreen';
import './recovery/RecoveryStartScreen';
import './send/SendScreen';
import './settings/SettingsScreen';

// End-to-end through the real shell, router and screens, against the FakeBridge with no latency.

const usdc = (whole: bigint): string => `0x${(whole * 10n ** 6n).toString(16)}`;

function popupRouter(): Router {
  return new Router(
    {
      onboarding: () => html`<sq-onboarding-screen></sq-onboarding-screen>`,
      home: () => html`<sq-home-screen></sq-home-screen>`,
      send: () => html`<sq-send-screen></sq-send-screen>`,
      confirm: ({ preview, asset }) => html`<sq-confirm-screen .preview=${preview} .asset=${asset}></sq-confirm-screen>`,
      activity: () => html`<sq-activity-screen></sq-activity-screen>`,
      settings: () => html`<sq-settings-screen></sq-settings-screen>`,
      'recovery-phone': () => html`<sq-recovery-phone-screen></sq-recovery-phone-screen>`,
      'recovery-start': () => html`<sq-recovery-start-screen></sq-recovery-start-screen>`,
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
    expect(deepText(shell)).toContain("Reçu d'analyse n° 0");
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

  it('"Comprendre ce score" opens the explainer with the weight and meaning of each signal', async () => {
    const { shell } = await openConfirm({ to: DEMO_ADDRESSES.mixerExposed, asset: USDC, amount: usdc(100n) });
    const why = deepQuery(shell, 'button.why');
    if (!(why instanceof HTMLElement)) throw new Error('no "Comprendre ce score" button');
    why.click();
    await settle();
    expect(deepText(shell)).toContain('Pourquoi cet avertissement ?');
    expect(deepText(shell)).toContain('Vous décidez.');
  });

  it('Sanctions: the strongest warning, explained, and the user still decides (self-custody)', async () => {
    const { shell, router } = await openConfirm({ to: DEMO_ADDRESSES.sanctioned, asset: USDC, amount: usdc(10n) });
    expect(deepText(shell)).toContain('Adresse sur une liste de sanctions');

    await signWithPasskey(shell);
    expect(deepText(shell)).not.toContain('Transaction envoyée');
    expect(passkeyButtonDisabled(shell)).toBe(true);

    await tick(shell, 'sq-risk-warning');
    await signWithPasskey(shell);
    expect(deepText(shell)).toContain('Transaction envoyée');

    const panel = deepQuery(shell, 'sq-outcome-panel');
    if (!panel) throw new Error('no outcome panel');
    emitWidgetEvent(panel, 'done', undefined);
    await settle();
    expect(router.current).toBe('home');
  });
});

describe('Activity', () => {
  it('shows a send with its Swissquote analysis receipt', async () => {
    const bridge = await signedInBridge();
    const preview = await bridge.previewSend({ to: DEMO_ADDRESSES.knownMerchant, asset: USDC, amount: usdc(50n) });
    if (!preview.ok) throw new Error('setup failed');
    await bridge.confirmSend(preview.value.id, { stepUp: false, acceptedRisk: false });
    const router = popupRouter();
    router.go('activity', undefined);
    const shell = await mount(new AppShell(bridge, router));
    await settle();

    const text = deepText(shell);
    expect(text).toContain('Envoi');
    expect(text).toContain('−50 USDC');
    expect(text).toContain('✓ Analysé');
    expect(text).toContain('Fonds de démo reçus');
  });
});

describe('Settings', () => {
  async function openSettings(): Promise<{ shell: AppShell; bridge: FakeBridge }> {
    const bridge = await signedInBridge();
    const router = popupRouter();
    router.go('settings', undefined);
    const shell = await mount(new AppShell(bridge, router));
    await settle();
    return { shell, bridge };
  }

  function typeInto(shell: AppShell, id: string, value: string): void {
    const input = deepQuery<HTMLInputElement>(shell, `#${id}`);
    if (!input) throw new Error(`no #${id}`);
    input.value = value;
    input.dispatchEvent(new Event('input'));
  }

  it('refuses a percentage above 100 before anything is signed', async () => {
    const { shell } = await openSettings();
    typeInto(shell, 'f-stepUpPct', '150');
    await settle();
    expect(deepText(shell)).toContain('Entre 0 et 100.');
    const save = deepQuery(deepQuery(shell, 'sq-settings-form') ?? shell, 'sq-button');
    expect(save?.hasAttribute('disabled')).toBe(true);
  });

  it('saves signed settings and confirms it', async () => {
    const { shell, bridge } = await openSettings();
    typeInto(shell, 'f-stepUpPct', '30');
    await settle();
    deepQuery(deepQuery(shell, 'sq-settings-form') ?? shell, 'sq-button')?.click();
    await settle();

    expect(deepText(shell)).toContain('Réglages enregistrés et signés.');
    const stored = await bridge.getSettings();
    expect(stored.ok && stored.value.step_up_above_pct).toBe(30);
  });
});

describe('Recovery phone', () => {
  it('pairs the phone by QR, shows the fingerprint to compare, and registers it with the passkey', async () => {
    vi.useFakeTimers();
    try {
      const bridge = await signedInBridge();
      const router = popupRouter();
      router.go('recovery-phone', undefined);
      const shell = await mount(new AppShell(bridge, router));
      await vi.advanceTimersByTimeAsync(10);
      expect(deepText(shell)).toContain('Aucun téléphone de secours');

      const button = (label: string): HTMLElement => {
        const found = [...(deepQuery(shell, 'sq-recovery-phone-screen')?.shadowRoot?.querySelectorAll('sq-button') ?? [])].find((b) => b.textContent?.includes(label));
        if (!(found instanceof HTMLElement)) throw new Error(`no button ${label}`);
        return found;
      };
      button('Associer mon téléphone').click();
      await vi.advanceTimersByTimeAsync(10);
      expect(deepQuery(shell, 'sq-qr-code')).not.toBeNull();

      // The fake phone answers on the second poll.
      await vi.advanceTimersByTimeAsync(4_100);
      expect(deepText(shell)).toContain('5FA8-122B');
      expect(deepText(shell)).toContain('même empreinte');

      button('Identique').click();
      await vi.advanceTimersByTimeAsync(10);
      expect(deepText(shell)).toContain('Téléphone de secours enregistré');
      const status = await bridge.getRecoveryPhone();
      expect(status.ok && status.value.fingerprint).toBe('5FA8-122B');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Recovery', () => {
  const buttonIn = (shell: AppShell, screen: string, label: string): HTMLElement => {
    const root = deepQuery(shell, screen)?.shadowRoot;
    const found = [...(root?.querySelectorAll('sq-button') ?? [])].find((b) => b.textContent?.includes(label));
    if (!(found instanceof HTMLElement)) throw new Error(`no button ${label}`);
    return found;
  };

  it('new device: new passkey, QR for the phone, smart delay with reasons, then the wallet opens', async () => {
    vi.useFakeTimers();
    try {
      const bridge = new FakeBridge({ delayMs: 0 });
      await bridge.login({ username: 'alice', password: 'demo' });
      const router = popupRouter();
      router.go('recovery-start', undefined);
      const shell = await mount(new AppShell(bridge, router));
      await vi.advanceTimersByTimeAsync(10);

      buttonIn(shell, 'sq-recovery-start-screen', 'Créer ma nouvelle passkey').click();
      await vi.advanceTimersByTimeAsync(10);
      expect(deepQuery(shell, 'sq-qr-code')).not.toBeNull();
      expect(deepText(shell)).toContain('A1B2-C3D4');

      // The phone signs and passes the KYC: the smart delay starts, with its reasons.
      await vi.advanceTimersByTimeAsync(3_100);
      expect(deepText(shell)).toContain('Délai de sécurité en cours');
      expect(deepText(shell)).toContain('Aucun signal particulier');

      await vi.advanceTimersByTimeAsync(31_000);
      buttonIn(shell, 'sq-recovery-start-screen', 'Finaliser').click();
      await vi.advanceTimersByTimeAsync(10);
      expect(deepText(shell)).toContain('Wallet récupéré');
      expect(deepText(shell)).toContain('Associer un téléphone de secours');
    } finally {
      vi.useRealTimers();
    }
  });

  it('existing device: alert on Home with the reasons, cancelled with the passkey', async () => {
    const bridge = await signedInBridge();
    bridge.simulateRecoveryElsewhere();
    const router = popupRouter();
    router.go('home', undefined);
    const shell = await mount(new AppShell(bridge, router));
    await settle();
    expect(deepText(shell)).toContain('Une récupération de votre wallet est en cours');
    expect(deepText(shell)).toContain('E5F6-0718');

    const alert = deepQuery(shell, 'sq-recovery-alert');
    const cancel = [...(alert?.shadowRoot?.querySelectorAll('sq-button') ?? [])].find((b) => b.textContent?.includes('Ce n’est pas moi'));
    if (!(cancel instanceof HTMLElement)) throw new Error('no cancel button');
    cancel.click();
    await settle();
    expect(deepText(shell)).not.toContain('Une récupération de votre wallet est en cours');
  });

  it('existing device: a contested recovery cannot be cancelled by the passkey alone', async () => {
    const bridge = await signedInBridge();
    bridge.simulateRecoveryElsewhere(true);
    const router = popupRouter();
    router.go('home', undefined);
    const shell = await mount(new AppShell(bridge, router));
    await settle();
    expect(deepText(shell)).toContain('Récupération contestée');
    expect(deepText(shell)).not.toContain('Ce n’est pas moi');
  });
});
