# Task 3 independent review

Reviewed base `9360aab137f93409c1b7c2570e5d5dccc97e1f77` through head `9ba59fb70f5d43eef1ff255b81692f3258690200` in `/home/jeremy/.codex/worktrees/nova-vault-integration/nova-build`.

**Spec verdict: REQUEST CHANGES.** Both B2 equality-oracle sites are fixed using metadata-only epochs, but the explicit uncertain-Gmail-source refusal requirement has an uncovered bypass.

**Code quality verdict: REQUEST CHANGES for one Important correctness issue.** The epoch producer/consumer design, approval binding, version separation, failure wording and regression tests are otherwise coherent and narrowly scoped.

New findings: **0 Critical / 1 Important / 0 Minor.** This is a Task 3 gate only, not branch approval, P1a merge approval or whole-phase completion.

## Important finding I1 — Gmail existence precheck converts uncertainty into absence

**Location:** `src/broker/oldvault.ts:121` (the `there(p)` precheck before `gmailEpoch`; helper at line 18).

`there()` uses `existsSync`, which follows symlinks and returns false on inaccessible paths as well as missing paths. Consequently an existing dangling symlink, or a real Gmail credential behind a directory without search permission, never reaches the new `lstatSync`/regular-file/epoch checks. `readGmailFiles` silently omits the source, and `migrationSnapshot` treats that incomplete inspection as an authoritative snapshot. If that condition persists, approved finish also succeeds and removes other migrated legacy entries.

This contradicts the concrete Task 3 ruling: non-regular or uncertain sources must refuse the whole stage/cleanup attempt, preserving sources for repair and retry. It is not a request for protection against hostile metadata forgery or unquiesced writers. A static permission failure in a quiescent synthetic directory is enough. No plaintext equality leak was found in this case; the defect is fail-open source discovery under the expressly required fail-closed contract.

**Independent reproduction:** `evidence/task-3/review-01-uncertain-existence.json`, `.stdout`, `.stderr`. A single focused probe used real `Broker.handle`, `Person` approval and the real launcher, with a synthetic file-key Vault and three separate private homes. It did not mock migration internals or change source files.

| Fixture | Stage observed | Approved commit observed | Legacy Vault file |
|---|---|---|---|
| Missing Gmail file control | staged 1 | moved 1, removed 1 | removed |
| Gmail `token.json` dangling symlink | staged 1 | moved 1, removed 1 | removed |
| Existing Gmail token behind directory mode `000` | staged 1 | moved 1, removed 1 | removed |

The two uncertain cases should fail staging. The probe collected all three observations, then deliberately asserted that the uncertain stages were `failed`; it exited 1 with actual `[{staged:1},{staged:1}]`. No prior green suite was rerun.

**Required correction:** distinguish confirmed absence from uncertainty before approving a snapshot. Inspect Gmail entries with `lstat` directly, refuse non-regular entries and propagate access/inspection failures through the existing generic migration refusal; only an appropriate confirmed not-found condition should be treated as absent. Preserve the normal missing-file and quiet regular-file behavior. Add behavioral regressions for a dangling symlink and inaccessible path, including finish-time uncertainty retaining sources and failed-restage authority invalidation where applicable. Do not replace the problem with a content-derived fallback or random epoch.

**Path and permission distinctions for the fix:** the probe's missing-file control has an existing accessible `connectors/gmail` directory and no `token.json`; it does not establish behavior for an entirely absent connectors directory. Direct `lstat` can return `ENOENT` for a truly missing entry, but returns the symlink itself for a dangling link, permitting the regular-file check to refuse it. The inaccessible-directory case is ordinary OS traversal denial (`EACCES`), not absence. The probe runs the in-process broker without Node `--permission`; therefore it demonstrates this OS-level failure independently of Node permission-model behavior and does not claim to reproduce `ERR_ACCESS_DENIED`.

