#!/usr/bin/env bash
# Ferrata - installation complete (macOS / Linux / Git Bash).
# A relancer apres chaque `git pull` : installe les dependances, construit l'extension,
# compile le backend. Usage : ./scripts/setup.sh [--skip-backend]
set -euo pipefail

MIN_NODE_MAJOR=22
DEV_SERVER_PORT=5173
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FRONTEND="$ROOT/frontend"
BACKEND="$ROOT/backend"
DIST="$FRONTEND/packages/extension/dist"
SKIP_BACKEND=false
FAKE=false
for arg in "$@"; do
  case "$arg" in
    --skip-backend) SKIP_BACKEND=true ;;
    --fake) FAKE=true ;; # simulated data (FakeBridge): no backend needed
  esac
done

step() { printf '\n\033[36m==> %s\033[0m\n' "$1"; }
fail() { printf '\n\033[31mERREUR : %s\033[0m\n' "$1" >&2; exit 1; }

step "Verification des outils"
command -v node >/dev/null || fail "Node.js n'est pas installe. Installe la version LTS ($MIN_NODE_MAJOR ou plus) depuis https://nodejs.org"
node_major="$(node --version | sed 's/^v//' | cut -d. -f1)"
(( node_major >= MIN_NODE_MAJOR )) || fail "Node.js $(node --version) est trop ancien. Il faut la version $MIN_NODE_MAJOR ou plus."
echo "Node.js $(node --version) OK"

# On Windows (Git Bash) files in use are locked: npm ci cannot replace node_modules while the
# dev server runs, and cargo cannot overwrite a running sq-services.exe.
if (echo >/dev/tcp/127.0.0.1/$DEV_SERVER_PORT) 2>/dev/null; then
  fail "Le serveur de dev de l'extension tourne (port $DEV_SERVER_PORT). Ferme-le puis relance le setup."
fi
if [[ "$SKIP_BACKEND" == false ]] && command -v pgrep >/dev/null && pgrep -x sq-services >/dev/null; then
  fail "Le backend tourne deja. Ferme-le puis relance le setup, ou utilise --skip-backend."
fi

has_cargo=false
command -v cargo >/dev/null && has_cargo=true
if [[ "$SKIP_BACKEND" == false && "$has_cargo" == false ]]; then
  printf '\033[33mRust (cargo) absent : le backend ne sera pas compile. https://rustup.rs\033[0m\n'
fi

step "Installation des dependances du frontend (npm ci)"
# npm ci suit exactement package-lock.json : tout le monde a les memes versions.
(cd "$FRONTEND" && npm ci --no-audit --no-fund) || fail "npm ci a echoue."

# Without the backend the real bridge has nothing to talk to: fall back to simulated data.
if [[ "$FAKE" == true || "$has_cargo" == false ]]; then export VITE_BRIDGE=fake; else export VITE_BRIDGE=real; fi
step "Construction de l'extension (donnees : $([[ $VITE_BRIDGE == fake ]] && echo simulees || echo 'backend reel'))"
(cd "$FRONTEND" && npm run build -w packages/extension) || fail "Le build de l'extension a echoue."

if [[ "$SKIP_BACKEND" == false && "$has_cargo" == true ]]; then
  step "Compilation du backend (la premiere fois peut prendre quelques minutes)"
  (cd "$BACKEND" && cargo build -p sq-services) || fail "cargo build a echoue."
fi

step "Termine"
printf '\033[32m'
cat <<EOF
Extension prete dans :
  $DIST

Pour l'ajouter a Chrome (une seule fois) :
  1. Ouvre chrome://extensions
  2. Active le Mode developpeur (en haut a droite)
  3. Charger l'extension non empaquetee -> choisis le dossier ci-dessus
Apres un nouveau setup : clique sur le bouton de rechargement de l'extension.

Pour developper (backend + rechargement automatique) : ./scripts/dev.sh
Connexion de demo : alice / demo
EOF
printf '\033[0m'
