use alloy_primitives::{Address, Bytes, U256};

use super::{DecodedAction, TxDecoder, TxRequest};
use crate::CoreError;

/// `transfer(address,uint256)`
pub const SEL_TRANSFER: [u8; 4] = [0xa9, 0x05, 0x9c, 0xbb];
/// `approve(address,uint256)`
pub const SEL_APPROVE: [u8; 4] = [0x09, 0x5e, 0xa7, 0xb3];

/// Decodes plain transfers and the two ERC-20 calls the demo needs; anything else is a `ContractCall`.
#[derive(Debug, Default, Clone)]
pub struct AbiTxDecoder;

impl AbiTxDecoder {
    pub fn new() -> Self {
        Self
    }

    fn word(data: &[u8], index: usize) -> Result<[u8; 32], CoreError> {
        let start = 4 + index * 32;
        let slice = data
            .get(start..start + 32)
            .ok_or_else(|| CoreError::Decode(format!("calldata too short for argument {index}")))?;
        let mut out = [0u8; 32];
        out.copy_from_slice(slice);
        Ok(out)
    }

    fn address_arg(data: &[u8], index: usize) -> Result<Address, CoreError> {
        let w = Self::word(data, index)?;
        if w[..12].iter().any(|b| *b != 0) {
            return Err(CoreError::Decode(format!("argument {index} is not a clean address")));
        }
        Ok(Address::from_slice(&w[12..]))
    }

    fn u256_arg(data: &[u8], index: usize) -> Result<U256, CoreError> {
        Ok(U256::from_be_bytes(Self::word(data, index)?))
    }
}

impl TxDecoder for AbiTxDecoder {
    fn decode(&self, req: &TxRequest) -> Result<DecodedAction, CoreError> {
        let data: &[u8] = &req.data;
        if data.is_empty() {
            return Ok(DecodedAction::NativeTransfer { to: req.to, amount: req.value });
        }
        let selector: [u8; 4] = data
            .get(..4)
            .and_then(|s| s.try_into().ok())
            .ok_or_else(|| CoreError::Decode("calldata shorter than a selector".into()))?;
        match selector {
            SEL_TRANSFER => Ok(DecodedAction::Erc20Transfer {
                token: req.to,
                to: Self::address_arg(data, 0)?,
                amount: Self::u256_arg(data, 1)?,
            }),
            SEL_APPROVE => {
                let amount = Self::u256_arg(data, 1)?;
                Ok(DecodedAction::Erc20Approve {
                    token: req.to,
                    spender: Self::address_arg(data, 0)?,
                    amount,
                    unlimited: amount == U256::MAX,
                })
            }
            _ => Ok(DecodedAction::ContractCall {
                target: req.to,
                selector: Bytes::copy_from_slice(&selector),
                value: req.value,
            }),
        }
    }
}

/// Build ERC-20 calldata; used by tests, fixtures and the mock chain.
pub fn encode_erc20_call(selector: [u8; 4], addr: Address, amount: U256) -> Bytes {
    let mut out = Vec::with_capacity(68);
    out.extend_from_slice(&selector);
    out.extend_from_slice(&[0u8; 12]);
    out.extend_from_slice(addr.as_slice());
    out.extend_from_slice(&amount.to_be_bytes::<32>());
    Bytes::from(out)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn req(to: Address, value: U256, data: Bytes) -> TxRequest {
        TxRequest { chain_id: 1, from: Address::ZERO, to, value, data, origin: None }
    }

    #[test]
    fn decodes_native_transfer() {
        let to = Address::repeat_byte(1);
        let action = AbiTxDecoder::new().decode(&req(to, U256::from(5), Bytes::new())).unwrap();
        assert_eq!(action, DecodedAction::NativeTransfer { to, amount: U256::from(5) });
    }

    #[test]
    fn decodes_erc20_transfer_and_unlimited_approve() {
        let token = Address::repeat_byte(9);
        let to = Address::repeat_byte(2);
        let d = AbiTxDecoder::new();
        let t = d.decode(&req(token, U256::ZERO, encode_erc20_call(SEL_TRANSFER, to, U256::from(7)))).unwrap();
        assert_eq!(t, DecodedAction::Erc20Transfer { token, to, amount: U256::from(7) });
        let a = d.decode(&req(token, U256::ZERO, encode_erc20_call(SEL_APPROVE, to, U256::MAX))).unwrap();
        assert!(matches!(a, DecodedAction::Erc20Approve { unlimited: true, .. }));
    }

    #[test]
    fn unknown_selector_is_contract_call() {
        let a = AbiTxDecoder::new().decode(&req(Address::ZERO, U256::ZERO, Bytes::from(vec![1, 2, 3, 4]))).unwrap();
        assert!(matches!(a, DecodedAction::ContractCall { .. }));
    }

    #[test]
    fn short_calldata_is_decode_error() {
        let e = AbiTxDecoder::new()
            .decode(&req(Address::ZERO, U256::ZERO, Bytes::from(vec![0xa9, 0x05, 0x9c, 0xbb, 1])))
            .unwrap_err();
        assert_eq!(e.code(), "DECODE");
    }
}
