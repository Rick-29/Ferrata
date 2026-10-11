# scripts

Tout installer ou tout lancer en une commande, sur n'importe quel PC.

| Quand | Windows | macOS / Linux |
| --- | --- | --- |
| Première fois, et **après chaque `git pull`** | `scripts\setup.cmd` (double-clic possible) | `./scripts/setup.sh` |
| Pour développer | `scripts\dev.cmd` | `./scripts/dev.sh` |

**`setup`** vérifie Node.js (version 22 ou plus) et installe les dépendances du frontend avec `npm ci`,
aux versions exactes de `package-lock.json`. Il construit ensuite l'extension dans
`frontend/packages/extension/dist` en vérifiant les types, puis compile le backend si Rust est installé.
Ajoute `-SkipBackend` (Windows) ou `--skip-backend` pour sauter le backend.

**Vraies données ou données simulées.** Par défaut, l'extension parle au vrai backend
(`http://localhost:8787`), qui doit tourner (`dev` le lance). Sans Rust, ou avec `-Fake` / `--fake`,
elle est construite sur des **données simulées** (le monde de démo de `fixtures/`), sans backend.
Le mode est choisi au build par la variable `VITE_BRIDGE` (`fake` ou `real`).

**Passkeys.** Par défaut, l'extension utilise de **vraies passkeys** (WebAuthn) : empreinte, visage
ou code de l'appareil, vérifiés par l'appareil lui-même. Le popup doit rester ouvert pendant la
signature. Sur une machine sans authentificateur, ou pour les tests, `VITE_PASSKEY=dev` utilise une
passkey **simulée** (porte-clés `/dev` du backend), signalée « Passkey simulée » à l'écran.

**USDC sans gas (ERC-4337).** Avec `VITE_PIMLICO_API_KEY` (clé gratuite sur
[dashboard.pimlico.io](https://dashboard.pimlico.io), plus une *sponsorship policy* pour Base Sepolia),
l'onglet Testnet affiche un compte intelligent « Base Sepolia · USDC sans gas » : la clé EVM du wallet
en est le propriétaire, Pimlico regroupe l'opération (bundler) et son paymaster paie le gas. On reçoit
des USDC de test sur [faucet.circle.com](https://faucet.circle.com) et on les envoie sans détenir
d'ETH. Modèle : `frontend/packages/extension/.env.example`.

**`dev`** lance le backend sur `http://localhost:8787` et l'extension en mode dev, avec rechargement
automatique à chaque sauvegarde.

## Ajouter l'extension à Chrome (une seule fois)

1. Ouvrir `chrome://extensions`.
2. Activer le **Mode développeur** (en haut à droite).
3. **Charger l'extension non empaquetée** et choisir `frontend/packages/extension/dist`.

Ensuite, après un `setup` ou au démarrage de `dev`, cliquer sur le bouton de rechargement de l'extension.
Connexion de démo : `alice` / `demo`.

## Prérequis

- [Node.js](https://nodejs.org) 22 ou plus (obligatoire).
- [Rust](https://rustup.rs) pour le backend. Sans Rust, l'extension marche en mode données simulées.

## Si ça ne marche pas

- **« Le service Swissquote est injoignable » / « Réseau indisponible »** : le backend ne tourne pas.
  Lance `dev`, ou reconstruis en mode simulé avec `setup -Fake`.
- **« Le serveur de dev tourne » ou « Le backend tourne déjà »** : ferme les fenêtres lancées par `dev`
  avant de relancer `setup`. Windows ne laisse pas remplacer des fichiers en cours d'utilisation
  (sinon : « Accès refusé (os error 5) »).
- **Le build échoue après un `git pull`** : le backend a peut-être changé les types de
  `frontend/packages/types`. Le message indique le fichier à adapter.
- **`dist` n'existe pas** : `dist/` n'est pas dans Git, il faut lancer `setup` sur chaque PC.
- **Copier le dossier `dist` d'un autre PC ne marche pas** : la version dev dépend du serveur local de ce PC.
