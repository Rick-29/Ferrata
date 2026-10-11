# Ferrata : analyse du dépôt avant le pitch

> **Mise à jour après le pull de `50fecc5` (11 octobre 2026).** Plusieurs constats ci-dessous sont dépassés :
> - **Self-custody** : la passkey seule autorise un transfert sur la chaîne Ferra ; la signature de Swissquote devient un reçu d'analyse facultatif (`sq-adapters/src/chain/ledger.rs`, commit `049f55a`).
> - **Récupération** : téléphone de récupération enregistré sur le compte ; la rotation exige la signature du téléphone **et** l'attestation KYC de Swissquote, vérifiées par la chaîne ; délai intelligent (1 à 7 jours selon l'historique) ; annulation par l'appareil actuel, sauf récupération « contestée » (`sq-services/src/recovery.rs`, test `owner_rotation_needs_the_recovery_key_and_swissquote_and_old_owner_stops_working`). L'écart « Swissquote seule peut remplacer la clé » est **corrigé**.
> - **Écran d'annulation** dans l'extension, alerte sur l'ancien appareil : **présent**.
> - **Testnets** : envois signés et diffusés sur Ethereum Sepolia, Base Sepolia (viem) et Solana devnet ; clés réseau scellées par une clé AES-GCM non extractable, déverrouillées par la passkey (commits `613a936`, `f619139`). Ce sont des comptes classiques : les règles de compte (clé de récupération, délai) restent sur la chaîne Ferra.
> - **dApps** : fournisseur EIP-1193 / EIP-6963, origine prise de l'expéditeur, proxy RPC en lecture seule ; **signatures refusées aux dApps tierces** en attendant la fenêtre d'approbation. Bonus partiel.
> - **Sanctions** : plus de refus ; avertissement le plus fort et décision enregistrée (`sq-services/src/assess.rs`). À valider avec la conformité.
> - **Gasless** : toujours absent (`faucet-relay` = faucet, pas paymaster).
> - Nouvelle faiblesse : après une annulation, une récupération relancée est « contestée » et l'ancienne passkey ne peut plus l'annuler ; le KYC (simulé) reste la dernière barrière.
>
> Vérifié par lecture du code ; tests non relancés après le pull.

---

Relevé sur `main` (commit `2d51006`), le 11 octobre 2026. Aucun code modifié pour ce document.

Légende : ✅ réel et vérifié · 🟣 simulé (étiqueté) · ⬜ prévu mais absent · ⚠️ écart ou problème.

« Vérifié » veut dire : lu dans le code **et** couvert par un test ou un essai fait pendant le
projet. Ce qui est seulement lu dans le code est indiqué comme tel.

---

## 0. Où sont les choses

Le brief parle de `docs/`, `rust/`, `ts/` : ces dossiers n'existent pas. La correspondance réelle :

| Brief | Dépôt | Contenu |
| --- | --- | --- |
| `rust/` | `backend/` | Workspace Rust : `wallet-core`, `sq-adapters` (pseudo-chaîne), `sq-services` (API Axum :8787), `api-types`, `ferra-verify`, `wallet-wasm`, connecteurs `sq-conn-{btc,evm,sol,ton}` |
| `ts/` | `frontend/` | Workspace npm : `packages/extension` (Lit, MV3), `sdk`, `types` (générés), `brand` ; à part : `mobile` (Expo), `web` (React) |
| — | `app/` | Visualiseur de chaîne (Tauri + React), par Rick |
| `docs/` | `implementation/`, `backend_timeline.md`, `future_implementation.md`, `frontend_tasks.md`, `testnet_plan.md` | Specs et suivi |
| `CLAUDE.md` | **absent du dépôt** | Le texte existe (collé en conversation) mais n'est pas commité. `app/CLAUDE.md` ne fait que renvoyer à `app/AGENTS.md` (consignes Figma Make) |

---

## 1. Ce qui est réellement implémenté et fonctionne

### Backend (P1) : `backend/`

