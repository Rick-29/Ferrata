use alloy_primitives::{B256, Bytes};
use ed25519_dalek::{Signer, SigningKey, VerifyingKey};
use wallet_core::{Ed25519ReceiptVerifier, Hash32, LogEntry, Receipt};

pub const COSIGN_DOMAIN: &[u8] = b"SQW-COSIGN-v1";

/// Bytes Swissquote signs when it co-signs a user operation (or any chain-level authorisation hash).
pub fn cosign_payload(hash: &B256) -> Vec<u8> {
    let mut out = Vec::with_capacity(COSIGN_DOMAIN.len() + 32);
    out.extend_from_slice(COSIGN_DOMAIN);
    out.extend_from_slice(hash.as_slice());
    out
}

pub trait ReceiptSigner: Send + Sync {
    fn sign_receipt(&self, entry: &LogEntry, entry_hash: Hash32) -> Receipt;
    /// Co-signature the pseudo-chain checks against Swissquote's key.
    fn cosign(&self, hash: &B256) -> Bytes;
    fn verifying_key(&self) -> VerifyingKey;
}

/// Swissquote's signing identity. In production this sits behind an HSM; here the seed comes from the environment.
pub struct Ed25519Signer {
    key: SigningKey,
}

impl Ed25519Signer {
    pub fn from_seed(seed: [u8; 32]) -> Self {
        Self { key: SigningKey::from_bytes(&seed) }
    }

    pub fn random() -> Self {
        let mut seed = [0u8; 32];
        rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut seed);
        Self::from_seed(seed)
    }

    pub fn verifier(&self) -> Ed25519ReceiptVerifier {
        Ed25519ReceiptVerifier::new(self.key.verifying_key())
    }
}

impl ReceiptSigner for Ed25519Signer {
    fn sign_receipt(&self, entry: &LogEntry, entry_hash: Hash32) -> Receipt {
        let mut r = Receipt {
            entry_hash,
            prev_head: entry.prev_head,
            seq: entry.seq,
            band: entry.assessment.band,
            user_op_hash: entry.user_op_hash,
            timestamp: entry.timestamp,
            signature: Bytes::new(),
        };
        r.signature = Bytes::copy_from_slice(&self.key.sign(&r.signing_payload()).to_bytes());
        r
    }

    fn cosign(&self, hash: &B256) -> Bytes {
        Bytes::copy_from_slice(&self.key.sign(&cosign_payload(hash)).to_bytes())
    }

    fn verifying_key(&self) -> VerifyingKey {
        self.key.verifying_key()
    }
}
