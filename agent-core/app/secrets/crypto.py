# agent-core/app/secrets/crypto.py
import functools
import os

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF


@functools.lru_cache(maxsize=4)
def derive_key(master_key_hex: str) -> bytes:
    """Derive a 32-byte AES key from the hex-encoded master key via HKDF-SHA256."""
    master_bytes = bytes.fromhex(master_key_hex)
    return HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=b"nova-secrets-v1",
        info=b"nova/secrets",
    ).derive(master_bytes)


def encrypt(plaintext: str, name: str, master_key_hex: str) -> tuple[bytes, bytes]:
    """Encrypt a secret. Returns (ciphertext, nonce). name is used as AAD."""
    key = derive_key(master_key_hex)
    nonce = os.urandom(12)
    ciphertext = AESGCM(key).encrypt(nonce, plaintext.encode(), name.encode())
    return ciphertext, nonce


def decrypt(ciphertext: bytes, nonce: bytes, name: str, master_key_hex: str) -> str:
    """Decrypt a secret. Raises InvalidTag on bad key/AAD/tamper."""
    key = derive_key(master_key_hex)
    plaintext = AESGCM(key).decrypt(nonce, ciphertext, name.encode())
    return plaintext.decode()
