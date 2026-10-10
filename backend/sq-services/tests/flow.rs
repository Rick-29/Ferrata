//! End-to-end demo flow through the HTTP router: register → fund → assess → co-sign → submit,
//! the four risk bands, hold release, escape hatch + reconciliation, recovery with cancel.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::PathBuf;
use std::sync::Arc;

use alloy_primitives::{Address, B256, Bytes, U256};
use api_types::*;
use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use ed25519_dalek::{Signer, SigningKey};
use http_body_util::BodyExt;
use serde::de::DeserializeOwned;
use sq_adapters::{FixedClock, MockChain};
use sq_services::config::Config;
use sq_services::state::AppState;
use tower::ServiceExt;
use wallet_core::tx::{SEL_TRANSFER, encode_erc20_call};

const USDC: Address = Address::new([0xAA; 20]);
const KNOWN: Address = Address::new([0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xAA]);
const SANCTIONED: Address = Address::new([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xde, 0xad]);
const MIXER_EXPOSED: Address = Address::new([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xc0, 0xff, 0xee]);

struct Owner(SigningKey);
impl Owner {
    fn new(seed: u8) -> Self {
        Self(SigningKey::from_bytes(&[seed; 32]))
    }
    fn key(&self) -> OwnerKey {
        OwnerKey::Ed25519 { key: Bytes::copy_from_slice(self.0.verifying_key().as_bytes()) }
    }
    fn sign(&self, h: &B256) -> OwnerSignature {
        OwnerSignature::Ed25519 { signature: Bytes::copy_from_slice(&self.0.sign(h.as_slice()).to_bytes()) }
    }
}

struct App {
    router: Router,
    clock: Arc<FixedClock>,
}

impl App {
    fn new() -> Self {
        let fixtures = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures");
        let config = Config::load(fixtures, 0, None, Some([42u8; 32]), true).unwrap();
        let clock = Arc::new(FixedClock::new(1_000_000));
        let state = AppState::build_with_clock(config, clock.clone()).unwrap();
        Self { router: sq_services::router(state), clock }
    }

    async fn call<T: DeserializeOwned>(&self, method: &str, path: &str, body: Option<serde_json::Value>) -> (StatusCode, T) {
        let req = Request::builder().method(method).uri(path).header("content-type", "application/json");
        let req = match body {
            Some(b) => req.body(Body::from(serde_json::to_vec(&b).unwrap())),
            None => req.body(Body::empty()),
        }
        .unwrap();
        let res = self.router.clone().oneshot(req).await.unwrap();
        let status = res.status();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        let parsed = serde_json::from_slice(&bytes).unwrap_or_else(|e| panic!("{method} {path} → {status}: {e}: {}", String::from_utf8_lossy(&bytes)));
        (status, parsed)
    }

    async fn post<T: DeserializeOwned>(&self, path: &str, body: impl serde::Serialize) -> T {
        let (s, v) = self.call::<serde_json::Value>("POST", path, Some(serde_json::to_value(body).unwrap())).await;
        assert!(s.is_success(), "POST {path} → {s}: {v}");
        serde_json::from_value(v).unwrap()
    }

    async fn get<T: DeserializeOwned>(&self, path: &str) -> T {
        let (s, v) = self.call::<serde_json::Value>("GET", path, None).await;
        assert!(s.is_success(), "GET {path} → {s}: {v}");
        serde_json::from_value(v).unwrap()
    }

    async fn post_err(&self, path: &str, body: impl serde::Serialize) -> (StatusCode, ApiError) {
        self.call("POST", path, Some(serde_json::to_value(body).unwrap())).await
    }

    /// Ownership proof + account creation + faucet. Returns the address.
    async fn onboard(&self, owner: &Owner) -> Address {
        let ch: ChallengeResponse = self.get("/ownership/challenge").await;
        let reg: RegisterWalletResponse = self
            .post("/wallet/register", RegisterWalletRequest { owner: owner.key(), challenge: ch.challenge, signature: owner.sign(&ch.challenge) })
            .await;
        assert_eq!(reg.address, MockChain::address_for(&owner.key()));
        let _: SubmitResult = self.post("/chain/faucet", FaucetRequest { address: reg.address, asset: None, amount: U256::from(10u64.pow(18)) }).await;
        let _: SubmitResult = self.post("/chain/faucet", FaucetRequest { address: reg.address, asset: Some(USDC), amount: U256::from(500_000_000u64) }).await;
        reg.address
    }

