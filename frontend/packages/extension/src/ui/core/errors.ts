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
  SQ_ANALYSIS_UNAVAILABLE: 'L’analyse de risque Swissquote ne répond pas. Vous pouvez réessayer, ou envoyer sans analyse : votre passkey suffit.',
  SQ_CHAIN_BAD_NONCE: 'La transaction est périmée, réessayez.',
  SQ_CHAIN_ESCAPE_LOCKED: 'La sortie de secours est encore verrouillée.',
  CORE_SEQ_GAP: "Le journal d'audit n'est pas synchronisé.",
  CORE_CHAIN_BROKEN: "Le journal d'audit a été altéré.",
  CORE_BAD_RECEIPT: 'Reçu Swissquote invalide.',
  PASSKEY_CANCELLED: 'Signature annulée.',
  PASSKEY_UNKNOWN: 'Passkey introuvable sur cet appareil. Reconnectez-vous pour en créer une.',
  PASSKEY_FAILED: 'La passkey n’a pas pu signer. Réessayez.',
  PASSKEY_UNSUPPORTED: 'Ce navigateur ne prend pas en charge les passkeys.',
  PASSKEY_UNAVAILABLE: 'Passkey introuvable sur cet appareil, ou fenêtre du wallet fermée. Rouvrez le wallet et réessayez.',
  UI_LOCKED: 'Wallet verrouillé : confirmez avec votre passkey pour continuer.',
  RECOVERY_PASSKEY_PRESENT: 'Cet appareil a encore votre passkey : déverrouillez le wallet au lieu de le récupérer.',
  RECOVERY_NOT_READY: 'Le délai de sécurité n’est pas encore écoulé.',
  RECOVERY_CONTESTED: 'Récupération contestée : votre passkey seule ne peut plus l’annuler. Contactez Swissquote.',
  CHAIN_UNAVAILABLE: 'Réseau indisponible.',
  UI_INVALID_ADDRESS: 'Adresse invalide.',
  UI_INVALID_AMOUNT: 'Montant invalide.',
  UI_BAD_REQUEST: 'La demande est invalide.',
  UI_FORBIDDEN: 'Action non autorisée.',
  UI_INTERNAL: "Erreur interne de l'extension.",
  UI_BACKGROUND_UNAVAILABLE: "Le service de l'extension ne répond pas. Rechargez l'extension.",
  UI_INVALID_SETTINGS: 'Réglages invalides : les pourcentages doivent être entre 0 et 100.',
  SQ_UNREACHABLE: 'Le service Swissquote est injoignable.',
  SQ_CHAIN_BAD_OWNER_SIGNATURE: 'Signature de la passkey refusée.',
  SQ_CHAIN_BAD_COSIGNATURE: 'Reçu d’analyse Swissquote invalide.',
  SQ_CORE_SEQ_GAP: "Le journal d'audit n'est pas synchronisé. Recommencez l'envoi.",
  TESTNET_FAUCET_LIMIT:
    'Le faucet public de Solana devnet refuse pour le moment (limite atteinte). Réessayez plus tard ou utilisez faucet.solana.com.',
  TESTNET_UNAVAILABLE: 'Le réseau de test ne répond pas. Réessayez dans un instant.',
  TESTNET_RPC_ERROR: 'Le réseau de test a refusé la demande.',
  TESTNET_SEND_FAILED: 'Le réseau de test a refusé la transaction (solde insuffisant, ou montant trop faible pour un nouveau compte).',
  TESTNET_GASLESS_OFF: 'Les envois sans gas ne sont pas configurés sur cet appareil (clé Pimlico absente).',
  TESTNET_NO_FAUCET_API: "Ce réseau n'a pas de faucet automatique : utilisez le bouton « Ouvrir le faucet ».",
};

const FALLBACK = 'Une erreur inattendue est survenue.';

export function errorMessage(error: UiError): string {
  return MESSAGES[error.code] ?? FALLBACK;
}

export const uiError = (code: string, retryable = false): UiError => ({ code, retryable });
