# Task 3 report: metadata-only migration epochs

Status: DONE_WITH_CONCERNS (bounded Gmail metadata proof, expected keychain skip, retained Node warnings; no failing checks).

Task base: `9360aab137f93409c1b7c2570e5d5dccc97e1f77`, verified clean before source/test edits. Workdir: `/home/jeremy/.codex/worktrees/nova-vault-integration/nova-build`. Branch: `codex/vault-integration-takeover`.

Commit: `9ba59fb70f5d43eef1ff255b81692f3258690200` — `fix(vault): bind migration to source write epochs`.

## Implementation and files

- `src/broker/oldvault.ts`: authenticates the encrypted file before returning its opaque `vault:<id>:<nonce-hex>` write epoch. The existing Core writer always generates a fresh 12-byte nonce in `#save`, including identical-value `put`; Core source was inspected and left unchanged. Per-source Gmail epochs use only regular-file device, inode, nanosecond modification time and nanosecond change time, checked before and after reading. Size, plaintext, plaintext hashes and access time do not participate. Non-regular/untrustworthy/changing Gmail sources refuse staging or finish. Snapshot revision is `v2:` plus a SHA-256 digest of source identities/epochs only.
- `src/broker/launch.ts`: carries independent per-entry epochs beside values over its existing private pipe; nonce/stat tuples never enter socket answers or audit. Finish compares the metadata snapshot; any newer write preserves the staged sources even when bytes happen to match. The authenticated recovery interface, writer lock, key removal and rekey behavior are preserved.
- `src/broker/broker.ts`: stages separate value and epoch maps; group `migrated_revision` is `v2:` plus a metadata-only digest of names and epochs. Older content-derived, unknown and absent revisions cannot resume. Approval action binds the snapshot digest and existing card flags display that same digest. No raw epoch is displayed. Restaging zeroes/discards prior staged buffers before launching, including when the new stage fails. Newly created copies still undergo private value read-back equality. Finish failure now states that copies and removals may already exist and asks for review/resume. The card explicitly says Gmail writers must remain stopped through cleanup.
- `tests/core/broker-owner-findings-b-migration.test.ts`: 21 behavioral regressions/controls using real Broker.handle calls, the existing approval machinery and real child launcher. Independent held-name and free-name global finish oracles run in core and passkey contexts. Includes old revision formats, approval epoch changes, private epoch/value checks, quiet and changed Gmail sources, fail-closed uncertain sources, stale approval after failed restage, real lock contention, real partial filesystem cleanup failure, and the unchanged pending approval rate cap.
- `tests/core/broker-canary.test.ts`: replaces the false same-value `put` crash fixture with the captured original encrypted file AND key bytes. Both original credential names are restored, so staged/moved/removed counts are exactly 2; no duplicate new items, read-back success and own-key value preservation are asserted.

No new dependency, public verb, raw-value API, runtime test gate, source registry or random uncertainty surrogate. Task 1 and Task 2 source/interfaces remain intact. No owner credentials, owner keychain, services, cloud/device/model actions, image pull or external network were used. No push, PR, merge, preview or other-worktree work occurred.

## Requirement clarification and bounded proof

Root confirmed that a public approval/card may carry the **v2 metadata-only digest**, while raw source epochs stay private. Root also explicitly directed refusing uncertain/non-regular Gmail staging rather than creating ephemeral uncertainty epochs. The concrete consequence is that an untrustworthy Gmail source blocks the whole stage/cleanup attempt; it is preserved for review/retry. A failed restage must discard the previous staged values and approval authority. This is covered by a real regular-file-to-symlink fixture, not a special-file hang or launcher bypass.

Quiet regular Gmail migration succeeds and deletes its legacy file. Equal-content rewrite, different-content rewrite, mtime restoration, and inode replacement all retain the newer file. This is a **quiescent-writer contract**, not an authenticated Gmail journal: it does not establish safety against hostile same-user/root metadata or clock manipulation, filesystem metadata forgery, or unquiesced writers racing after validation. No equality-oracle waiver was added. Encrypted Vault epochs remain authenticated nonce/write identities, independent of this Gmail limit.

