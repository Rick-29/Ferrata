#!/usr/bin/env sh
# Starts the Swissquote service for extension development on http://localhost:8787
# with a stable signing key, mock passkeys on, and the Ferra chain persisted at ../ferra-chain.jsonl.
# Usage: ./dev.sh    (from backend/)
cd "$(dirname "$0")" || exit 1
SQ_PORT=8787 \
SQ_SIGNING_SEED=1111111111111111111111111111111111111111111111111111111111111111 \
SQ_CHAIN_FILE=../ferra-chain.jsonl \
SQ_DEV_SIGNER=1 \
RUST_LOG=info \
exec cargo run -p sq-services
