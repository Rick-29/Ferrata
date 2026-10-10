pub mod rules;

use alloy_primitives::{Address, U256};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use ts_rs::TS;

use crate::{CoreError, DecodedAction};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum RiskBand {
    Low,
    Medium,
    High,
    Critical,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
#[ts(export)]
pub enum ReasonCode {
    UnknownAsset,
    UnknownOrigin,
    LargeAmount,
    NewRecipient,
    UnlimitedApproval,
    PermitSignature,
    Sanctioned,
    MixerExposure,
    SimulatedDrain,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Reason {
    pub code: ReasonCode,
    pub points: u32,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RiskAssessment {
    pub score: u32,
    pub band: RiskBand,
    pub reasons: Vec<Reason>,
}

/// One asset's balance before and after a simulated execution.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct BalanceDelta {
    /// `None` is the native asset.
    #[ts(type = "string | null")]
    pub asset: Option<Address>,
    pub symbol: String,
    #[ts(type = "string")]
    pub before: U256,
    #[ts(type = "string")]
    pub after: U256,
}

/// Data gathered outside the core (sanctions lists, exposure graph, simulation) before scoring.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ExternalSignals {
    pub sanctions_hit: bool,
    /// Shortest path in hops from the counterparty to a flagged address, if any.
    pub exposure_hops: Option<u32>,
    pub simulation: Vec<BalanceDelta>,
}

/// What the wallet knows about its own account at scoring time.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AccountContext {
    #[ts(type = "string[]")]
    pub known_recipients: Vec<Address>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct BandThresholds {
    pub medium: u32,
    pub high: u32,
    pub critical: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PolicyConfig {
    pub thresholds: BandThresholds,
    #[ts(type = "string[]")]
    pub allowlisted_assets: Vec<Address>,
    pub allowlisted_origins: Vec<String>,
    /// Per-asset amount above which `LARGE_AMOUNT` fires; key is the asset address, `"native"` for ETH.
    #[ts(type = "Record<string, string>")]
    pub amount_limits: BTreeMap<String, U256>,
    #[ts(type = "string")]
    pub default_amount_limit: U256,
    pub max_exposure_hops: u32,
}

impl PolicyConfig {
    pub fn validate(&self) -> Result<(), CoreError> {
        let t = &self.thresholds;
        if !(t.medium < t.high && t.high < t.critical) {
            return Err(CoreError::Config("thresholds must be strictly increasing".into()));
        }
        Ok(())
    }

    pub fn band_for(&self, score: u32) -> RiskBand {
        let t = &self.thresholds;
        if score >= t.critical {
            RiskBand::Critical
        } else if score >= t.high {
            RiskBand::High
        } else if score >= t.medium {
            RiskBand::Medium
        } else {
            RiskBand::Low
        }
    }

    pub fn amount_limit(&self, asset: Option<Address>) -> U256 {
        let key = asset.map(|a| a.to_string().to_lowercase()).unwrap_or_else(|| "native".into());
        self.amount_limits.get(&key).copied().unwrap_or(self.default_amount_limit)
    }
}

pub struct EvalContext<'a> {
    pub action: &'a DecodedAction,
    pub origin: Option<&'a str>,
    pub account: &'a AccountContext,
    pub signals: &'a ExternalSignals,
    pub config: &'a PolicyConfig,
}

pub trait Rule: Send + Sync {
    fn id(&self) -> &'static str;
    fn evaluate(&self, ctx: &EvalContext) -> Result<Option<Reason>, CoreError>;
}

pub trait RiskScorer: Send + Sync {
    fn assess(&self, ctx: &EvalContext) -> Result<RiskAssessment, CoreError>;
}

pub struct RuleBasedScorer {
    rules: Vec<Box<dyn Rule>>,
}

impl RuleBasedScorer {
    pub fn new() -> Self {
        Self { rules: Vec::new() }
    }

    pub fn with_rule(mut self, rule: Box<dyn Rule>) -> Self {
        self.rules.push(rule);
        self
    }

    /// The eight demo rules, in evaluation order.
    pub fn standard() -> Self {
        use rules::*;
        Self::new()
            .with_rule(Box::new(SanctionsRule))
            .with_rule(Box::new(ExposureRule))
            .with_rule(Box::new(SimulationDrainRule))
            .with_rule(Box::new(UnlimitedApprovalRule))
            .with_rule(Box::new(TypedDataPermitRule))
            .with_rule(Box::new(AmountLimitRule))
            .with_rule(Box::new(NewRecipientRule))
            .with_rule(Box::new(AllowlistRule))
    }

    pub fn rule_ids(&self) -> Vec<&'static str> {
        self.rules.iter().map(|r| r.id()).collect()
    }
}

impl Default for RuleBasedScorer {
    fn default() -> Self {
        Self::standard()
    }
}

