# Owner Insertion #3 — 2026-11-03

This records owner instructions, not completed work or a new builder-run security review. It overrides the older vault freeze and remaining wiring order in [the combined queue](owner-priority-queue-2026-11-02.md).

## Part A — PR275 Findings Set C

The owner reports that the independent live-probe review reproduced no Critical, High, or Medium defect against claims C2–C9, and that Findings A and B hold live. Apply the following remaining corrections on PR275's `vault/broker-phase1` branch, test first, then re-run CI. The existing owned integration worktree may retain its local branch name; the remote PR head is the integration target, never a rebase or an edit of an old owner's checkout.

- A1 / F1: extend `formsOf` in `src/broker/scrub.ts` for JSON `\uXXXX` forms escaping every non-ASCII character and `<`, `>`, `&`, and `'`, lower- and upper-case hex per UTF-16 code unit. Test Go-style HTML escapes and Python-style `ensure_ascii` echoes of a synthetic bound credential; the value must not reach Core.
- A2 / F2: reject metadata renames whose `secret://` alias another item already holds, matching create's collision check. Renaming BETA onto `provider/ALPHA` must be refused without changing `use()` resolution.
- A3 / F3: queue the real P1b hub-pin fingerprint: full SHA-256 of the decoded Ed25519 public key on the pin card, and the same value in hub `state()`. Correct stated-limit6 now so it does not claim the fingerprint comparison is possible today.
- A4 / N1: classify IPv4-compatible `::/96` and Teredo `2001::/32` as private. Triage N2/N3 and fix or record stated limits with reasons; their contents are not supplied in this insertion and must not be invented.
- A5: repair B3's PID fixture race using atomic temporary-file rename or parse-safe polling. Put the seal-module browser test in a browser-equipped job or otherwise supply the required installed browser; the owner also permits a loud presence-gated skip. Prefer preserving executed browser qualification rather than introducing a new skip. The review attributes neither CI failure to broker behavior.
- A6: explicitly report S4 (old vault/key and Era2 Gmail material retained in pre-migration checkpoints) and S6 (delete-with-holders wording versus C7) as fixed, deferred with reason, or still open. Do not imply historical copies or already-received material were retroactively erased.

The owner states that A1–A5 plus green CI satisfy the independent live-probe gate and make PR275 mergeable on the owner's word. Existing honest-claims, independent implementation review, same-PR LEDGER, exact-head CI, matching merge and preview requirements still apply. Reconcile earlier open review items individually against the returned evidence; a review conclusion is not a silent code fix. No new adversarial probe campaign is required by this instruction.

## Part B — security before the remaining wiring

After in-flight #283/#285/#287 land, implement **T1, T2, T3 in order**, with meaningful failing regression checks first. This is ahead of the remaining wiring workstream. The full threat model is sensitive and must remain private; this public queue records requirements only, without its probe procedures.

1. **T1 — device-origin authority:** screen device requests through the ingest gate; bound tier by the enrolled spoke ceiling and prevent privacy or self-tier elevation. Inbox configuration changes require the same approval as the corresponding API operation. A device request is never equivalent to an owner request.
2. **T2 — tier3 owner verification:** a console header alone does not authorize tier3. Require the passkey path or broker-native approval, including the broker's Core-relayed fallback. Audit all routes deriving owner authority from loopback/header and list retained lower-tier rights.
3. **T3 — standing-file integrity:** writes to standing instruction files require approval once a run has touched any tool output; screen and mark the previously unscreened status tools through the ingest gate. Preserve the authoritative approval and taint records.

**T4 — Architecture track, ADR before code:** design one egress enforcement point and an OS-level egress test covering DNS, UDP and child processes, including execution/coding/browser/local-model paths. Cite the existing vault broker programme as the response to credential exposure, and as a reason P1b/Phase2 must not slip behind feature work. This requirement does not authorize a second credential path or an enforcement bypass.

Graph Engineering remains after A1/A2 with its own docs-only ADR and second-model gate. T4 joins the Architecture track; this insertion does not silently decide its relative order against those ADRs. Root should make that sequencing concrete when the track is reached, within the owner's stated dependencies.
