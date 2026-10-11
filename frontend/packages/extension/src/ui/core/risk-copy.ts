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
  // Self-custody: the user decides, so they must know why. Sanctions lists are public; this says
  // nothing about any report Swissquote may file (no tipping-off).
  SANCTIONED: 'Adresse sur une liste de sanctions',
  MIXER_EXPOSURE: 'Destinataire lié à un service de mixage',
  SIMULATED_DRAIN: 'La simulation vide votre compte',
  OWN_LIMIT_EXCEEDED: 'Au-dessus de la limite que vous avez fixée',
};

/** The pop-up "Pourquoi cet avertissement ?": what each signal means and what to do about it. */
export interface ReasonExplainer {
  readonly why: string;
  readonly advice: string;
}

export const REASON_EXPLAINERS: Readonly<Record<ReasonCode, ReasonExplainer>> = {
  UNKNOWN_ASSET: {
    why: 'Ce jeton ne figure pas dans la liste des actifs connus de Swissquote : il peut s’agir d’une imitation sans valeur.',
    advice: 'Vérifiez l’adresse du contrat du jeton auprès d’une source officielle.',
  },
  UNKNOWN_ORIGIN: {
    why: 'La demande vient d’un site que Swissquote ne connaît pas. Les faux sites copient souvent de vrais services.',
    advice: 'Vérifiez l’adresse du site dans la barre du navigateur avant de signer.',
  },
  LARGE_AMOUNT: {
    why: 'Le montant dépasse le seuil au-delà duquel une vérification supplémentaire est demandée.',
    advice: 'Assurez-vous que le montant est bien celui prévu, et envisagez un premier petit envoi de test.',
  },
  NEW_RECIPIENT: {
    why: 'Vous n’avez jamais envoyé de fonds à cette adresse. Les arnaques passent souvent par une adresse nouvelle ou modifiée.',
    advice: 'Comparez l’adresse caractère par caractère avec celle de votre destinataire, par un autre canal que celui du message reçu.',
  },
  UNLIMITED_APPROVAL: {
    why: 'Vous autorisez un contrat à dépenser tout votre solde de ce jeton, maintenant et plus tard, sans nouvelle signature.',
    advice: 'Préférez une autorisation limitée au montant nécessaire.',
  },
  PERMIT_SIGNATURE: {
    why: 'Cette signature donne une autorisation de dépense sans transaction visible : c’est une technique fréquente de vol.',
    advice: 'Ne signez que si vous savez exactement à quel service vous donnez cette autorisation.',
  },
  SANCTIONED: {
    why: 'Cette adresse figure sur une liste de sanctions publique (par exemple SECO, ONU, OFAC). Y envoyer des fonds peut être illégal.',
    advice: 'Ne poursuivez pas sauf si vous êtes certain de la légalité de l’opération. La décision et sa responsabilité vous reviennent.',
  },
  MIXER_EXPOSURE: {
    why: 'Le destinataire est proche, dans le graphe des transactions, d’une adresse signalée (service de mixage, fraude…).',
    advice: 'Demandez-vous d’où viennent et où vont ces fonds. En cas de doute, n’envoyez pas.',
  },
  SIMULATED_DRAIN: {
    why: 'La simulation montre que cette opération viderait votre compte, ce qui est typique d’un contrat malveillant.',
    advice: 'N’envoyez pas si ce n’est pas exactement ce que vous voulez faire.',
  },
  OWN_LIMIT_EXCEEDED: {
    why: 'Le montant dépasse la limite par transaction que vous avez vous-même fixée dans vos réglages.',
    advice: 'Si c’est voulu, continuez ; sinon, réduisez le montant.',
  },
};

/** Score scale from fixtures/policy.json (thresholds medium 25, high 50, critical 80). */
export const SCORE_SCALE: readonly { readonly band: RiskBand; readonly from: number }[] = [
  { band: 'Low', from: 0 },
  { band: 'Medium', from: 25 },
  { band: 'High', from: 50 },
  { band: 'Critical', from: 80 },
];

export const bandColor = (band: RiskBand): string => `var(--sq-risk-${band.toLowerCase()})`;
