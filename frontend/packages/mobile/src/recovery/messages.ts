import type { SdkError } from '@sqw/sdk';

// User-facing text for errors, same wording as the extension's table (ui/core/errors.ts).

const MESSAGES: Readonly<Record<string, string>> = {
  UNAUTHORIZED: 'Identifiants invalides ou session expirée.',
  NOT_FOUND: "Ce wallet n'existe pas sur la chaîne Ferra. Vérifiez l'adresse.",
  CONFLICT: 'Une récupération est déjà en cours pour ce wallet, ou le délai de sécurité n’est pas écoulé.',
  BAD_REQUEST: 'La demande est invalide.',
  BIOMETRY_CANCELLED: 'Vérification annulée. Réessayez avec Face ID, votre empreinte ou votre code.',
  BIOMETRY_UNAVAILABLE: 'Activez un code de déverrouillage (et si possible Face ID ou l’empreinte) sur ce téléphone.',
  BIOMETRY_FAILED: 'La vérification biométrique a échoué. Réessayez.',
  DEVICE_KEY_FAILED: 'Impossible de créer la clé sur ce téléphone.',
  UNREACHABLE: 'Le service Swissquote est injoignable. Le téléphone et le PC sont-ils sur le même Wi-Fi ?',
};

export function errorMessage(error: SdkError): string {
  return MESSAGES[error.code] ?? `Erreur inattendue (${error.code}).`;
}
