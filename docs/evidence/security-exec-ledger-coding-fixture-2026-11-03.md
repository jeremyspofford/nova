# Coding fixture maintenance and repository-integrity evidence

PR #284. Third ordinary run41569116009 atdd41 failed one unit test:1647total,1632pass,1fail,14unchangedskips,0cancelled; tripwire never fired. The exact protected-repository tree equality assertion at coding.test.ts246 failed. UI subsequently passed157/157 with zero failures/skips/cancellations/warnings; gate125709575171 failed because of the unit result.

Historical CI retained hashes, not differing-path manifests. Its exact path delta remains **UNKNOWN**. The evidence below separately proves a real fixture lifetime race at that same unchanged assertion with controlled actual Git2.56 scheduling and a fixture-only control. It is not a claim of recovered historical CI trace or unauthorized application content changes.

Only test helper `tests/support/coding.ts` changes at`c82e6cfc9f1c2e479400074457fa2c8a347216f2`: synchronous automatic maintenance via command-line maintenance.autoDetach=false. Production, treeHash, every refused-agent outcome and the complete repository equality assertion remain unchanged. Independent review approved with no findings. Fresh full ordinary CI, including its shared UI fixture consumer, is still mandatory.

## Original raw CI log identity

| Job | Result | Bytes | SHA-256 |
|---|---|---:|---|
| [job125697727049](https://github.com/jeremyspofford/nova/actions/runs/41569116009/job/125697727049) | unit1fail | 257462 | `1ffcd0735a87a0563ba7338bbfdc411de3569ceee692755d5022266ebb8e0fb3` |
| [job125697726975](https://github.com/jeremyspofford/nova/actions/runs/41569116009/job/125697726975) | UI157/157pass | 233413 | `6f19da40021b572e33c4cc06bb6d09e39f1bb58d609e2553afa39da3a66db4f5` |

## Complete implementer report

# Coding repository-integrity CI investigation and fixture correction

Base: `dd41c5e67c604f8edc24f0654d8c4316be9eedf3`, branch `codex/security-exec-ledger`.
Workspace: `/home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build`.

## Observations and limits

The historical CI log is `ci-unit-job-125697727049.log` alongside this report (257462 bytes). CI's only failure was `tests/core/coding.test.ts:246`, the unchanged original complete-tree equality assertion after all negative agent refusals and the explicitly editable test case. CI expected `c85cbbb298c7268f86642b1f1b5ae401145c21d0da98dbc224c4543d8aeb1627`, actual `f36a5659142fe7ea5619569d1fb192d8dc41e3901a5e5849045e8a698d5f5342`. That run retained no path manifests, so its exact historical path delta cannot be recovered from those hashes. Do not claim otherwise.

One unchanged isolated named-case run passed on Node 26.3.1 / Git 2.53.0 (`01-unchanged-case.log`). A full-byte manifest diagnostic passed (`02-manifest-case.log`), with identical hashes and no differing paths. One version-matched Git 2.56.0 run also passed (`08-git256-manifest-case.log`). No repeated passing-suite or blanket full-suite runs were used.

Controlled scheduling reproduced the exact original assertion with all preceding refusal outcomes intact (`10-controlled-case.log`). The before/after full manifests show the ONLY delta is deletion of `.git/objects/maintenance.lock`: an empty regular file of mode 33188 (0100644), SHA256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`, present before and absent after. All other 42 entries, including work files, configuration, HEAD, refs, object files, directories, modes and any symlink targets, remain equal. See `controlled-manifest-diff.json` and `controlled-manifests/`.

The control in `11-fixture-only.log` constructs no Nova/core/provider whatsoever. Fixture creation, the first tree hash, completion of its real Git maintenance daemon and another hash alone reproduce exactly that one delta (`fixture-only-manifests/`, `fixture-only-diff.json`). This isolates an actual fixture lifetime race without excusing repository contents or weakening the hash oracle.

## Controlled diagnostic, not an unmodified timing reproduction

Git 2.56.0 was downloaded as an upstream release source archive from `https://www.kernel.org/pub/software/scm/git/git-2.56.0.tar.xz`, built privately under the logs directory, without installing anything or modifying system Git. Local zlib 1.3.1 source was needed for headers/static linkage. Build failures and the successful build are retained in logs 03–07: missing zlib headers, command-line CFLAGS misuse suppressing Git's defines, missing cargo; final build explicitly uses NO_RUST and does not download Rust dependencies. No Git repository was cloned.

Git 2.54 release notes announce geometric maintenance as default; Git 2.55 release notes describe the detached-maintenance lock fix. Git 2.56 `builtin/gc.c:maintenance_run_tasks` takes the real objects/maintenance lock, daemonizes, runs background tasks and releases it. The fixture helper's synchronous `execFileSync` waits for the invoking Git process, not that detached worker. Production `src/core/coding/git.ts` already uses `maintenance.auto=false` and `gc.auto=0`.

The retained `git-diagnostic.patch` adds only a private-file rendezvous after Git's real daemonization and before its existing background phase/lock release. It does not create/delete any repository entry. The ready file identifies that daemon; its wait has a 10-second fail-open diagnostic bound. The fixture helper temporarily passes the diagnostic variable ONLY to its own final fetch, waits for readiness, and the manifest helper releases the barrier only after capturing the first full tree. Production Git's finite environment forwards none of this. The unchanged behavioral test then detects the real Git-created lock's removal.

`coding-support-original.ts` and `coding-support-diagnostic.ts` retain exact helper states. `git-diagnostic-receipt.patch` adds an explicit detach mode receipt for a comparative synchronous-maintenance experiment, still preserving the same barrier for detached workers. `13-controlled-receipt-red.log` fails at the same original assertion, and `receipt-red-diff.json` records the same sole path. These are controlled diagnostic REDs, not claims that unmodified timing deterministically failed locally.

No test assertion, refusal expectation or production source has been changed. Root explicitly approved the test-helper-only `maintenance.autoDetach=false` remedy after reviewing the controlled failure and fixture-only control: preserve maintenance semantics and join owned Git maintenance before the helper returns. This is a fixture completion correction, not an exception to the protected-repository contract. The exact CI historical path remains unknown. All known diagnostic daemon PIDs (2319422, 2319880, 2320176) were individually checked and had exited; no owner process inventory was consulted.

## Commands and safety

Every shell tool call uses the workspace above as its working directory. Test calls use Node 26.3.1 first on PATH and `timeout <bound>s sh scripts/test.sh [flags BEFORE paths]`, retaining the no-Kubernetes tripwire. No test-force-exit, timeout widening, production sleep, environment allowlist relaxation or protected-file omission is used. Every completed test run printed tripwire never fired. No real provider, owner repository/data, credentials, cloud, Kubernetes, device, image/model pull, protected preview/Serve or shim was used. The source archive downloads are public upstream build inputs only.

Exact unchanged/diagnostic named-case invocation:

```sh
PATH=/home/jeremy/.local/share/mise/installs/node/26.3.1/bin:$PATH timeout 150s sh scripts/test.sh --test-name-pattern='^M10c: what Nova refuses from an agent:' tests/core/coding.test.ts
```

For Git 2.56, append `$PWD/.superpowers/sdd/security-exec-ledger-2026-11-02/ci-coding-fix-logs/git-2.56.0` immediately after Node's PATH entry. For manifests set `NOVA_PRIVATE_MANIFEST_DIR` to the named logs subdirectory. Controlled runs additionally set `NOVA_PRIVATE_MAINT_HOLD` to the private gate path, with distinct names for each experiment, and use the retained diagnostic helper/source. All stdout/stderr are retained in numbered logs.

Successful build command (from the workspace):

```sh
make -C .superpowers/sdd/security-exec-ledger-2026-11-02/ci-coding-fix-logs/git-2.56.0 -j4 NO_RUST=YesPlease NO_GETTEXT=YesPlease NO_TCLTK=YesPlease NO_CURL=YesPlease NO_OPENSSL=YesPlease CFLAGS="-O2 -I$PWD/.superpowers/sdd/security-exec-ledger-2026-11-02/ci-coding-fix-logs/zlib-1.3.1" LDFLAGS="-L$PWD/.superpowers/sdd/security-exec-ledger-2026-11-02/ci-coding-fix-logs/zlib-1.3.1" git git-upload-pack
```

Archive hashes: Git `26c56c296b38c0695b26fa95f475f1d01704d2d38e73465ca30b0b2f5dc789d3`; zlib `9a93b2b7dfdac77ceba5a558a580e74667dd6fede4585b91eefb60f03b72df23`. These are recorded content hashes, not a claim of signature verification.

## Final change and comparative proof

The sole tracked change is `tests/support/coding.ts`: add `-c maintenance.autoDetach=false` to test-side Git's explicit arguments, with two explanatory comment lines. Automatic maintenance still runs when Git chooses it, but cannot outlive the synchronous fixture command. The environment remains the same finite fixture environment, no ambient Git selector is forwarded, and no runtime dependency or production behavior changes. `treeHash`, all negative refusal expectations and all repository equality assertions are byte-for-byte unchanged. Source policy S1/S2 and Ledger behavior are untouched.

The same controlled diagnostic with its actual detach-mode receipt gave:

- RED: `13-controlled-receipt-red.log`, `receipt-red-gate.ready`: PID 2320176, `detach=1`; original assertion line 246 fails. Before hash `1f088d9241cf67e99f4d1dc40348665423d0b8a0596702fb0d0fb69228971187`, after `f7589c7d94b85254bab87443d653c8464a095ce075c449668a4d2f19bc35335f`; only maintenance.lock deleted.
- GREEN: `14-controlled-receipt-green.log`, `receipt-green-gate.ready`: PID 2320532, `detach=0`; the same original behavioral test passes. Before/after hash `ffd5002f163bdb0ad7c88b293b8736c806ac8cf4f0334ca138c8785ff5a624d2`; zero differing entries. Full snapshots in `receipt-green-manifests/`, diff in `receipt-green-manifests-diff.json`.

`coding-support-diagnostic-green.ts` retains the temporary diagnostic version including the approved fix. All diagnostics were then removed from the tracked helper by restoring its exact baseline and adding only the final option/comments. The private Git C source was restored byte-for-byte to the release source and rebuilt (`15-git-pristine-rebuild.log`). Its `builtin/gc.c` SHA256 matches retained pristine source: `17a03f6f413a82f9a532596b0b3bf5c43119c1d9e8209149dff8d5f69e41e21d`.

## Final verification scope and packaging correction

Host Git 2.53.0, final helper source: full `tests/core/coding.test.ts`, 12/12 PASS, no skips/cancellations, tripwire never fired (`17-final-host-coding.log`, 11.413 seconds). Typecheck passes (`18-final-typecheck.log`).

The first pristine Git 2.56 cohort had 51 PASS / 1 FAIL (`16-final-git256-affected.log`). The sole failure was the existing hook canary test `a whole coding run, merge included, runs none of the person’s hooks and no fsmonitor`: ENOENT creating `.git/hooks/pre-commit`. This private build had not built/configured its standard template directory. No repository source was changed for that failure. Built Git's upstream templates using `make -C <private-git-source>/templates all`, then rebuilt with `template_dir="$PWD/.superpowers/sdd/security-exec-ledger-2026-11-02/ci-coding-fix-logs/git-2.56.0/templates/blt"` plus the same successful flags above (`19-private-templates-build.log`). Nothing was installed globally. This packaging correction justified one fresh affected-cohort rerun against unchanged final helper source.

Affected-cohort command, flags precede paths, pristine Git 2.56 first after Node on PATH:

```sh
PATH="/home/jeremy/.local/share/mise/installs/node/26.3.1/bin:$PWD/.superpowers/sdd/security-exec-ledger-2026-11-02/ci-coding-fix-logs/git-2.56.0:$PATH" timeout 420s sh scripts/test.sh tests/core/coding.test.ts tests/core/coding-git.test.ts tests/core/coding-review.test.ts tests/ingest/coding-guard.test.js tests/ingest/checks.test.ts tests/acceptance/m10c-coding.test.ts tests/core/decision-service-boundary.test.ts
```

This includes all original coding cases; local Git transport/config/hook/fsmonitor guards; coding commit/cancel/preview/branch/scope/integrity review cases; ingest approval guarding and its checks; the actual chat-to-review-to-decline/confirmed-merge acceptance case; and Decision Service boundary checks. These cover fixture consumers and coding effects without rerunning unrelated exec/S1, Ledger, browser or trigger packages whose source did not change. The original ongoing CI UI outcome remains root-owned; no local UI gate, blanket full suite or new CI run was launched here. Root must review and perform its ordinary CI/merge/preview gate separately.

Exact host full-file and typecheck commands:

```sh
PATH=/home/jeremy/.local/share/mise/installs/node/26.3.1/bin:$PATH timeout 200s sh scripts/test.sh tests/core/coding.test.ts
PATH=/home/jeremy/.local/share/mise/installs/node/26.3.1/bin:$PATH timeout 120s npm run typecheck
```

Final source SHA256: `tests/support/coding.ts` = `8b2bfc378d014bf7311d0aeec94de77817b248c2a5a379edb901969bbb0c5e81`. Unchanged original case file SHA256 = `4b615ccc97d29f20172bfb5f90b5cf6f33e3b42bec0bad967cf6883a66ca6d2e`; unchanged production Git wrapper SHA256 = `3847b0b28a9bc652d5cb57928b204c82aa52e30f1776dc398b3cc2fb0600a7a6`.

## Completion and release

Final pristine Git 2.56 affected cohort: **52/52 PASS**, zero failures/skips/cancellations, 14.110 seconds; tripwire never fired (`20-final-git256-affected.log`). This includes all 12 original coding cases and the previously failing hooks/fsmonitor canary. Final host Git cohort: **12/12 PASS** (`17-final-host-coding.log`). Typecheck exit 0 (`18-final-typecheck.log`). Final unstaged/staged/committed diff checks exit 0; final patch in `23-final.patch`. No code changed after these successful runs.

Normal test-only commit: **`c82e6cfc9f1c2e479400074457fa2c8a347216f2`**, `test(coding): wait for fixture Git maintenance`, parent **`dd41c5e67c604f8edc24f0654d8c4316be9eedf3`**. Only `tests/support/coding.ts` is committed (3 additions, 1 deletion). The worktree's tracked status is clean. No report, root document, downloaded archive, Git build, diagnostic source, or log is staged/committed. No amend/rebase/push/PR/merge was performed.

All four owned diagnostic process receipts (2319422, 2319880, 2320176, 2320532) individually report exited. Every recorded private fixture root is removed by the test wrapper. All test/build sessions returned normal exit codes (including explicitly retained diagnostic RED/build failures); no external watchdog fired. No containers were created. See `21-cleanup-and-hashes.log` for exact owned-PID/fixture cleanup evidence and private binary/source hashes. Private Git source/build and causal evidence are retained only for independent review; the final binary's source is pristine, with standard templates configured privately, SHA256 `1d6c68b174d1c89d943f6fda169fa7b24f00416bd00ad316a75482a35e724146`.

RELEASE: all assigned implementation, diagnostic, verification and report writes are complete. No owned processes remain active. Root may independently review this one-file commit and then resume its records/ordinary CI gates; historical CI path causation remains an inference supported by the controlled exact-assertion reproduction, not a recovered CI manifest.

## Complete independent review

Spec compliance: Pass.
Task quality: Approved.
Findings: Critical 0 / Important 0 / Minor 0.

Reviewed scope: `dd41c5e67c604f8edc24f0654d8c4316be9eedf3..c82e6cfc9f1c2e479400074457fa2c8a347216f2`, using the supplied one-file review package. This is approval of the fixture completion correction, not a final CI, whole-branch, merge, or preview verdict. Evidence paths below are relative to `.superpowers/sdd/security-exec-ledger-2026-11-02/` unless they begin with `tests/` or `src/`.

## Spec compliance and strengths

- `tests/support/coding.ts:23`: the two comment lines explain the actual lifetime boundary: fixture-owned automatic maintenance must finish before the complete repository baseline is recorded.
- `tests/support/coding.ts:26`: the only behavioral change is the explicit `-c maintenance.autoDetach=false` argument to the existing synchronous Git invocation. It preserves automatic maintenance and waits for its foreground completion. The supplied diff contains no production, treeHash, refusal, assertion, environment, dependency, timeout, or protected-path exception change (`review-dd41c5e6..c82e6cfc.diff:26`).
- `tests/support/coding.ts:28`: the existing finite environment and configuration isolation remain unchanged; no diagnostic variable or ambient Git selector is added. Existing execFileSync failure propagation is preserved at line 26.
- Named production-policy risk check: production already disables automatic maintenance through `gc.auto=0` and `maintenance.auto=false` (`src/core/coding/git.ts:34`, `src/core/coding/git.ts:35`). The patch does not alter production behavior or the repository protection contract.
- Named supported-setting/lifetime check: retained upstream Git 2.56 documentation defines foreground automatic maintenance (`ci-coding-fix-logs/git-2.56.0/Documentation/config/maintenance.adoc:6`). Its actual command preparation reads `maintenance.autodetach` and selects `--no-detach` when false (`ci-coding-fix-logs/git-2.56.0/run-command.c:1974`, `:1982`). The maintenance implementation takes the repository objects maintenance lock before the optional daemonization and releases it after background-phase tasks (`ci-coding-fix-logs/git-2.56.0/builtin/gc.c:1402`, `:1423`, `:1434`). This confirms the option addresses the demonstrated race without suppressing maintenance.

## Independently checked causal evidence

- The historical CI log records Git 2.56.0 and the original integrity assertion at `tests/core/coding.test.ts:246` (`ci-unit-job-125697727049.log:55`, `:1978`, `:1984`). This establishes the failing assertion and version, not the historical differing path.
- The retained diagnostic patch inserts a bounded rendezvous after real daemonization and before existing background work; it does not add or remove repository entries (`ci-coding-fix-logs/git-diagnostic-receipt.patch:3`, `:7`, `:18`). The retained diagnostic helper restricts the variable to fixture fetch, captures the original whole-tree hash, and releases the rendezvous after recording the snapshot (`ci-coding-fix-logs/coding-support-diagnostic-green.ts:24`, `:52`, `:58`, `:74`). These files are diagnostic evidence, not the reviewed tracked change.
- I independently compared all raw before/after manifest objects in `controlled-manifests/`, `fixture-only-manifests/`, and `receipt-red-manifests/`. Each has 43 entries before and 42 after, with exactly 42 identical entries. The sole change is removal of `.git/objects/maintenance.lock`: empty regular file, mode 33188/0100644, SHA256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`. Paths, recorded file bytes, types, modes, refs, and recorded link targets otherwise compare equal. This independently agrees with `ci-coding-fix-logs/controlled-manifest-diff.json:8` and `:18`, `fixture-only-diff.json:2`, and `receipt-red-diff.json:2`.
- For all eight raw manifests, I verified each file's decoded byte digest and recomputed the complete tree hash using the recorded original hash ordering/format. Every recomputed hash matches its stored hash. The raw comparisons therefore do not rely only on the implementer's summary diff JSON.
- The fixture-only control imports fixture helpers and Node built-ins, creates no Nova/core/provider, hashes, waits for lock disappearance, and hashes again (`ci-coding-fix-logs/fixture-only.test.ts:1`, `:8`, `:17`). Its successful run records the same isolated change (`ci-coding-fix-logs/11-fixture-only.log:2`).
- The receipt comparison records `detach=1` for RED and `detach=0` for GREEN (`ci-coding-fix-logs/receipt-red-gate.ready:1`, `receipt-green-gate.ready:1`). RED reaches the unchanged original assertion at line 246 (`13-controlled-receipt-red.log:22`); GREEN passes that same case (`14-controlled-receipt-green.log:2`). I independently compared GREEN's raw pair: all 41 entries match, zero path changes, with identical independently recomputed hash `ffd5002f163bdb0ad7c88b293b8736c806ac8cf4f0334ca138c8785ff5a624d2` (`receipt-green-manifests/manifest-1793676135721-uy4i2yb0p2.json:1`, `receipt-green-manifests/manifest-1793676136279-3g466vtz624.json:1`).
- I independently hashed the retained pristine and final `builtin/gc.c`: both equal `17a03f6f413a82f9a532596b0b3bf5c43119c1d9e8209149dff8d5f69e41e21d`. The final private Git binary hash also matches the recorded `1d6c68b174d1c89d943f6fda169fa7b24f00416bd00ad316a75482a35e724146` (`ci-coding-fix-logs/21-cleanup-and-hashes.log:11`). This verifies the targeted diagnostic restoration evidence, not a signature or exhaustive build attestation.

## Validation evidence and remaining limits

- The final pristine Git 2.56 affected cohort reports 52/52 passing, no failures/skips/cancellations, and an unfired tripwire (`ci-coding-fix-logs/20-final-git256-affected.log:54`, `:62`). It includes the hooks/fsmonitor canary (`:7`) and Decision Service boundary checks (`:35`, `:37`). The final host cohort reports 12/12 passing with an unfired tripwire (`17-final-host-coding.log:14`, `:22`). The typecheck log contains the compiler invocation and no diagnostics (`18-final-typecheck.log:2`). No warning/error output was found in these final logs. I did not rerun green tests.
- Initial build failures and the 51/52 cohort are disclosed rather than erased. The retained initial cohort identifies missing `.git/hooks/pre-commit` as ENOENT (`ci-coding-fix-logs/16-final-git256-affected.log:67`); the report explains the private templates packaging correction (`ci-coding-fix-report.md:63`), its retained build log finishes linking, and the final cohort passes the same canary. These resolved diagnostic/build conditions are not outstanding defects in the one-line helper correction.
- Cannot verify the exact historical CI path delta: CI retained hashes, not manifests. The controlled reproduction proves a real fixture lifetime race at the same assertion; attribution of the historical CI failure to that race remains an inference (`ci-coding-fix-report.md:8`, `:90`). The passing unmodified local runs do not constitute a deterministic unmodified-timing reproduction.
- Named shared-helper consumer check: `tests/ui/m10c-coding.test.ts:12` imports this helper. No local UI run on the final source is supplied. The root's required fresh full ordinary UI run on the corrected head must cover this consumer; an older-head UI result cannot qualify it (`ci-coding-fix-report.md:71`). This remains a validation dependency outside this task-scoped approval.
- I did not independently reconstruct Git history/index/HEAD, rerun silent diff checks/typecheck to capture exit statuses, audit the entire private build, inspect owner state, or verify final CI/merge/preview. The supplied diff and retained logs support this scoped review; command exit statuses, exact commit packaging, and global absence-of-side-effect claims remain implementation/root records (`ci-coding-fix-report.md:84`, `:86`, `:88`). No broad security or completion guarantee is inferred from this narrow patch.

## Issues and assessment

Critical: None.
Important: None.
Minor: None.

Task quality: Approved. The explicit supported Git option closes the proven fixture lifetime boundary while preserving the complete-tree oracle and production protections. The raw controlled failure/control/foreground evidence supports the minimal change; historical causation and the fresh ordinary UI/CI gates remain explicitly bounded above.

RELEASE: review complete. Only this review report was written. No tests, builds, Git state mutations, subagents, downloads, or background processes were started by this review; all review commands have returned. No further commands or writes are pending.

## Exact controlled manifest deltas

Raw full manifests and private build/source artifacts are retained locally; the independent review rehashed every raw file and recomputed complete tree hashes. The small deltas below contain all changed protected entries.

### `controlled-manifest-diff.json`

```json
{
  "before": ".superpowers/sdd/security-exec-ledger-2026-11-02/ci-coding-fix-logs/controlled-manifests/manifest-1793675889906-unnifpl9dib.json",
  "after": ".superpowers/sdd/security-exec-ledger-2026-11-02/ci-coding-fix-logs/controlled-manifests/manifest-1793675890436-pc39za7vau.json",
  "root": "/tmp/nova-test-WRoSKE/nova-coding-DPCpD1/project",
  "beforeHash": "c8323fa7ffb16e9fe5fa767a5c0ab52fd227ac03807b9ec9c360642c71ce1dec",
  "afterHash": "69f8434e960d633e9f343f37e12621251fed1ca7a351df64b021658c9b0deb85",
  "changedPaths": {
    ".git/objects/maintenance.lock": {
      "before": {
        "type": "file",
        "mode": 33188,
        "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "bytes": ""
      },
      "after": null
    }
  },
  "otherEntriesUnchanged": 42
}
```

### `fixture-only-diff.json`

```json
{
  ".git/objects/maintenance.lock": {
    "before": {
      "type": "file",
      "mode": 33188,
      "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "bytes": ""
    },
    "after": null
  }
}
```

### `receipt-red-diff.json`

```json
{
  ".git/objects/maintenance.lock": {
    "before": {
      "type": "file",
      "mode": 33188,
      "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "bytes": ""
    },
    "after": null
  }
}
```

### `receipt-green-manifests-diff.json`

```json
{}
```

## Additional ruling

25. Ruling: make fixture Git maintenance synchronous with explicit maintenance.autoDetach=false, preserving maintenance semantics and every full-tree/refusal assertion. Why: controlled actual Git2.56 and fixture-only controls prove an owned daemon can remove its preexisting empty maintenance lock after baseline hashing; no Nova mutation or assertion exception is needed. Cost if wrong: fixture setup can take longer and another integrity cause could remain; finalpristine-version52/host12/independentreview/ordinaryCI stillrequired and the historicalCIpath remains unobserved.

[Exact safe test/diagnostic output](security-exec-ledger-ci-output-2026-11-03.md#third-ci-coding-fixture-output) includes controlled RED, no-Nova control, foreground GREEN, the resolved private-template packaging failure and final52/12 passes. Compiler/vendor source and unrelated process snapshots are not published.
