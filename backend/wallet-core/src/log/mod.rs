use alloy_primitives::B256;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use ts_rs::TS;

use crate::{CoreError, DecodedAction, Hash32, Receipt, ReceiptVerifier, RiskAssessment};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum OutcomeKind {
    Cosigned,
    /// A second passkey confirmation is required (and, above Medium, an explicit risk acceptance).
    StepUp,
    /// Legacy: Swissquote no longer holds transactions (see the legal positioning doc). Kept so old logs still parse.
    Held,
    /// Regulatory refusal (sanctions). The only case where Swissquote declines to co-sign.
    Refused,
}

/// One decision, as both the extension and Swissquote record it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct LogEntry {
    #[ts(type = "number")]
    pub seq: u64,
    #[ts(type = "string")]
    pub prev_head: Hash32,
    #[ts(type = "string")]
    pub user_op_hash: Hash32,
    pub action: DecodedAction,
    pub assessment: RiskAssessment,
    pub outcome: OutcomeKind,
    pub step_up: bool,
    /// The user was warned (High / Critical, non-regulatory) and explicitly accepted the risk.
    #[serde(default)]
    pub risk_accepted: bool,
    pub warnings: Vec<String>,
    #[ts(type = "number")]
    pub timestamp: u64,
}

impl LogEntry {
    /// Canonical bytes: the entry's JSON in field order. Both sides build it from the same struct.
    fn canonical_bytes(&self) -> Result<Vec<u8>, CoreError> {
        serde_json::to_vec(self).map_err(|e| CoreError::Decode(format!("cannot serialise entry: {e}")))
    }

    pub fn hash(&self) -> Result<Hash32, CoreError> {
        let mut h = Sha256::new();
        h.update(b"SQW-ENTRY-v1");
        h.update(self.canonical_bytes()?);
        Ok(B256::from_slice(&h.finalize()))
    }
}

/// An entry plus its hash and Swissquote's receipt over that hash.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SignedEntry {
    pub entry: LogEntry,
    #[ts(type = "string")]
    pub entry_hash: Hash32,
    pub receipt: Receipt,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AuditLog {
    entries: Vec<SignedEntry>,
}

impl AuditLog {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn entries(&self) -> &[SignedEntry] {
        &self.entries
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn head(&self) -> Hash32 {
        self.entries.last().map(|e| e.entry_hash).unwrap_or(B256::ZERO)
    }

    pub fn next_seq(&self) -> u64 {
        self.entries.len() as u64
    }

    /// Checks that `entry` extends this log: next seq, current head, correct hash. Does not verify the receipt.
    pub fn check_extends(&self, entry: &LogEntry) -> Result<Hash32, CoreError> {
        let expected = self.next_seq();
        if entry.seq != expected {
            return Err(CoreError::SeqGap { expected, got: entry.seq });
        }
        if entry.prev_head != self.head() {
            return Err(CoreError::ChainBroken(entry.seq));
        }
        entry.hash()
    }

    pub fn append(&mut self, signed: SignedEntry) -> Result<(), CoreError> {
        let hash = self.check_extends(&signed.entry)?;
        if hash != signed.entry_hash || signed.receipt.entry_hash != hash {
            return Err(CoreError::ChainBroken(signed.entry.seq));
        }
        self.entries.push(signed);
        Ok(())
    }

    /// Full chain walk plus a receipt check on every entry.
    pub fn verify(&self, verifier: &dyn ReceiptVerifier) -> Result<Hash32, CoreError> {
        let mut head = B256::ZERO;
        for (i, e) in self.entries.iter().enumerate() {
            let seq = i as u64;
            if e.entry.seq != seq {
                return Err(CoreError::SeqGap { expected: seq, got: e.entry.seq });
            }
            if e.entry.prev_head != head {
                return Err(CoreError::ChainBroken(seq));
            }
            let hash = e.entry.hash()?;
            if hash != e.entry_hash || e.receipt.entry_hash != hash || e.receipt.seq != seq {
                return Err(CoreError::ChainBroken(seq));
            }
            verifier.verify(&e.receipt).map_err(|_| CoreError::BadReceipt(seq))?;
            head = hash;
        }
        Ok(head)
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
pub(crate) mod tests {
    use super::*;
    use crate::receipt::tests::TestSigner;
    use crate::{Address, RiskBand, U256};
    use alloy_primitives::Bytes;

    pub fn entry(seq: u64, prev_head: Hash32) -> LogEntry {
        LogEntry {
            seq,
            prev_head,
            user_op_hash: B256::repeat_byte(seq as u8 + 1),
            action: DecodedAction::NativeTransfer { to: Address::repeat_byte(2), amount: U256::from(1) },
            assessment: RiskAssessment { score: 0, band: RiskBand::Low, reasons: vec![] },
            outcome: OutcomeKind::Cosigned,
            step_up: false,
            risk_accepted: false,
            warnings: vec![],
            timestamp: 1_700_000_000 + seq,
        }
    }

    pub fn build_log(signer: &TestSigner, n: u64) -> AuditLog {
        let mut log = AuditLog::new();
        for seq in 0..n {
            let e = entry(seq, log.head());
            let hash = e.hash().unwrap();
            let receipt = signer.sign(&e, hash);
            log.append(SignedEntry { entry: e, entry_hash: hash, receipt }).unwrap();
        }
        log
    }

    #[test]
    fn appends_and_verifies_valid_chain() {
        let signer = TestSigner::new();
        let log = build_log(&signer, 3);
        assert_eq!(log.verify(&signer.verifier()).unwrap(), log.head());
    }

    #[test]
    fn rejects_seq_gap() {
        let signer = TestSigner::new();
        let mut log = build_log(&signer, 1);
        let e = entry(5, log.head());
        let hash = e.hash().unwrap();
        let r = signer.sign(&e, hash);
        let err = log.append(SignedEntry { entry: e, entry_hash: hash, receipt: r }).unwrap_err();
        assert_eq!(err, CoreError::SeqGap { expected: 1, got: 5 });
    }

    #[test]
    fn rejects_wrong_prev_head() {
        let signer = TestSigner::new();
        let mut log = build_log(&signer, 1);
        let e = entry(1, B256::repeat_byte(0xFF));
        let hash = e.hash().unwrap();
        let r = signer.sign(&e, hash);
        let err = log.append(SignedEntry { entry: e, entry_hash: hash, receipt: r }).unwrap_err();
        assert_eq!(err, CoreError::ChainBroken(1));
    }

    #[test]
    fn detects_tampered_middle_entry() {
        let signer = TestSigner::new();
        let mut log = build_log(&signer, 3);
        log.entries[1].entry.action = DecodedAction::NativeTransfer { to: Address::repeat_byte(9), amount: U256::from(999) };
        assert_eq!(log.verify(&signer.verifier()).unwrap_err(), CoreError::ChainBroken(1));
    }

    #[test]
    fn detects_forged_receipt() {
        let signer = TestSigner::new();
        let mut log = build_log(&signer, 2);
        let mut sig = log.entries[1].receipt.signature.to_vec();
        sig[3] ^= 0x01;
        log.entries[1].receipt.signature = Bytes::from(sig);
        assert_eq!(log.verify(&signer.verifier()).unwrap_err(), CoreError::BadReceipt(1));
    }
}