The actual production migration launcher adds read grants only for `<home>/vault/` and `<home>/connectors/`; stage write authority is limited to `<home>/vault/`, and finish adds `<home>/connectors/` write authority (`broker.ts:700–705`). `grantsIf` at line 41 adds those flags only when the broker uses Node permissions; the existing comment states that the child also inherits broker grants. The `there` helper was originally justified by Node's inability to grant a directory that does not exist. A safe fix must preserve ordinary no-connectors migration while distinguishing that confirmed absence from an unexpected permission denial. It must not blanket-catch `ERR_ACCESS_DENIED` as absence, add whole-home/filesystem access, or grant stage connector writes merely to make the check pass. Preserve the narrow production launcher authority and verify the missing-directory case through the existing permission-enabled harness when implementing the correction. Current review evidence establishes I1's two concrete cases, not every permission-model/absent-ancestor variant.

## Spec and producer/consumer checks

- **Encrypted epoch authenticated before use:** `oldvault.ts:62–72` decrypts/authenticates before producing `vault:<id>:<nonce-hex>`, checks nonce length 12, and retains authenticated pending-file recovery. The unchanged Core writer was independently inspected at `src/core/vault.ts:268–283` and `591–615`: every successful nonempty `put`, including the same value, invokes `#save` and draws `randomBytes(12)`. There is no same-value optimization that reuses the epoch.
- **Per-item B2 oracle:** `broker.ts:668–670` computes `v2:` revisions from grouped source names and their independent epochs only. It neither hashes nor compares plaintext for resume eligibility. Old unprefixed content digests, unknown versions and missing revisions cannot equal this result. The held-name tests keep the broker item intact while making equal/different legacy `Vault.put` guesses, inspect unapproved card statuses, approve cleanup, and compare the resulting counts and retained-source behavior in both core and passkey contexts.
- **Independent global-finish B2 oracle:** `oldvault.ts:151–154` hashes encrypted source epoch plus Gmail name/epoch pairs; it does not include plaintext, length or plaintext equality. `launch.ts` compares this revision before any removal under the old Vault writer lock. The separate free-name tests explicitly assert `move`, create/read back the staged copy, then prove both equal and different newer writes produce removed 0 and retain the newer legacy value. This reaches finish independently of held-name decisions.
- **Private transport and approval:** launcher migration streams each value and epoch through the existing private pipe, with encrypted Vault entries overriding Gmail values and epochs together. Broker retains separate maps. Only the metadata digest enters the action and card flags; raw source IDs/nonces/epoch strings are not newly exposed. `#approve` at `broker.ts:209–224` issues/checks the full action, including the snapshot. The tests verify that restaging an identical-value newer write changes the visible snapshot and rejects the earlier approval in both core/passkey modes. The existing three-pending-card rate cap remains tested.
- **Read-back remains private:** `broker.ts:680–684` retains store read-back equality for newly created items. That check is not used as a resume or global finish revision. Existing canary/heap tests remain in the affected run.
- **Genuine crash resume:** the canary fixture now restores captured original encrypted file and key bytes. Both original names are restored; stage/moved/removed counts are exactly 2, no new duplicates appear, read-back success is asserted, and the own backup-key name and value remain. New same-value writes are covered separately as newer epochs that stay kept.
- **Gmail normal/changed-source behavior:** regular-file device/inode/mtimeNs/ctimeNs are checked before and after the read. Size, content and access time do not enter the epoch. Quiet-source success still migrates/deletes the Gmail file. Same-content rewrite, different-content rewrite, restored mtime and file replacement preserve the source. The regular-target symlink fixtures prove refusal and failed-restage clearing once identity inspection is reached. I1 identifies the precheck path that avoids that inspection.
- **Staged authority and honest errors:** stage zeroes and discards prior staged buffers before launching, so a genuine launch refusal leaves no earlier staged values usable. The saved stale-approval RED and final GREEN show this was tested behaviorally. Finish failures now acknowledge possible copies/removals and ask for review/resume; real writer contention and directory cleanup failure exercise this after copies exist, including a partial removal.
- **Preserved recovery/security contracts:** inspected exact SEC05 newer-value, lock and rekey assertions, plus authenticated pending migration recovery fixtures. The affected output includes their passing execution. No new public verb, getter, listener, dependency, arbitrary execution bridge, permission bypass or parent-environment spread is introduced by this diff. Task 4 process/env work remains separate.

## Evidence inspected

Read the task brief first, including all Global Constraints and the concrete uncertainty ruling; read `task-3-specific-regression-notes.md` and the complete implementer report. Read the immutable `review-9360aab1..9ba59fb7.diff` once, including its commit/stat and all semantic edits. The tool elided a small comment fragment in its output; the relevant `oldvault.ts` source range was subsequently read directly. No `git diff` was rerun. Named unchanged cross-checks were limited to migration approval/grouping/support, Core save/put, SEC05 and authenticated migration recovery.