| Fonction | Preuve | État |
| --- | --- | --- |
| Compte « 2 sur 2 » : aucune transaction sans signature du propriétaire **et** de Swissquote | `sq-adapters/src/chain/ledger.rs` (`authorize`), test listé dans `backend_timeline.md` | ✅ |
| Le serveur recalcule le risque et le `user_op_hash`, ne fait pas confiance au client | `sq-services/src/assess.rs` (`cosign`) | ✅ |
| Jamais de blocage pour risque : moyen → 2e signature ; élevé/critique → avertissement + acceptation explicite + 2e signature ; seul refus : sanctions (raison non divulguée) | `assess.rs`, `implementation/…Positionnement légal du blocage.md` | ✅ |
| Signatures propriétaire WebAuthn P-256 vérifiées (type `webauthn.get`, challenge = hash, DER) | `sq-adapters/src/chain/auth.rs` (`verify_owner`) | ✅ (testé avec un authentificateur logiciel, ⚠️ pas depuis un vrai navigateur) |
| Journal d'audit chaîné par hash, reçus signés par Swissquote, ancrage du journal sur la chaîne | `sq-services/src/log.rs`, `reconcile.rs` | ✅ |
| Pseudo-chaîne « Ferra » infalsifiable : blocs signés, rejeu et vérification au démarrage, `/chain/verify`, `/dev/tamper` pour la démo | `sq-adapters/src/chain/`, `ferra-verify/` | ✅ |
| Sortie de secours (escape hatch) : propriétaire seul, délai, adresse de sortie fixée au départ, sans Swissquote | `ledger.rs` (`start_escape_hatch`, `escape_delay_secs`), routes `chain.rs` `/chain/escape/*` | ✅ côté backend |
| Récupération : démarrage → délai → annulation par l'appareil actuel → exécution (rotation du propriétaire) | `sq-services/src/recovery.rs` | ✅ (testé contre le vrai backend : attaquant refusé, exécution anticipée refusée, exécution après délai) |
| Sessions par jeton Bearer, wallets liés au client qui les a créés | `sq-services/src/auth.rs`, `state.rs::check_owner` | ✅ |
| Revue de compte, rapports d'adresses, validateur, modèle de risque (régression logistique, **poids fixés à la main**) | `review.rs`, `reports.rs`, `validator.rs`, `backend/features.md` | ✅ (modèle non entraîné) |
| Tests : le README annonce 147 tests `cargo test --workspace` | `README.md` | non relancé pour ce document |

### Extension Chrome (P2) : `frontend/packages/extension`

| Fonction | Preuve | État |
| --- | --- | --- |
| Écrans : création du wallet, accueil, envoi, confirmation, activité, réglages | `src/popup/main.ts`, `src/ui/` | ✅ |
| Chaîne popup → background (service worker) → SDK → backend ; jeton de session gardé dans le background | `src/background/SwissquoteBridge.ts`, `dispatch.ts` | ✅ |
| Vraies passkeys WebAuthn (P-256, vérification utilisateur obligatoire) | `src/passkey/webauthn.ts`, `src/background/WebAuthnPasskeySigner.ts` | ✅ (e2e contre le vrai backend avec un authentificateur logiciel) · ⚠️ pas encore essayé dans un vrai Chrome |
| Avertissement + double confirmation sur risque élevé, refus réglementaire sans raison | `src/ui/widgets/risk-warning`, `outcome-panel` | ✅ |
| Tests : 87 réussis, 7 e2e ignorés par défaut ; `tsc --noEmit` propre | `npm test`, `npm run typecheck` | ✅ (lancés le 11/10) |

### Appli mobile de récupération (P2) : `frontend/packages/mobile`

| Fonction | Preuve | État |
| --- | --- | --- |
| Invite biométrique du téléphone (Face ID / empreinte / code) | `src/device/biometrics.ts` (`expo-local-authentication`) | ✅ |
| Nouvelle clé propriétaire P-256 créée sur le téléphone, gardée dans le Keychain / Keystore, jamais envoyée | `src/device/deviceKey.ts` (`@noble/curves`, `expo-secure-store`) | ✅ |
| Parcours connexion → wallet → identité → délai → finalisation, branché sur `/recovery/*` | `src/recovery/HttpRecoveryService.ts`, `useRecoveryFlow.ts` | ✅ (⚠️ `.env.local` est en mode démo `EXPO_PUBLIC_BRIDGE=fake`) |
| Caméra réelle (visage, document), téléversement depuis la galerie | `src/screens/FaceCheck.tsx`, `src/screens/document/DocumentCapture.tsx` | ✅ |
| Lecture de la bande MRZ avec vérification des chiffres de contrôle ICAO, âge ≥ 18, validité, type de document | `src/identity/mrz.ts`, `checks.ts`, tests `mrz.test.mjs` (10/10, dont les spécimens officiels ICAO) | ✅ |
| Photos effacées à la fin, rien d'envoyé | `src/screens/document/DocumentCheck.tsx` | ✅ (lu dans le code) |

### Autres