    /// assess → cosign with the current log head. Returns the outcome and the prepared op.
    async fn cosign(&self, tx: &TxRequest, account: &AccountContext, step_up: bool) -> (CosignOutcome, PreparedOp) {
        let a: AssessResponse = self.post("/assess", AssessRequest { tx: tx.clone(), account: Some(account.clone()) }).await;
        let prepared = a.prepared.expect("account exists on chain");
        let outcome: CosignOutcome = self
            .post(
                "/cosign",
                CosignRequest { tx: tx.clone(), user_op_hash: prepared.user_op_hash, seq: a.next_seq, prev_head: a.head, step_up, account: Some(account.clone()) },
            )
            .await;
        (outcome, prepared)
    }

    async fn submit(&self, owner: &Owner, tx: TxRequest, prepared: &PreparedOp, cosignature: Option<Bytes>) -> SubmitResult {
        self.post("/chain/submit", SignedUserOp { tx, nonce: prepared.nonce, owner_signature: owner.sign(&prepared.user_op_hash), cosignature }).await
    }
}

fn usdc_tx(from: Address, to: Address, amount: u64) -> TxRequest {
    TxRequest { chain_id: 84532, from, to: USDC, value: U256::ZERO, data: encode_erc20_call(SEL_TRANSFER, to, U256::from(amount)), origin: None }
}

fn usdc_balance(acc: &AccountView) -> U256 {
    acc.balances.iter().find(|b| b.asset == Some(USDC)).unwrap().amount
}

#[tokio::test]
async fn login_rejects_bad_credentials_and_issues_sessions() {
    let app = App::new();
    let (s, _) = app.post_err("/auth/session", LoginRequest { username: "alice".into(), password: "wrong".into() }).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    let sess: Session = app.post("/auth/session", LoginRequest { username: "alice".into(), password: "demo".into() }).await;
    assert_eq!(sess.client_id, "SQ-100001");
}

#[tokio::test]
async fn low_band_transfer_is_cosigned_submitted_and_logged() {
    let app = App::new();
    let owner = Owner::new(1);
    let addr = app.onboard(&owner).await;
    let account = AccountContext { known_recipients: vec![KNOWN] };

    let tx = usdc_tx(addr, KNOWN, 50_000_000);
    let (outcome, prepared) = app.cosign(&tx, &account, false).await;
    let CosignOutcome::Cosigned { entry, cosignature } = outcome else { panic!("expected cosigned, got {outcome:?}") };
    assert_eq!(entry.entry.assessment.band, RiskBand::Low);
    assert_eq!(entry.entry.seq, 0);

    let r = app.submit(&owner, tx, &prepared, Some(cosignature)).await;
    assert_eq!(r.kind, TxKind::Cosigned);

    let acc: AccountView = app.get(&format!("/chain/accounts/{addr}")).await;
    assert_eq!(usdc_balance(&acc), U256::from(450_000_000u64));
    assert_eq!(acc.nonce, 1);

    let log: LogResponse = app.get(&format!("/log/{addr}")).await;
    assert_eq!(log.entries.len(), 1);
    assert_eq!(log.head, entry.entry_hash);

    let rec: ReconcileResponse = app.post(&format!("/reconcile/{addr}"), serde_json::json!({})).await;
    assert!(rec.findings.is_empty(), "{:?}", rec.findings);
}

#[tokio::test]
async fn chain_rejects_submission_without_cosignature() {
    let app = App::new();
    let owner = Owner::new(2);
    let addr = app.onboard(&owner).await;
    let tx = usdc_tx(addr, KNOWN, 1);
    let prepared: PreparedOp = app.post("/chain/prepare", SimulateRequest { tx: tx.clone() }).await;
    let (s, e) = app
        .post_err("/chain/submit", SignedUserOp { tx, nonce: prepared.nonce, owner_signature: owner.sign(&prepared.user_op_hash), cosignature: None })
        .await;
    assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(e.code, "CHAIN_ESCAPE_NOT_STARTED");
}

#[tokio::test]
async fn medium_band_requires_step_up_then_cosigns() {
    let app = App::new();
    let owner = Owner::new(3);
    let addr = app.onboard(&owner).await;
    let account = AccountContext::default();
    let _: SubmitResult = app.post("/chain/faucet", FaucetRequest { address: addr, asset: Some(USDC), amount: U256::from(2_000_000_000u64) }).await;
    let tx = usdc_tx(addr, Address::repeat_byte(0x22), 2_000_000_000);

    let (first, _) = app.cosign(&tx, &account, false).await;
    assert!(matches!(first, CosignOutcome::StepUp { .. }), "{first:?}");

    let (second, prepared) = app.cosign(&tx, &account, true).await;
    let CosignOutcome::Cosigned { entry, cosignature } = second else { panic!("{second:?}") };
    assert_eq!(entry.entry.seq, 1);
    assert!(entry.entry.step_up);
    let _: SubmitResult = app.submit(&owner, tx, &prepared, Some(cosignature)).await;
}

