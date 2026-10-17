//! Hashes, Ed25519 and encodings for novad (FR-142 signed capability documents, FR-148 signed update bundles). SHA-256/512 come from the `sha2` crate and Ed25519 (RFC 8032) from `ed25519-dalek`; this module only adapts them to novad's byte-array API. Checked against the FIPS 180-4 and RFC 8032 test vectors.
#![allow(dead_code)]

use std::io::Read;

use sha2::Digest;

// ---------------------------------------------------------------------------
// SHA-256 and SHA-512 (FIPS 180-4), from `sha2`
// ---------------------------------------------------------------------------

/// Streaming SHA-256 for hashing files in chunks.
pub struct Sha256(sha2::Sha256);

impl Sha256 {
    pub fn new() -> Self {
        Self(sha2::Sha256::new())
    }

    pub fn update(&mut self, data: &[u8]) {
        self.0.update(data);
    }

    pub fn finalize(self) -> [u8; 32] {
        let mut out = [0u8; 32];
        out.copy_from_slice(&self.0.finalize());
        out
    }
}

impl Default for Sha256 {
    fn default() -> Self {
        Self::new()
    }
}

pub fn sha256(data: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(data);
    h.finalize()
}

pub fn sha512(data: &[u8]) -> [u8; 64] {
    let mut out = [0u8; 64];
    out.copy_from_slice(&sha2::Sha512::digest(data));
    out
}

// ---------------------------------------------------------------------------
// Hex and base64 (RFC 4648)
// ---------------------------------------------------------------------------

/// Lowercase hex.
pub fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        s.push(DIGITS[usize::from(b >> 4)] as char);
        s.push(DIGITS[usize::from(b & 0x0f)] as char);
    }
    s
}

fn hex_digit(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

/// Lowercase/uppercase hex decode; None on odd length or a bad digit.
pub fn hex_decode(s: &str) -> Option<Vec<u8>> {
    let b = s.as_bytes();
    if b.len() % 2 != 0 {
        return None;
    }
    b.chunks_exact(2)
        .map(|pair| Some((hex_digit(pair[0])? << 4) | hex_digit(pair[1])?))
        .collect()
}

const B64_STD: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_URL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

// Character -> 6-bit value, 0xff for characters outside the alphabet.
const fn b64_reverse(alphabet: &[u8; 64]) -> [u8; 256] {
    let mut table = [0xffu8; 256];
    let mut i = 0;
    while i < 64 {
        table[alphabet[i] as usize] = i as u8;
        i += 1;
    }
    table
}

const B64_STD_REV: [u8; 256] = b64_reverse(B64_STD);
const B64_URL_REV: [u8; 256] = b64_reverse(B64_URL);

fn b64_encode_with(bytes: &[u8], alphabet: &[u8; 64], pad: bool) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = u32::from(chunk[0]);
        let b1 = u32::from(chunk.get(1).copied().unwrap_or(0));
        let b2 = u32::from(chunk.get(2).copied().unwrap_or(0));
        let n = (b0 << 16) | (b1 << 8) | b2;
        // n input bytes carry 8n bits, which need n + 1 six-bit characters.
        let chars = chunk.len() + 1;
        for i in 0..4 {
            if i < chars {
                out.push(alphabet[((n >> (18 - 6 * i)) & 63) as usize] as char);
            } else if pad {
                out.push('=');
            }
        }
    }
    out
}