## Isolated launch evidence

All runtime attempts use `evidence/task-3/launcher.py`, copied from the required Task 2 pattern with a dedicated evidence directory and unique labels. It creates its JSON record **before** the run and fills in exit status/end timestamp afterward; refuses existing labels; preserves separate stdout/stderr without erasing attempts. Every JSON records the exact argv, clean launcher env, command, workdir, private temporary host HOME, runtime HOME and timestamps.

Runtime: cached `mcr.microsoft.com/playwright:v1.56.1-noble`, `--pull=never`, `--network=none`, UID/GID 1000, read-only root and checkout, private `/tmp` tmpfs; Node 26.3.1 installation mounted read-only at `/opt/node`. No desktop/credential sockets or homes mounted. Runtime env is the enumerated HOME/PATH/TZ/LANG context; no global UI-shot flag or warning suppression was introduced. Every recorded run armed the no-Kubernetes tripwire and reported `no-Kubernetes tripwire: never fired`.

`evidence/task-3/task-base.txt` records the base. `final-manifest.json` records SHA-256 hashes of the committed task files and the boundary-counted source total.

## RED evidence, including every failed attempt

These fail through actual public migration calls and approved commits, not source-string checks or missing methods. Original attack tests never replace the broker item. The free-name global test independently reaches the finish guard even though the staged item is newly created.

1. `red-01`: original production base, new tests. **19 tests / 6 pass / 13 fail**, exit 1. Held-name equal guess: `status: ['moved']`, moved 1, removed 1, retained false; different guess: `status: ['kept']`, moved 0, removed 0, retained true. Independently, GLOBAL free-name equal guess removed 1/retained false versus different guess removed 0/retained true. Both core/passkey contexts fail. Prior approvals incorrectly cover same-name/same-kind rewrites; the legacy plaintext-derived revision resumes; equal-content Gmail rewrite and non-regular source cases also fail.
   - Two failures in this first attempt were **test mistakes**, asserting `result.message` instead of the actual schema's `result.words`; they are not claimed as behavioral wording proof. Their exact attempt is preserved in `red-01.test.ts`, stdout and stderr.
2. `red-02-errors`: corrected only those error field assertions; original production unchanged. **2 tests / 0 pass / 2 fail**, exit 1. Both real owned filesystem faults return exactly `The old vault couldn’t be read or changed; nothing was moved or removed.` after copies already exist (and, in the partial cleanup case, after legacy removal succeeded). This is the behavioral RED for honest failure wording. Corrected test snapshot: `red-02.test.ts`.
3. `red-03-uncertain-approval`: self-review regression after initial epoch implementation. **1 test / 0 pass / 1 fail**, exit 1. Initial uncertain-source handling retained null epochs; an old approval still accepted a restaged uncertain source. This run motivated the clarification above. `red-03.test.ts` preserves the exact test attempt. The initial null-epoch design was replaced with refusal, not an ephemeral epoch workaround.
4. `red-04-uncertain-refusal`: revised requirements/tests before fail-closed source changes. **3 tests / 0 pass / 3 fail**, exit 1. Non-regular stage and finish were accepted rather than refused. `red-04.test.ts` preserves the exact assertions.
5. `red-05-stale-approval`: after introducing source refusal but **before** clearing prior stage. **1 test / 0 pass / 1 fail**, exit 1. Regular source staged and approved; source becomes a symlink; restage fails; old approval still creates **1 broker copy, expected 0**. That is independent evidence of stale staged authority. `red-05.test.ts` plus `red-05-source.patch` preserve this state relative to task base. Fix subsequently clears/zeroes old staged buffers before attempting the launcher.

No RED was discarded. Exploratory reads also reported missing guessed paths (`broker-test-helpers.ts`, `migrate.ts`, `approval.ts`, `schema.ts`, `types.ts`, and the initially nonexistent new test file); the existing actual modules/support file were then located. These were read-only discovery misses, not test/runtime failures.

## GREEN evidence and scope

