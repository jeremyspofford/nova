# Vault proposal approval card and digest

Base: `b6389906f6407118bd2004d0ee46b1fe7aaf364e`.
Branch: `codex/vault-review-policy-fixes`.

A class-only migration proposal showed an empty binding list and target `unbound` on its approval
card, although applying it retained an existing usable binding. Its digest also omitted retained
bindings, allowing a proposal approved against one retained scope/injection to apply after that
binding had changed.

The proposal now computes its complete effective bindings once: existing bindings not replaced,
followed by proposed replacements and additions. The sensitive-consent check, approval card,
approval digest and saved metadata use that same set. Retained consents keep their existing approval
IDs; only new/replacement consents receive the proposal's approval ID. An actually unbound item
still has no effective bindings. The preceding grant-revocation/root-rotation protection is kept.

## Verification

New regressions were written and run before production edits:

```sh
sh scripts/test.sh 'tests/core/broker-proposal-card.test.ts'
```

**RED: 0 passed, 3 failed**:
- A class-only card claimed `unbound` instead of showing its retained target/scope/injection.
- A mixed card omitted the retained binding while showing only replacements/additions.
- An approval still applied after a retained binding changed, because its digest omitted that binding.

After the minimal effective-bindings fix: **GREEN: 3/3 passed**. The stale-challenge test signs after
the binding change, so the expected rejection tests the action digest rather than accidentally
relying on a passkey counter replay. A fresh approval still applies the updated policy.

```sh
sh scripts/test.sh 'tests/core/broker-*.test.ts' 'tests/core/vault.test.ts'
npm run typecheck
```

**88 passed, 1 skipped, 0 failed** across 89 tests. The skip is the existing real `secret-tool`
keychain test (no secret-tool or desktop session here). Typecheck and `git diff --check` passed.
The no-Kubernetes tripwire was armed and never fired. No full host suite was run.

Only temporary homes, generated synthetic credentials, software passkeys and loopback stand-ins
were used. No owner home, real credential, keychain, external target, real passkey device or UI
flow was exercised. Real-device behavior remains **UNPROVEN**. Owner review B remains a separate
pending gate and is not satisfied or waived by this fix.
