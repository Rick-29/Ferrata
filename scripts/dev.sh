#!/usr/bin/env bash
# Ferrata - lance l'environnement de dev (macOS / Linux / Git Bash).
# Backend (http://localhost:8787) en arriere-plan + extension en mode dev au premier plan.
# Ctrl+C arrete les deux. Usage : ./scripts/dev.sh [--skip-backend]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FRONTEND="$ROOT/frontend"
BACKEND="$ROOT/backend"
SKIP_BACKEND=false
FAKE=false
for arg in "$@"; do
  case "$arg" in
    --skip-backend) SKIP_BACKEND=true ;;
    --fake) FAKE=true ;; # simulated data (FakeBridge) instead of the backend
  esac
done

[[ -d "$FRONTEND/node_modules" ]] || { echo "Dependances absentes : lance d'abord ./scripts/setup.sh" >&2; exit 1; }

backend_pid=""
cleanup() { [[ -n "$backend_pid" ]] && kill "$backend_pid" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

if [[ "$SKIP_BACKEND" == false ]]; then
  if command -v cargo >/dev/null; then
    (cd "$BACKEND" && cargo run -p sq-services) &
    backend_pid=$!
    echo "Backend en cours de demarrage : http://localhost:8787"
  else
    echo "Rust (cargo) absent : backend non lance, l'extension utilise des donnees simulees."
    FAKE=true
  fi
fi

echo "Extension : quand \"CRXJS: Load dist as unpacked extension\" s'affiche, recharge-la dans chrome://extensions."
if [[ "$FAKE" == true ]]; then export VITE_BRIDGE=fake; else export VITE_BRIDGE=real; fi
echo "Donnees : $([[ $VITE_BRIDGE == fake ]] && echo simulees || echo 'backend reel')"
cd "$FRONTEND" && npm run dev -w packages/extension