- `green-01-focused`: initial epoch implementation, **19/19 pass**, exit 0. This preceded the additional uncertainty/stale-stage review regressions and is not presented as final proof.
- `green-02-affected`: final relevant source and test changes, **99 tests / 98 pass / 0 fail / 1 skip**, exit 0. Includes all 21 new Task 3 tests, Owner A SEC01–05 (other SEC06/07 remain untouched for the final whole-branch gate), existing B review coverage, full canary/heap test, genuine snapshot restore/resume, authenticated migration recovery cases, Task 2 legacy Vault tests, base Vault tests, and boundary/budget checks. This affected suite was run once after final changes.
- `green-03-typecheck`: final TypeScript compiler, exit 0, no compiler diagnostics.
- `git diff --check`: clean before commit. Entire task diff and new tests were self-reviewed; only the five named source/test files are committed.

The only skip was the preexisting real `secret-tool` throwaway-account integration test: `# no secret-tool or no desktop session here`. No real keychain account was created. Three existing Node `SecurityWarning: The flag --allow-child-process must be used with extreme caution. It could invalidate the permission model.` messages were preserved during the affected suite. Other recorded runtime stderr files are empty; there were no compiler warnings. Existing launch code's warning flags were not modified.

Full-phase suites, broader origin/revocation/effective-binding gates and the final whole-branch adversarial review remain for the owning root's final gate. No claim of whole-product credential cutover or whole-phase completion is made.

## Exact commands and raw outputs

All commands below were run in the explicit integration workdir. Raw `.json`, `.stdout`, `.stderr` files remain beside the dedicated launcher. The summaries above quote the behavioral differences; these files retain the complete output including each failure's stack/diff and all warnings/skips.

### red-01

```sh
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-3/launcher.py red-01 sh scripts/tripwire.sh node --test --test-concurrency=1 --test-timeout=120000 tests/core/broker-owner-findings-b-migration.test.ts
```

Exit 1; started `2026-11-03T06:22:41.805197+00:00`; ended `2026-11-03T06:22:48.379674+00:00`. [Launch record](evidence/task-3/red-01.json), [stdout](evidence/task-3/red-01.stdout), [stderr](evidence/task-3/red-01.stderr).

### red-02-errors

```sh
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-3/launcher.py red-02-errors sh scripts/tripwire.sh node --test --test-concurrency=1 --test-timeout=120000 '--test-name-pattern=finish failure|partial cleanup failure' tests/core/broker-owner-findings-b-migration.test.ts
```

Exit 1; started `2026-11-03T06:22:59.613780+00:00`; ended `2026-11-03T06:23:00.955419+00:00`. [Launch record](evidence/task-3/red-02-errors.json), [stdout](evidence/task-3/red-02-errors.stdout), [stderr](evidence/task-3/red-02-errors.stderr).

### green-01-focused

```sh
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-3/launcher.py green-01-focused sh scripts/tripwire.sh node --test --test-concurrency=1 --test-timeout=120000 tests/core/broker-owner-findings-b-migration.test.ts
```

Exit 0; started `2026-11-03T06:24:18.172323+00:00`; ended `2026-11-03T06:24:24.953952+00:00`. [Launch record](evidence/task-3/green-01-focused.json), [stdout](evidence/task-3/green-01-focused.stdout), [stderr](evidence/task-3/green-01-focused.stderr).

### red-03-uncertain-approval

```sh
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-3/launcher.py red-03-uncertain-approval sh scripts/tripwire.sh node --test --test-concurrency=1 --test-timeout=120000 '--test-name-pattern=restaging an uncertain' tests/core/broker-owner-findings-b-migration.test.ts
```

Exit 1; started `2026-11-03T06:25:24.732080+00:00`; ended `2026-11-03T06:25:26.036887+00:00`. [Launch record](evidence/task-3/red-03-uncertain-approval.json), [stdout](evidence/task-3/red-03-uncertain-approval.stdout), [stderr](evidence/task-3/red-03-uncertain-approval.stderr).

### red-04-uncertain-refusal

