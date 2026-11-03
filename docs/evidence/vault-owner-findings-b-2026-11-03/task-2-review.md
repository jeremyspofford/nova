# Spec compliance: Issues found

The explicit B6 read/recovery mechanics are implemented. The new warm-read failure behavior is not safely integrated with the existing outbound secret guard (I1). This is a task-scoped review of immutable package `review-bcda07c8..15d5cf68.diff`, base `bcda07c832cb1864ee418b36b1642f68c0e08bcf`, head `15d5cf68417333cbbff49833c2a63a1cbfb5e612`; it is not whole-branch or whole-phase approval.

## Strengths

- `src/core/vault.ts:461–520`: ordinary committed reads authenticate without acquiring the writer lock or removing pending ciphertext. Cache reuse requires exact serialized committed bytes and exact key bytes. `tests/core/vault-owner-findings-b.test.ts:37–77` checks all four verbs cold/warm under a stale lock, unchanged bytes, unrelated pending state, external saves/deletes/clear, and no resurrection on a later mutation.
- `src/core/vault.ts:487–493,522–537`: pending state is probed, then reopened and authenticated again under the exclusive lock before rename. The pending map is not returned as committed data. `tests/core/vault-owner-findings-b.test.ts:92–124,202–214` covers stale-lock refusal, successful same-vault repair, malformed/tampered/different-vault refusal and authentication after acquisition.
- `src/core/vault.ts:512–518,554–586`: key-file promotion and duplicate removal happen only after authentication and inside serialization; unavailable serialization leaves the valid read usable and key file intact. Exact key readback precedes successful file removal. `tests/core/vault-owner-findings-b.test.ts:126–159,191–200` covers deferred housekeeping, ordinary keychain reads and authentication before promotion.
- `src/core/vault.ts:440–447`: unconditional map/serialized-cache invalidation after a mutation attempt closes the failed-deletion cache defect. `tests/core/vault-owner-findings-b.test.ts:161–189` checks failure, committed readback, changed ciphertext, key loss and restoration.
- The patch changes only the legacy Vault and a new 214-line regression file. It adds no dependency, broker protocol/API, file format or public raw-value method. Existing tests and security assertions have no edits in this package.

## Issues

### Critical: 0

None found in this task-scoped review.

### Important: 1

**I1 — Newly revalidated warm reads can silently disable outbound secret screening.** Changed site: `src/core/vault.ts:486` (key lookup now precedes the cache hit at line 496). Existing integration: `src/core/index.ts:501`; `src/core/ingest/screen.ts:305–310`; `src/core/ingest/outbound.ts:69–76`.

Core collects values using `vault.list().map(n => vault.get(n))`, catches any exception, and returns `[]`. The outbound guard accepts that as a successful scan with no known secrets. Before this patch, a successfully warmed Vault used its cached map without probing the keychain again. Now a temporarily unavailable keychain makes that same warmed Vault throw, the collector silently empties the secret set, and a payload containing the already-known credential is allowed. A failure on any individual get also discards the entire scan. Key disappearance must not be hidden by stale credential reads, but a scan failure must not mean there are no secrets to protect.

A narrow synthetic probe reproduced exactly this transition using the real Vault, the verbatim Core collector, and the real `outbound` function: before keychain unavailability `{ok:false,matched:[{kind:'secret',...}]}`; afterwards `{ok:true,matched:[]}`. It does not claim the pre-existing cold-start fail-open collector was introduced here; the regression is its new reachability after an already-warmed successful read. The probe does not start the full Core or prove an end-to-end network transmission.

Fix the consumer error contract so unavailable/failed credential enumeration refuses the outbound operation, and add a behavior test for warm-keychain disappearance and partial scan failure. Merely removing the Core catch is insufficient because `IngestScreen.outbound` also catches and substitutes an empty list. Preserve the required fresh-read semantics; do not solve this by retaining a stale public plaintext cache, weakening canary checks, or adding a broker raw-value API. Root should explicitly scope any necessary consumer changes before implementation.

### Minor: 1

**M1 — The warm cache preserves crypto work but loses low per-name access cost.** `src/core/vault.ts:475–486,496,555–560`; callers `src/core/index.ts:501`, `src/core/browser/worker.ts:1041`, `src/core/diagnostics/index.ts:100`.