fn b64_decode_with(s: &str, reverse: &[u8; 256]) -> Option<Vec<u8>> {
    let input = s.as_bytes();
    let pad = input.iter().rev().take_while(|&&c| c == b'=').count();
    // Padding is optional, but when present it must complete a 4-character group.
    if pad > 2 || (pad > 0 && input.len() % 4 != 0) {
        return None;
    }
    let body = &input[..input.len() - pad];
    // A lone trailing character carries only 6 bits: no byte string encodes to it.
    if body.len() % 4 == 1 {
        return None;
    }
    let mut out = Vec::with_capacity(body.len() / 4 * 3 + 2);
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    for &c in body {
        let v = reverse[usize::from(c)];
        if v == 0xff {
            return None;
        }
        acc = (acc << 6) | u32::from(v);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    // Leftover bits must be zero so every byte string has exactly one encoding.
    if acc != 0 {
        return None;
    }
    Some(out)
}

/// base64url without padding (RFC 4648 section 5).
pub fn b64url_encode(bytes: &[u8]) -> String {
    b64_encode_with(bytes, B64_URL, false)
}

/// base64url; padding optional; None on any invalid character or impossible length.
pub fn b64url_decode(s: &str) -> Option<Vec<u8>> {
    b64_decode_with(s, &B64_URL_REV)
}

/// Standard base64 with padding (RFC 4648 section 4).
pub fn b64_encode(bytes: &[u8]) -> String {
    b64_encode_with(bytes, B64_STD, true)
}

/// Standard base64; padding optional; ASCII whitespace NOT allowed; None when invalid.
pub fn b64_decode(s: &str) -> Option<Vec<u8>> {
    b64_decode_with(s, &B64_STD_REV)
}

// ---------------------------------------------------------------------------
// Ed25519 (RFC 8032 section 5.1), from `ed25519-dalek`
// ---------------------------------------------------------------------------

/// An Ed25519 key pair from a 32-byte seed (RFC 8032 private key). The secret is wiped on drop.
pub struct SigningKey(ed25519_dalek::SigningKey);

impl SigningKey {
    pub fn from_seed(seed: &[u8; 32]) -> Self {
        Self(ed25519_dalek::SigningKey::from_bytes(seed))
    }

    pub fn public_key(&self) -> [u8; 32] {
        self.0.verifying_key().to_bytes()
    }

    /// Deterministic (RFC 8032): the same key and message always give the same signature.
    pub fn sign(&self, msg: &[u8]) -> [u8; 64] {
        use ed25519_dalek::Signer;
        self.0.sign(msg).to_bytes()
    }
}

// RFC 8032 section 5.1.3 decoding: a curve point in its one canonical encoding. ed25519-dalek
// also accepts y >= p and a set sign bit on x = 0 (ZIP-215 leniency); re-encoding the decoded
// point and comparing rejects both, so every public key has exactly one accepted spelling.
fn decode_public_key(bytes: &[u8; 32]) -> Option<ed25519_dalek::VerifyingKey> {
    let key = ed25519_dalek::VerifyingKey::from_bytes(bytes).ok()?;
    (key.to_edwards().compress().as_bytes() == bytes).then_some(key)
}

/// RFC 8032 verification. Returns false (never panics) for a public key that is not the
/// canonical encoding of a curve point, a small-order (weak) public key or R, S >= L
/// (non-canonical signature scalar), or any tampered byte.
pub fn verify(public_key: &[u8; 32], msg: &[u8], sig: &[u8; 64]) -> bool {
    let Some(key) = decode_public_key(public_key) else {
        return false;
    };
    // verify_strict: S < L, a canonical R, and no small-order key or R. A small-order key
    // would otherwise accept one forged signature for every message (see the tests).
    key.verify_strict(msg, &ed25519_dalek::Signature::from_bytes(sig)).is_ok()
}

// ---------------------------------------------------------------------------
// Randomness and comparison
// ---------------------------------------------------------------------------

/// Bytes from the OS (read /dev/urandom); Err with a message when unavailable.
pub fn random_bytes(out: &mut [u8]) -> Result<(), String> {
    let mut f = std::fs::File::open("/dev/urandom")
        .map_err(|e| format!("cannot open /dev/urandom: {e}"))?;
    f.read_exact(out).map_err(|e| format!("cannot read /dev/urandom: {e}"))
}

/// Constant-time equality for tokens (false when lengths differ).
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    // Lengths are not secret; the contents are compared without an early exit.
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b) {
        diff |= x ^ y;
    }
    // Keep the optimizer from turning the loop back into an early-exit compare.
    std::hint::black_box(diff) == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unhex(s: &str) -> Vec<u8> {
        hex_decode(s).expect("valid hex in test data")
    }

    fn arr32(s: &str) -> [u8; 32] {
        unhex(s).try_into().expect("32 bytes")
    }

    fn arr64(s: &str) -> [u8; 64] {
        unhex(s).try_into().expect("64 bytes")
    }

    // ---- SHA-256 ----------------------------------------------------------

    #[test]
    fn sha256_fips_vectors() {
        assert_eq!(
            hex(&sha256(b"")),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            hex(&sha256(b"abc")),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            hex(&sha256(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")),
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
        );
    }

    #[test]
    fn sha256_million_a() {
        let data = vec![b'a'; 1_000_000];
        assert_eq!(
            hex(&sha256(&data)),
            "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"
        );
        // The same input streamed in uneven pieces.
        let mut h = Sha256::default();
        let mut rest: &[u8] = &data;
        let mut step = 1;
        while !rest.is_empty() {
            let n = step.min(rest.len());
            h.update(&rest[..n]);
            rest = &rest[n..];
            step = step * 7 % 1013 + 1;
        }
        assert_eq!(
            hex(&h.finalize()),
            "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"
        );
    }

    #[test]
    fn sha256_streaming_matches_one_shot() {
        let data: Vec<u8> = (0..5000u32).map(|i| (i * 31 + 7) as u8).collect();
        for len in [0usize, 1, 55, 56, 63, 64, 65, 119, 120, 128, 1000, 5000] {
            let msg = &data[..len];
            for chunk in [1usize, 3, 7, 13, 63, 64, 65, 127] {
                let mut h = Sha256::new();
                for piece in msg.chunks(chunk) {
                    h.update(piece);
                }
                assert_eq!(h.finalize(), sha256(msg), "len {len} chunk {chunk}");
            }
        }
    }

    // ---- SHA-512 ----------------------------------------------------------

    #[test]
    fn sha512_fips_vectors() {
        assert_eq!(
            hex(&sha512(b"")),
            "cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce\
             47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e"
        );
        assert_eq!(
            hex(&sha512(b"abc")),
            "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a\
             2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f"
        );
        // 112 bytes: the length no longer fits in the first block's padding.
        assert_eq!(
            hex(&sha512(
                b"abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu"
            )),
            "8e959b75dae313da8cf4f72814fc143f8f7779c6eb9f7fa17299aeadb6889018\
             501d289e4900f7e4331b99dec4b5433ac7d329eeb6dd26545e96e55b874be909"
        );
    }

    // ---- Ed25519 ----------------------------------------------------------

    // L = 2^252 + 27742317777372353535851937790883648493, the base point's order, little-endian.
    const L: [u8; 32] = [
        0xed, 0xd3, 0xf5, 0x5c, 0x1a, 0x63, 0x12, 0x58, 0xd6, 0x9c, 0xf7, 0xa2, 0xde, 0xf9, 0xde,
        0x14, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x10,
    ];

    struct Vector {
        secret: &'static str,
        public: &'static str,
        msg: &'static str,
        sig: &'static str,
    }

    // RFC 8032 section 7.1: TEST 1, TEST 2, TEST 3 and TEST SHA(abc).
    const VECTORS: [Vector; 4] = [
        Vector {
            // secret-scan: fake
            secret: "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
            public: "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
            msg: "",
            sig: "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
        },
        Vector {
            // secret-scan: fake
            secret: "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb",
            public: "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c",
            msg: "72",
            sig: "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00",
        },
        Vector {
            // secret-scan: fake
            secret: "c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7",
            public: "fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025",
            msg: "af82",
            sig: "6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a",
        },
        Vector {
            // secret-scan: fake
            secret: "833fe62409237b9d62ec77587520911e9a759cec1d19755b7da901b96dca3d42",
            public: "ec172b93ad5e563bf4932c70e1245034c35467ef2efd4d64ebf819683467e2bf",
            msg: "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f",
            sig: "dc2a4459e7369633a52b1bf277839a00201009a3efbf3ecb69bea2186c26b58909351fc9ac90b3ecfdfbc7c66431e0303dca179c138ac17ad9bef1177331a704",
        },
    ];

    #[test]
    fn ed25519_rfc8032_vectors() {
        for v in &VECTORS {
            let key = SigningKey::from_seed(&arr32(v.secret));
            assert_eq!(hex(&key.public_key()), v.public);
            let msg = unhex(v.msg);
            let sig = key.sign(&msg);
            assert_eq!(hex(&sig), v.sig);
            assert!(verify(&arr32(v.public), &msg, &arr64(v.sig)));
        }
    }

    #[test]
    fn ed25519_matches_openssl_on_a_multi_block_message() {
        // Generated by Node 26's crypto.sign (OpenSSL 3.5.7) with seed [3; 32], the update-key
        // seed the tests use, over 1000 bytes: an independent implementation, and a message
        // long enough that every SHA-512 inside signing spans several blocks.
        let key = SigningKey::from_seed(&[3u8; 32]);
        assert_eq!(
            hex(&key.public_key()),
            "ed4928c628d1c2c6eae90338905995612959273a5c63f93636c14614ac8737d1"
        );
        let msg: Vec<u8> = (0..1000u32).map(|i| (i * 31 + 7) as u8).collect();
        let sig = key.sign(&msg);
        assert_eq!(
            hex(&sig),
            "b8c7bc32e2df60a5fa7c6c9586bb9970811425e3c380e32926db7ff3ff424881\
             2e81ad3e0f75f71431148b363d2994daa9e949704edd9a02ae41e749aa183d0c"
        );
        assert!(verify(&key.public_key(), &msg, &sig));
    }

    #[test]
    fn ed25519_rejects_tampering() {
        for v in &VECTORS {
            let pk = arr32(v.public);
            let msg = unhex(v.msg);
            let sig = arr64(v.sig);

            // A changed message: flip a bit, or append a byte to the empty one.
            let mut m = msg.clone();
            match m.first_mut() {
                Some(b) => *b ^= 0x01,
                None => m.push(0),
            }
            assert!(!verify(&pk, &m, &sig));

            // Flipped bits across R and S.
            for (i, bit) in [(0usize, 0u8), (17, 3), (31, 7), (32, 0), (50, 5), (63, 6)] {
                let mut s = sig;
                s[i] ^= 1 << bit;
                assert!(!verify(&pk, &msg, &s), "sig byte {i} bit {bit}");
            }

            // Flipped bits in the public key, including the x sign bit.
            for (i, bit) in [(0usize, 0u8), (15, 2), (31, 7)] {
                let mut p = pk;
                p[i] ^= 1 << bit;
                assert!(!verify(&p, &msg, &sig), "pk byte {i} bit {bit}");
            }
        }
    }

    #[test]
    fn ed25519_rejects_non_canonical_s() {
        for v in &VECTORS {
            let pk = arr32(v.public);
            let msg = unhex(v.msg);
            let sig = arr64(v.sig);
            // S + L still satisfies the group equation, so only the range check stops it.
            let mut bumped = sig;
            let mut carry = 0u16;
            for i in 0..32 {
                let sum = u16::from(sig[32 + i]) + u16::from(L[i]) + carry;
                bumped[32 + i] = sum as u8;
                carry = sum >> 8;
            }
            assert_eq!(carry, 0);
            assert!(!verify(&pk, &msg, &bumped));
        }
    }

    #[test]
    fn ed25519_rejects_public_key_off_curve() {
        let v = &VECTORS[0];
        let sig = arr64(v.sig);
        let msg = unhex(v.msg);
        let mut found = 0;
        for k in 0u8..=255 {
            let mut pk = arr32(v.public);
            pk[0] = k;
            if ed25519_dalek::VerifyingKey::from_bytes(&pk).is_err() {
                assert!(decode_public_key(&pk).is_none());
                assert!(!verify(&pk, &msg, &sig));
                found += 1;
                if found == 3 {
                    break;
                }
            }
        }
        assert_eq!(found, 3, "expected some y values with no curve point");
    }

    #[test]
    fn ed25519_rejects_non_canonical_public_keys() {
        let v = &VECTORS[0];
        let sig = arr64(v.sig);
        let msg = unhex(v.msg);
        // y = p + k (p = 2^255 - 19) is a second spelling of y = k for k in 0..19.
        let mut lenient_only = 0;
        for k in 0u8..19 {
            let mut y = [0xffu8; 32];
            y[0] = 0xed + k;
            y[31] = 0x7f;
            assert!(decode_public_key(&y).is_none(), "y = p + {k}");
            assert!(!verify(&y, &msg, &sig), "y = p + {k}");
            if ed25519_dalek::VerifyingKey::from_bytes(&y).is_ok_and(|key| !key.is_weak()) {
                lenient_only += 1;
            }
        }
        // Some (y = 3, 4, 5, ...) decode in ed25519-dalek and are not small order, so only the
        // re-encoding check in decode_public_key stops their second spelling.
        assert!(lenient_only > 0);

        // Canonical y = 0 and y = 1 are curve points; y = 1 gives x = 0, whose sign bit must be
        // clear.
        let mut y = [0u8; 32];
        assert!(decode_public_key(&y).is_some());
        y[0] = 1;
        assert!(decode_public_key(&y).is_some());
        y[31] = 0x80;
        assert!(ed25519_dalek::VerifyingKey::from_bytes(&y).is_ok());
        assert!(decode_public_key(&y).is_none());
        assert!(!verify(&y, &msg, &sig));
    }

    #[test]
    fn ed25519_rejects_small_order_public_key() {
        use ed25519_dalek::Verifier;
        // The identity (y = 1) is a canonical curve point of order 1: [k]A vanishes, so R = B,
        // S = 1 satisfies the cofactorless equation [S]B = R + [k]A for EVERY message.
        let mut identity = [0u8; 32];
        identity[0] = 1;
        let mut forged = [0u8; 64];
        forged[..32].copy_from_slice(&arr32(
            "5866666666666666666666666666666666666666666666666666666666666666",
        ));
        forged[32] = 1;
        let lenient = ed25519_dalek::VerifyingKey::from_bytes(&identity).unwrap();
        for msg in [&b""[..], b"update manifest", b"any other message"] {
            let sig = ed25519_dalek::Signature::from_bytes(&forged);
            assert!(lenient.verify(msg, &sig).is_ok(), "the plain RFC 8032 check accepts it");
            assert!(!verify(&identity, msg, &forged));
        }
    }

    #[test]
    fn ed25519_verify_rejects_garbage_without_panicking() {
        assert!(!verify(&[0; 32], b"", &[0; 64]));
        assert!(!verify(&[0xff; 32], b"", &[0xff; 64]));
        let good = &VECTORS[1];
        assert!(!verify(&arr32(good.public), &unhex(good.msg), &[0; 64]));
        for _ in 0..200 {
            let mut pk = [0u8; 32];
            let mut sig = [0u8; 64];
            let mut msg = [0u8; 16];
            random_bytes(&mut pk).unwrap();
            random_bytes(&mut sig).unwrap();
            random_bytes(&mut msg).unwrap();
            assert!(!verify(&pk, &msg, &sig));
        }
    }

    #[test]
    fn ed25519_round_trip_random_keys() {
        for len in [0usize, 1, 1000] {
            let mut seed = [0u8; 32];
            random_bytes(&mut seed).unwrap();
            let mut msg = vec![0u8; len];
            random_bytes(&mut msg).unwrap();
            let key = SigningKey::from_seed(&seed);
            let sig = key.sign(&msg);
            assert_eq!(sig, key.sign(&msg), "signing is deterministic");
            assert!(verify(&key.public_key(), &msg, &sig));
            let other = SigningKey::from_seed(&[0x5a; 32]);
            assert!(!verify(&other.public_key(), &msg, &sig));
        }
    }

    // ---- Encodings --------------------------------------------------------

    #[test]
    fn b64url_round_trip_and_known_value() {
        for len in 0..64usize {
            let data: Vec<u8> = (0..len).map(|i| (i * 37 + 250) as u8).collect();
            let enc = b64url_encode(&data);
            assert!(!enc.contains('='));
            assert_eq!(b64url_decode(&enc).as_deref(), Some(&data[..]), "len {len}");
        }
        assert_eq!(b64url_encode(&[0xfb, 0xff]), "-_8");
        assert_eq!(b64url_decode("-_8"), Some(vec![0xfb, 0xff]));
        assert_eq!(b64url_decode("-_8="), Some(vec![0xfb, 0xff]));
    }

    #[test]
    fn b64url_rejects_invalid() {
        assert_eq!(b64url_decode("+_8"), None);
        assert_eq!(b64url_decode("-/8"), None);
        assert_eq!(b64url_decode("AB=C"), None);
        assert_eq!(b64url_decode("AB=CDEFG"), None);
        // Length 1 mod 4 can never come from whole bytes.
        assert_eq!(b64url_decode("A"), None);
        assert_eq!(b64url_decode("AAAAA"), None);
        // Padding that does not complete a group, or too much of it.
        assert_eq!(b64url_decode("AA="), None);
        assert_eq!(b64url_decode("A==="), None);
        // Non-zero leftover bits ("-_9" would be a second spelling of "-_8").
        assert_eq!(b64url_decode("-_9"), None);
        assert_eq!(b64url_decode("AB C"), None);
    }

    #[test]
    fn b64_standard_values() {
        assert_eq!(b64_encode(b"foobar"), "Zm9vYmFy");
        assert_eq!(b64_decode("Zm9vYmFy"), Some(b"foobar".to_vec()));
        assert_eq!(b64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(b64_decode("Zm9vYg=="), Some(b"foob".to_vec()));
        assert_eq!(b64_decode("Zm9vYg"), Some(b"foob".to_vec()));
        assert_eq!(b64_encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(b64_encode(b""), "");
        assert_eq!(b64_decode(""), Some(Vec::new()));
        assert_eq!(b64_encode(&[0xfb, 0xff]), "+/8=");
        assert_eq!(b64_decode("+/8="), Some(vec![0xfb, 0xff]));
        for len in 0..40usize {
            let data: Vec<u8> = (0..len).map(|i| (i * 91 + 13) as u8).collect();
            assert_eq!(b64_decode(&b64_encode(&data)).as_deref(), Some(&data[..]));
        }
    }

    #[test]
    fn b64_standard_rejects_invalid() {
        assert_eq!(b64_decode("Zm9v-mFy"), None);
        assert_eq!(b64_decode("Zm9v_mFy"), None);
        assert_eq!(b64_decode("Zm9v YmFy"), None);
        assert_eq!(b64_decode("Zm9vYmFy\n"), None);
        assert_eq!(b64_decode("Zm9=vYmFy"), None);
        assert_eq!(b64_decode("Zm9vY"), None);
        assert_eq!(b64_decode("Zm9vYg="), None);
    }

    #[test]
    fn hex_round_trip_and_errors() {
        let data: Vec<u8> = (0..=255u8).collect();
        let enc = hex(&data);
        assert_eq!(&enc[..8], "00010203");
        assert_eq!(hex_decode(&enc), Some(data.clone()));
        assert_eq!(hex_decode(&enc.to_uppercase()), Some(data));
        assert_eq!(hex_decode(""), Some(Vec::new()));
        assert_eq!(hex_decode("abc"), None);
        assert_eq!(hex_decode("zz"), None);
        assert_eq!(hex_decode("0g"), None);
    }

    #[test]
    fn constant_time_eq_cases() {
        assert!(constant_time_eq(b"", b""));
        assert!(constant_time_eq(b"token", b"token"));
        assert!(!constant_time_eq(b"token", b"tokem"));
        assert!(!constant_time_eq(b"token", b"token2"));
        assert!(!constant_time_eq(b"a", b""));
    }

    #[test]
    fn random_bytes_fills_the_buffer() {
        let mut a = [0u8; 32];
        let mut b = [0u8; 32];
        random_bytes(&mut a).unwrap();
        random_bytes(&mut b).unwrap();
        assert_ne!(a, b);
        assert_ne!(a, [0u8; 32]);
        random_bytes(&mut []).unwrap();
    }
}