```sh
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-3/launcher.py red-04-uncertain-refusal sh scripts/tripwire.sh node --test --test-concurrency=1 --test-timeout=120000 '--test-name-pattern=uncertain Gmail' tests/core/broker-owner-findings-b-migration.test.ts
```

Exit 1; started `2026-11-03T06:26:30.968814+00:00`; ended `2026-11-03T06:26:32.575861+00:00`. [Launch record](evidence/task-3/red-04-uncertain-refusal.json), [stdout](evidence/task-3/red-04-uncertain-refusal.stdout), [stderr](evidence/task-3/red-04-uncertain-refusal.stderr).

### red-05-stale-approval

```sh
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-3/launcher.py red-05-stale-approval sh scripts/tripwire.sh node --test --test-concurrency=1 --test-timeout=120000 '--test-name-pattern=restaging an uncertain' tests/core/broker-owner-findings-b-migration.test.ts
```

Exit 1; started `2026-11-03T06:26:47.924136+00:00`; ended `2026-11-03T06:26:49.150159+00:00`. [Launch record](evidence/task-3/red-05-stale-approval.json), [stdout](evidence/task-3/red-05-stale-approval.stdout), [stderr](evidence/task-3/red-05-stale-approval.stderr).

### green-02-affected

```sh
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-3/launcher.py green-02-affected sh scripts/tripwire.sh node --test --test-concurrency=1 --test-timeout=120000 tests/core/broker-owner-findings-b-migration.test.ts tests/core/broker-owner-findings.test.ts tests/core/broker-canary.test.ts tests/core/broker-migration-recovery.test.ts tests/core/broker-review-1.test.ts tests/core/vault.test.ts tests/core/vault-owner-findings-b.test.ts tests/core/broker-boundary.test.ts
```

Exit 0; started `2026-11-03T06:27:57.565955+00:00`; ended `2026-11-03T06:28:18.144116+00:00`. [Launch record](evidence/task-3/green-02-affected.json), [stdout](evidence/task-3/green-02-affected.stdout), [stderr](evidence/task-3/green-02-affected.stderr).

### green-03-typecheck

```sh
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-3/launcher.py green-03-typecheck sh scripts/tripwire.sh node node_modules/typescript/bin/tsc -p tsconfig.json
```

Exit 0; started `2026-11-03T06:27:57.564022+00:00`; ended `2026-11-03T06:27:59.343527+00:00`. [Launch record](evidence/task-3/green-03-typecheck.json), [stdout](evidence/task-3/green-03-typecheck.stdout), [stderr](evidence/task-3/green-03-typecheck.stderr).

## Source budget and release

Boundary count: **2,721 / 3,000 lines**, 279 lines remaining. The count includes every `.ts`/`.js` file under `src/broker` using the exact boundary test's newline accounting. No moved privileged code, raised limit, removed assertions or compaction was used.

No unresolved defect from this task is known under the stated contract. Material limitations are the Gmail quiescence/metadata scope, intentional refusal for uncertain sources, the real-keychain skip, and retained Node permission-model warnings; full branch review remains pending. The commit is locally complete and reviewable. RELEASE: implementation writer released to root; no further mutations planned.


# Task 3 fix round 1/5 — review Important I1

Status: DONE_WITH_CONCERNS (existing bounded Gmail contract and Node warnings; focused checks all pass; independent re-review pending).

Read the full `task-3-review.md` before editing. Fix base was clean `9ba59fb70f5d43eef1ff255b81692f3258690200`; work remained solely in `/home/jeremy/.codex/worktrees/nova-vault-integration/nova-build`, branch `codex/vault-integration-takeover`. Fix commit: `c38cb860e32d734bbdc583133c11faa34de75a15` — `fix(vault): refuse uncertain Gmail source discovery`.

## Finding and correction

Review I1 was valid: the Gmail `there()`/`existsSync()` precheck followed symlinks and silently treated traversal/access errors as absence. Dangling token links or inaccessible existing sources could disappear from the staged source inventory. The independent reviewer probe in `evidence/task-3/review-01-uncertain-existence.*` was preserved unchanged.

