# Ferrata Recovery (Expo Go)

App mobile du **téléphone de secours** : associé au wallet (sa clé est enregistrée dans Ferra chain
par la passkey du propriétaire), il approuve une récupération lancée sur un nouvel ordinateur. Il ne
détient jamais le wallet et ne peut pas déplacer de fonds ; Swissquote seul ne peut pas récupérer sans lui.

1. Connexion Swissquote (`alice` / `demo`).
2. **Associer** : dans l'extension, Réglages → Téléphone de secours affiche un QR. Le téléphone le scanne,
   crée sa clé (P-256, coffre sécurisé, biométrie) et l'envoie ; les deux écrans affichent la même
   **empreinte**, puis la passkey confirme dans l'extension.
3. **Approuver une récupération** : sur le nouvel ordinateur, « J'ai perdu ma passkey » crée une nouvelle
   passkey et affiche un QR. Le téléphone le scanne, montre l'empreinte de la nouvelle passkey (à comparer),
   puis la **vérification faciale** (simulée, optionnelle), le **document d'identité**, l'**identification
   vidéo simulée** (`kyc-pass` / `kyc-fail`) et la **signature** par la clé du téléphone (biométrie).
4. Le **délai intelligent** (raisons affichées) court ; l'ancienne passkey peut annuler. L'ordinateur
   finalise : sa nouvelle passkey devient la clé du wallet (même adresse, mêmes fonds).

La clé du téléphone n'est pas une vraie passkey FIDO (Expo Go n'y a pas accès) : elle signe au format
d'une assertion WebAuthn, celui que le backend vérifie pour une clé P-256 (`src/device/assertion.ts`,
vérifié côté Rust par `recovery_phone_assertion_verifies`).

Elle réutilise le SDK (`../sdk`) et les types du backend (`../types`) ; elle n'est pas dans les
workspaces npm (React Native et Vite ne partagent pas bien leurs dépendances).

## Lancer

```sh
cd frontend/packages/mobile
npm install
npm start
```

`npm start` lance `expo start --go`. Avec `npx expo start` tout court, vérifier que la dernière ligne dit
« Using Expo Go » ; sinon appuyer sur `s` avant de scanner.

Puis scanner le QR code avec **Expo Go** (Android : dans l'app ; iPhone : avec l'appareil photo).
Le téléphone et le PC doivent être sur **le même Wi-Fi**.

Le backend doit tourner sur le PC (`scripts\dev.cmd`, ou `cargo run -p sq-services` dans `backend/`).
L'app le trouve toute seule à l'adresse IP du PC, port 8787. Si Windows demande d'autoriser
`sq-services` sur le réseau privé, accepter.

### Sans backend

Créer `frontend/packages/mobile/.env.local` avec :

```
EXPO_PUBLIC_BRIDGE=fake
```

puis relancer `npx expo start`. Données simulées, délai de sécurité raccourci à 30 s.

### Autre adresse de backend

```
EXPO_PUBLIC_SQ_API_URL=http://192.168.1.20:8787
```

## Vérifier

```sh
npx tsc --noEmit
```
