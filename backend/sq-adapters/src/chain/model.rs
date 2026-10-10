//! The validator's risk model. The tool owns the model, not the client: features are computed
//! on the chain, the model lives in the service, and its output becomes a flag like any other.
//!
//! `LinearModel` is a logistic regression over `TxFeatures::to_vector()`. The shipped weights in
//! `fixtures/model.json` are hand-set from the AML heuristics the features encode; replace them
//! with trained ones from `GET /chain/dataset` without touching code.

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::features::TxFeatures;

pub trait RiskModel: Send + Sync {
    fn name(&self) -> &str;
    /// Probability-like risk in `[0, 1]`.
    fn score(&self, features: &TxFeatures) -> f64;
    /// Top contributions, for explanations in the UI.
    fn explain(&self, features: &TxFeatures, top: usize) -> Vec<(String, f64)>;
    fn describe(&self) -> ModelInfo;
    /// Probability the model assigns when nothing is known: the "typical transfer" to compare against.
    fn baseline(&self) -> f64;
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ModelInfo {
    pub name: String,
    pub kind: String,
    #[ts(type = "number")]
    pub feature_count: u64,
    /// Scores at or above this raise a `MODEL_RISK` flag.
    pub threshold: f64,
}

/// `sigmoid(bias + Σ weight_i · scale(x_i))`, where `scale` applies an optional per-feature
/// `log1p` or division so hand-set and trained weights stay in a sane range.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LinearModel {
    pub name: String,
    pub bias: f64,
    pub threshold: f64,
    pub weights: BTreeMap<String, f64>,
    /// Per-feature transform: `"log1p"` or a positive divisor as a number.
    #[serde(default)]
    pub transforms: BTreeMap<String, Transform>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Transform {
    Named(String),
    Divide(f64),
}

impl LinearModel {
    pub fn load(path: &Path) -> Result<Self, String> {
        let bytes = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
        serde_json::from_slice(&bytes).map_err(|e| format!("{}: {e}", path.display()))
    }

    fn scaled(&self, key: &str, x: f64) -> f64 {
        match self.transforms.get(key) {
            Some(Transform::Named(n)) if n == "log1p" => (x.max(0.0) + 1.0).ln(),
            Some(Transform::Divide(d)) if *d > 0.0 => x / d,
            _ => x,
        }
    }

    fn contributions(&self, features: &TxFeatures) -> Vec<(String, f64)> {
        let v = features.to_vector();
        self.weights
            .iter()
            .filter_map(|(k, w)| v.get(k).map(|x| (k.clone(), w * self.scaled(k, *x))))
            .filter(|(_, c)| *c != 0.0)
            .collect()
    }
}

impl RiskModel for LinearModel {
    fn name(&self) -> &str {
        &self.name
    }

    fn score(&self, features: &TxFeatures) -> f64 {
        let z: f64 = self.bias + self.contributions(features).iter().map(|(_, c)| c).sum::<f64>();
        1.0 / (1.0 + (-z).exp())
    }

    fn explain(&self, features: &TxFeatures, top: usize) -> Vec<(String, f64)> {
        let mut c = self.contributions(features);
        c.sort_by(|a, b| b.1.abs().partial_cmp(&a.1.abs()).unwrap_or(std::cmp::Ordering::Equal));
        c.truncate(top);
        c
    }

    fn describe(&self) -> ModelInfo {
        ModelInfo { name: self.name.clone(), kind: "logistic_regression".into(), feature_count: self.weights.len() as u64, threshold: self.threshold }
    }

    fn baseline(&self) -> f64 {
        1.0 / (1.0 + (-self.bias).exp())
    }
}

/// One training row: features plus the label the flags imply.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct DatasetRow {
    #[ts(type = "string")]
    pub tx_hash: alloy_primitives::B256,
    #[ts(type = "number")]
    pub block_number: u64,
    pub features: TxFeatures,
    /// Highest flag severity on the event, if any.
    pub label: Option<wallet_core::RiskBand>,
    pub label_codes: Vec<String>,
}