#[tokio::test]
async fn high_band_is_held_then_released_with_justification() {
    let app = App::new();
    let owner = Owner::new(4);
    let addr = app.onboard(&owner).await;
    let account = AccountContext::default();
    let tx = usdc_tx(addr, MIXER_EXPOSED, 1_000_000);

    let (outcome, prepared) = app.cosign(&tx, &account, false).await;
    let CosignOutcome::Held { hold_id, entry, .. } = outcome else { panic!("{outcome:?}") };
    assert_eq!(entry.entry.assessment.band, RiskBand::High);
    assert!(entry.entry.assessment.reasons.iter().any(|r| r.code == ReasonCode::MixerExposure));

    let (s, _) = app.post_err(&format!("/holds/{hold_id}/justify"), JustifyRequest { text: "short".into() }).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);

    let hold: HoldState = app.post(&format!("/holds/{hold_id}/justify"), JustifyRequest { text: "Paying my cousin back for the ski trip".into() }).await;
    assert_eq!(hold.status, HoldStatus::Released);
    let release = hold.release_entry.unwrap();
    assert_eq!(release.entry.seq, 1);
    assert_eq!(release.entry.outcome, OutcomeKind::Cosigned);

    let r = app.submit(&owner, tx, &prepared, hold.cosignature).await;
    assert_eq!(r.kind, TxKind::Cosigned);
    let rec: ReconcileResponse = app.post(&format!("/reconcile/{addr}"), serde_json::json!({})).await;
    assert!(rec.findings.is_empty(), "{:?}", rec.findings);
}

#[tokio::test]
async fn critical_band_is_refused_and_chain_rejects_forged_cosignature() {
    let app = App::new();
    let owner = Owner::new(5);
    let addr = app.onboard(&owner).await;
    let tx = usdc_tx(addr, SANCTIONED, 1);
    let (outcome, prepared) = app.cosign(&tx, &AccountContext::default(), false).await;
    let CosignOutcome::Refused { entry } = outcome else { panic!("{outcome:?}") };
    assert_eq!(entry.entry.assessment.band, RiskBand::Critical);

    let forged = Bytes::from(vec![1u8; 64]);
    let (s, e) = app
        .post_err("/chain/submit", SignedUserOp { tx, nonce: prepared.nonce, owner_signature: owner.sign(&prepared.user_op_hash), cosignature: Some(forged) })
        .await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    assert_eq!(e.code, "CHAIN_BAD_COSIGNATURE");
}

#[tokio::test]
async fn cosign_rejects_stale_log_head() {
    let app = App::new();
    let owner = Owner::new(6);
    let addr = app.onboard(&owner).await;
    let tx = usdc_tx(addr, KNOWN, 1);
    let prepared: PreparedOp = app.post("/chain/prepare", SimulateRequest { tx: tx.clone() }).await;
    let (s, e) = app
        .post_err("/cosign", CosignRequest { tx, user_op_hash: prepared.user_op_hash, seq: 7, prev_head: B256::ZERO, step_up: false, account: None })
        .await;
    assert_eq!(s, StatusCode::CONFLICT);
    assert_eq!(e.code, "CORE_SEQ_GAP");
}

#[tokio::test]
async fn escape_hatch_exit_is_flagged_by_reconciliation() {
    let app = App::new();
    let owner = Owner::new(7);
    let addr = app.onboard(&owner).await;
    let exit_to = Address::repeat_byte(0x33);

    let h: HashResponse = app.post("/chain/escape/hash", EscapeHashRequest { address: addr, to: Some(exit_to) }).await;
    let started: EscapeResponse = app.post("/chain/escape/start", StartEscapeRequest { address: addr, to: exit_to, signature: owner.sign(&h.hash) }).await;
    let EscapeStatus::Pending { unlock_at, .. } = started.escape else { panic!("{:?}", started.escape) };

    let tx = usdc_tx(addr, exit_to, 500_000_000);
    let prepared: PreparedOp = app.post("/chain/prepare", SimulateRequest { tx: tx.clone() }).await;
    let (s, e) = app
        .post_err("/chain/submit", SignedUserOp { tx: tx.clone(), nonce: prepared.nonce, owner_signature: owner.sign(&prepared.user_op_hash), cosignature: None })
        .await;
    assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(e.code, "CHAIN_ESCAPE_LOCKED");

    app.clock.set(unlock_at + 1);
    let r = app.submit(&owner, tx, &prepared, None).await;
    assert_eq!(r.kind, TxKind::EscapeExit);

    let rec: ReconcileResponse = app.post(&format!("/reconcile/{addr}"), serde_json::json!({})).await;
    assert!(rec.findings.iter().any(|f| f.code == "ESCAPE_HATCH_EXIT" && f.severity == RiskBand::Critical), "{:?}", rec.findings);
    assert_eq!(rec.log_entries, 0);
}