Production changes are confined to `src/broker/oldvault.ts`:

- `gmailStat` uses direct `lstatSync` and treats **only ENOENT** as confirmed absence. EACCES, ERR_ACCESS_DENIED and all other inspection errors propagate to the existing generic broker error. Symlinks remain visible to the regular-file/directory checks.
- `readGmailFiles` inspects the exact fixed `connectors` root and then `connectors/gmail` before looking at files. Confirmed missing directories yield an empty Gmail inventory; existing ancestors must be real directories, not symlinks or other file types. This also prevents a dangling ancestor link from being mistaken for a missing descendant.
- The per-file check no longer calls `there()`. A confirmed absent file is omitted; existing non-regular files refuse; trustworthy regular-file epochs and before/after read checks remain unchanged.
- No `broker.ts`, `launch.ts`, `spawn.ts`, Core Vault, permission flag, read grant, write grant or environment behavior changed in this fix. There is **no authority expansion**, no blanket access-denied catch, no connector write permission during stage, no whole-home grant, and no content-derived fallback or surrogate epoch.

`tests/core/broker-migration-source-inspection.test.ts` adds 23 checks: 11 in-process public Broker cases, the same 11 through the actual permission-enabled `startBroker` plus core IPC harness, and one explicit Node permission-denial propagation check. The public cases cover entirely missing connectors, nested missing Gmail, missing files, dangling ancestors, dangling file and mode-000 ancestor failures at stage/restage/finish. They assert no legacy rewrite/removal, no stale approval authority after failed restage, generic errors without source names/values, and retained links/files. Finish cases explicitly allow already-approved broker copies but require all sources retained. The explicit denial check invokes the production `readGmailFiles` under Node permissions without granting its synthetic source path and asserts the actual `ERR_ACCESS_DENIED` code.

## Permission-model conflict and resolution

The first direct-lstat attempt resolved both reported source defects but made the existing no-connectors production case fail: `probe-02-direct-lstat` passed 17/18 and failed only **entirely absent connectors directory, permission IPC**. This was reported to root before changing authority. The failing public response was the expected generic `The old vault couldn’t be read; nothing was staged.`; the test correctly required successful ordinary migration.

The isolated Node 26.3.1 `probe-03-permission-grants` then established exact behavior rather than guessing:

- With the existing `<home>/connectors/` grant and an absent root, `lstat(connectors)` is permitted and returns **ENOENT**. Looking up its `gmail`/file descendants is not permitted and returns **ERR_ACCESS_DENIED**.
- Once the root exists, that same directory grant permits descendant inspection. A mode-000 Gmail directory produces ordinary **EACCES** at the token lookup.
- An unrelated sibling remains **ERR_ACCESS_DENIED** in all tested grant forms.
- Explicit wildcard alternatives were explored only in the synthetic probe. They were not applied to production. Root's conditional allowance for an exact-root/subtree grant was not needed: checking existing fixed ancestors first solved the conflict with **unchanged grants**.

The probe script and complete path-index/result records are saved in `evidence/task-3-fix1/permission-probe.mjs` and `probe-03-permission-grants.stdout`. The final real permission IPC controls prove no-connectors, missing Gmail directory and missing Gmail files all still migrate/remove the unrelated legacy credential normally.

## Exact attempt ledger

All runtime records use the dedicated `evidence/task-3-fix1/launcher.py`: records created before execution, unique no-overwrite labels, enumerated clean host launcher environment, unique private HOME, exact argv/workdir/timestamps/status, separate unchanged stdout/stderr. Runtime remains cached image `mcr.microsoft.com/playwright:v1.56.1-noble`, `--pull=never`, `--network=none`, UID/GID 1000, read-only checkout/root, private tmpfs, Node 26.3.1 read-only mount. No owner credentials, live keychain, desktop socket, cloud/device/model/service interaction, external network or image pull. Every recorded attempt armed the no-Kubernetes tripwire and reported **never fired**.

