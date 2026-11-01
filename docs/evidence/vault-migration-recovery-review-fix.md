# Legacy-vault interrupted re-key recovery

Base: `b04a2b380080fd3aa72add08f96035fe3c1d589b`.
Branch: `codex/vault-review-policy-fixes`.

A broker migration could not resume the writer's persisted state after its new key was saved and
before `secrets.json.tmp` replaced `secrets.json`. The broker read only the old main file, whose
key had already been replaced. Reopening the legacy vault in core recovered it, but migration must
not depend on core opening credential values.

The broker's old-vault reader now finishes that interrupted rename itself. It first tries the
current file. Only when no saved key matches that file does it consider the pending file, requiring
the existing vault ID, supported format, a matching saved-key fingerprint and successful AES-GCM
authentication/decryption before rename. The migration launcher already holds the shared writer
lock throughout read/recovery. A valid current file wins over pending ciphertext. Invalid pending
files remain untouched. Existing writer locks, including abandoned locks, are never stolen; their
operator recovery remains separate.

## Verification

All fixtures use temporary homes, synthetic credentials and local file keys. The failure state is
reconstructed from the broker's own `removeFromOldVault` writer. The positive test then stages and
commits through the broker launcher without reopening a legacy `Vault` in core, preserving Nova's
own key and never resurrecting an already-removed credential.

Before production edits:

```sh
sh scripts/test.sh 'tests/core/broker-migration-recovery.test.ts'
```

**RED: 5 passed, 2 failed.** Broker staging failed on the recoverable state, including after release
of a writer lock. Existing refusal checks passed for malformed, tampered, wrong-format and genuinely
authenticated different-ID pending ciphertext; an openable current file was preserved.

After the minimal reader change: **GREEN: 7/7 passed**. Recovery promotes only the authenticated
same-ID pending file, with mode 0600; writer-lock refusal and all negative cases still pass.

```sh
sh scripts/test.sh 'tests/core/broker-*.test.ts' 'tests/core/vault.test.ts'
npm run typecheck
```

**85 passed, 1 skipped, 0 failed** across 86 tests. The skip is the existing real `secret-tool`
keychain test: no secret-tool or desktop session is available. Typecheck and `git diff --check`
passed; the no-Kubernetes tripwire never fired. No full host suite was run.

No owner home, real credential, real keychain, external target or real passkey device was used.
Real-device behavior remains **UNPROVEN**. Owner review B remains a separate pending gate.
