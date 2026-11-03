from pathlib import Path
import datetime,json,subprocess
repo=Path('/home/jeremy/.codex/worktrees/nova-health-backend-wiring/nova-build')
root=repo/'.superpowers/sdd/health-backend-wiring-2026-11-03'
evidence=root/'evidence/task-1'
blobs=json.loads((evidence/'source-blobs.json').read_text())
checks=json.loads((evidence/'precommit-checks.json').read_text())
text='''# Task 1 — backend-only Health activation

Status: implementation and scoped verification complete; pending source release after the documentation commit. No PR, push, merge, preview or UI work performed. This report is local ignored audit material, not final-head CI or a whole-branch review.

## Identity and authorization

- Sole writing checkout: `/home/jeremy/.codex/worktrees/nova-health-backend-wiring/nova-build`.
- Branch: `codex/health-backend-wiring`.
- Clean initial BASE: `0134b074b3c97ed67c4d5765a1ba788be1205145`, the existing controller plan atop main `ab902518`; initial `git status --short` was empty.
- Read the complete Task 1 brief and all Global Constraints first. Read original Task 2 report/review and Task 3 report/review only from the original Health workspace, not the whole parent Health plan/UI history. Read the Vault Task 4 fix1 launcher pattern read-only. Parent required exact source picks, focused actual composition/API/ceiling checks and compiler, source blob proof, plain LEDGER and provenance, no worker/reviewer subagents, no other-worktree writes, and no owner actions. These constraints control over generic broad-suite/retest suggestions.
- Applied verification-before-completion and systematic-debugging skills; using-superpowers explicitly exempts dispatched subagents. No new feature or production fix is intended, so existing original test-first evidence was preserved instead of creating mirror tests. No subagent was launched.

## Exact integration and scope

Executed from this sole writing checkout, in order:

```sh
git cherry-pick -x 68b09020730e91d08b89b268abb745c52d66764e
git cherry-pick -x 19989f5d1921a29c5e41b398dc02e19ecbb189fd
```

Both exited 0 without conflict or missing UI dependency:

- `eddb30b82a0b269eed2ed1d4d9498ac947163cc2`: Caps source pick, exact `-x` provenance retained.
- `254d75ab978c33e5aef8f98d18d9b4734ea605a9`: diagnostics source pick, exact `-x` provenance retained; this is the actual tested source HEAD.

No code/test changes beyond those picks. This source HEAD, not the later docs-only HEAD, is the immutable HEAD in the isolated Git identity fixture. Later whole-branch review and exact-head CI remain root work.

Complete changed-file list against BASE (including the three authored documentation files):

'''
files=next(c['stdout'].splitlines() for c in checks if c.get('command',[])[:3]==['git','diff','--name-only'])
text+='\n'.join('- `'+p+'`' for p in files)+'\n\n'
text+='''All eleven picked files equal reviewed #285 head `1572f294d319791bfaa73ccf224335eb06eb1bbc`. The runtime/test set is eight files; the remaining three are the reviewed diagnostics docs/Core README and unchanged historical Task 3 report. Comparison commands were `git rev-parse HEAD:PATH`, `git rev-parse REVIEWED:PATH` and `git hash-object PATH`, independently checked equal for every row. No deviations:

| Path | Reviewed = integration = worktree Git blob |
| --- | --- |
'''
for row in blobs['files']:
 text+=f"| `{row['path']}` | `{row['reviewed_blob']}` |\n"
