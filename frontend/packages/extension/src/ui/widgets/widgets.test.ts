import type { Reason } from '@sqw/types/Reason';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ready } from '../core/Widget';
import { newDemoAccount } from '../services/fake-world';
import { deepQuery, deepText, mount, settle } from '../testing/dom';
import './address-input/AddressInput';
import './button/Button';
import './amount-input/AmountInput';
import './asset-picker/AssetPicker';
import './balance-delta/BalanceDelta';
import './outcome-panel/OutcomePanel';
import './reason-list/ReasonList';
import './risk-badge/RiskBadge';
import './risk-explainer/RiskExplainer';

const create = <K extends keyof HTMLElementTagNameMap>(tag: K): HTMLElementTagNameMap[K] => document.createElement(tag);

afterEach(() => {
  document.body.innerHTML = '';
});

describe('sq-risk-badge', () => {
  it('never says "low risk" when nothing fired, only that nothing was detected', async () => {
    const el = create('sq-risk-badge');
    el.state = ready({ band: 'Low', score: 0 });
    await mount(el);
    expect(deepText(el)).toContain('Aucun signal détecté');
    expect(deepText(el)).not.toContain('Risque faible');
  });

  it('names the band in words, not only in colour', async () => {
    const el = create('sq-risk-badge');
    el.state = ready({ band: 'High', score: 60 });
    await mount(el);
    expect(deepText(el)).toContain('Risque élevé');
    expect(deepText(el)).toContain('60/100');
  });
});

describe('sq-reason-list', () => {
  it('lists reasons in French, heaviest first', async () => {
    const reasons: Reason[] = [
      { code: 'NEW_RECIPIENT', points: 20, message: '' },
      { code: 'MIXER_EXPOSURE', points: 40, message: '' },
    ];
    const el = create('sq-reason-list');
    el.state = ready(reasons);
    await mount(el);
    const items = Array.from(el.shadowRoot?.querySelectorAll('li') ?? []).map((li) => li.textContent ?? '');
    expect(items[0]).toContain('service de mixage');
    expect(items[1]).toContain('Premier envoi');
  });

  it('says so when nothing fired', async () => {
    const el = create('sq-reason-list');
    el.state = ready([]);
    await mount(el);
    expect(deepText(el)).toContain('Aucun signal');
  });
});

describe('sq-balance-delta', () => {
  it('shows before, after and the signed change', async () => {
    const el = create('sq-balance-delta');
    el.state = ready([{ symbol: 'USDC', decimals: 6, before: '0x12a05f200', after: '0x1270b0180' }]);
    await mount(el);
    expect(deepText(el)).toMatch(/5\s000 → 4\s950/);
    expect(deepText(el)).toContain('−50');
  });
});

describe('sq-asset-picker', () => {
  it('marks the selected asset and emits the chosen one', async () => {
    const el = create('sq-asset-picker');
    el.state = ready(newDemoAccount('0x1').balances);
    el.selected = null;
    await mount(el);
    const onSelect = vi.fn();
    el.addEventListener('asset-selected', (e) => onSelect(e instanceof CustomEvent ? e.detail : undefined));

    const buttons = Array.from(el.shadowRoot?.querySelectorAll('button') ?? []);
    expect(buttons[0]?.getAttribute('aria-checked')).toBe('true');
    buttons[1]?.click();

    expect(onSelect).toHaveBeenCalledWith('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  });
});

describe('sq-address-input', () => {
  it('flags a bad address only after the field is left', async () => {
    const el = create('sq-address-input');
    el.value = '0x123';
    await mount(el);
    const input = deepQuery<HTMLInputElement>(el.shadowRoot ?? el, 'input');
    expect(deepText(el)).not.toContain('Adresse invalide');

    input?.dispatchEvent(new Event('blur'));
    await el.updateComplete;

    expect(deepText(el)).toContain('Adresse invalide');
    expect(input?.getAttribute('aria-invalid')).toBe('true');
  });
});

describe('sq-amount-input', () => {
  it('shows the available balance, or the error when there is one', async () => {
    const el = create('sq-amount-input');
    el.symbol = 'USDC';
    el.available = '5 000';
    await mount(el);
    expect(deepText(el)).toContain('Disponible : 5 000 USDC');

    el.error = 'Solde insuffisant.';
    await el.updateComplete;
    expect(deepText(el)).toContain('Solde insuffisant.');
  });

  it('emits max-requested', async () => {
    const el = await mount(create('sq-amount-input'));
    const onMax = vi.fn();
    el.addEventListener('max-requested', onMax);
    deepQuery<HTMLButtonElement>(el.shadowRoot ?? el, '.max')?.click();
    expect(onMax).toHaveBeenCalledOnce();
  });
});

describe('sq-outcome-panel', () => {
  it('explains a regulatory refusal without saying what was flagged', async () => {
    const el = create('sq-outcome-panel');
    el.state = ready({ kind: 'refused', reason: 'regulatory' });
    await mount(el);
    await settle();
    const text = deepText(el);
    expect(text).toContain('Transaction refusée');
    expect(text).toContain('raisons réglementaires');
    expect(text).toContain("Vos fonds n'ont pas bougé");
    expect(text).not.toMatch(/sanction/i);
  });
});

describe('sq-button', () => {
  it('does not reach parent click handlers while disabled or busy', async () => {
    const el = create('sq-button');
    const onClick = vi.fn();
    el.addEventListener('click', onClick);
    await mount(el);

    el.disabled = true;
    el.click();
    el.disabled = false;
    el.busy = true;
    el.click();
    el.busy = false;
    el.click();

    expect(onClick).toHaveBeenCalledOnce();
  });
});

describe('sq-risk-explainer', () => {
  it('lays the score open: each signal with its weight, meaning and advice, and says the user decides', async () => {
    const el = create('sq-risk-explainer');
    el.state = ready({
      score: 60,
      band: 'High',
      reasons: [
        { code: 'NEW_RECIPIENT', points: 20, message: 'first interaction' },
        { code: 'MIXER_EXPOSURE', points: 40, message: 'counterparty is 1 hop(s) from a flagged address' },
      ],
      exposureHops: 1,
      balanceShare: 0.85,
    });
    await mount(el);
    const text = deepText(el);
    expect(text).toContain('Pourquoi cet avertissement ?');
    expect(text).toContain('Score 60/100');
    expect(text).toMatch(/\+40 pts · 67 %[\s\S]*\+20 pts · 33 %/);
    expect(text).toContain('Comparez l’adresse');
    expect(text).toContain('85 % de votre solde');
    expect(text).toContain('à 1 intermédiaire(s) d’une adresse signalée');
    expect(text).toContain('Vous décidez.');
  });

  it('closes on "J’ai compris"', async () => {
    const el = create('sq-risk-explainer');
    el.state = ready({ score: 0, band: 'Low', reasons: [], exposureHops: null, balanceShare: null });
    await mount(el);
    const closed = vi.fn();
    el.addEventListener('explainer-closed', closed);
    const button = [...(el.shadowRoot?.querySelectorAll('button') ?? [])].find((b) => b.textContent?.includes('compris'));
    button?.click();
    expect(closed).toHaveBeenCalledOnce();
  });
});
