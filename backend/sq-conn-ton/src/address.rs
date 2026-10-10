//! TON address forms. Friendly: base64url of `[tag, workchain, hash32, crc16]` (36 bytes);
//! tag bit 0x11 bounceable, 0x51 non-bounceable, 0x80 testnet. Raw: `workchain:hex64`.
//! Ported from NetView `wallet-info/src/decoder.rs`.

use base64::Engine;

fn crc16(data: &[u8]) -> u16 {
    let mut crc: u16 = 0;
    for &b in data {
        crc ^= u16::from(b) << 8;
        for _ in 0..8 {
            crc = if crc & 0x8000 != 0 { (crc << 1) ^ 0x1021 } else { crc << 1 };
        }
    }
    crc
}

fn decode_friendly(addr: &str) -> Option<[u8; 36]> {
    let normalized = addr.replace('-', "+").replace('_', "/");
    let padding = match normalized.len() % 4 {
        0 => String::new(),
        n => "=".repeat(4 - n),
    };
    let raw = base64::engine::general_purpose::STANDARD.decode(format!("{normalized}{padding}")).ok()?;
    let bytes: [u8; 36] = raw.try_into().ok()?;
    let crc = crc16(&bytes[..34]);
    if bytes[34] != (crc >> 8) as u8 || bytes[35] != (crc & 0xff) as u8 {
        return None;
    }
    Some(bytes)
}

/// `0:abcd…` for any friendly or raw input; `None` when it is neither.
pub fn to_raw(addr: &str) -> Option<String> {
    let addr = addr.trim();
    if let Some((wc, hex_part)) = addr.split_once(':')
        && wc.parse::<i32>().is_ok()
        && hex_part.len() == 64
        && hex_part.chars().all(|c| c.is_ascii_hexdigit())
    {
        return Some(format!("{wc}:{}", hex_part.to_lowercase()));
    }
    let bytes = decode_friendly(addr)?;
    let workchain = bytes[1] as i8;
    Some(format!("{workchain}:{}", hex::encode(&bytes[2..34])))
}

/// Friendly form of a raw address.
pub fn to_friendly(raw: &str, bounceable: bool, testnet: bool) -> Option<String> {
    let (wc, hex_part) = raw.split_once(':')?;
    let workchain: i8 = wc.parse().ok()?;
    let hash = hex::decode(hex_part).ok()?;
    if hash.len() != 32 {
        return None;
    }
    let mut tag: u8 = if bounceable { 0x11 } else { 0x51 };
    if testnet {
        tag |= 0x80;
    }
    let mut bytes = vec![tag, workchain as u8];
    bytes.extend_from_slice(&hash);
    let crc = crc16(&bytes);
    bytes.push((crc >> 8) as u8);
    bytes.push((crc & 0xff) as u8);
    Some(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&bytes))
}

/// Whether a friendly address carries the testnet flag.
pub fn is_testnet_flagged(addr: &str) -> bool {
    decode_friendly(addr).is_some_and(|b| b[0] & 0x80 != 0)
}

/// Canonical bounceable mainnet form, or the input unchanged when it does not parse.
pub fn normalize(addr: &str) -> String {
    to_raw(addr).and_then(|r| to_friendly(&r, true, false)).unwrap_or_else(|| addr.to_string())
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    // From NetView's recorded samples: a mainnet bounceable address.
    const FRIENDLY: &str = "EQD_N0hrgbiQzAh72500KZbYU76VOOEg5RxIu4unxZGhAdXC";

    #[test]
    fn friendly_to_raw_and_back() {
        let raw = to_raw(FRIENDLY).unwrap();
        assert!(raw.starts_with("0:"));
        assert_eq!(raw.len(), 2 + 64);
        assert_eq!(to_friendly(&raw, true, false).unwrap(), FRIENDLY);
        assert_eq!(to_raw(&raw).unwrap(), raw, "raw is idempotent");
        assert_eq!(normalize(FRIENDLY), FRIENDLY);
        // non-bounceable and testnet variants of the same account map to the same raw
        let nb = to_friendly(&raw, false, true).unwrap();
        assert!(nb.starts_with("0Q"), "{nb}");
        assert!(is_testnet_flagged(&nb));
        assert_eq!(to_raw(&nb).unwrap(), raw);
    }

    #[test]
    fn rejects_garbage_and_bad_crc() {
        assert_eq!(to_raw("not-an-address"), None);
        let mut broken = FRIENDLY.to_string();
        broken.replace_range(10..11, if &FRIENDLY[10..11] == "A" { "B" } else { "A" });
        assert_eq!(to_raw(&broken), None, "crc catches a changed character");
        assert_eq!(normalize("xyz"), "xyz");
    }
}
