#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum CoreError {
    #[error("cannot decode transaction: {0}")]
    Decode(String),
    #[error("log sequence gap: expected {expected}, got {got}")]
    SeqGap { expected: u64, got: u64 },
    #[error("log chain broken at seq {0}")]
    ChainBroken(u64),
    #[error("receipt signature invalid at seq {0}")]
    BadReceipt(u64),
    #[error("rule {rule} failed: {msg}")]
    Rule { rule: &'static str, msg: String },
    #[error("invalid config: {0}")]
    Config(String),
}

impl CoreError {
    /// Stable machine code consumed by the TypeScript side.
    pub fn code(&self) -> &'static str {
        match self {
            CoreError::Decode(_) => "DECODE",
            CoreError::SeqGap { .. } => "SEQ_GAP",
            CoreError::ChainBroken(_) => "CHAIN_BROKEN",
            CoreError::BadReceipt(_) => "BAD_RECEIPT",
            CoreError::Rule { .. } => "RULE",
            CoreError::Config(_) => "CONFIG",
        }
    }
}
