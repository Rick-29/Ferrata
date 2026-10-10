use alloy_primitives::Bytes;
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{CoreError, Hash32, RiskBand};

pub const RECEIPT_DOMAIN: &[u8] = b"SQW-RECEIPT-v1";

/// Swissquote's signed acknowledgement of one log entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Receipt {
    #[ts(type = "string")]
    pub entry_hash: Hash32,
    #[ts(type = "string")]
    pub prev_head: Hash32,
    #[ts(type = "number")]
    pub seq: u64,
    pub band: RiskBand,
    #[ts(type = "string")]
    pub user_op_hash: Hash32,
    #[ts(type = "number")]
    pub timestamp: u64,
    /// 64-byte Ed25519 signature over `signing_payload()`, hex on the wire.
    #[ts(type = "string")]
    pub signature: Bytes,
}

impl Receipt {
    /// Domain-separated bytes the signer signs and the verifier checks.
    pub fn signing_payload(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(RECEIPT_DOMAIN.len() + 32 * 3 + 8 * 2 + 1);
        out.extend_from_slice(RECEIPT_DOMAIN);
        out.extend_from_slice(self.entry_hash.as_slice());
        out.extend_from_slice(self.prev_head.as_slice());
        out.extend_from_slice(&self.seq.to_be_bytes());
        out.push(self.band as u8);
        out.extend_from_slice(self.user_op_hash.as_slice());
        out.extend_from_slice(&self.timestamp.to_be_bytes());
        out
    }
}

pub trait ReceiptVerifier: Send + Sync {
    fn verify(&self, r: &Receipt) -> Result<(), CoreError>;
}

pub struct Ed25519ReceiptVerifier {
    public_key: VerifyingKey,
}

impl Ed25519ReceiptVerifier {
    pub fn new(public_key: VerifyingKey) -> Self {
        Self { public_key }
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self, CoreError> {
        let arr: [u8; 32] =
            bytes.try_into().map_err(|_| CoreError::Config("public key must be 32 bytes".into()))?;
        let key = VerifyingKey::from_bytes(&arr).map_err(|e| CoreError::Config(format!("bad public key: {e}")))?;
        Ok(Self::new(key))
    }

    pub fn public_key(&self) -> &VerifyingKey {
        &self.public_key
    }
}

impl ReceiptVerifier for Ed25519ReceiptVerifier {
    fn verify(&self, r: &Receipt) -> Result<(), CoreError> {
        let sig_bytes: [u8; 64] = r.signature.as_ref().try_into().map_err(|_| CoreError::BadReceipt(r.seq))?;
        let sig = Signature::from_bytes(&sig_bytes);
        self.public_key.verify_strict(&r.signing_payload(), &sig).map_err(|_| CoreError::BadReceipt(r.seq))
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
pub(crate) mod tests {
    use super::*;
    use crate::LogEntry;
    use ed25519_dalek::{Signer, SigningKey};

    /// Test-only signer; the real one lives in `sq-adapters`.
    pub struct TestSigner(SigningKey);

    impl TestSigner {
        pub fn new() -> Self {
            Self(SigningKey::from_bytes(&[7u8; 32]))
        }
        pub fn other() -> Self {
            Self(SigningKey::from_bytes(&[8u8; 32]))
        }
        pub fn verifier(&self) -> Ed25519ReceiptVerifier {
            Ed25519ReceiptVerifier::new(self.0.verifying_key())
        }
        pub fn sign(&self, e: &LogEntry, entry_hash: Hash32) -> Receipt {
            let mut r = Receipt {
                entry_hash,
                prev_head: e.prev_head,
                seq: e.seq,
                band: e.assessment.band,
                user_op_hash: e.user_op_hash,
                timestamp: e.timestamp,
                signature: Bytes::new(),
            };
            r.signature = Bytes::copy_from_slice(&self.0.sign(&r.signing_payload()).to_bytes());
            r
        }
    }

    fn sample() -> (TestSigner, Receipt) {
        let s = TestSigner::new();
        let e = crate::log::tests::entry(0, Hash32::ZERO);
        let h = e.hash().unwrap();
        let r = s.sign(&e, h);
        (s, r)
    }

    #[test]
    fn valid_signature_passes() {
        let (s, r) = sample();
        s.verifier().verify(&r).unwrap();
    }

    #[test]
    fn flipped_byte_fails() {
        let (s, mut r) = sample();
        let mut sig = r.signature.to_vec();
        sig[10] ^= 0xFF;
        r.signature = Bytes::from(sig);
        assert_eq!(s.verifier().verify(&r).unwrap_err(), CoreError::BadReceipt(0));
    }

    #[test]
    fn wrong_key_fails() {
        let (_, r) = sample();
        assert_eq!(TestSigner::other().verifier().verify(&r).unwrap_err(), CoreError::BadReceipt(0));
    }
}
