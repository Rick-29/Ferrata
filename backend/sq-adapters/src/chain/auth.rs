//! Owner authentication for pseudo-chain accounts: a raw Ed25519 key (fast fake passkey in JS)
//! or a real WebAuthn P-256 credential, verified the way an on-chain verifier would.

use alloy_primitives::{B256, Bytes};
use base64::Engine;
use ed25519_dalek::VerifyingKey;
use p256::ecdsa::signature::Verifier;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum OwnerKey {
    /// 32-byte Ed25519 public key, hex.
    Ed25519 {
        #[ts(type = "string")]
        key: Bytes,
    },
    /// Uncompressed SEC1 P-256 public key (65 bytes, `0x04…`), hex. What a WebAuthn credential exposes.
    P256 {
        #[ts(type = "string")]
        key: Bytes,
    },
}

impl OwnerKey {
    pub fn bytes(&self) -> &[u8] {
        match self {
            OwnerKey::Ed25519 { key } | OwnerKey::P256 { key } => key,
        }
    }

    pub fn validate(&self) -> Result<(), String> {
        match self {
            OwnerKey::Ed25519 { key } => {
                let arr: [u8; 32] = key.as_ref().try_into().map_err(|_| "ed25519 key must be 32 bytes")?;
                VerifyingKey::from_bytes(&arr).map(|_| ()).map_err(|e| e.to_string())
            }
            OwnerKey::P256 { key } => {
                p256::ecdsa::VerifyingKey::from_sec1_bytes(key).map(|_| ()).map_err(|e| e.to_string())
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum OwnerSignature {
    Ed25519 {
        #[ts(type = "string")]
        signature: Bytes,
    },
    /// Raw `navigator.credentials.get` output. The challenge must be the hash being authorised.
    #[serde(rename = "webauthn")]
    WebAuthn {
        #[ts(type = "string")]
        authenticator_data: Bytes,
        #[ts(type = "string")]
        client_data_json: Bytes,
        /// DER-encoded ECDSA signature, as returned by the authenticator.
        #[ts(type = "string")]
        signature: Bytes,
    },
}

#[derive(Deserialize)]
struct ClientData {
    #[serde(rename = "type")]
    kind: String,
    challenge: String,
}

/// Verifies `sig` over `hash` for `key`. Returns `false` on any malformed input.
pub fn verify_owner(key: &OwnerKey, hash: &B256, sig: &OwnerSignature) -> bool {
    match (key, sig) {
        (OwnerKey::Ed25519 { key }, OwnerSignature::Ed25519 { signature }) => {
            let Ok(arr) = <[u8; 32]>::try_from(key.as_ref()) else {
                return false;
            };
            let Ok(k) = VerifyingKey::from_bytes(&arr) else {
                return false;
            };
            let Ok(s) = <[u8; 64]>::try_from(signature.as_ref()) else {
                return false;
            };
            k.verify_strict(hash.as_slice(), &ed25519_dalek::Signature::from_bytes(&s)).is_ok()
        }
        (OwnerKey::P256 { key }, OwnerSignature::WebAuthn { authenticator_data, client_data_json, signature }) => {
            let Ok(k) = p256::ecdsa::VerifyingKey::from_sec1_bytes(key) else {
                return false;
            };
            let Ok(client): Result<ClientData, _> = serde_json::from_slice(client_data_json) else {
                return false;
            };
            if client.kind != "webauthn.get" {
                return false;
            }
            let expected = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(hash.as_slice());
            if client.challenge != expected {
                return false;
            }
            let Ok(s) = p256::ecdsa::Signature::from_der(signature) else {
                return false;
            };
            let mut msg = authenticator_data.to_vec();
            msg.extend_from_slice(&Sha256::digest(client_data_json));
            k.verify(&msg, &s).is_ok()
        }
        _ => false,
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use p256::ecdsa::SigningKey as P256Signing;

    /// Vector produced by the recovery phone's own code (`frontend/packages/mobile/src/device/assertion.ts`,
    /// secret = 32 x 0x07): the phone's key answers in the WebAuthn format this verifies.
    #[test]
    fn recovery_phone_assertion_verifies() {
        let hex = |s: &str| Bytes::from(alloy_primitives::hex::decode(s).unwrap());
        let key = OwnerKey::P256 { key: hex("0x041e18532fd4754c02f3041d9c75ceb33b83ffd81ac7ce4fe882ccb1c98bc5896ea46c311c4e2ff40dd96a3653e6e45445d32dfe486eced75c7a90c6a18881c0a3") };
        let sig = OwnerSignature::WebAuthn {
            authenticator_data: hex("0xd0b0f41ab28539f3f9fd83a1d7d65a25daa1edd779d7dcbe332a8c94895fd5d90500000000"),
            client_data_json: hex("0x7b2274797065223a22776562617574686e2e676574222c226368616c6c656e6765223a2271367572713675727136757271367572713675727136757271367572713675727136757271367572713673222c226f726967696e223a22666572726174612d7265636f766572792d70686f6e65227d"),
            signature: hex("0x304402201c91fbc7267916ecc575d2751282e5027836a03e7500bb264126d18ae4ae6bdf022007eb653699add0938badf052143b7bc47193dcfe35e1fbf2abc6c9904e296a3e"),
        };
        let hash = B256::repeat_byte(0xab);
        assert!(verify_owner(&key, &hash, &sig));
        assert!(!verify_owner(&key, &B256::repeat_byte(0xcd), &sig), "bound to the recovery hash");
    }

    #[test]
    fn ed25519_roundtrip() {
        let sk = SigningKey::from_bytes(&[1u8; 32]);
        let key = OwnerKey::Ed25519 { key: Bytes::copy_from_slice(sk.verifying_key().as_bytes()) };
        let hash = B256::repeat_byte(7);
        let sig = OwnerSignature::Ed25519 { signature: Bytes::copy_from_slice(&sk.sign(hash.as_slice()).to_bytes()) };
        assert!(verify_owner(&key, &hash, &sig));
        assert!(!verify_owner(&key, &B256::repeat_byte(8), &sig));
    }

    #[test]
    fn webauthn_roundtrip() {
        let sk = P256Signing::from_bytes(&[2u8; 32].into()).unwrap();
        let pk = sk.verifying_key().to_encoded_point(false);
        let key = OwnerKey::P256 { key: Bytes::copy_from_slice(pk.as_bytes()) };
        let hash = B256::repeat_byte(9);
        let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(hash.as_slice());
        let client = format!(r#"{{"type":"webauthn.get","challenge":"{challenge}","origin":"chrome-extension://abc"}}"#);
        let auth_data = vec![0xAAu8; 37];
        let mut msg = auth_data.clone();
        msg.extend_from_slice(&Sha256::digest(client.as_bytes()));
        let der: p256::ecdsa::Signature = sk.sign(&msg);
        let sig = OwnerSignature::WebAuthn {
            authenticator_data: Bytes::from(auth_data),
            client_data_json: Bytes::from(client.into_bytes()),
            signature: Bytes::from(der.to_der().as_bytes().to_vec()),
        };
        assert!(verify_owner(&key, &hash, &sig));
        assert!(!verify_owner(&key, &B256::repeat_byte(1), &sig));
    }
}
