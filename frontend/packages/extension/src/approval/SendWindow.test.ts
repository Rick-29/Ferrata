import { describe, expect, it } from 'vitest';
import { sendPreset } from './SendWindow';

describe('sendPreset', () => {
  it('keeps a well-formed recipient and amount from the website', () => {
    const to = `0x${'b'.repeat(40)}`;
    expect(sendPreset(`?send=1&to=${to}&amount=0.25`)).toEqual({ to, amount: '0.25' });
  });

  it('drops anything malformed rather than filling the form with it', () => {
    expect(sendPreset('?send=1&to=<script>&amount=1e9')).toEqual({ to: '', amount: '' });
    expect(sendPreset('?send=1')).toEqual({ to: '', amount: '' });
  });
});
