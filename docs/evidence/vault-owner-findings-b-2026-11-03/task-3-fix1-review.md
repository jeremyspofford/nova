# Task 3 fix round 1 independent review

Scope: original Important I1, “Gmail existence precheck converts uncertainty into absence,” and regressions introduced by its correction only. Reviewed base `9ba59fb70f5d43eef1ff255b81692f3258690200` through head `c38cb860e32d734bbdc583133c11faa34de75a15` in `/home/jeremy/.codex/worktrees/nova-vault-integration/nova-build`.

**I1: ADDRESSED. Spec verdict: PASS for this scoped correction. Code quality verdict: APPROVE for this scoped correction.** New findings: **0 Critical / 0 Important / 0 Minor.** No remaining Task 3 I1 blocker was identified. This closes the Important finding from the initial Task 3 review; it does not approve the whole branch, merge or any later phase.

## Why I1 is addressed

At `src/broker/oldvault.ts:111`, `gmailStat` calls `lstatSync` directly and treats only `ENOENT` as absent. It rethrows OS traversal/access failures, Node `ERR_ACCESS_DENIED`, and other inspection errors. A dangling symlink remains visible as a symlink rather than disappearing through `existsSync`.

At `src/broker/oldvault.ts:129`, discovery checks the exact `connectors` root, then `connectors/gmail`, before inspecting files. Confirmed absence returns an empty inventory. An existing ancestor must be a real directory; both live and dangling symlink ancestors fail the directory check. This avoids treating a dangling ancestor's missing target as proof that the descendant credential does not exist.

At `src/broker/oldvault.ts:136`, file inspection distinguishes absent (`undefined`) from present but non-regular/untrustworthy (`null`). The latter refuses migration. Read failure propagates; after-read disappearance or epoch change cannot equal the prior valid epoch and therefore refuses. The metadata tuple remains device/inode/mtimeNs/ctimeNs, with no content, size, plaintext equality or surrogate epoch added.

Both stage and finish use this same snapshot producer. Thus the correction covers the initial bypass at both boundaries. Existing failed-restage clearing and generic failure messages remain intact. The new public-path tests establish that failed restage leaves no earlier staged approval usable, that finish may create the already-approved copies but does not rewrite/remove legacy sources on uncertainty, and that errors do not disclose credential names, paths or canary values.

## Missing paths and authority

The correction resolves the actual Node 26 permission behavior without broadening grants. The saved narrow probe demonstrates that the existing trailing-slash grant permits `lstat` of the exact absent connectors root and returns `ENOENT`, whereas descendant lookup beneath that absent root returns `ERR_ACCESS_DENIED`. Inspecting ancestors first therefore permits ordinary no-connectors migration without interpreting permission denial as absence.

The final real IPC controls independently cover all three absence cases: no connectors directory, existing connectors with no Gmail directory, and existing Gmail directory with no credential files. Each stages the unrelated legacy credential, commits successfully, reports removed 1 and confirms the source credential is gone. These controls pass in-process and under `startBroker`/core IPC. Inspection of the unchanged `src/broker/spawn.ts:21` command confirms that `startBroker` uses `--permission`; the test's “permission IPC” label is backed by the production launcher.

The immutable fix diff changes only `oldvault.ts` and the new test file. It changes no `broker.ts`, `launch.ts`, `spawn.ts`, Core writer, grant flag, environment or public interface. The root's conditional grant allowance was not used. The existing narrow read/write authority remains unchanged, and there is no new stage connector-write grant or whole-home access.

## Tests and evidence independently checked

Read the original I1 section verbatim, the Task 3 brief including Global Constraints and uncertainty ruling, and the complete fix appendix in `task-3-report.md`. Read `review-9ba59fb7..c38cb860.diff` once; no repeated `git diff` or broad source crawl. Inspected the changed source with line numbers and the exact unchanged production broker-spawn command required to validate the IPC harness.

The new `tests/core/broker-migration-source-inspection.test.ts` contains 23 meaningful checks: 11 public cases in each of two harnesses, plus an explicit production `readGmailFiles` call under Node permissions without a source grant. Public cases cover the three missing-path controls, dangling connectors/Gmail ancestors, and dangling/inaccessible credential sources at stage, restage and finish. Assertions include source bytes unchanged, source values retained, no broker copies on stage/restage refusal, existing approved copies after failed finish, retained links/files, generic errors, and stale approval invalidation. The final explicit check asserts the actual `ERR_ACCESS_DENIED` code rather than accepting a generic process failure.

