import type { AccountView } from '@sqw/types/AccountView';
import type { DecodedAction } from '@sqw/types/DecodedAction';
import type { OutcomeKind } from '@sqw/types/OutcomeKind';
import type { Reason } from '@sqw/types/Reason';
import type { RiskAssessment } from '@sqw/types/RiskAssessment';
import type { RiskBand } from '@sqw/types/RiskBand';
import type { SignedEntry } from '@sqw/types/SignedEntry';
import type { SendDraft } from './UiBridge';

// Mirrors fixtures/ (demo-seed, policy, sanctions, exposure-graph) so the fake and the real
// backend score the same addresses the same way. Mock data, demo only.

export const USDC = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
export const USDC_DECIMALS = 6;
export const ETH_DECIMALS = 18;

export const DEMO_ADDRESSES = {
  knownMerchant: '0x00000000000000000000000000000000000000aa',
  sanctioned: '0x000000000000000000000000000000000000dead',
  mixerExposed: '0x0000000000000000000000000000000000c0ffee',
} as const;

export const DEMO_CLIENTS: Readonly<Record<string, { clientId: string; displayName: string }>> = {
  alice: { clientId: 'SQ-100001', displayName: 'Alice Keller' },
  mallory: { clientId: 'SQ-100002', displayName: 'Mallory (attacker persona)' },
};
export const DEMO_PASSWORD = 'demo';

const LARGE_AMOUNT_LIMIT = 1_000n * 10n ** BigInt(USDC_DECIMALS);
const BAND_THRESHOLDS = { medium: 25, high: 50, critical: 80 } as const;
/** Reasons that trigger a regulatory refusal. Everything else only warns: Swissquote never blocks on risk alone. */
const REGULATORY_REASONS: ReadonlySet<Reason['code']> = new Set(['SANCTIONED']);

export const GENESIS_HEAD = `0x${'0'.repeat(64)}`;

export const toHex = (value: bigint): string => `0x${value.toString(16)}`;

/** Deterministic fake 32-byte hash, good enough to tell entries apart in the UI. */
export const fakeHash = (seed: number): string => `0x${seed.toString(16).padStart(64, 'f')}`;

export const nowSecs = (): number => Math.floor(Date.now() / 1000);

export function newDemoAccount(ownerKey: string): AccountView {
  return {
    address: '0x5a11e7000000000000000000000000000000a11c',
    owner: { kind: 'ed25519', key: ownerKey },
    cosigner: 'dcbdece0aaa41985309f5461fdc18ae2556c38f1e4db77083e2e32c605bad402',
    nonce: 0,
    balances: [
      { asset: null, symbol: 'ETH', decimals: ETH_DECIMALS, amount: toHex(10n ** 18n) },
      { asset: USDC, symbol: 'USDC', decimals: USDC_DECIMALS, amount: toHex(5_000n * 10n ** 6n) },
    ],
    escape: { state: 'inactive' },
    created_block: 1,
  };
}

function bandFor(score: number): RiskBand {
  if (score >= BAND_THRESHOLDS.critical) return 'Critical';
  if (score >= BAND_THRESHOLDS.high) return 'High';
  if (score >= BAND_THRESHOLDS.medium) return 'Medium';
  return 'Low';
}

export interface DraftScore {
  readonly assessment: RiskAssessment;
  readonly sanctionsHit: boolean;
  readonly exposureHops: number | null;
}

/** Same rules as the README's demo table. */
export function scoreDraft(draft: SendDraft): DraftScore {
  const to = draft.to.toLowerCase();
  const reasons: Reason[] = [];

  if (to === DEMO_ADDRESSES.sanctioned) {
    reasons.push({ code: 'SANCTIONED', points: 100, message: 'Recipient is on a sanctions list' });
  }
  if (to === DEMO_ADDRESSES.mixerExposed) {
    reasons.push({ code: 'MIXER_EXPOSURE', points: 40, message: 'Recipient is 2 hops from a known mixer' });
  }
  if (to !== DEMO_ADDRESSES.knownMerchant) {
    reasons.push({ code: 'NEW_RECIPIENT', points: 20, message: 'First transfer to this address' });
  }
  if (draft.asset === USDC && BigInt(draft.amount) > LARGE_AMOUNT_LIMIT) {
    reasons.push({ code: 'LARGE_AMOUNT', points: 25, message: 'Amount above your usual limit' });
  }

  const score = Math.min(100, reasons.reduce((sum, r) => sum + r.points, 0));
  return {
    assessment: { score, band: bandFor(score), reasons },
    sanctionsHit: to === DEMO_ADDRESSES.sanctioned,
    exposureHops: to === DEMO_ADDRESSES.mixerExposed ? 2 : null,
  };
}

export function actionFor(draft: SendDraft): DecodedAction {
  return draft.asset === null
    ? { kind: 'native_transfer', to: draft.to, amount: draft.amount }
    : { kind: 'erc20_transfer', token: draft.asset, to: draft.to, amount: draft.amount };
}

export type FakeDecision =
  | { readonly kind: 'cosign' }
  | { readonly kind: 'confirm'; readonly level: 'standard' | 'high_risk' }
  | { readonly kind: 'refuse_regulatory' };

/**
 * Swissquote's co-signer: refuses only for a regulatory reason; otherwise asks for a double
 * confirmation on Medium and above (with an explicit risk warning from High), then co-signs.
 */
export function decide(assessment: RiskAssessment, stepUp: boolean): FakeDecision {
  if (assessment.reasons.some((r) => REGULATORY_REASONS.has(r.code))) return { kind: 'refuse_regulatory' };
  if (assessment.band === 'Low' || stepUp) return { kind: 'cosign' };
  return { kind: 'confirm', level: assessment.band === 'Medium' ? 'standard' : 'high_risk' };
}

export function loggedOutcome(decision: FakeDecision): OutcomeKind {
  switch (decision.kind) {
    case 'cosign':
      return 'cosigned';
    case 'confirm':
      return 'step_up';
    case 'refuse_regulatory':
      return 'refused';
  }
}

export interface EntryInput {
  readonly seq: number;
  readonly prevHead: string;
  readonly userOpHash: string;
  readonly action: DecodedAction;
  readonly assessment: RiskAssessment;
  readonly outcome: OutcomeKind;
  readonly stepUp: boolean;
}

export function signedEntry(input: EntryInput): SignedEntry {
  const timestamp = nowSecs();
  const entryHash = fakeHash(1_000 + input.seq);
  return {
    entry: {
      seq: input.seq,
      prev_head: input.prevHead,
      user_op_hash: input.userOpHash,
      action: input.action,
      assessment: input.assessment,
      outcome: input.outcome,
      step_up: input.stepUp,
      warnings: [],
      timestamp,
    },
    entry_hash: entryHash,
    receipt: {
      entry_hash: entryHash,
      prev_head: input.prevHead,
      seq: input.seq,
      band: input.assessment.band,
      user_op_hash: input.userOpHash,
      timestamp,
      signature: `0x${'ab'.repeat(64)}`,
    },
  };
}