| Pièce | Preuve | État |
| --- | --- | --- |
| Visualiseur de chaîne (Tauri), connecté au backend sur `localhost:8787` | `app/src/screens/OpenScreen.tsx`, `app/src-tauri/` | ✅ (compilé et lancé le 11/10) |
| Site web : vitrine, connexion, profil, tableau de bord | `frontend/packages/web/` | ✅ en interface seulement (données de démo) |
| Scripts d'installation et de lancement (Windows, macOS, Linux) | `scripts/` | ✅ |

---

## 2. Ce qui est simulé

| Élément | Où | Étiqueté ? |
| --- | --- | --- |
| **La blockchain elle-même** : « Ferra » est une pseudo-chaîne en Rust, pas un réseau public ; pas de contrat ERC-4337 | `sq-adapters/src/chain/` | oui (README, specs) |
| **KYC / identification vidéo** : le client choisit lui-même l'issue (`kyc-pass` / `kyc-fail`) | `recovery.rs` (`kyc_scripts`), `fixtures/` | oui (« Identification vidéo simulée ») |
| Analyse du visage (vivacité), comparaison photo du document ↔ visage | `mobile/src/screens/FaceCheck.tsx`, `DocumentScan.tsx` | oui (« simulé » sur chaque ligne) |
| Lecture de la puce NFC | `mobile/src/screens/document/DocumentCheck.tsx` | oui |
| Passkeys de démo (clé Ed25519 gardée **par le serveur**) | `sq-services/src/dev.rs`, extension avec `VITE_PASSKEY=dev` | oui (« Passkey simulée · démo ») |
| Données du site web | `web/src/data/demo.ts` | oui |
| Liste de sanctions, graphe d'exposition, comptes de démo | `fixtures/` | oui (README) |
| Poids du modèle de risque (fixés à la main, non entraînés) | `fixtures/model.json`, `backend/features.md` | oui (doc) |

---

## 3. Prévu mais absent

| Prévu | Source | État |
| --- | --- | --- |
| Vraie chaîne (Base Sepolia, compte ERC-4337 audité, paymaster) | `Middleware Spec.md` (« hour-1 spike »), `future_implementation.md` §2 | ⬜ |
| **Gasless réel** (paymaster) | Middleware Spec | ⬜ : il n'y a pas de gaz sur la pseudo-chaîne ; le badge « frais pris en charge » de l'extension (`GaslessBadge.ts`) décrit une intention, pas un paymaster |
| **Fournisseur pour les dApps (EIP-1193)** + fenêtre d'approbation | Middleware Spec (`src/inpage/`, `src/content/`) | ⬜ : aucun script injecté, aucune fenêtre d'approbation |
| Module WASM dans le front (`core-wasm`) | Rust Spec, Middleware Spec | ⬜ : `wallet-wasm` existe, jamais compilé vers le front |
| Écran d'annulation d'une récupération | route `/recovery/{id}/cancel` existe | ⬜ aucun écran ne l'appelle |
| Bouton « sortie de secours » | routes `/chain/escape/*` existent | ⬜ aucun écran ne l'appelle |
| Plusieurs appareils / plusieurs clés propriétaires | discussion d'équipe | ⬜ un seul propriétaire par compte |
| Rôle conformité (réserver `/reconcile`, `/review`, `/dev`) | `backend_timeline.md` « Next » | ⬜ |
| Synchro automatique des connecteurs BTC / EVM / SOL / TON | `backend_timeline.md` « Next » | ⬜ (connecteurs codés) |
| Notifications | Frontend Spec | ⬜ |

---

## 4. Écarts entre la documentation et le code

| Documentation | Code | Gravité |
| --- | --- | --- |
| `CLAUDE.md` : « Swissquote seule ne peut jamais remplacer la clé du client » | `recovery.rs::execute` : après le délai, **la co-signature de Swissquote suffit** à faire la rotation (`rotate_owner`). Le KYC est un script choisi par le client | ⚠️ critique pour la note custody |
| `CLAUDE.md` : « Le délai de récupération est imposé par le contrat, pas par le serveur » | Le délai de récupération est dans `sq-services` (map `recoveries` **en mémoire**, perdue au redémarrage). Celui de la sortie de secours, lui, est bien dans la chaîne (`ledger.rs`) | ⚠️ |
| `README.md` : « recoverable through a timelocked, cancellable flow » | Vrai côté API, mais aucune interface ne permet d'annuler | ⚠️ |
| README / specs : « co-signed by Swissquote » | L'interface dit désormais « double signature » (choix de vocabulaire) | info |
| Middleware Spec : monorepo **pnpm** dans `ts/`, `viem`, WASM, P3 seul à faire `fetch` | Workspace **npm** dans `frontend/`, pas de `viem`, pas de WASM, le SDK fait les `fetch` | info |
| Frontend Spec : UI en Lit | Extension en Lit ✅ ; mobile (React Native) et web (React) ne sont pas en Lit | info |
| `CLAUDE.md` : « jamais de travail direct sur `main` » | Une partie du travail a été poussée directement sur `main` | info process |
| `backend_timeline.md` : WebAuthn « ⬜ from a real browser » | Toujours vrai | ⚠️ à tester avant la démo |
| Bug connu | `/wallet/overview` dérive l'adresse de la clé propriétaire : après une récupération, le wallet n'est plus retrouvé | ⚠️ casse la fin de la démo |
| Hygiène | `server.log` et `validator-testnet.log` commités à la racine | mineur |

