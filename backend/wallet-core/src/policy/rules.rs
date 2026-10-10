//! One struct per rule. Each returns `Some(Reason)` when it fires, `None` otherwise.

use alloy_primitives::U256;

use super::{EvalContext, Reason, ReasonCode, Rule};
use crate::{CoreError, DecodedAction};

fn reason(code: ReasonCode, points: u32, message: impl Into<String>) -> Option<Reason> {
    Some(Reason { code, points, message: message.into() })
}

/// Unknown asset or dApp origin adds friction; allowlisted ones add nothing.
pub struct AllowlistRule;
impl Rule for AllowlistRule {
    fn id(&self) -> &'static str {
        "allowlist"
    }
    fn evaluate(&self, ctx: &EvalContext) -> Result<Option<Reason>, CoreError> {
        if let Some(asset) = ctx.action.asset()
            && !ctx.config.allowlisted_assets.contains(&asset)
        {
            return Ok(reason(ReasonCode::UnknownAsset, 15, format!("asset {asset} is not on the allowlist")));
        }
        if let Some(origin) = ctx.origin
            && !ctx.config.allowlisted_origins.iter().any(|o| o == origin)
        {
            return Ok(reason(ReasonCode::UnknownOrigin, 10, format!("origin {origin} is not a known dApp")));
        }
        Ok(None)
    }
}

pub struct AmountLimitRule;
impl Rule for AmountLimitRule {
    fn id(&self) -> &'static str {
        "amount_limit"
    }
    fn evaluate(&self, ctx: &EvalContext) -> Result<Option<Reason>, CoreError> {
        if matches!(ctx.action, DecodedAction::Erc20Approve { .. } | DecodedAction::TypedData { .. }) {
            return Ok(None);
        }
        let limit = ctx.config.amount_limit(ctx.action.asset());
        if ctx.action.amount() > limit {
            return Ok(reason(ReasonCode::LargeAmount, 25, format!("amount exceeds the limit of {limit}")));
        }
        Ok(None)
    }
}

pub struct NewRecipientRule;
impl Rule for NewRecipientRule {
    fn id(&self) -> &'static str {
        "new_recipient"
    }
    fn evaluate(&self, ctx: &EvalContext) -> Result<Option<Reason>, CoreError> {
        match ctx.action.counterparty() {
            Some(to) if !ctx.account.known_recipients.contains(&to) => {
                Ok(reason(ReasonCode::NewRecipient, 20, format!("first interaction with {to}")))
            }
            _ => Ok(None),
        }
    }
}

pub struct UnlimitedApprovalRule;
impl Rule for UnlimitedApprovalRule {
    fn id(&self) -> &'static str {
        "unlimited_approval"
    }
    fn evaluate(&self, ctx: &EvalContext) -> Result<Option<Reason>, CoreError> {
        match ctx.action {
            DecodedAction::Erc20Approve { unlimited: true, spender, .. } => {
                Ok(reason(ReasonCode::UnlimitedApproval, 30, format!("{spender} could spend the entire balance")))
            }
            _ => Ok(None),
        }
    }
}

pub struct TypedDataPermitRule;
impl Rule for TypedDataPermitRule {
    fn id(&self) -> &'static str {
        "typed_data_permit"
    }
    fn evaluate(&self, ctx: &EvalContext) -> Result<Option<Reason>, CoreError> {
        if let DecodedAction::TypedData { primary_type, summary, .. } = ctx.action
            && primary_type.eq_ignore_ascii_case("permit")
        {
            let limit = ctx.config.amount_limit(ctx.action.asset());
            let amount = summary.amount.unwrap_or(U256::ZERO);
            if amount == U256::MAX || amount > limit {
                return Ok(reason(ReasonCode::PermitSignature, 30, "signature grants a large token allowance"));
            }
        }
        Ok(None)
    }
}

pub struct SanctionsRule;
impl Rule for SanctionsRule {
    fn id(&self) -> &'static str {
        "sanctions"
    }
    fn evaluate(&self, ctx: &EvalContext) -> Result<Option<Reason>, CoreError> {
        if ctx.signals.sanctions_hit {
            return Ok(reason(ReasonCode::Sanctioned, 100, "counterparty is on a sanctions list"));
        }
        Ok(None)
    }
}

pub struct ExposureRule;
impl Rule for ExposureRule {
    fn id(&self) -> &'static str {
        "exposure"
    }
    fn evaluate(&self, ctx: &EvalContext) -> Result<Option<Reason>, CoreError> {
        match ctx.signals.exposure_hops {
            Some(hops) if hops <= ctx.config.max_exposure_hops => {
                Ok(reason(ReasonCode::MixerExposure, 40, format!("counterparty is {hops} hop(s) from a flagged address")))
            }
            _ => Ok(None),
        }
    }
}

/// Fires when the simulation shows more leaving the account than the action states.
pub struct SimulationDrainRule;
impl Rule for SimulationDrainRule {
    fn id(&self) -> &'static str {
        "simulation_drain"
    }
    fn evaluate(&self, ctx: &EvalContext) -> Result<Option<Reason>, CoreError> {
        let stated_asset = ctx.action.asset();
        let stated_amount = ctx.action.amount();
        for d in &ctx.signals.simulation {
            if d.after >= d.before {
                continue;
            }
            let out = d.before - d.after;
            let is_stated = d.asset == stated_asset;
            if (!is_stated && out > U256::ZERO) || (is_stated && out > stated_amount) {
                return Ok(reason(
                    ReasonCode::SimulatedDrain,
                    50,
                    format!("simulation moves {out} {} out of the account, more than the request states", d.symbol),
                ));
            }
        }
        Ok(None)
    }
}
