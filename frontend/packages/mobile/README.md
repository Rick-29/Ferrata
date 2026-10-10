# Ferrata Recovery (Expo Go)

App mobile de **récupération de wallet** : le téléphone est le nouvel appareil d'un client qui a
perdu sa passkey. Elle fait une seule chose :

1. Connexion Swissquote (`alice` / `demo`).
2. Adresse du wallet à récupérer (copiable dans les Réglages de l'extension).
3. Nouvelle passkey créée sur le téléphone (passkey de démo `/dev/passkeys` tant que WebAuthn n'est pas branché).
4. **Identification vidéo simulée** : titulaire (`kyc-pass`) ou attaquant (`kyc-fail`, rejeté).
5. Délai de sécurité (2 min en démo) : les autres appareils peuvent annuler.
6. Finaliser : Swissquote fait tourner la clé ; la passkey du téléphone devient la clé du wallet.

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