---

## 5. Le cycle de vie, étape par étape

| Étape | État | Détail |
| --- | --- | --- |
| **Créer** | ✅ | Extension : passkey WebAuthn → `/ownership/challenge` → `/wallet/register`. Une adresse par chaîne |
| **S'authentifier** | ✅ / 🟣 | Session par identifiant et mot de passe de démo (`alice` / `demo`) ; chaque opération est signée par la passkey (biométrie de l'appareil) |
| **Signer et envoyer** | ✅ | `/assess` → `/cosign` (avertissement, double confirmation, refus réglementaire) → signature passkey → `/chain/submit`. Pas de gaz (pseudo-chaîne) ; pas de dApps |
| **Perdre l'accès** | ⚠️ | Un seul appareil propriétaire. Aucune interface pour annuler une récupération frauduleuse ni pour lancer la sortie de secours |
| **Récupérer** | ✅ / 🟣 / ⚠️ | Mobile : nouvelle clé sur le téléphone + biométrie (réel) → vérification du visage et du document (en partie simulée) → KYC (simulé) → délai 120 s (serveur) → Swissquote fait la rotation seule. Puis l'extension ne retrouve plus le wallet (bug `/wallet/overview`) et ne détient plus la clé |

---

## 6. Décisions d'architecture

| Sujet | Décidé dans le code | Encore ouvert |
| --- | --- | --- |
| **Signataires** | 2 sur 2 : une clé propriétaire (passkey P-256 ou Ed25519 de démo) + la co-signature Swissquote (Ed25519) | Plusieurs appareils propriétaires ; secp256k1 pour une vraie chaîne |
| **Guardians** | Aucun. Le seul « garant » de la récupération est le KYC de Swissquote (simulé) | Qui garde la clé de secours (puce de la carte d'identité, appareils supplémentaires, proches) : solution en cours chez un membre de l'équipe |
| **Annulation** | Toute signature de la clé propriétaire actuelle annule une récupération en attente (`cancel_hash`) | Pas d'interface. Le `CLAUDE.md` demande qu'« un téléphone volé ne suffise pas » : aujourd'hui, l'appareil volé peut annuler une récupération légitime |
| **Délai** | 120 s en démo (`fixtures/demo-seed.json`) pour la récupération et la sortie de secours | Délai de récupération à déplacer dans la chaîne ; durée réelle (heures, jours) |
| **Escape hatch** | Implémentée : propriétaire seul, délai, adresse fixée, sans Swissquote ; signalée « critique » par la revue | Pas d'interface. Risque : un appareil volé peut lancer une sortie vers l'adresse du voleur ; l'annulation existe côté API |
| **Face ID** | Biométrie = celle de l'OS (réelle) pour débloquer la clé. Vérification faciale « maison » = simulée, facteur additionnel, jamais seul | Modèle réel : licence (InsightFace non commercial) et données sensibles en droit suisse, **à valider avec la conformité** |
| **Blocage** | Jamais de blocage pour risque ; seul refus : sanctions | Validation juridique : **à valider avec la conformité** |

---

## 7. Ce que ça implique pour le pitch

- **Points forts défendables** : double signature avec risque recalculé côté serveur, jamais de blocage (avertir, pas bloquer), journal infalsifiable vérifiable en direct, vraies passkeys, vraie biométrie et vraie clé sur le téléphone, sortie de secours sans Swissquote (côté backend), visualiseur.
- **À dire honnêtement** : pseudo-chaîne et pas de vraie blockchain ; KYC, analyse faciale et NFC simulés ; pas de gasless réel ni de dApps (bonus non acquis).
- **À corriger ou à éviter en démo** : la rotation par Swissquote seule (question jury quasi certaine), le bug `/wallet/overview` après récupération, la passkey jamais testée dans un vrai Chrome.
- **Choix de langue des slides** : à fixer avant l'étape 2 (`[ANGLAIS ou FRANÇAIS]`).
