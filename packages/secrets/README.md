# @nova/secrets

Secret storage behind `secret://` references (FR-101, `docs/12` §5). Every value written or read
is registered with the redactor so it cannot leak into logs. 90 % branch coverage floor.

- `FileVault` encrypts the whole map with ChaCha20-Poly1305 under a random 32-byte key in a 0600
  key file, or under Argon2id(passphrase) in portable mode, and fails closed on a wrong key or a
  tampered file.
- `KeychainStore` keeps secrets in the OS keychain: the Linux Secret Service through
  `secret-tool` (needs a D-Bus session bus) or the macOS keychain through `security`. Values
  never appear on a command line (stdin only) and are stored base64-encoded; an index item keeps
  the list of references (names only) because neither CLI can list items portably.
- `openSecretStore({ mode })` picks the store at startup (`NOVA_SECRETS=vault|keychain`, default
  `vault`). `keychain` falls back to the vault with a warning when no keychain is reachable, and
  moves existing vault secrets into the keychain (each is read back before it leaves the vault).
- `MemorySecretStore` is for tests and ephemeral profiles. Every store describes itself through
  `info` (`backend`, `detail`, `warning`) for Diagnostics.
