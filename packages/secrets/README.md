# @nova/secrets

Secret storage behind `secret://` references (FR-101, `docs/12` §5). `FileVault` encrypts the
whole map with ChaCha20-Poly1305 under a random 32-byte key in a 0600 key file, or under
Argon2id(passphrase) in portable mode, and fails closed on a wrong key or a tampered file. Every
value written or read is registered with the redactor so it cannot leak into logs. OS keychain
backends plug in behind the same `SecretStore` interface. 90 % branch coverage floor.
