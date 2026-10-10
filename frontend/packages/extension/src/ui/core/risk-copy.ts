import type { ReasonCode } from '@sqw/types/ReasonCode';
import type { RiskBand } from '@sqw/types/RiskBand';

// User-facing wording for risk. The backend's English `message` is for logs; P2 owns this text.

export const BAND_LABELS: Readonly<Record<RiskBand, string>> = {
  Low: 'Risque faible',
  Medium: 'Risque modéré',
  High: 'Risque élevé',
  Critical: 'Risque critique',
};

export const REASON_LABELS: Readonly<Record<ReasonCode, string>> = {
  UNKNOWN_ASSET: 'Actif non reconnu',
  UNKNOWN_ORIGIN: 'Site non vérifié',
  LARGE_AMOUNT: 'Montant inhabituellement élevé',
  NEW_RECIPIENT: 'Premier envoi à cette adresse',
  UNLIMITED_APPROVAL: 'Autorisation de dépense illimitée',
  PERMIT_SIGNATURE: "Signature d'autorisation (permit)",
  // Deliberately vague: a regulatory refusal must not tell the client what was flagged.
  SANCTIONED: 'Motif réglementaire',
  MIXER_EXPOSURE: 'Destinataire lié à un service de mixage',
  SIMULATED_DRAIN: 'La simulation vide votre compte',
  OWN_LIMIT_EXCEEDED: 'Au-dessus de la limite que vous avez fixée',
};

export const bandColor = (band: RiskBand): string => `var(--sq-risk-${band.toLowerCase()})`;
