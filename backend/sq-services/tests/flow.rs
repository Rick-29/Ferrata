//! End-to-end demo flow through the HTTP router: login → register → fund → assess → co-sign →
//! submit, the four risk bands, verified step-up, hold release, escape hatch + reconciliation,
//! anchoring, recovery with cancel, auth gate, dev reset.

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
use async_trait::async_trait;
use sq_adapters::{FixedClock, MockChain};
use sq_connectors::{ConnectorError, NetworkSource, ObservedEvent, Page, SourceRegistry};
use sq_services::assess::step_up_hash;
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
    state: sq_services::state::SharedState,
    clock: Arc<FixedClock>,
    token: Option<String>,
}

impl App {
    fn new() -> Self {
        let fixtures = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures");
        let config = Config::load(fixtures, 0, None, Some([42u8; 32]), true, true).unwrap();
        let clock = Arc::new(FixedClock::new(1_000_000));
        let sources = SourceRegistry::new().register(Box::new(FakeTon));
        let state = AppState::build_with(config, clock.clone(), sources).unwrap();
        Self { router: sq_services::router(state.clone()), state, clock, token: None }
    }

    /// A second session on the same server, as another Swissquote client.
    async fn login_as(&self, username: &str) -> Self {
        let mut other = Self { router: self.router.clone(), state: self.state.clone(), clock: self.clock.clone(), token: None };
        let sess: Session = other.post("/auth/session", LoginRequest { username: username.into(), password: "demo".into() }).await;
        other.token = Some(sess.token);
        other
    }

    /// Logged-in app; every later call carries the bearer token.
    async fn logged_in() -> Self {
        let mut app = Self::new();
        let sess: Session = app.post("/auth/session", LoginRequest { username: "alice".into(), password: "demo".into() }).await;
        app.token = Some(sess.token);
        app
    }

