# Task 3 — production diagnostics mounting

Status: implementation and focused verification complete; released for independent review. No UI work, push, PR, preview or merge performed.

## Scope and final behavior

Base: `17ec5b9deb33df9897780d2293852e178588320a`, branch `codex/health-caps-diagnostics`, sole writing checkout `/home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build`.

- Core mounts the existing `diagnosticsRoutes` and `buildDiagnostics` through a late getter over the returned Core object. Metadata uses existing version, instance, clock and `self.build()` getter. Construction does not build a bundle; each authorized request builds in memory.
- Production `createNova` passes an Era 2 callback returning numeric `chat_logs`, `schedules` and `skills`, evaluated per download. No provider/model inference call, dependency, shadow store or second route implementation was added.
- `SessionStore.countLogs()` reads directory entries only. It counts regular `.jsonl` files with a valid session id, including main, run and helper logs, even empty/malformed contents. Invalid names, directories and symlinks are excluded. It does not read title, kind, metadata or transcript. Existing SessionStore APIs are unchanged.
- Existing person access, authorization, mutation guards, native JSON, attachment filename, no-store and diagnostics scrubber are reused unchanged. Existing diagnostics canary assertions/eval graders were not edited.
- Docs explain the count semantics and residual privacy limits. No app/surfaces/components/styleguide/crawl changes.

## Root contract rulings

1. Root rejected `store.list().length` because listing reads session titles/kind. Root authorized directory-only `countLogs()` including main/run/helper. Initial requested field `session_logs` collided with the scrubber's intentional `/session/i` match and was redacted even when numeric. Root ruled `chat_logs`; no scrubber exception or weakened assertion.
2. The “no output includes private mesh addresses” constraint applies to tool/public evidence, not removal of the existing diagnostics address metadata documented in the plan. A draft new assertion excluding synthetic documentation IP `192.0.2.10` was removed on root's instruction before execution reached it. This was an unsupported new assumption, not an existing assertion. No projection was changed, and no owner address or real preview diagnostics was read.

## Test coverage and safety

New `tests/core/diagnostics-composition.test.ts` uses actual `createNova`, Core, stores and two loopback HTTP listeners. It tests the unmounted production route first; actual console enrollment/reveal/approval and approved browser-cookie download; public, invalid-cookie and proxied-console denial; mutation header/origin guards; native JSON, filename and no-store headers; exact numeric/fresh counts; useful nonempty health/log/count payload; no new file under Nova home and no retained bundle signature in existing fixture files; actual listener shutdown.

The production download plants synthetic vault/environment secrets and fixture-generated mesh/vault keys, with plain/case-folded/URL/base64/base64url/hex log variants and a Bearer problem detail. It independently checks no variant survives. It plants content in real memory, capture, ledger title/goal/brief inputs, profile user, session title/transcript, schedule prompt and skill body; none appears in the download. Session `list` and `read` throw during downloads to guard against content reads. Focused count tests cover directory-only semantics with real files and a symlink.

Fixtures use private temp HOME, explicit file-held vault, fake Ollama and fixed hardware. The launcher below supplies a clean enumerated environment, dropping inherited Nova/provider credentials. The test also scopes/restores its own HOME/vault/canary settings for normal CI. No owner keys, keychain, home, cloud, device, provider or model data were used. Existing suite fixtures run under the private launcher HOME and file-vault override. Existing acceptance egress guards and no-Kubernetes tripwire remain active; every completed test launcher reports the tripwire never fired.

## Exact verification launcher and retained evidence

All commands below ran from the checkout above. The launcher source was saved **before RED**, not reconstructed later. Each run saved its complete argv, cwd and fully enumerated environment before launching, combined stdout/stderr in full, and the actual child status; the wrapper exits that status after printing the saved output. Shell `cat` never masks a failure. `HOME` is a newly created temporary private directory removed on completion; its exact run value is retained in each invocation JSON. Raw evidence is local and ignored under `evidence/task-3/`, not a claim of hosted CI or final-branch qualification.

```python
from pathlib import Path
import json, os, subprocess, sys, tempfile
base=Path(__file__).resolve().parent
name=sys.argv[1]
command=sys.argv[2:]
# Deliberate clean env: no inherited Nova/provider/keychain credentials.
env={k:os.environ[k] for k in ['PATH','LANG','LC_ALL','SYSTEMROOT','SystemRoot'] if k in os.environ}
env['PATH']='/home/jeremy/.local/share/mise/installs/node/26.3.1/bin:'+env.get('PATH','/usr/bin:/bin')
env['NOVA_VAULT_KEY']='file'
env['NOVA_SECRET_DIAGNOSTICS_TEST']='synthetic-environment-7f3a91c2e8b4+/='
with tempfile.TemporaryDirectory(prefix='nova-diagnostics-private-user-') as home:
 env['HOME']=home
 (base/(name+'.invocation.json')).write_text(json.dumps({'cwd':str(Path.cwd()),'command':command,'env':env},indent=2)+'\n')
 with (base/(name+'.log')).open('w') as output:
  result=subprocess.run(command,env=env,stdout=output,stderr=subprocess.STDOUT)
 (base/(name+'.exit')).write_text(str(result.returncode)+'\n')
 print((base/(name+'.log')).read_text())
 print('EXIT_CODE='+str(result.returncode))
 raise SystemExit(result.returncode)
```