#[tokio::test]
async fn recovery_cancel_during_timelock_wins_and_execute_after_timelock_rotates_owner() {
    let app = App::new();
    let real = Owner::new(8);
    let addr = app.onboard(&real).await;

    // attacker fails KYC
    let attacker = Owner::new(9);
    let rejected: RecoveryState = app
        .post("/recovery/start", StartRecoveryRequest { address: addr, new_owner: attacker.key(), kyc: KycAttestation { script_id: "kyc-fail".into(), full_name: "Mallory".into() } })
        .await;
    assert!(matches!(rejected.status, RecoveryStatus::Rejected { .. }));

    // attacker passes KYC (stolen documents); real user cancels from an existing device
    let rec: RecoveryState = app
        .post("/recovery/start", StartRecoveryRequest { address: addr, new_owner: attacker.key(), kyc: KycAttestation { script_id: "kyc-pass".into(), full_name: "Alice Keller".into() } })
        .await;
    let RecoveryStatus::Pending { unlock_at } = rec.status else { panic!("{:?}", rec.status) };
    let (s, _) = app.post_err(&format!("/recovery/{}/execute", rec.id), serde_json::json!({})).await;
    assert_eq!(s, StatusCode::CONFLICT);
    let (s, _) = app.post_err(&format!("/recovery/{}/cancel", rec.id), CancelRecoveryRequest { signature: attacker.sign(&rec.cancel_hash) }).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    let cancelled: RecoveryState = app.post(&format!("/recovery/{}/cancel", rec.id), CancelRecoveryRequest { signature: real.sign(&rec.cancel_hash) }).await;
    assert!(matches!(cancelled.status, RecoveryStatus::Cancelled { .. }));
    app.clock.set(unlock_at + 1);
    let (s, _) = app.post_err(&format!("/recovery/{}/execute", rec.id), serde_json::json!({})).await;
    assert_eq!(s, StatusCode::CONFLICT);

    // real user lost the device: recovery runs to completion, old key stops working
    let new_device = Owner::new(10);
    let rec: RecoveryState = app
        .post("/recovery/start", StartRecoveryRequest { address: addr, new_owner: new_device.key(), kyc: KycAttestation { script_id: "kyc-pass".into(), full_name: "Alice Keller".into() } })
        .await;
    let RecoveryStatus::Pending { unlock_at } = rec.status else { panic!("{:?}", rec.status) };
    app.clock.set(unlock_at);
    let done: RecoveryState = app.post(&format!("/recovery/{}/execute", rec.id), serde_json::json!({})).await;
    assert!(matches!(done.status, RecoveryStatus::Completed { .. }));

    let tx = usdc_tx(addr, KNOWN, 1);
    let (outcome, prepared) = app.cosign(&tx, &AccountContext { known_recipients: vec![KNOWN] }, false).await;
    let CosignOutcome::Cosigned { cosignature, .. } = outcome else { panic!("{outcome:?}") };
    let (s, e) = app
        .post_err("/chain/submit", SignedUserOp { tx: tx.clone(), nonce: prepared.nonce, owner_signature: real.sign(&prepared.user_op_hash), cosignature: Some(cosignature.clone()) })
        .await;
    assert_eq!((s, e.code.as_str()), (StatusCode::UNAUTHORIZED, "CHAIN_BAD_OWNER_SIGNATURE"));
    let r = app.submit(&new_device, tx, &prepared, Some(cosignature)).await;
    assert_eq!(r.kind, TxKind::Cosigned);
}

#[tokio::test]
async fn dev_passkeys_drive_the_flow_without_client_side_crypto() {
    let app = App::new();
    let pk: DevPasskey = app.post("/dev/passkeys", DevPasskeyRequest { name: "alice-phone".into() }).await;
    let ch: ChallengeResponse = app.get("/ownership/challenge").await;
    let sig: OwnerSignature = app.post("/dev/passkeys/alice-phone/sign", DevSignRequest { hash: ch.challenge }).await;
    let reg: RegisterWalletResponse = app.post("/wallet/register", RegisterWalletRequest { owner: pk.owner, challenge: ch.challenge, signature: sig }).await;
    assert_eq!(reg.address, pk.address);
}