    async fn call<T: DeserializeOwned>(&self, method: &str, path: &str, body: Option<serde_json::Value>) -> (StatusCode, T) {
        let mut req = Request::builder().method(method).uri(path).header("content-type", "application/json");
        if let Some(t) = &self.token {
            req = req.header("authorization", format!("Bearer {t}"));
        }
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

    /// Ownership proof + account creation on every chain + faucet. Returns the default-chain address.
    async fn onboard(&self, owner: &Owner) -> Address {
        let ch: ChallengeResponse = self.get("/ownership/challenge").await;
        let reg: RegisterWalletResponse = self
            .post("/wallet/register", RegisterWalletRequest { owner: owner.key(), challenge: ch.challenge, signature: owner.sign(&ch.challenge) })
            .await;
        assert_eq!(reg.address, MockChain::address_for(&owner.key()));
        assert_eq!(reg.accounts.len(), 1, "one account per registered chain");
        let _: SubmitResult = self.post("/chain/faucet", FaucetRequest { chain_id: None, address: reg.address, asset: None, amount: U256::from(10u64.pow(18)) }).await;
        let _: SubmitResult = self.post("/chain/faucet", FaucetRequest { chain_id: None, address: reg.address, asset: Some(USDC), amount: U256::from(500_000_000u64) }).await;
        reg.address
    }

    /// assess → cosign with the current log head. Returns the outcome and the prepared op.
    async fn cosign(&self, tx: &TxRequest, account: &AccountContext, step_up: Option<OwnerSignature>) -> (CosignOutcome, PreparedOp) {
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

/// A network source that answers from memory: two TON events, then an empty page.
struct FakeTon;

#[async_trait]
impl NetworkSource for FakeTon {
    fn network(&self) -> Network {
        Network { family: ChainFamily::Ton, name: "ton-testnet".into(), chain_id: None }
    }
    async fn fetch(&self, address_raw: &str, cursor: Option<&str>, _limit: u32) -> Result<Page, ConnectorError> {
        if cursor.is_some() {
            return Ok(Page::default());
        }
        if address_raw == "EQCsomeone" {
            // the counterparty's own history: received 3 TON from a third party and forwarded it at once
            let mk = |from: &str, to: &str, amount: &str, incoming: bool| ObservedEvent {
                external: ExternalRef { network: self.network(), tx_id: format!("{from}>{to}"), block: Some(10), from_raw: from.into(), to_raw: to.into(), asset_symbol: "TON".into(), decimals: 9, amount: amount.into(), fee: None, explorer_url: None },
                incoming,
                counterparty: None,
            };
            return Ok(Page { events: vec![mk("EQCthird", "EQCsomeone", "3000000000", true), mk("EQCsomeone", "EQCalice", "3000000000", false)], next_cursor: None });
        }
        let ev = |id: &str, incoming: bool, amount: &str| ObservedEvent {
            external: ExternalRef {
                network: self.network(),
                tx_id: id.into(),
                block: Some(10),
                from_raw: if incoming { "EQCsomeone".into() } else { address_raw.into() },
                to_raw: if incoming { address_raw.into() } else { "EQCsomeone".into() },
                asset_symbol: "TON".into(),
                decimals: 9,
                amount: amount.into(),
                fee: Some(0.002),
                explorer_url: None,
            },
            incoming,
            counterparty: None,
        };
        Ok(Page { events: vec![ev("ton-1", true, "3000000000"), ev("ton-2", false, "1000000000")], next_cursor: Some("older".into()) })
    }
}

fn usdc_tx(from: Address, to: Address, amount: u64) -> TxRequest {
    TxRequest { chain_id: 84532, from, to: USDC, value: U256::ZERO, data: encode_erc20_call(SEL_TRANSFER, to, U256::from(amount)), origin: None }
}

fn usdc_balance(acc: &AccountView) -> U256 {
    acc.balances.iter().find(|b| b.asset == Some(USDC)).unwrap().amount
}

#[tokio::test]
async fn auth_gate_rejects_missing_or_bad_tokens_but_not_public_routes() {
    let app = App::new();
    let (s, _) = app.post_err("/auth/session", LoginRequest { username: "alice".into(), password: "wrong".into() }).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);

    let (s, e) = app.call::<ApiError>("GET", "/ownership/challenge", None).await;
    assert_eq!((s, e.code.as_str()), (StatusCode::UNAUTHORIZED, "UNAUTHORIZED"));
    let (s, _) = app.call::<serde_json::Value>("GET", "/chain/info", None).await;
    assert_eq!(s, StatusCode::OK);
    let (s, _) = app.call::<serde_json::Value>("GET", "/chains", None).await;
    assert_eq!(s, StatusCode::OK);

    let mut bad = App::new();
    bad.token = Some("sess_nope".into());
    let (s, _) = bad.call::<ApiError>("GET", "/ownership/challenge", None).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);

    let app = App::logged_in().await;
    let _: ChallengeResponse = app.get("/ownership/challenge").await;
}

#[tokio::test]
async fn low_band_transfer_is_cosigned_submitted_logged_and_anchored() {
    let app = App::logged_in().await;
    let owner = Owner::new(1);
    let addr = app.onboard(&owner).await;
    let account = AccountContext { known_recipients: vec![KNOWN], own_per_tx_limit: None };

    let tx = usdc_tx(addr, KNOWN, 50_000_000);
    let (outcome, prepared) = app.cosign(&tx, &account, None).await;
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

    let anchored: AnchorResponse = app.post(&format!("/log/{addr}/anchor"), serde_json::json!({})).await;
    assert_eq!(anchored.head, log.head);
    assert_eq!(anchored.tx.unwrap().kind, TxKind::Anchor);
    let v: ChainVerification = app.get("/chain/verify").await;
    assert!(v.ok, "{v:?}");

    let rec: ReconcileResponse = app.post(&format!("/reconcile/{addr}"), serde_json::json!({})).await;
    assert!(rec.findings.is_empty(), "{:?}", rec.findings);
    assert_eq!(rec.anchors_checked, 1);

    let overview: WalletOverview = app.post("/wallet/overview", WalletOverviewRequest { owner: owner.key() }).await;
    assert_eq!(overview.accounts.len(), 1);
    assert_eq!(overview.accounts[0].address, addr);
}

#[tokio::test]
async fn server_derived_known_recipients_make_second_payment_low() {
    let app = App::logged_in().await;
    let owner = Owner::new(11);
    let addr = app.onboard(&owner).await;
    let fresh = Address::repeat_byte(0x55);
    let empty = AccountContext::default();

    let tx = usdc_tx(addr, fresh, 1_000_000);
    let a: AssessResponse = app.post("/assess", AssessRequest { tx: tx.clone(), account: None }).await;
    assert!(a.assessment.reasons.iter().any(|r| r.code == ReasonCode::NewRecipient));
    let (outcome, prepared) = app.cosign(&tx, &empty, None).await;
    let CosignOutcome::Cosigned { cosignature, .. } = outcome else { panic!("{outcome:?}") };
    app.submit(&owner, tx, &prepared, Some(cosignature)).await;

    // same recipient again, client sends no list: the server already knows it
    let a: AssessResponse = app.post("/assess", AssessRequest { tx: usdc_tx(addr, fresh, 1_000_000), account: None }).await;
    assert!(a.assessment.reasons.is_empty(), "{:?}", a.assessment.reasons);
}

#[tokio::test]
async fn chain_rejects_submission_without_cosignature() {
    let app = App::logged_in().await;
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
async fn medium_band_requires_a_verified_step_up_signature() {
    let app = App::logged_in().await;
    let owner = Owner::new(3);
    let addr = app.onboard(&owner).await;
    let account = AccountContext::default();
    let _: SubmitResult = app.post("/chain/faucet", FaucetRequest { chain_id: None, address: addr, asset: Some(USDC), amount: U256::from(2_000_000_000u64) }).await;
    let tx = usdc_tx(addr, Address::repeat_byte(0x22), 2_000_000_000);

    let (first, prepared) = app.cosign(&tx, &account, None).await;
    let CosignOutcome::StepUp { step_up_hash: h, .. } = first else { panic!("{first:?}") };
    assert_eq!(h, step_up_hash(&prepared.user_op_hash));

    // a signature from a different key, or over the wrong hash, is rejected
    let log: LogResponse = app.get(&format!("/log/{addr}")).await;
    let forged = CosignRequest { tx: tx.clone(), user_op_hash: prepared.user_op_hash, seq: log.next_seq, prev_head: log.head, step_up: Some(Owner::new(4).sign(&h)), account: None };
    let (s, e) = app.post_err("/cosign", forged).await;
    assert_eq!((s, e.code.as_str()), (StatusCode::UNAUTHORIZED, "UNAUTHORIZED"));
    let wrong_hash = CosignRequest { tx: tx.clone(), user_op_hash: prepared.user_op_hash, seq: log.next_seq, prev_head: log.head, step_up: Some(owner.sign(&prepared.user_op_hash)), account: None };
    let (s, _) = app.post_err("/cosign", wrong_hash).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);

    let (second, prepared) = app.cosign(&tx, &account, Some(owner.sign(&h))).await;
    let CosignOutcome::Cosigned { entry, cosignature } = second else { panic!("{second:?}") };
    assert_eq!(entry.entry.seq, 1);
    assert!(entry.entry.step_up);
    let _: SubmitResult = app.submit(&owner, tx, &prepared, Some(cosignature)).await;
}

#[tokio::test]
async fn high_band_is_held_then_released_with_justification() {
    let app = App::logged_in().await;
    let owner = Owner::new(4);
    let addr = app.onboard(&owner).await;
    let account = AccountContext::default();
    let tx = usdc_tx(addr, MIXER_EXPOSED, 1_000_000);

    let (outcome, prepared) = app.cosign(&tx, &account, None).await;
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
    let app = App::logged_in().await;
    let owner = Owner::new(5);
    let addr = app.onboard(&owner).await;
    let tx = usdc_tx(addr, SANCTIONED, 1);
    let (outcome, prepared) = app.cosign(&tx, &AccountContext::default(), None).await;
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
async fn cosign_rejects_stale_log_head_and_unknown_chain() {
    let app = App::logged_in().await;
    let owner = Owner::new(6);
    let addr = app.onboard(&owner).await;
    let tx = usdc_tx(addr, KNOWN, 1);
    let prepared: PreparedOp = app.post("/chain/prepare", SimulateRequest { tx: tx.clone() }).await;
    let (s, e) = app
        .post_err("/cosign", CosignRequest { tx: tx.clone(), user_op_hash: prepared.user_op_hash, seq: 7, prev_head: B256::ZERO, step_up: None, account: None })
        .await;
    assert_eq!(s, StatusCode::CONFLICT);
    assert_eq!(e.code, "CORE_SEQ_GAP");

    let mut other = tx;
    other.chain_id = 1;
    let (s, e) = app.post_err("/chain/prepare", SimulateRequest { tx: other }).await;
    assert_eq!((s, e.code.as_str()), (StatusCode::UNPROCESSABLE_ENTITY, "CHAIN_UNKNOWN_CHAIN"));
}

#[tokio::test]
async fn escape_hatch_exit_is_flagged_by_reconciliation() {
    let app = App::logged_in().await;
    let owner = Owner::new(7);
    let addr = app.onboard(&owner).await;
    let exit_to = Address::repeat_byte(0x33);

    let h: HashResponse = app.post("/chain/escape/hash", EscapeHashRequest { chain_id: None, address: addr, to: Some(exit_to) }).await;
    let started: EscapeResponse = app.post("/chain/escape/start", StartEscapeRequest { chain_id: None, address: addr, to: exit_to, signature: owner.sign(&h.hash) }).await;
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
    let app = App::logged_in().await;
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
    let (outcome, prepared) = app.cosign(&tx, &AccountContext { known_recipients: vec![KNOWN], own_per_tx_limit: None }, None).await;
    let CosignOutcome::Cosigned { cosignature, .. } = outcome else { panic!("{outcome:?}") };
    let (s, e) = app
        .post_err("/chain/submit", SignedUserOp { tx: tx.clone(), nonce: prepared.nonce, owner_signature: real.sign(&prepared.user_op_hash), cosignature: Some(cosignature.clone()) })
        .await;
    assert_eq!((s, e.code.as_str()), (StatusCode::UNAUTHORIZED, "CHAIN_BAD_OWNER_SIGNATURE"));
    let r = app.submit(&new_device, tx, &prepared, Some(cosignature)).await;
    assert_eq!(r.kind, TxKind::Cosigned);
}

#[tokio::test]
async fn dev_passkeys_and_reset_drive_rehearsals() {
    let app = App::logged_in().await;
    let pk: DevPasskey = app.post("/dev/passkeys", DevPasskeyRequest { name: "alice-phone".into() }).await;
    let ch: ChallengeResponse = app.get("/ownership/challenge").await;
    let sig: OwnerSignature = app.post("/dev/passkeys/alice-phone/sign", DevSignRequest { hash: ch.challenge }).await;
    let reg: RegisterWalletResponse = app.post("/wallet/register", RegisterWalletRequest { owner: pk.owner, challenge: ch.challenge, signature: sig }).await;
    assert_eq!(reg.address, pk.address);

    let _: serde_json::Value = app.post("/dev/reset", serde_json::json!({})).await;
    let (s, e) = app.call::<ApiError>("GET", &format!("/chain/accounts/{}", pk.address), None).await;
    assert_eq!((s, e.code.as_str()), (StatusCode::NOT_FOUND, "CHAIN_UNKNOWN_ACCOUNT"));
    // session survives the reset
    let _: ChallengeResponse = app.get("/ownership/challenge").await;
}

#[tokio::test]
async fn sessions_are_bound_to_the_wallets_they_registered() {
    let alice = App::logged_in().await;
    let owner = Owner::new(12);
    let addr = alice.onboard(&owner).await;
    let mallory = alice.login_as("mallory").await;

    let (s, e) = mallory.call::<ApiError>("GET", &format!("/log/{addr}"), None).await;
    assert_eq!((s, e.code.as_str()), (StatusCode::UNAUTHORIZED, "UNAUTHORIZED"));
    let tx = usdc_tx(addr, KNOWN, 1);
    let (s, _) = mallory.post_err("/assess", AssessRequest { tx: tx.clone(), account: None }).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    let prepared: PreparedOp = mallory.post("/chain/prepare", SimulateRequest { tx: tx.clone() }).await;
    let (s, _) = mallory
        .post_err("/chain/submit", SignedUserOp { tx: tx.clone(), nonce: prepared.nonce, owner_signature: owner.sign(&prepared.user_op_hash), cosignature: None })
        .await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);

    // the owner, on a fresh session of the same client, still can
    let alice_again = alice.login_as("alice").await;
    let _: LogResponse = alice_again.get(&format!("/log/{addr}")).await;
    // public reads stay public
    let _: AccountView = mallory.get(&format!("/chain/accounts/{addr}")).await;
}

#[tokio::test]
async fn rewritten_log_is_caught_by_anchor_mismatch() {
    let app = App::logged_in().await;
    let owner = Owner::new(13);
    let addr = app.onboard(&owner).await;
    let tx = usdc_tx(addr, KNOWN, 1);
    let (outcome, prepared) = app.cosign(&tx, &AccountContext { known_recipients: vec![KNOWN], own_per_tx_limit: None }, None).await;
    let CosignOutcome::Cosigned { cosignature, .. } = outcome else { panic!("{outcome:?}") };
    app.submit(&owner, tx, &prepared, Some(cosignature)).await;
    let _: AnchorResponse = app.post(&format!("/log/{addr}/anchor"), serde_json::json!({})).await;
    let rec: ReconcileResponse = app.post(&format!("/reconcile/{addr}"), serde_json::json!({})).await;
    assert!(rec.findings.is_empty(), "{:?}", rec.findings);

    // Swissquote "loses" or rewrites the log: the anchor on the chain gives it away
    app.state.log.clear().unwrap();
    let rec: ReconcileResponse = app.post(&format!("/reconcile/{addr}"), serde_json::json!({})).await;
    assert!(rec.findings.iter().any(|f| f.code == "ANCHOR_MISMATCH" && f.severity == RiskBand::Critical), "{:?}", rec.findings);
    assert!(rec.findings.iter().any(|f| f.code == "UNLOGGED_COSIGNED_TX"), "{:?}", rec.findings);
    assert_eq!(rec.anchors_checked, 1);
}

#[tokio::test]
async fn review_flags_sanctioned_counterparties_and_escape_exits_and_verdicts() {
    let app = App::logged_in().await;
    let owner = Owner::new(14);
    let addr = app.onboard(&owner).await;

    // clean account: one co-signed payment to a known merchant
    let tx = usdc_tx(addr, KNOWN, 1_000_000);
    let (outcome, prepared) = app.cosign(&tx, &AccountContext { known_recipients: vec![KNOWN], own_per_tx_limit: None }, None).await;
    let CosignOutcome::Cosigned { cosignature, .. } = outcome else { panic!("{outcome:?}") };
    app.submit(&owner, tx, &prepared, Some(cosignature)).await;
    let r: ReviewReport = app.post(&format!("/review/{addr}"), serde_json::json!({})).await;
    assert_eq!(r.verdict, ReviewVerdict::Clean, "{r:?}");
    assert_eq!(r.new_flags, 0);
    assert!(r.chain.ok);

    // another client pays alice: inbound events are reviewed too
    let bad = Owner::new(15);
    let mallory = app.login_as("mallory").await;
    let bad_addr = mallory.onboard(&bad).await;
    let pay = usdc_tx(bad_addr, addr, 2_000_000);
    let (outcome, prepared) = mallory.cosign(&pay, &AccountContext::default(), None).await;
    let CosignOutcome::Cosigned { cosignature, .. } = outcome else { panic!("{outcome:?}") };
    mallory.submit(&bad, pay, &prepared, Some(cosignature)).await;

    // alice then pays the mixer-exposed address through a released hold
    let risky = usdc_tx(addr, MIXER_EXPOSED, 500_000);
    let (outcome, prepared) = app.cosign(&risky, &AccountContext::default(), None).await;
    let CosignOutcome::Held { hold_id, .. } = outcome else { panic!("{outcome:?}") };
    let hold: HoldState = app.post(&format!("/holds/{hold_id}/justify"), JustifyRequest { text: "Refund to a friend who moved abroad".into() }).await;
    app.submit(&owner, risky, &prepared, hold.cosignature).await;

    let r: ReviewReport = app.post(&format!("/review/{addr}"), serde_json::json!({})).await;
    assert_eq!(r.verdict, ReviewVerdict::Suspicious, "{r:?}");
    assert!(r.flags.iter().any(|f| f.code == "MIXER_EXPOSURE" && f.source == FlagSource::Review), "{:?}", r.flags);
    assert!(r.flags.iter().any(|f| f.code == "POLICY_REASONS" && f.source == FlagSource::Policy), "{:?}", r.flags);
    let again: ReviewReport = app.post(&format!("/review/{addr}"), serde_json::json!({})).await;
    assert_eq!(again.new_flags, 0, "review is idempotent");
    assert_eq!(again.flags.len(), r.flags.len());

    // flags are visible on the event itself and on the account
    let history: HistoryResponse = app.get(&format!("/chain/history/{addr}")).await;
    assert!(history.txs.iter().any(|t| t.flags.iter().any(|f| f.code == "MIXER_EXPOSURE")));
    let acc: AccountView = app.get(&format!("/chain/accounts/{addr}")).await;
    assert!(!acc.flags.is_empty());

    // escape-hatch exit makes it Blocked
    let exit_to = Address::repeat_byte(0x33);
    let h: HashResponse = app.post("/chain/escape/hash", EscapeHashRequest { chain_id: None, address: addr, to: Some(exit_to) }).await;
    let started: EscapeResponse = app.post("/chain/escape/start", StartEscapeRequest { chain_id: None, address: addr, to: exit_to, signature: owner.sign(&h.hash) }).await;
    let EscapeStatus::Pending { unlock_at, .. } = started.escape else { panic!("{:?}", started.escape) };
    app.clock.set(unlock_at + 1);
    let exit = usdc_tx(addr, exit_to, 100);
    let prepared: PreparedOp = app.post("/chain/prepare", SimulateRequest { tx: exit.clone() }).await;
    app.submit(&owner, exit, &prepared, None).await;
    let r: ReviewReport = app.post(&format!("/review/{addr}"), serde_json::json!({})).await;
    assert_eq!(r.verdict, ReviewVerdict::Blocked, "{r:?}");
    assert!(r.flags.iter().any(|f| f.code == "ESCAPE_HATCH_EXIT" && f.source == FlagSource::Reconciliation));
    assert!(r.chain.ok, "flag events keep the chain consistent");
}

#[tokio::test]
async fn tampering_is_visible_through_verify_blocks_and_review() {
    let app = App::logged_in().await;
    let owner = Owner::new(16);
    let addr = app.onboard(&owner).await;
    let tx = usdc_tx(addr, KNOWN, 1);
    let (outcome, prepared) = app.cosign(&tx, &AccountContext { known_recipients: vec![KNOWN], own_per_tx_limit: None }, None).await;
    let CosignOutcome::Cosigned { cosignature, .. } = outcome else { panic!("{outcome:?}") };
    let mined = app.submit(&owner, tx, &prepared, Some(cosignature)).await;

    let page: Vec<BlockWithTxs> = app.get("/chain/blocks?limit=3").await;
    assert_eq!(page.len(), 3);
    assert!(page.iter().any(|b| b.block.number == mined.block_number && b.txs[0].hash == mined.tx_hash), "the mined tx is in the newest page (followed by its intent outcome)");
    assert_eq!(page[1].block.hash, page[2].block.parent_hash);
    let v: ChainVerification = app.get("/chain/verify").await;
    assert!(v.ok);

    let _: serde_json::Value = app.post("/dev/tamper", TamperRequest { chain_id: None, tamper: Tamper::TxValue { hash: mined.tx_hash, value: U256::from(7u64) } }).await;
    let v: ChainVerification = app.get("/chain/verify").await;
    assert!(!v.ok);
    assert_eq!(v.first_bad_block, Some(mined.block_number));
    let r: ReviewReport = app.post(&format!("/review/{addr}"), serde_json::json!({})).await;
    assert_eq!(r.verdict, ReviewVerdict::Blocked);
    assert!(r.flags.iter().any(|f| f.code == "CHAIN_TAMPERED" && f.source == FlagSource::Integrity), "{:?}", r.flags);
}

#[tokio::test]
async fn events_carry_features_network_and_feed_the_dataset_and_model() {
    let app = App::logged_in().await;
    let owner = Owner::new(17);
    let addr = app.onboard(&owner).await;

    // a co-signed payment: features come from the pre-state, latency from /assess, policy from the log
    let tx = usdc_tx(addr, Address::repeat_byte(0x66), 100_000_000);
    let a: AssessResponse = app.post("/assess", AssessRequest { tx: tx.clone(), account: None }).await;
    app.clock.advance(42);
    let (outcome, prepared) = app.cosign(&tx, &AccountContext::default(), None).await;
    let CosignOutcome::Cosigned { cosignature, .. } = outcome else { panic!("{outcome:?}") };
    let mined = app.submit(&owner, tx, &prepared, Some(cosignature)).await;
    let t: ChainTx = app.get(&format!("/chain/tx/{}", mined.tx_hash)).await;
    assert_eq!(t.network.family, ChainFamily::Ferra);
    let f = t.features.expect("features stored on the event");
    assert_eq!(f.decision_latency_secs, Some(42));
    assert_eq!(f.policy.score, a.assessment.score.into());
    assert_eq!(f.policy.reasons, vec!["NewRecipient".to_string()]);
    assert!(f.counterparty_new_for_sender);
    assert_eq!(f.signer_kind, "ed25519");
    assert!((f.fraction_of_balance - 0.2).abs() < 1e-9);

    // an event seen on Bitcoin lands on the Ferra chain with its origin
    let ext = ExternalRef {
        network: Network { family: ChainFamily::Bitcoin, name: "bitcoin-testnet".into(), chain_id: None },
        tx_id: "deadbeef".into(),
        block: Some(1),
        from_raw: "tb1qsomeone".into(),
        to_raw: "tb1qalice".into(),
        asset_symbol: "BTC".into(),
        decimals: 8,
        amount: "250000".into(),
        fee: Some(0.000003),
        explorer_url: Some("https://mempool.space/testnet/tx/deadbeef".into()),
    };
    let r: SubmitResult = app.post("/chain/ingest", IngestRequest { chain_id: None, wallet: addr, counterparty: None, incoming: true, event: ext }).await;
    assert_eq!(r.kind, TxKind::External);
    let t: ChainTx = app.get(&format!("/chain/tx/{}", r.tx_hash)).await;
    assert_eq!(t.network.name, "bitcoin-testnet");
    assert_eq!(t.to, addr);
    let v: ChainVerification = app.get("/chain/verify").await;
    assert!(v.ok);

    // the dataset exposes every featured event with its labels; the model describes itself
    let rows: Vec<DatasetRow> = app.get("/chain/dataset").await;
    assert!(rows.iter().any(|r| r.tx_hash == mined.tx_hash && r.label.is_none()));
    assert!(rows.iter().any(|r| r.features.network.family == ChainFamily::Bitcoin));
    let info: ModelInfo = app.get("/model").await;
    assert!(info.feature_count > 10);

    // a self-draining night-time payment to a fresh address right after an escape timer trips the model
    let exit_to = Address::repeat_byte(0x77);
    let h: HashResponse = app.post("/chain/escape/hash", EscapeHashRequest { chain_id: None, address: addr, to: Some(exit_to) }).await;
    let _: EscapeResponse = app.post("/chain/escape/start", StartEscapeRequest { chain_id: None, address: addr, to: exit_to, signature: owner.sign(&h.hash) }).await;
    let drain = usdc_tx(addr, Address::repeat_byte(0x88), 400_000_000);
    let (outcome, prepared) = app.cosign(&drain, &AccountContext::default(), None).await;
    let CosignOutcome::Cosigned { cosignature, .. } = outcome else { panic!("{outcome:?}") };
    let mined = app.submit(&owner, drain, &prepared, Some(cosignature)).await;
    let report: ReviewReport = app.post(&format!("/review/{addr}"), serde_json::json!({})).await;
    let model_flag = report.flags.iter().find(|f| f.code == "MODEL_RISK" && f.target == mined.tx_hash).unwrap_or_else(|| panic!("{:?}", report.flags));
    assert_eq!(model_flag.source, FlagSource::Model);
    assert!(model_flag.data.contains_key("top"));
    let rows: Vec<DatasetRow> = app.get("/chain/dataset").await;
    assert!(rows.iter().any(|r| r.tx_hash == mined.tx_hash && r.label_codes.contains(&"MODEL_RISK".to_string())));
}

#[tokio::test]
async fn sync_pulls_a_network_history_onto_the_ferra_chain_idempotently() {
    let app = App::logged_in().await;
    let owner = Owner::new(18);
    let addr = app.onboard(&owner).await;

    let nets: Vec<Network> = app.get("/networks").await;
    assert_eq!(nets.len(), 1);
    assert_eq!(nets[0].name, "ton-testnet");

    let r: SyncResponse = app.post("/chain/sync", SyncRequest { wallet: addr, network: "ton-testnet".into(), address_raw: "EQCalice".into(), limit: None, cursor: None }).await;
    assert_eq!((r.fetched, r.recorded, r.skipped_existing), (2, 2, 0));
    assert_eq!(r.next_cursor.as_deref(), Some("older"));

    let again: SyncResponse = app.post("/chain/sync", SyncRequest { wallet: addr, network: "ton-testnet".into(), address_raw: "EQCalice".into(), limit: None, cursor: None }).await;
    assert_eq!((again.fetched, again.recorded, again.skipped_existing), (2, 0, 2));
    let older: SyncResponse = app.post("/chain/sync", SyncRequest { wallet: addr, network: "ton-testnet".into(), address_raw: "EQCalice".into(), limit: None, cursor: Some("older".into()) }).await;
    assert_eq!(older.fetched, 0);
    assert!(older.next_cursor.is_none());

    let history: HistoryResponse = app.get(&format!("/chain/history/{addr}")).await;
    let ton: Vec<_> = history.txs.iter().filter(|t| t.kind == TxKind::External).collect();
    assert_eq!(ton.len(), 2);
    assert!(ton.iter().all(|t| t.network.family == ChainFamily::Ton && t.cosignature.is_some()));
    assert!(ton.iter().any(|t| t.to == addr) && ton.iter().any(|t| t.from == addr));
    assert!(ton.iter().all(|t| t.features.as_ref().is_some_and(|f| f.network.name == "ton-testnet")));
    let v: ChainVerification = app.get("/chain/verify").await;
    assert!(v.ok);

    let (s, e) = app.post_err("/chain/sync", SyncRequest { wallet: addr, network: "sui".into(), address_raw: "0x1".into(), limit: None, cursor: None }).await;
    assert_eq!((s, e.code.as_str()), (StatusCode::BAD_REQUEST, "BAD_REQUEST"));
}

#[tokio::test]
async fn events_expose_wallet_risk_and_reviewed_risk_separately() {
    let app = App::logged_in().await;
    let owner = Owner::new(19);
    let addr = app.onboard(&owner).await;
    let tx = usdc_tx(addr, MIXER_EXPOSED, 1_000_000);
    let (outcome, prepared) = app.cosign(&tx, &AccountContext::default(), None).await;
    let CosignOutcome::Held { hold_id, .. } = outcome else { panic!("{outcome:?}") };
    let hold: HoldState = app.post(&format!("/holds/{hold_id}/justify"), JustifyRequest { text: "Paying back a friend from the trip".into() }).await;
    let mined = app.submit(&owner, tx, &prepared, hold.cosignature).await;

    let t: ChainTx = app.get(&format!("/chain/tx/{}", mined.tx_hash)).await;
    assert_eq!(t.risk_level, Some(RiskBand::High), "what the wallet computed at co-sign time");
    assert_eq!(t.reviewed_risk, None, "no tool has looked yet");
    let _: ReviewReport = app.post(&format!("/review/{addr}"), serde_json::json!({})).await;
    let t: ChainTx = app.get(&format!("/chain/tx/{}", mined.tx_hash)).await;
    assert_eq!(t.reviewed_risk, Some(RiskBand::High), "the review's verdict, from its flags");
    assert_eq!(t.risk_level, Some(RiskBand::High), "the wallet's verdict is immutable");
}

#[tokio::test]
async fn intents_settings_profile_and_behaviour_flags_through_the_api() {
    let app = App::logged_in().await;
    let owner = Owner::new(20);
    let addr = app.onboard(&owner).await;

    // the owner sets a 20 % per-transaction limit, signed with the passkey
    let settings = WalletSettings { per_tx_limit_pct: 20, ..Default::default() };
    let h: HashResponse = app.post(&format!("/settings/{addr}/hash"), SettingsHashRequest { settings: settings.clone() }).await;
    let (s, _) = app.post_err(&format!("/settings/{addr}"), SetSettingsRequest { settings: settings.clone(), signature: Owner::new(21).sign(&h.hash) }).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    let set: SettingsResponse = app.post(&format!("/settings/{addr}"), SetSettingsRequest { settings: settings.clone(), signature: owner.sign(&h.hash) }).await;
    assert_eq!(set.tx.unwrap().kind, TxKind::SettingsChanged);
    let got: SettingsResponse = app.get(&format!("/settings/{addr}")).await;
    assert_eq!(got.settings.per_tx_limit_pct, 20);

    // a habit: six small payments, each composed (intent) then submitted (outcome)
    let merchant = Address::repeat_byte(0x44);
    for _ in 0..6 {
        let tx = usdc_tx(addr, merchant, 5_000_000);
        let a: AssessResponse = app.post("/assess", AssessRequest { tx: tx.clone(), account: None }).await;
        let id = a.intent_id.expect("intent recorded at assess time");
        let st: IntentState = app.get(&format!("/intents/{addr}/{id}")).await;
        assert_eq!(st.outcome, None);
        let (outcome, prepared) = app.cosign(&tx, &AccountContext::default(), None).await;
        let CosignOutcome::Cosigned { cosignature, .. } = outcome else { panic!("{outcome:?}") };
        app.submit(&owner, tx, &prepared, Some(cosignature)).await;
        let st: IntentState = app.get(&format!("/intents/{addr}/{id}")).await;
        assert_eq!(st.outcome, Some(IntentOutcomeKind::Submitted));
        app.clock.advance(3_600);
    }
    let p: WalletProfile = app.get(&format!("/profile/{addr}")).await;
    assert_eq!(p.archetype, Archetype::Holder);
    assert_eq!(p.out_count, 6);
    assert!(p.submitted >= 6, "every composition of a landed tx is resolved: {}", p.submitted);
    assert_eq!(p.cancelled, 0);
    assert_eq!(p.distinct_recipients, 1);

    // then the user composes a 200 USDC payment to a stranger, cancels twice, and goes through
    let stranger = Address::repeat_byte(0x99);
    let big = usdc_tx(addr, stranger, 200_000_000);
    for _ in 0..2 {
        let a: AssessResponse = app.post("/assess", AssessRequest { tx: big.clone(), account: None }).await;
        assert!(a.assessment.reasons.iter().any(|r| r.code == ReasonCode::OwnLimitExceeded), "{:?}", a.assessment);
        let id = a.intent_id.unwrap();
        let c: IntentState = app.post(&format!("/intents/{addr}/{id}/cancel"), serde_json::json!({})).await;
        assert_eq!(c.outcome, Some(IntentOutcomeKind::Cancelled));
        let (s, _) = app.post_err(&format!("/intents/{addr}/{id}/cancel"), serde_json::json!({})).await;
        assert_eq!(s, StatusCode::CONFLICT);
        app.clock.advance(60);
    }
    // own-limit + new recipient + large amount puts it in Medium → step-up, then it lands
    let (first, prepared) = app.cosign(&big, &AccountContext::default(), None).await;
    let CosignOutcome::StepUp { step_up_hash, .. } = first else { panic!("{first:?}") };
    let (second, prepared2) = app.cosign(&big, &AccountContext::default(), Some(owner.sign(&step_up_hash))).await;
    assert_eq!(prepared.user_op_hash, prepared2.user_op_hash);
    let CosignOutcome::Cosigned { cosignature, .. } = second else { panic!("{second:?}") };
    let mined = app.submit(&owner, big, &prepared2, Some(cosignature)).await;

    let t: ChainTx = app.get(&format!("/chain/tx/{}", mined.tx_hash)).await;
    let f = t.features.unwrap();
    assert_eq!(f.archetype, "holder");
    assert!(f.exceeds_own_limit);
    assert!(f.cancels_24h >= 2, "{}", f.cancels_24h);
    assert!(f.amount_vs_mean_out > 30.0);

    let r: ReviewReport = app.post(&format!("/review/{addr}"), serde_json::json!({})).await;
    let codes: Vec<&str> = r.flags.iter().filter(|f| f.target == mined.tx_hash).map(|f| f.code.as_str()).collect();
    assert!(codes.contains(&"CANCEL_STREAK"), "{codes:?}");
    assert!(codes.contains(&"BEHAVIOUR_DEVIATION"), "{codes:?}");
    assert!(codes.contains(&"OWN_LIMIT_BYPASS"), "{codes:?}");
    assert!(r.flags.iter().any(|f| f.source == FlagSource::Behaviour));
    assert_eq!(r.verdict, ReviewVerdict::Suspicious);
    let p: WalletProfile = app.get(&format!("/profile/{addr}")).await;
    assert_eq!(p.cancelled, 2);
    assert!(p.cancel_rate > 0.0);
    assert!(r.chain.ok);
}

#[tokio::test]
async fn provenance_checks_the_counterparty_on_its_origin_network() {
    let app = App::logged_in().await;
    let owner = Owner::new(22);
    let addr = app.onboard(&owner).await;
    let _: SyncResponse = app.post("/chain/sync", SyncRequest { wallet: addr, network: "ton-testnet".into(), address_raw: "EQCalice".into(), limit: None, cursor: None }).await;
    let history: HistoryResponse = app.get(&format!("/chain/history/{addr}")).await;
    let inbound = history.txs.iter().find(|t| t.kind == TxKind::External && t.to == addr).unwrap();

    let pr: ProvenanceResponse = app.post(&format!("/provenance/{}", inbound.hash), serde_json::json!({})).await;
    assert!(pr.assessment.verified);
    assert_eq!(pr.assessment.counterparty, "EQCsomeone");
    assert!(pr.assessment.reasons.iter().any(|r| r.code == "PASS_THROUGH"), "{:?}", pr.assessment);
    assert_eq!(pr.assessment.risk, RiskBand::High);
    assert!(pr.flagged);

    let t: ChainTx = app.get(&format!("/chain/tx/{}", inbound.hash)).await;
    assert!(t.flags.iter().any(|f| f.code == "PROVENANCE" && f.source == FlagSource::Provenance));
    assert_eq!(t.reviewed_risk, Some(RiskBand::High));

    // the review can run the same check for whatever is still unjudged, and is idempotent
    let r: ReviewReport = app.post(&format!("/review/{addr}?provenance=true"), serde_json::json!({})).await;
    let prov: Vec<_> = r.flags.iter().filter(|f| f.code == "PROVENANCE").collect();
    assert_eq!(prov.len(), 2, "one verdict per external event, both against the same mule");
    assert_ne!(prov[0].target, prov[1].target);
    assert_eq!(r.verdict, ReviewVerdict::Suspicious);
    let v: ChainVerification = app.get("/chain/verify").await;
    assert!(v.ok);
}
