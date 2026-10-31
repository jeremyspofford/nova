Status: OWNER DECISIONS, given by Jeremy 2026-10-31 in reply to the builder's three waiting questions (orb states / 17 unproven claims / vault broker questions). Apply and record; see the accompanying consolidated prompt.

# Reply to Claude — orb states, the 17 claims, vault questions (2026-10-31)

For Jeremy to paste into the builder session. Resolves the three
"still waiting" items, including all vault conflicts rows 2-4 and
open questions 1-6 (read from docs/plans/vault-broker.md).

```
Three waiting items, decided:

1. THE ORB. Yes: RED is reserved for problems that STOP Nova
   (the Failed class — work cannot proceed, a dead-man switch
   fired, a security refusal). AMBER is needs-you-but-running:
   approvals waiting, problems like the Health items, degraded
   capture. This maps 1:1 onto the status vocabulary and it is a
   SEMANTIC rule, not a colour choice, so it survives theming:
   - The state set is fixed (idle / listening / working / speaking
     / needs-you-amber / stopped-red / offline) and themes may not
     add, remove, or re-meaning states.
   - Each theme package expresses the states in its own visual
     language (a future space theme renders the same states as
     stellar phenomena, not teal light — values and motion are the
     theme's, the meanings are the system's).
   - In EVERY theme: the stopped state must be unmistakable, and
     states must differ by motion and brightness pattern as well
     as hue (colour alone is not a safe channel). Reduced-motion
     equivalents required.
   Apply this in the DESIGN-SYSTEM record alongside the F3 orb fix
   from the UX review: the flat salmon disc captured there reads
   as the amber needs-you state, which fits what Health was
   reporting — the rendering depth is still the F3 fix.

2. THE 17 UNPROVEN CLAIMS. Both, split by audience:
   - Any claim a USER can see (UI copy, onboarding, docs aimed at
     users) gets SOFTENED NOW to what the evidence supports. The
     Amendment B closing rule is not deferred: unproven capability
     claims do not stand in user-facing text while evals are
     pending.
   - All 17 go into the eval harness backlog (Track 3) as named
     eval cases, prioritised by how load-bearing the claim is,
     each marked with the claim it would prove. When an eval
     passes, the strong wording may return, citing the eval.
   - Internal design docs keep the claims but mark them UNPROVEN
     inline, so nobody quotes them as settled.

3. THE VAULT BROKER QUESTIONS (docs/plans/vault-broker.md).
   Conflicts:
   - Row 2: a wrap sealed to a specific holder device's broker key
     MAY travel in sync. It is not an "unlock key" in the rule's
     sense — it is unusable anywhere else. The rule, restated
     precisely: no passphrase, recovery key, or device unlock key
     ever moves, and no key material ever moves in a form another
     device can use. Sealed per-device wraps are the one allowed
     exception, recorded as such.
   - Row 3: TypeScript now is APPROVED as an ADR-2 exception, with
     the size budget and Node permission-model narrowing as
     proposed. The Rust port stays the stated end-state under
     ADR-2, revisited at Phase 2 or the first external security
     review, whichever comes first. Record the exception in the
     ADR; do not silently treat it as the rule changing.
   - Row 4: Nova's own keys stay in core, out of broker scope for
     Phase 1 — APPROVED, with the plain statement as drafted.
     They are Nova's data/identity keys, not user credentials;
     growing sign/encrypt verbs for core would break the
     fixed-verb discipline that makes the broker auditable.
   Open questions — all proposed defaults ACCEPTED except Q6:
   - Q1 verbs reading: accept (seven verbs; delete as
     update(remove); sealed/oauth as sources; unlock/lock as
     no-value protocol messages).
   - Q2 separate-user mode: accept (offer at install on Linux/
     macOS hub, tier 3; same-user elsewhere with the plain notice).
   - Q3 "no network surface": accept the reading (nothing inbound;
     outbound only during a use, to the bound origin).
   - Q4 passkey approvals: accept (required for bind/share_scope/
     external connections where WebAuthn works; core-relayed
     fallback as proposed, stated in Settings).
   - Q5 placement: accept (side track after M10e; M10h ships with
     no spoke credential if Phase 1 is not merged).
   - Q6 showing a value: MODIFIED. Never through a verb, never to
     core or any model — that stands. But the owner may reveal a
     Nova Vault value ON THE DEVICE'S OWN SCREEN via a broker-
     rendered UI, gated by passkey/biometric, tier 3, auto-hiding
     — the same precedent as the backup recovery key (Conflicts
     row 4 note). A vault that can never show its owner a password
     traps them the first time they need that login outside Nova;
     the reveal path keeps the value out of every API while not
     locking the owner out of their own credentials. Nothing else
     about Q6 changes.
```