1. `red-01-inspection`: original fix-base production, 18 tests, **6 pass / 12 fail**, exit 1. All confirmed-missing controls pass. Both dangling and mode-000 cases incorrectly succeed at stage/restage/finish in both public harnesses; assertions require `failed` but receive no error. This is behavioral RED through actual launcher invocations, not an implementation string check. Exact pre-fix test preserved in `red-01.test.ts`.
2. `probe-02-direct-lstat`: minimal direct-lstat/ENOENT-only intermediate fix, **17 pass / 1 fail**, exit 1. Original uncertainty cases now refuse; absent connectors under production Node permissions regresses. This failure is retained, not erased or called green. Intermediate source is preserved in `probe-02-source.patch`.
3. `probe-03-permission-grants`: focused synthetic runtime diagnostic, exit 0. Eight missing/existing-root grant observations plus one OS-denial observation; the expected ENOENT/EACCES/ERR_ACCESS_DENIED results are quoted above. This was diagnostic evidence, not a claim that migration tests passed.
4. `red-04-ancestor`: before adding directory inspection, **1 pass / 3 fail**, exit 1. Both dangling-ancestor forms are silently accepted in-process, and dangling Gmail ancestor is silently accepted through permission IPC. The dangling connectors root through IPC already refused because its descendant grant was unavailable. Exact test snapshot is `red-04.test.ts`.
5. `green-05-focused`: final source, **57/57 pass**, 0 failures/skips/cancellations, exit 0. Includes all 23 inspection tests, all 21 original Task 3 tests (both independent B2 oracles in both contexts, approval binding, quiet/changed Gmail), 7 authenticated migration recovery cases, and 6 boundary/budget checks.
6. `green-06-resume-sec05`: final source, **6/6 pass**, 0 failures/skips/cancellations, exit 0. Name-filtered actual encrypted-file+key crash resume and all five Owner A SEC05 controls (newer source, lock, cache/rekey, concurrent writer and core replacement). The unrelated canary/owner tests were intentionally excluded from this focused correction run, not silently claimed as rerun.
7. `green-07-typecheck`: final source, exit 0, no diagnostics.

All runtime stderr files are empty. Existing Node child-process SecurityWarnings are retained in test stdout: 9 in red-01, 9 in probe-02, 2 in red-04, 11 in final green-05 and 1 in final green-06. The synthetic grant probe and compiler emitted no warnings. No tests were skipped in this fix round. Previous live-keychain skip/full-branch limits remain historical unresolved coverage, not newly exercised or waived. No failed test attempt was discarded and no green unaffected suite was repeatedly run.

## Commands and full output links

All commands used the explicit integration workdir. Each linked record contains exact runtime argv, launcher environment and timestamps, and each stdout preserves full assertions, warnings and tripwire results.

### Fix1 red-01-inspection

```sh
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-3-fix1/launcher.py red-01-inspection sh scripts/tripwire.sh node --test --test-concurrency=1 --test-timeout=120000 tests/core/broker-migration-source-inspection.test.ts
```

Exit 1; started `2026-11-03T06:37:02.616601+00:00`; ended `2026-11-03T06:37:19.359525+00:00`. [Record](evidence/task-3-fix1/red-01-inspection.json), [stdout](evidence/task-3-fix1/red-01-inspection.stdout), [stderr](evidence/task-3-fix1/red-01-inspection.stderr).

### Fix1 probe-02-direct-lstat

```sh
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-3-fix1/launcher.py probe-02-direct-lstat sh scripts/tripwire.sh node --test --test-concurrency=1 --test-timeout=120000 tests/core/broker-migration-source-inspection.test.ts
```

Exit 1; started `2026-11-03T06:37:46.753524+00:00`; ended `2026-11-03T06:38:02.965933+00:00`. [Record](evidence/task-3-fix1/probe-02-direct-lstat.json), [stdout](evidence/task-3-fix1/probe-02-direct-lstat.stdout), [stderr](evidence/task-3-fix1/probe-02-direct-lstat.stderr).

### Fix1 probe-03-permission-grants

```sh
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-3-fix1/launcher.py probe-03-permission-grants sh scripts/tripwire.sh node .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-3-fix1/permission-probe.mjs
```

