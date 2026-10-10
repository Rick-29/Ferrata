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
