import pytest
from app.secrets.crypto import decrypt, derive_key, encrypt
from cryptography.exceptions import InvalidTag

MASTER_KEY = "aa" * 32  # 64 hex chars = 32 bytes


def test_encrypt_decrypt_roundtrip():
    ciphertext, nonce = encrypt("sk-test-secret", "anthropic_api_key", MASTER_KEY)
    result = decrypt(ciphertext, nonce, "anthropic_api_key", MASTER_KEY)
    assert result == "sk-test-secret"


def test_wrong_name_aad_fails():
    ciphertext, nonce = encrypt("sk-test-secret", "anthropic_api_key", MASTER_KEY)
    with pytest.raises(InvalidTag):
        decrypt(ciphertext, nonce, "different_name", MASTER_KEY)


def test_tampered_ciphertext_fails():
    ciphertext, nonce = encrypt("sk-test-secret", "some_key", MASTER_KEY)
    tampered = bytes([b ^ 0xFF for b in ciphertext])
    with pytest.raises(InvalidTag):
        decrypt(tampered, nonce, "some_key", MASTER_KEY)


def test_different_nonces_each_call():
    _, nonce1 = encrypt("same-value", "key", MASTER_KEY)
    _, nonce2 = encrypt("same-value", "key", MASTER_KEY)
    assert nonce1 != nonce2


def test_derive_key_is_deterministic():
    key1 = derive_key(MASTER_KEY)
    key2 = derive_key(MASTER_KEY)
    assert key1 == key2


def test_derive_key_is_32_bytes():
    assert len(derive_key(MASTER_KEY)) == 32