Inspected the dedicated `evidence/task-3-fix1/launcher.py`, all seven contemporaneous run JSON records including complete argv/env/cwd/status/timestamps, final output and stderr files, RED failure summaries/assertions, the permission probe source and full output, and `final-manifest.json`. Recomputed the SHA-256 hashes of both final changed files; both match the manifest.

| Run | Observed evidence |
|---|---|
| `red-01-inspection` | 18 tests: 6 pass, 12 fail, exit 1. All missing-path controls pass; dangling/inaccessible stage/restage/finish wrongly succeed in both public harnesses. |
| `probe-02-direct-lstat` | 18 tests: 17 pass, 1 fail, exit 1. Initial direct-lstat fix fails the no-connectors production permission case; this failure is retained. |
| `probe-03-permission-grants` | Exit 0. Existing slash grant gives exact-root ENOENT but descendant ERR_ACCESS_DENIED when root is absent. Existing-root lookup works, mode-000 traversal yields EACCES, unrelated sibling remains denied. Alternative grants are diagnostic only. |
| `red-04-ancestor` | 4 tests: 1 pass, 3 fail, exit 1. Demonstrates missing-target ancestor acceptance before the ancestor inspection fix. |
| `green-05-focused` | 57/57 pass, exit 0; all 23 inspection tests, 21 prior Task 3 tests, 7 authenticated recovery tests and 6 boundary checks. No skips or cancellations. |
| `green-06-resume-sec05` | 6/6 pass, exit 0; exact ciphertext/key crash resume and all five SEC05 controls. No skips or cancellations. |
| `green-07-typecheck` | Exit 0, no compiler diagnostics. |

The focused output includes both independent B2 oracle regressions in core and passkey contexts, source-bound approval changes, quiet Gmail success, newer Gmail retention, genuine resume and authenticated recovery. The fix leaves the epoch/revision algorithm unchanged, and the recorded regressions support its preservation.

The launcher records show cached image `mcr.microsoft.com/playwright:v1.56.1-noble`, `--pull=never`, `--network=none`, UID/GID 1000, read-only checkout/root, private tmpfs and Node 26.3.1 read-only mount. Host launcher environments enumerate PATH/private HOME/LANG; runtime HOME/PATH/TZ/LANG are explicit. All records have completion statuses and unique labels. Every output records the no-Kubernetes tripwire armed and never fired. All stderr files are empty; test-runner warnings remain in stdout.

The saved boundary test passes and manifest records **2,736/3,000 lines**, 264 remaining. The fix adds 15 production lines and does not move privileged code, change the budget or weaken assertions. No additional runtime probe or green-suite rerun was needed for this review: existing evidence answers the specific correctness and permission-model questions.

## Separate retained concerns and scope limits

- No new out-of-scope code finding is raised. The preexisting M1 per-name scan cost remains for final triage; closing I1 does not close or waive it.
- Node child-process SecurityWarnings remain unresolved: 9 in the initial RED, 9 in the intermediate run, 2 in ancestor RED, 11 in final focused GREEN and 1 in resume/SEC05 GREEN. They are preserved evidence, not a new fix regression or proof that the permission model is a complete security boundary.
- Gmail still requires quiescent writers and trustworthy OS metadata. Hostile same-user/root metadata or clock manipulation and races outside that contract are not established safe by this review. There is no new equality-oracle waiver.
- CannotVerify/full scope: the full branch gate, untouched SEC06/07 and broader origin/revocation/effective-binding checks, takeover integration requirements, Task 4, P1b/P1c and product cutover are outside this fix review. Prior live-keychain skip remains a coverage limit; no live keychain was exercised or claimed covered here.

No source, index, HEAD or branch mutation occurred during this review. Only this report was added. No subagents, owner credentials, keychain/services, push, PR, merge or preview actions were used.

**RELEASE:** scoped fix review complete. I1 closed; reviewer released to root. Root retains ownership of subsequent task and final branch gates.
