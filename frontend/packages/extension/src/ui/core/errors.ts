// What the background hands the UI: a code and whether retrying makes sense.
// P2 owns the user-facing text, kept in one table below.
export interface UiError {
  readonly code: string;
  readonly retryable: boolean;
}

const MESSAGES: Readonly<Record<string, string>> = {
  SQ_UNAUTHORIZED: 'Identifiants invalides ou session expirée.',
  SQ_BAD_REQUEST: 'La demande est invalide.',
  SQ_NOT_FOUND: 'Élément introuvable.',
  SQ_CONFLICT: 'Cette action a déjà été traitée.',
  SQ_CHAIN_INSUFFICIENT_BALANCE: 'Solde insuffisant.',
  SQ_CHAIN_BAD_NONCE: 'La transaction est périmée, réessayez.',
  SQ_CHAIN_ESCAPE_LOCKED: 'La sortie de secours est encore verrouillée.',
  CORE_SEQ_GAP: "Le journal d'audit n'est pas synchronisé.",
  CORE_CHAIN_BROKEN: "Le journal d'audit a été altéré.",
  CORE_BAD_RECEIPT: 'Reçu Swissquote invalide.',
  PASSKEY_CANCELLED: 'Signature annulée.',
  PASSKEY_UNSUPPORTED: 'Ce navigateur ne prend pas en charge les passkeys.',
  CHAIN_UNAVAILABLE: 'Réseau indisponible.',
  UI_INVALID_ADDRESS: 'Adresse invalide.',
  UI_INVALID_AMOUNT: 'Montant invalide.',
};

const FALLBACK = 'Une erreur inattendue est survenue.';

export function errorMessage(error: UiError): string {
  return MESSAGES[error.code] ?? FALLBACK;
}

export const uiError = (code: string, retryable = false): UiError => ({ code, retryable });