Each warm get reads and JSON-parses the entire encrypted envelope, then probes key storage before reusing the map. The existing N-entry Core collector therefore performs N+1 whole-file reads/parses and, with an answering platform keychain, 2(N+1) synchronous CLI calls: `available()` and `read()` each invoke a command (`src/core/vault.ts:103–110,131–136,160–165`). Those commands block the event loop, with a 10-second timeout each (`src/core/vault.ts:49–50`). The old warm path did not perform these keychain calls. For an N-entry file whose size grows with N, the collection also repeats proportional file work N+1 times.

The freshness requirement explains why key changes cannot be ignored, and this report does not invent an OS-keychain latency measurement or relax it. Nevertheless this is a concrete cost regression in an existing outbound guard, not a constant-time cache. Treat as a follow-up design constraint when fixing I1: avoid repeated envelope parsing where safe and evaluate a bounded internal scan/snapshot that preserves the public Vault API and fresh-read contract. An injected-store invocation-count test can make the cost explicit without a real keychain benchmark. Classified Minor because no quantitative latency threshold was specified and the new probes enforce required key-loss observation; the retained report candidly describes the limitation (`task-2-report.md:55`).

## Named risk checks and scope

1. **Read/recovery/promotion ordering and authentication:** reviewed the diff plus unchanged `#save` tail (`src/core/vault.ts:591–620`, the diff cuts this function off), `parseFile/decrypt` (`633–650`), and public mutation/read wrappers (`256–414`) to check lock entry, synchronous change events and standby key access. Every existing mutation wrapper remains serialized; put/delete/deletePrefix still refresh. Recovery re-enters `#open` after lock acquisition and after rename. A valid current file ignores unrelated pending state. No fingerprint-only recovery or lost/waiting reset regression found.
2. **Optional housekeeping under a stale lock:** `src/core/vault.ts:420–429,512–518` supplies the already authenticated map on failed lock acquisition; it does not steal/remove another lock. `tests/core/vault-owner-findings-b.test.ts:126–159` verifies key-file preservation/deferred promotion. Existing immediate promotion contract remains in `tests/core/vault.test.ts:177–181`, unchanged and passing in retained evidence. No conflicting housekeeping assertion was silently removed.
3. **Cache after failed mutation/external changes:** checked the key+serialized comparison and finally invalidation in the diff against public get/has/list/status and mutation call sites. Real external writer, failed deletion and tampering tests are at `tests/core/vault-owner-findings-b.test.ts:65–77,161–189`. No permanently cached unsaved mutation found.
4. **Existing SEC05 and recovery contract:** inspected `tests/core/broker-owner-findings.test.ts:108–203` and `tests/core/broker-migration-recovery.test.ts:54–121` only for the cross-cutting lock/rekey contract. Newer values, concurrent acknowledged writes, reload after migration, authenticated same-vault repair and stale-lock refusal remain asserted. No B2 implementation or fixture change is part of this patch; future B2 work is not approved by this review.
5. **Standby contract:** inspected `tests/acceptance/m5b-vault-standby.test.ts:33–75` for the affected change-event/read boundary: replication uses actual nodes and fake Home Assistant, checks 0600 ciphertext/key, no plaintext token in either home, no key in sync logs, then checks failover behavior. Retained run passed; no rerun performed.
6. **Per-read cost and warm-read error propagation:** focused call-site check found the existing Core collector and its outbound consumer, then platform key-store implementations for operation counts. This check yielded I1/M1. No unrelated codebase crawl, real keychain access, timing benchmark or broad test run was performed.

## Retained evidence inspection

- Read all seven JSON launch records, the complete green-new/green-focused/standby/typecheck/typecheck-fixed/red-cache-auth stdout, the RED failure entries/summaries, and launcher source. Confirmed all seven stderr files are zero bytes.
- `evidence/task-2/launcher.py:13–30` and each JSON record enumerate clean host env, exact argv/cwd, private HOME, cached image with `--pull=never`, `--network=none`, user 1000, read-only filesystem/worktree/Node binds, start/end timestamps and exit status. No warning suppression is present. No Kubernetes tripwire fired.
- `evidence/task-2/red.stdout:2–27`: 18 tests, 5 pass, 13 intentional failures. `red-cache-auth.stdout:2–12`: 4 tests, 1 pass, 3 intentional failures; these are real behavioral defects, not an import/configuration failure.
- `evidence/task-2/green-new.stdout`: 22/22 pass. `green-focused.stdout:71–79`: 69 tests, 68 pass, 1 skip, 0 fail. SEC01–05, migration recovery, provider redaction and boundary tests are named in the retained output. The skip is the existing real secret-tool case (`tests/core/vault.test.ts:219–231`), which conditionally requires secret-tool and a desktop session; it is not evidence of real OS-keychain validation. This permitted environment-dependent skip is a stated limitation, not an unexplained warning or new skipped regression.
- `evidence/task-2/typecheck.stdout:2–4` retains TS2322 in the new fixture; the final diff contains the explicit `Buffer` annotation at `tests/core/vault-owner-findings-b.test.ts:163`. `typecheck-fixed.json` has exit 0; corresponding stdout has only tripwire notices. The initial compiler failure is resolved evidence, not an outstanding finding.
- `evidence/task-2/standby.stdout:2–11`: 1/1 acceptance pass, 0 skip/fail. Green output has no compiler/test warnings; deliberate tripwire notices are expected instrumentation. No green suite was rerun by this reviewer.