text+='''
`source-blobs.json` retains the exact comparison data. `protected-scope.json` records the initial pre-inventory protected-path `git diff --exit-code BASE -- ...` command, exit 0 and empty stdout/stderr. Initial protected paths include UI, package/lock, controller plan, capability inventory, work ledger, #284 child-env/ledger source, diagnostics scrubber, Models, existing caps/diagnostics tests, egress guard and tripwire. Parent subsequently required correction of the two current C18/C19 inventory rows because their backend descriptions falsely remained inert/unwired. `protected-scope-final.json` repeats the unchanged protection command with only that authorized file removed, exit0/empty output. Those two rows retain app Not shipped status, pending #285 Health approval/crawl, provider/replication/integrity-scrub limits, and diagnostics free-text limits. Historical #282 evidence and O14/O15 are untouched. Router/crawl code and gates were not changed. Package/lock actual bytes also match the read-only dependency-source checkout; hashes are in precommit-checks.json. No install/update or image pull occurred. The precreated empty ignored node_modules mountpoint remains empty on the host; dependencies are an explicit nested read-only Docker bind.

## Acceptance and self-review

- Core creates exactly one Caps with its existing clock and live profile timezone → detected timezone → UTC, mounts existing capsRoutes, exposes core.caps and assigns runner.caps to that exact instance. No second store, options path or alternate test injection was introduced. Existing autonomous task/day ceilings, default runaway limit, explicit-null eight-step negative control and tier-2 resume approval remain tested; personal conversation usage is recorded once per model call without autonomous caps/day consumption.
- API defaults, all six stored fields, intentional null, real restart/readback, invalid shapes/types/unknown fields/zero/negative/fraction/nonfinite JSON refusal preserve existing limits. Real console, paired browser cookie and phone bearer allowed; public/computer/standby refused; missing X-Nova/foreign Origin refused. Shared API authorization still executes before route handling, with default person access and unchanged mutation guards.
- Caps accounting explicitly says `scope:this-node-runner`, `provider_reports_included:false`. Provider reports remain separately recorded in Models and are excluded from Caps day/month totals and live caps. Other-node spend is excluded. Estimated/unpriced usage stays labeled. Durable provider-report reconciliation is Track 1 follow-up, not a second store or complete billing claim.
- Existing diagnostics builder/routes are mounted with a request-time closure after Core/server stores are initialized. Core self.build and the existing clock/version/instance are used. Numeric chat_logs/schedules/skills are fresh per request; SessionStore.countLogs uses only directory entries, valid-id/regular-jsonl classification, excludes symlinks/directories/invalid names and never opens titles/kinds/transcripts. Schedule/skill counts use existing views and return lengths only.
- Existing person guards, native JSON attachment/no-store, no persisted bundle, known-secret encodings and excluded-store canaries remain intact. No raw secret getter, arbitrary scrubber exception, weakened canary, route bypass or provider-account glue was added. Fresh HTTP/listener tests pass after a harness-only Git identity correction. Tests are private synthetic homes/file vault/fake agent/Ollama/hardware; no owner services/data/model/provider calls or preview action.
- Read the complete picked code/test changes and docs, then checked unchanged shared API guard/Reply dispatch, Caps route handlers, diagnostics request build/scrub and Self.build paths for the concrete composition risks. No new source defect found. New docs preserve the real scope instead of promoting endpoint existence into app-shipped inventory. Parent required current-claims accuracy: the two current inventory rows now say backend Caps active and diagnostics route mounted while retaining app Not shipped status and pending Health approval/crawl. No historical crawl evidence or O14/O15 was edited.
- The controller's plan and initial docs commit remain untouched. Authored the plain owner LEDGER entry, concise self-contained backend evidence/provenance doc and two current inventory row accuracy corrections. No app Health controls, rendered-entry approval, actual browser save/download, Home phone/rail crawl or W1/W2 completion claim.

## Original RED history and previous reviews preserved

Original root: `/home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build/.superpowers/sdd/health-caps-diagnostics-2026-11-03` (read-only). `collect_provenance.py` saved beside this report's evidence copies the following original files byte-for-byte into `evidence/task-1/original-health/` and records absolute source paths, copied paths, sizes and SHA-256 in `original-health-manifest.json`:

- task-2-report.md, task-2-review.md, task-2-invocation-history.md, task-3-report.md, task-3-review.md.
- Every regular file under original evidence/task-2 (11 files) and evidence/task-3 (29 files), including every RED, failed intermediate correction, final GREEN/compiler/diff log, original launcher, invocation/exit and historical hashes.

Total: 45 files, 144,285 bytes, zero hash mismatches. Original files were not changed. Historical Task 3 report also remains carried exactly by its source pick. No historical suite was rerun or rewritten as fresh evidence.

Original Caps chronology: RED and isolated final-fixture replay both 6 tests, 1 pass/5 fail (actual API 404; undefined Core Caps; null negative control passed). Focused green-attempt-1 12 pass/1 fail from incorrect lazy vault field expectation; attempt-2 12 pass/1 fail from nonloopback mesh URL; attempt-3 13/13 pass. Failed typecheck had four TS2345 header-union errors, corrected in reviewed source. Original affected and final isolated affected 89/89; final compiler/diff checks passed. Initial inherited-HOME/environment/probe limits remain disclosed, and launcher-body transcription is explicitly retrospective rather than original contemporaneous proof. No historical no-owner-contact assertion beyond the original evidence is adopted.

Original diagnostics chronology: RED 0/2 (missing countLogs, API 404). green-first 1/2 because session_logs was intentionally redacted; reviewed field was renamed chat_logs without changing scrubber/assertions. typecheck-first TS2345 header union; green-second 1/2 from lazy vault-key assertion timing; green-third 2/2. existing-affected 109/109; final affected 111/111; compiler/diff passed. All raw failures/attempts retained. Original Task 3 launcher is host Python subprocess execution, with no Docker Git-identity handling.

Both original backend reviews approved. Task 2: 0 Critical/0 Important/0 Minor. Task 3: 0 Critical/0 Important/1 Minor, optional M1: historical compiler npm available-update notice. It remains a final-review triage item, not a source blocker. New NPM_CONFIG_UPDATE_NOTIFIER=false suppresses only future notifier noise; no warnings/stderr are hidden and no passing compiler was rerun to erase its historical output.

## Dedicated safe contemporaneous launcher

`evidence/task-1/launcher.py` was saved before the first run, derived from the exact read-only Vault Task 4 fix1 launcher. `launcher-initial.py` retains its pre-correction body byte-for-byte. Each unique run label refuses to overwrite evidence and writes its enumerated host environment, full Docker argv/command/cwd and start timestamp before child execution; it then appends actual exit status/end timestamp and retains separate complete stdout/stderr. The wrapper returns the actual child exit code. No cat masks status.

Common Docker contract:

- `/usr/bin/docker run --rm --pull=never --network=none --user=1000:1000 --read-only` with `/tmp:rw,exec,nosuid,size=1g` tmpfs.
- Cached image `mcr.microsoft.com/playwright:v1.56.1-noble`; no pull/install. Actual Node v26.3.1 confirmed.
- Own checkout bound read-only to `/workspace`; matching installed deps bound explicitly read-only from `/home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build/node_modules` to `/workspace/node_modules`; `/home/jeremy/.local/share/mise/installs/node/26.3.1` bound read-only to `/opt/node`.
- Container workdir `/workspace`; host workdir the sole writing checkout above.
- Host launcher env only PATH=/usr/bin:/bin, unique temporary private HOME, LANG=C.UTF-8. Host HOME exact values are saved in each JSON and removed after run.
- Container env overrides HOME=/tmp/nova-health-backend-task1-private-home (created mode700 inside each new tmpfs), PATH=/opt/node/bin:/usr/bin:/bin, NOVA_VAULT_KEY=file, NPM_CONFIG_UPDATE_NOTIFIER=false, TZ=UTC, LANG=C.UTF-8. No inherited provider/Nova/keychain/Git credentials.
- All checks run through existing scripts/tripwire.sh (test.sh invokes it); every run printed never fired. Fake runtime/listeners stay inside an isolated network namespace. No owner HOME, gitdir/config/credential helper, service, keychain, keys, device, model, cloud/account or preview mount/action.

### First failure and targeted harness correction

Original focused invocation: exit1, 30 tests, 29 pass/1 fail, zero skipped/cancelled/todo, 5735.863097ms. Only `tests/core/diagnostics-composition.test.ts:63` failed: about.build was null versus regex /^[a-f0-9]{7,40}$/. Compiler independently exited0. All original logs and first launcher preserved.

Root cause (systematic-debugging): unchanged Self.build at src/core/self.ts:292 runs git -C codeRoot rev-parse --short HEAD and catches errors as null. The code mount's .git file points at a host external worktree directory. A dedicated tripwire-wrapped probe confirmed /usr/bin/git exists, then exit128 with `fatal: not a git repository: /home/jeremy/workspace/nova-build/.git/worktrees/nova-build10`. This is missing container Git metadata, not a missing Health source/UI dependency. Read original Task3 run.py to confirm it previously used host Git. Parent explicitly authorized synthetic read-only metadata preserving actual tested HEAD, forbidding shared gitdir/owner config/credential binds and test weakening.

Exact identity creation executed as host Python inline from this checkout (this report transcribes that already-executed tool call; it does not claim a contemporaneous standalone script):

```python
from pathlib import Path
import hashlib,json,subprocess,zlib
repo=Path.cwd()
evidence=repo/'.superpowers/sdd/health-backend-wiring-2026-11-03/evidence/task-1'
launcher=evidence/'launcher.py'
(evidence/'launcher-initial.py').write_bytes(launcher.read_bytes())
head=subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()
raw=subprocess.check_output(['git','cat-file','commit',head])
obj=b'commit '+str(len(raw)).encode()+b'\\0'+raw
assert hashlib.sha1(obj).hexdigest()==head
identity=evidence/'git-identity'
(identity/'objects'/head[:2]).mkdir(parents=True)
(identity/'refs').mkdir()
(identity/'HEAD').write_text(head+'\\n')
(identity/'config').write_text('[core]\\n\\trepositoryformatversion = 0\\n\\tbare = false\\n')
(identity/'objects'/head[:2]/head[2:]).write_bytes(zlib.compress(obj))
(evidence/'git-pointer').write_text('gitdir: /workspace/.superpowers/sdd/health-backend-wiring-2026-11-03/evidence/task-1/git-identity\\n')
(evidence/'git-identity.json').write_text(json.dumps({'head':head,'source':'git cat-file commit HEAD; exact SHA-1 validated','scope':'single actual commit object, detached HEAD, empty refs, local-only minimal config; no shared Git directory/history/config'},indent=2)+'\\n')
s=launcher.read_text().replace("        '--mount', 'type=bind,src=/home/jeremy/.local", "        '--mount', f'type=bind,src={evidence}/git-pointer,dst=/workspace/.git,readonly',\\n        '--mount', 'type=bind,src=/home/jeremy/.local")
launcher.write_text(s)
print(head)
```

Creation output: `254d75ab978c33e5aef8f98d18d9b4734ea605a9`. Only own `/workspace/.git` is overlaid via the explicit read-only bind; the actual commit object and pointer are under own read-only code/evidence mount. No Git environment overrides or remote/config/history/credential data. Probe exit0 returned `254d75a`, proving actual tested HEAD, not a fabricated hash or assertion bypass. No source/test file was changed. Reran amended diagnostics file only first, as parent required: exit0, 2/2 pass, zero skips/cancellations/todo, 748.208278ms. The other 28 planned cases already passed initially; one previously passing directory-count case repeats within the necessary two-test file rerun. No single fresh 30/30 invocation is claimed and no larger passing group was repeated.

## Exact new verification commands, statuses and complete outputs

For each label below the host invocation is:

`python3 .superpowers/sdd/health-backend-wiring-2026-11-03/evidence/task-1/launcher.py LABEL COMMAND...`

The following retained JSON is the actual launch record (full argv/env/cwd/timestamps/status), followed by exact stdout and stderr. Ordinary compiler npm invocation notices are retained. No hidden/redacted warnings or output omissions.
'''
for label in ['runtime','focused','compiler','git-boundary','git-identity-probe','diagnostics-corrected']:
 text+=f'\n### {label}\n\n```json\n'+(evidence/f'{label}.json').read_text()+'```\n\nstdout:\n\n```text\n'+(evidence/f'{label}.stdout').read_text()+'```\n\nstderr:\n\n```text\n'+(evidence/f'{label}.stderr').read_text()+'```\n'