Each invocation is `python3 .superpowers/sdd/health-caps-diagnostics-2026-11-03/evidence/task-3/run.py NAME COMMAND...`.
For every NAME below, retained files are `evidence/task-3/NAME.invocation.json`, `NAME.log`, `NAME.exit`. Source: `evidence/task-3/run.py`; hashes: `evidence/task-3/sha256.json`.

| NAME | Command after NAME | Actual exit and result |
| --- | --- | --- |
| red | `sh scripts/test.sh --test-concurrency=1 tests/core/diagnostics-composition.test.ts` | 1; 2 tests, 0 pass, 2 fail: missing countLogs; actual production diagnostics 404 vs expected 200. Run before production edits. |
| green-first | same focused command | 1; 1 pass, 1 fail: session_logs intentionally scrubbed to marker. Preserved generic scrubber; root selected chat_logs. |
| typecheck-first | `npm run typecheck` | 1; TS2345 on new test public-header union. Corrected explicit Record typing. No production type error. |
| green-second | focused command above | 1; 1 pass, 1 fail: empty vault reports null key store before first write. Corrected fixture timing; assert file key after planting canary and in downloaded bundle. |
| green-third | focused command above | 0; 2/2 pass, no failures/skips; 931.563487 ms. |
| existing-affected | affected command below without the new diagnostics-composition file | 0; 109/109 pass, no failures/cancelled/skips/todo; 70864.480333 ms. |
| typecheck-final | `npm run typecheck` | 0. npm printed an available-update notice; no install/update performed. |
| diff-check | `git diff --check` | 0. |
| affected-final | affected command below | 0; 111/111 pass, no failures/cancelled/skips/todo; 68207.998655 ms. |

Exact final affected command (test flags precede paths):

```sh
sh scripts/test.sh --test-concurrency=1 tests/core/diagnostics-composition.test.ts tests/core/diagnostics.test.ts tests/core/api.test.ts tests/core/core-options.test.ts tests/core/caps.test.ts tests/core/caps-composition.test.ts tests/acceptance/caps.test.ts tests/acceptance/caps-api.test.ts tests/core/evals.test.ts tests/acceptance/evals-regression.test.ts tests/server.test.js tests/runner.test.js tests/chat-run.test.js tests/helpers.test.js tests/scheduler.test.js
```

These runs include all existing diagnostics canary tests, the real diagnostics regression eval, regression negative control, capability and injection batteries, Core/API boundary checks, production Caps composition/API, clock/timezone semantics and server/runner/chat/scheduler/helper tests. No skip, test weakening, assertion relaxation or blind rerun. Every failed attempt above led to a specific fixture/schema correction.

## Self-review and limitations

- Reviewed the complete source/test/docs diff and closure initialization order: route getters execute after `self`, `core`, store and runner exist; no bundle/global cache is retained. Core Caps and `runner.caps` ownership are unchanged and covered by existing affected checks.
- `chat_logs` is intentionally not a person-started-conversation count. Schedules/skills use existing views and return their lengths; the callback does not project their prompt/body.
- Excluded content-store canaries and known-secret variants are evidence for those boundaries, not a universal classifier. Arbitrary personal free text can still occur in included log/problem messages, service details and configured names when it is neither known nor secret-shaped. Existing documented hostname/IP/model/runtime metadata remains included. This task does not redesign that module.
- The new production test starts actual HTTP servers through createNova and closes them; it is not a new subprocess CLI/shutdown test. Existing production Caps API test exercises real subprocess launch/restart/shutdown.
- Focused checks are the authorized task scope. No whole-suite ordinary CI, UI crawl, screenshots, owner recognition, preview, PR or merge proof is claimed; root owns final branch qualification and independent review.
- Skills read/applied: test-driven-development (including writing-good-tests) and verification-before-completion. using-superpowers explicitly says dispatched subagents ignore that skill. Parent's authorized focused validation scope controls over generic full-suite suggestions.

RELEASEsource: no further source writes planned after this task commit; root may review and take ownership.