Exit 0; started `2026-11-03T06:38:50.138488+00:00`; ended `2026-11-03T06:38:51.147350+00:00`. [Record](evidence/task-3-fix1/probe-03-permission-grants.json), [stdout](evidence/task-3-fix1/probe-03-permission-grants.stdout), [stderr](evidence/task-3-fix1/probe-03-permission-grants.stderr).

### Fix1 red-04-ancestor

```sh
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-3-fix1/launcher.py red-04-ancestor sh scripts/tripwire.sh node --test --test-concurrency=1 --test-timeout=120000 --test-name-pattern=ancestor tests/core/broker-migration-source-inspection.test.ts
```

Exit 1; started `2026-11-03T06:39:44.378269+00:00`; ended `2026-11-03T06:39:48.527986+00:00`. [Record](evidence/task-3-fix1/red-04-ancestor.json), [stdout](evidence/task-3-fix1/red-04-ancestor.stdout), [stderr](evidence/task-3-fix1/red-04-ancestor.stderr).

### Fix1 green-05-focused

```sh
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-3-fix1/launcher.py green-05-focused sh scripts/tripwire.sh node --test --test-concurrency=1 --test-timeout=120000 tests/core/broker-migration-source-inspection.test.ts tests/core/broker-owner-findings-b-migration.test.ts tests/core/broker-migration-recovery.test.ts tests/core/broker-boundary.test.ts
```

Exit 0; started `2026-11-03T06:40:39.587736+00:00`; ended `2026-11-03T06:41:07.364772+00:00`. [Record](evidence/task-3-fix1/green-05-focused.json), [stdout](evidence/task-3-fix1/green-05-focused.stdout), [stderr](evidence/task-3-fix1/green-05-focused.stderr).

### Fix1 green-06-resume-sec05

```sh
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-3-fix1/launcher.py green-06-resume-sec05 sh scripts/tripwire.sh node --test --test-concurrency=1 --test-timeout=120000 '--test-name-pattern=migration resumes:|SEC05:' tests/core/broker-canary.test.ts tests/core/broker-owner-findings.test.ts
```

Exit 0; started `2026-11-03T06:40:39.587717+00:00`; ended `2026-11-03T06:40:45.233108+00:00`. [Record](evidence/task-3-fix1/green-06-resume-sec05.json), [stdout](evidence/task-3-fix1/green-06-resume-sec05.stdout), [stderr](evidence/task-3-fix1/green-06-resume-sec05.stderr).

### Fix1 green-07-typecheck

```sh
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-3-fix1/launcher.py green-07-typecheck sh scripts/tripwire.sh node node_modules/typescript/bin/tsc -p tsconfig.json
```

Exit 0; started `2026-11-03T06:40:39.588431+00:00`; ended `2026-11-03T06:40:41.709364+00:00`. [Record](evidence/task-3-fix1/green-07-typecheck.json), [stdout](evidence/task-3-fix1/green-07-typecheck.stdout), [stderr](evidence/task-3-fix1/green-07-typecheck.stderr).

## Self-review, budget and retained limits

Read the complete source diff and new test file; `git diff --check` passes. Only `oldvault.ts` and the new test file are committed. Final file hashes and commit/base are saved in `evidence/task-3-fix1/final-manifest.json`. Boundary accounting is **2736/3000 lines**, +15 from fix base, 264 remaining. No privileged code was moved and no limit or assertion was weakened.

The correction preserves the authenticated encrypted nonce epochs, v2 group/global revisions, source-bound approval/card, failed-restage zeroing, genuine ciphertext/key crash resume, private read-back, SEC05 protection and pending authenticated recovery. It does not change Task 4 lifetime/env work. Gmail still requires quiescent writers and trustworthy OS metadata; hostile metadata/clock manipulation and races outside that contract remain unproven. No new equality-oracle exception was introduced. Independent I1 re-review and full branch gates remain root-owned; this report does not self-approve the branch or claim product cutover.

RELEASE: fix round 1 implementation writer released to root; no further mutations planned.