text+='''
## Scope/provenance verification commands and outputs

`python3 .../evidence/task-1/collect_provenance.py` exited0:

```json
{"archived_original_files":45,"archived_bytes":144285,"source_blob_matches":11,"runtime_test_blob_matches":8,"protected_scope_exit":0}
```

The script itself is retained; it performs exact per-file Git blob and byte/sha comparisons and captures the protected-scope diff without modifying source. Then `git add -- docs/builder-packet/CAPABILITY-INVENTORY.md docs/LEDGER.md docs/evidence/health-backend-wiring-2026-11-03.md` staged only the three authorized documentation files. Initial pre-inventory staging/check records remain in precommit-checks-initial.json. Precommit verification (all commands executed with explicit sole-checkout cwd):

```json
'''+json.dumps(checks,indent=2)+'''\n```

Exploration failures/warnings retained in this report's command audit: `git rev-parse 1572` exited128 because 1572 matched both commit1572f294 and tree15728ed3; corrected once to full reviewed commit1572f294d319791bfaa73ccf224335eb06eb1bbc, not a source ambiguity. A bounded read plus rg across nonexistent optional env filenames exited2; follow-up read the actual self.ts/child-env.ts files; no code/test invocation failed there. Initial combined read/diff/LEDGER tool outputs exceeded output limits; complete original reports were reread individually and changed code/docs inspected in bounded reads. These do not replace any missing test output: all test/probe/compiler stdout/stderr above are complete and retained.

## Limits and controller handoff

- No newly found source blocker, skip, weakened assertion, bypass or dependency change. Historical optional npm-notice Minor M1 remains recorded for final review.
- Runner-only accounting cannot represent complete monthly billing. Provider loops/reports and other nodes remain excluded; Models keeps separate accounting. No provider report reconciliation/store added.
- Known-secret/excluded-store tests are named boundary proof, not a universal privacy classifier. Arbitrary personal free text may remain in included log/problem messages, names and service details. Existing documented synthetic hostname/IP/model/runtime metadata is allowed; no actual owner/private host/data entered builder evidence.
- Health UI/specimen approval remains pending in #285; no UI source was cherry-picked. C18/O14 and C19/O15 remain API-only/app-not-shipped. Inventory app Not shipped flags, router/crawl gates and controller initial plan are unchanged; only the two current backend descriptions were corrected under parent instruction. W1/W2, save/download browser interactions and Home phone/rail crawl are not done by this task.
- Original RED/GREEN/history limitations are preserved rather than upgraded into modern no-contact proof. New clean-container evidence qualifies only the focused backend integration on source HEAD254d75ab, not full CI or a real owner system.
- Root owns fresh most-capable whole-branch review, ordinary exact-head all-required CI, PR/push/merge, matching-head tree checks and authorized preview. None performed by this worker. No other-worktree writes or process kills.

Final documentation commit and postcommit scope verification will be appended after the commit; no further production writes are planned.
'''
(root/'task-1-report.md').write_text(text)
print(json.dumps({'report':str(root/'task-1-report.md'),'bytes':len(text.encode()),'lines':len(text.splitlines())}))