## Focused reviewer probe for I1

One command only, using cached `mcr.microsoft.com/playwright:v1.56.1-noble`, `--pull=never --network=none --user=1000:1000 --read-only`, private `/tmp` tmpfs/HOME, read-only own-worktree `/workspace` and Node 26.3.1 `/opt/node` mounts. Host environment was exactly PATH `/usr/bin:/bin`, HOME `/tmp/nova-review-docker-l2f7vln_`, LANG `C.UTF-8`; container overrides HOME `/tmp/nova-review-private-home`, PATH `/opt/node/bin:/usr/bin:/bin`, TZ `UTC`, LANG `C.UTF-8`. Workdir was the authorized worktree on the host and `/workspace` in the container. Wrapper `sh -c 'mkdir -m 700 "$HOME" && exec "$@"' review` executed `sh scripts/tripwire.sh node --input-type=module -e` with this exact program:

```javascript
import { Vault } from './src/core/vault.ts';
import { outbound } from './src/core/ingest/outbound.ts';
import { mkdtempSync } from 'node:fs';
import assert from 'node:assert/strict';
const home = mkdtempSync('/tmp/nova-review-b6-');
const secret = 'synthetic-review-outbound-canary';
let key = null, up = true;
const kc = { kind: 'keychain', name: 'synthetic', available: () => ({ok:up,detail:'synthetic'}), read: () => key, write: k => {key=Buffer.from(k)}, remove: () => {key=null} };
const vault = new Vault({ home, mode:'auto', keychain: () => kc });
vault.put('provider/KEEP', secret);
assert.equal(vault.get('provider/KEEP'), secret);
const secrets = () => { try { return vault.list().map(n => vault.get(n)).filter(v => typeof v === 'string'); } catch { return []; } };
const check = () => outbound(secret,{tainted:false,secrets:secrets(),mine:()=>new Set()});
const before = check();
up=false;
const after = check();
assert.equal(before.ok,false);
assert.equal(after.ok,true);
console.log(JSON.stringify({probe:'warm keychain availability and existing Core callback',before,after}));
```

Observed exit 0, empty stderr, exact stdout:

```text
no-Kubernetes tripwire: armed (kubectl, helm, flux and k3s on PATH record and fail every call; KUBECONFIG unset)
{"probe":"warm keychain availability and existing Core callback","before":{"ok":false,"matched":[{"kind":"secret","words":"looks like a saved password or key"}]},"after":{"ok":true,"matched":[]}}
no-Kubernetes tripwire: never fired
```

## Cannot verify from this task diff

- Full P1a takeover NOTES, P1b consumer switch/browser relay, P1c gates, SEC06–07/heap/physical-lifetime and other unchanged security suites are not demonstrated by this task's selected runs. The patch does not edit those surfaces; root must preserve their separate gates. `task-2-report.md:57` correctly disclaims whole-phase completion.
- Real OS-keychain behavior and latency, physical passkeys, actual owner credentials/devices/cloud, and a full application/network reproduction of I1 were intentionally not exercised. The platform command-count analysis is static, and I1's focused proof is component-level with the exact existing collector.
- The package proves no broker-source delta; boundary output proves the unchanged budget passed, but this review did not independently recount the reported 2,688 lines or inspect unrelated broker internals.
- The retained launch records are inspected evidence, not a reconstruction of unrecorded process history or independent proof of every earlier self-review command.

## Assessment

Task quality: **Needs fixes**. Counts: **0 Critical / 1 Important / 1 Minor**.

The lock-free committed-read and serialized authenticated-recovery implementation is well covered and preserves the requested file/API boundaries. The changed warm-read failure contract exposes an existing fail-open consumer on the active legacy path, so the task should not be approved until I1 is fixed or explicitly ruled by root with the preserved security contract addressed.

Review source ownership: **RELEASED**. Only this requested review report was written; no source, index, HEAD, branch, push or merge changes, and no subagents.