impl RiskScorer for RuleBasedScorer {
    fn assess(&self, ctx: &EvalContext) -> Result<RiskAssessment, CoreError> {
        ctx.config.validate()?;
        let mut reasons = Vec::new();
        for rule in &self.rules {
            if let Some(reason) = rule.evaluate(ctx)? {
                reasons.push(reason);
            }
        }
        let score = reasons.iter().map(|r| r.points).sum();
        Ok(RiskAssessment { score, band: ctx.config.band_for(score), reasons })
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use crate::tx::Eip712Domain;

    pub fn config() -> PolicyConfig {
        PolicyConfig {
            thresholds: BandThresholds { medium: 25, high: 50, critical: 80 },
            allowlisted_assets: vec![usdc()],
            allowlisted_origins: vec!["https://app.uniswap.org".into()],
            amount_limits: BTreeMap::from([(usdc().to_string().to_lowercase(), U256::from(1_000_000_000u64))]),
            default_amount_limit: U256::from(10u64).pow(U256::from(18)),
            max_exposure_hops: 2,
        }
    }
    fn usdc() -> Address {
        Address::repeat_byte(0xAA)
    }
    fn known() -> Address {
        Address::repeat_byte(0x11)
    }
    fn account() -> AccountContext {
        AccountContext { known_recipients: vec![known()] }
    }
    fn assess(action: DecodedAction, origin: Option<&str>, signals: ExternalSignals) -> RiskAssessment {
        let cfg = config();
        let acc = account();
        let ctx = EvalContext { action: &action, origin, account: &acc, signals: &signals, config: &cfg };
        RuleBasedScorer::standard().assess(&ctx).unwrap()
    }
    fn codes(a: &RiskAssessment) -> Vec<ReasonCode> {
        a.reasons.iter().map(|r| r.code).collect()
    }

    #[test]
    fn low_band_known_recipient_allowlisted_asset() {
        let a = assess(
            DecodedAction::Erc20Transfer { token: usdc(), to: known(), amount: U256::from(50_000_000u64) },
            None,
            ExternalSignals::default(),
        );
        assert_eq!(a.band, RiskBand::Low);
        assert!(a.reasons.is_empty());
    }

    #[test]
    fn low_band_new_recipient_small_amount() {
        let a = assess(
            DecodedAction::Erc20Transfer { token: usdc(), to: Address::repeat_byte(0x22), amount: U256::from(1u64) },
            None,
            ExternalSignals::default(),
        );
        assert_eq!(a.band, RiskBand::Low);
        assert_eq!(codes(&a), vec![ReasonCode::NewRecipient]);
    }

    #[test]
    fn medium_band_new_recipient_large_amount() {
        let a = assess(
            DecodedAction::Erc20Transfer { token: usdc(), to: Address::repeat_byte(0x22), amount: U256::from(5_000_000_000u64) },
            None,
            ExternalSignals::default(),
        );
        assert_eq!(a.band, RiskBand::Medium);
        assert_eq!(codes(&a), vec![ReasonCode::LargeAmount, ReasonCode::NewRecipient]);
    }

    #[test]
    fn high_band_mixer_exposure() {
        let a = assess(
            DecodedAction::Erc20Transfer { token: usdc(), to: Address::repeat_byte(0x22), amount: U256::from(1u64) },
            None,
            ExternalSignals { exposure_hops: Some(2), ..Default::default() },
        );
        assert_eq!(a.band, RiskBand::High);
        assert_eq!(codes(&a), vec![ReasonCode::MixerExposure, ReasonCode::NewRecipient]);
    }

    #[test]
    fn high_band_unlimited_approval_unknown_origin() {
        let a = assess(
            DecodedAction::Erc20Approve { token: usdc(), spender: Address::repeat_byte(0x22), amount: U256::MAX, unlimited: true },
            Some("https://evil.example"),
            ExternalSignals::default(),
        );
        assert_eq!(a.band, RiskBand::High);
        assert!(codes(&a).contains(&ReasonCode::UnlimitedApproval));
        assert!(codes(&a).contains(&ReasonCode::UnknownOrigin));
    }

    #[test]
    fn critical_band_sanctioned() {
        let a = assess(
            DecodedAction::NativeTransfer { to: known(), amount: U256::from(1u64) },
            None,
            ExternalSignals { sanctions_hit: true, ..Default::default() },
        );
        assert_eq!(a.band, RiskBand::Critical);
        assert_eq!(codes(&a), vec![ReasonCode::Sanctioned]);
    }

    #[test]
    fn permit_typed_data_scores() {
        let a = assess(
            DecodedAction::TypedData {
                domain: Eip712Domain { name: "USD Coin".into(), chain_id: 1, verifying_contract: usdc() },
                primary_type: "Permit".into(),
                summary: crate::tx::TypedDataSummary { spender: Some(Address::repeat_byte(0x22)), amount: Some(U256::MAX), deadline: None },
            },
            Some("https://app.uniswap.org"),
            ExternalSignals::default(),
        );
        assert!(codes(&a).contains(&ReasonCode::PermitSignature));
        assert_eq!(a.band, RiskBand::High);
    }

    #[test]
    fn invalid_thresholds_rejected() {
        let mut cfg = config();
        cfg.thresholds.high = 10;
        assert_eq!(cfg.validate().unwrap_err().code(), "CONFIG");
    }
}
