# Starts the Swissquote service for extension development on http://localhost:8787
# with a stable signing key, mock passkeys on, and the Ferra chain persisted at ../ferra-chain.jsonl.
# Usage: .\dev.ps1    (from backend/)
$env:SQ_PORT = "8787"
$env:SQ_SIGNING_SEED = "1111111111111111111111111111111111111111111111111111111111111111"
$env:SQ_CHAIN_FILE = "../ferra-chain.jsonl"
$env:SQ_DEV_SIGNER = "1"
$env:RUST_LOG = "info"
cargo run -p sq-services