Inspected `evidence/task-3/launcher.py`, all original run JSON records and their command/env/isolation fields, the final manifest, final affected stdout/stderr, compiler stdout/stderr, and recorded RED failure outputs. Independently recomputed the five manifest file hashes: all matched the current reviewed files. The source budget record is 2,721/3,000; the saved boundary test passes. No privileged code was moved out of the counted tree in the task diff.

| Recorded run | Actual evidence |
|---|---|
| red-01 | 19 tests, 6 pass, 13 fail. Both held-name and free-name global equal/different outcomes diverge on the original implementation. The two wrong-field wording assertions are not counted as wording proof. |
| red-02-errors | 2 tests, 0 pass, 2 fail; actual `words` says nothing was moved or removed after copies/partial cleanup. |
| green-01-focused | Recorded exit 0, initial 19-test implementation; not used as final coverage for later uncertainty changes. |
| red-03-uncertain-approval | 1 test fails: prior approval was not rejected under the intermediate uncertain-epoch approach. |
| red-04-uncertain-refusal | 3 tests fail because uncertain stages/finish were accepted. |
| red-05-stale-approval | 1 test fails: one broker copy exists where zero is required after failed restage. |
| green-02-affected | 99 tests, 98 pass, 0 fail, 1 skip; all 21 final Task 3 tests, migration/recovery/owner/canary/Vault/boundary coverage represented in output. |
| green-03-typecheck | Recorded exit 0; no compiler diagnostics. |
| review-01-uncertain-existence | Independent new focused probe exits 1, demonstrating I1; confirmed-missing-file control succeeds. |

The review probe used the existing dedicated launcher with a new, non-overwriting label. Its contemporaneous record includes exact source snippet/argv, cwd, private launcher HOME, enumerated launcher environment, start/end times and status. Runtime was cached `mcr.microsoft.com/playwright:v1.56.1-noble`, `--pull=never`, `--network=none`, UID/GID 1000, read-only checkout/root, private tmpfs and Node 26.3.1 mounted read-only. The tripwire was armed and never fired. Fixtures were removed within the temporary container. No owner credentials, keychain, desktop sockets, services, cloud/model/image pulls or other checkout actions were used.

## Scope gates and retained concerns

- **CannotVerify/full-branch gate:** this review does not certify full branch suites, untouched SEC06/07, broader origin/revocation/effective-binding gates, P1a takeover integration NOTES, supervisor/reset/SECRET_DIRS/diagnostics/seal serving, LEDGER/ROADMAP completion, P1b consumer switch or P1c. These remain root-owned gates, not newly invented owner approvals.
- **CannotVerify/keychain:** the existing real `secret-tool` throwaway-account integration is skipped because there is no secret-tool/desktop session in the isolated runtime. File-key and synthetic recovery evidence does not prove live owner keychain behavior.
- **Bounded Gmail proof:** quiescent writers and trustworthy OS file metadata remain required. No claim is made for hostile same-user/root metadata or clock manipulation, filesystem metadata forgery, or races after validation. This accepted limit does not excuse I1's ordinary inspection uncertainty.
- **Carry forward M1:** the preexisting per-name migration/index scan cost remains for final triage (`broker.ts:667`); it was not re-reviewed, fixed, waived or counted as a new Task 3 finding.
- **Carry forward child-process warnings:** the actual affected output contains three Node `SecurityWarning` messages about `--allow-child-process` potentially invalidating the permission model. They were not suppressed, discarded or resolved by this task. The original stderr files are empty because those test-runner messages are retained in stdout. Task 4/final security triage must retain them.

No source, index, HEAD or branch writes occurred during this review. Only this report and the authorized focused probe's evidence records were added. No subagents, push, PR, merge or preview actions occurred.

A final named helper lookup included a nonexistent `src/broker/process.ts` path; `rg` reported that read-only discovery miss, and the relevant `grantsIf` definition was found in `broker.ts`. It was not a test or runtime attempt.

**RELEASE:** Task 3 review complete; reviewer released to root. Task 3 approval is withheld pending I1 correction and focused verification.
