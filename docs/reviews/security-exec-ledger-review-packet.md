# Review packet: subprocess environments and Ledger physical lifetime

Owner IMMEDIATE S1/S2 from the whole-app review of main `048eea0e`. This is a self-contained candidate review packet, not a statement that final CI or merge has happened. Production artifact: base `048eea0ee043f43d01bc9a36bed601ce9805373b` → source `7055737e3d2571df279574847107c83b2acfc6e6`. Both independent task reviews approved the candidate. The separate final in-house adversarial review approved this source with zero findings; ordinary exact-head CI and LEDGER/merge gates remain pending. No additional owner input is required to continue these expressly ordered fixes; external findings can be worked forward under the standing review pattern.

## Claims to uphold

1. Exec and agent children inherit only the same finite public process metadata; unknown innocently named future secret variables cannot leak merely because their names were absent from a blacklist. Provider CLI defaults use that policy too; trusted explicit caller extras remain a separate contract and no production caller supplies extras today.
2. The server secret-source audit covers provider vault/environment fallback, mesh control/session tokens and identity/TLS material, callbacks, connectors and vault storage by code. No actual owner values were inspected. The tests use synthetic canaries in disposable explicit parent environments and actual child processes.
3. An inherited shell selector or startup/runtime variable cannot automatically reconstruct filtered credentials. Exec selects non-login `/bin/sh -c`; implicit login/shell-specific configuration is intentionally no longer part of its contract.
4. A timeout, cancel or halt immediately revokes the old attempt's committing/notStarted authority, while its actual unresolved worker promise still reserves its task id and one slot in its lane. No own-retry overlap, late accepted report or unhandled late worker rejection. Other lanes progress; spare same-lane capacity remains usable.
5. Actual settlement wakes scheduling. Halt/idle/drain reflect physical lifetime. A live orphan refuses handover; refused drain/resume and restart recovery retain existing effect/commit/approval safety and do not strand settled cooperative work.
6. No second durable queue, runtime dependency, task schema or authority model. Tests protect actual behavior, beginning with observed RED before implementation. Final ordinary unit/UI and required gate are independent requirements, not replaced by focused evidence.

## Threat model and explicit limits

The attacker may influence untrusted content and get an approved command executed; the server holds secrets in its environment. Protect automatic environment inheritance without trusting the model to identify today's key names. The attacker may also cause a worker to ignore abort, resolve/reject late, or race retry/drain; do not mistake loss of attempt authority for physical completion. Existing approval and external-effect reconciliation remain authoritative.

This is not a filesystem sandbox or general DLP. An explicitly approved command can select an interpreter or access files available to its OS user. Real authenticated provider CLIs, owner keychains and physical OS installations were not exercised. Arbitrary fire-and-forget work after the tracked promise settles is outside the worker contract. A forever-pending worker keeps its own id/slot and blocks safe handover; JavaScript cannot forcibly kill an arbitrary in-process promise. Drain can take `boundMs + 2*commitMs` (production defaults eleven minutes), plus scheduling delay; promotion runs asynchronously and transfers no role/name before safe drain. Existing bounded process shutdown remains separate.

One independent task probe directly closed the database before late settlement and observed the pump reject with `database is not open`. Existing Core.close's Promise.race/idle observer stays attached after its timeout, so no Core.close unhandled-rejection failure was demonstrated. The observation is explicitly carried into final review, and is not evidence for arbitrary direct DB-close consumers.

## Evidence

Full implementation and task-review reports: [evidence](../evidence/security-exec-ledger-2026-11-02.md). Actual available RED/GREEN and diagnostic log bodies: [output](../evidence/security-exec-ledger-test-output-2026-11-02.md). Early failed syntax/typecheck attempts are retained; no final-CI success is inferred from them. All probes use private fake workers/agents or owned loopback; no live provider/account/keychain/cloud/Kubernetes/model/image operations.

## Complete candidate diff, with context

Diff display removes trailing whitespace only; the pinned source and source hashes in the reports are authoritative.

````diff
diff --git a/src/agent.js b/src/agent.js
index 8fccefee..3ccbb4bf 100644
--- a/src/agent.js
+++ b/src/agent.js
@@ -1,32 +1,27 @@
 // Runs the configured agent_cmd once: system prompt in a file, conversation on
 // stdin, text streamed back. Understands plain text output and Claude Code's
 // stream-json; anything else that prints text works too.
 import { spawn } from 'node:child_process';
-import { trackChild } from './core/index.ts';
+import { inheritedChildEnv, trackChild } from './core/index.ts';
 import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
 import { tmpdir } from 'node:os';
 import { join } from 'node:path';

 export class AgentError extends Error {
   constructor(message, detail = '') { super(message); this.detail = detail; }
 }

-// Nova's files are the agent's only memory. When Nova itself runs inside a
-// Claude Code session, that session's memory, extra CLAUDE.md folders and the
-// signed-in account's email arrive through the environment; strip them so
-// they can't leak in. (A real run signed a draft with a name only that email held.)
-// Nova's own secrets in its environment never reach the agent either: the stable name's control
-// token (M10g) can move where every device goes.
-const LEAKY = /^CLAUDE\w*(MEMORY|ADDITIONAL_DIRECTORIES|CLAUDE_MD|USER_EMAIL)|^NOVA_MESH_NAME_TOKEN$/;
+// Nova's files are the agent's only memory. Ambient credentials, settings and host-session
+// memory never reach it; use the same finite inherited policy as tools and provider CLIs.
 export function agentEnv(env = process.env) {
-  return Object.fromEntries(Object.entries(env).filter(([k]) => !LEAKY.test(k)));
+  return inheritedChildEnv(env);
 }

 export function runAgent({ cmd, system, prompt, signal, onText = () => {} }) {
   const dir = mkdtempSync(join(tmpdir(), 'nova-'));
   const systemFile = join(dir, 'system.md');
   let input = prompt;
   if (cmd.includes('{system_file}')) writeFileSync(systemFile, system);
   else input = `${system}\n\n${prompt}`;
   const command = cmd.replaceAll('{system_file}', `'${systemFile}'`);

diff --git a/src/core/child-env.ts b/src/core/child-env.ts
new file mode 100644
index 00000000..faf7c7b2
--- /dev/null
+++ b/src/core/child-env.ts
@@ -0,0 +1,19 @@
+// Ambient parent data is untrusted: copy only these finite, public process settings.
+// Never forward whole prefixes (even LC_ or XDG_), authentication, session identity,
+// runtime injection options, or shell startup selectors. Adding a name needs review.
+const PUBLIC_ENV = [
+  'PATH', 'HOME', 'USER', 'LOGNAME',
+  'TMPDIR', 'TMP', 'TEMP',
+  'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_COLLATE', 'LC_MESSAGES',
+  'LC_MONETARY', 'LC_NUMERIC', 'LC_TIME', 'TZ',
+  'TERM', 'COLORTERM', 'NO_COLOR',
+];
+
+export function inheritedChildEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
+  const out: Record<string, string> = {};
+  for (const key of PUBLIC_ENV) {
+    const value = env[key];
+    if (value !== undefined) out[key] = value;
+  }
+  return out;
+}
diff --git a/src/core/index.ts b/src/core/index.ts
index 8e70cb65..5a9d62dd 100644
--- a/src/core/index.ts
+++ b/src/core/index.ts
@@ -148,20 +148,21 @@ export { makeScratch, dropScratch } from './resilience/scratch.ts';
 export type { Manifest as BackupManifest } from './resilience/backup.ts';
 export { restoreBackup, loadMigrations } from './db.ts';
 // Checkpoints (M7 amendment §1): the supervisor takes one before a release switch on the stopped
 // home; the server applies a staged restore before anything opens the home.
 export { takeCheckpoint, listCheckpoints, finishStaged, stagedPending, KEEP_AUTO, RETENTION as CHECKPOINT_RETENTION } from './resilience/checkpoints.ts';
 export type { CheckpointView, CheckpointManifest } from './resilience/checkpoints.ts';
 // Nova's own entries in a home, by name: what checkpoints, restore and factory reset may touch.
 export { NOVA_ENTRIES, isNovaEntry, foreignEntries } from './resilience/entries.ts';
 // Every process Nova starts, so none outlives an in-place restart (Era 2's commands register too).
 export { trackChild } from './children.ts';
+export { inheritedChildEnv } from './child-env.ts';
 // Services (M10e): the definition, the driver interface, the Service Manager.
 export * from './services/index.ts';
 // Onboarding (M10f): device detection, the backend words, discovery and import sources.
 export { OS_FAMILIES, OS_WORDS, detectOs, factsWords, recommendedHubPurposes, standInOs } from './onboard/detect.ts';
 export type { DeviceFacts, OsFamily } from './onboard/detect.ts';
 export { backendFor } from './onboard/backend.ts';
 export type { BackendSummary } from './onboard/backend.ts';
 export { LOCAL_PORTS as DISCOVERY_PORTS, SERVICES as DISCOVERY_SERVICES, discover, loopbackTransport, realTransport, transportFromEnv } from './onboard/discover.ts';
 export type { Discovery, DiscoveryTransport, Found } from './onboard/discover.ts';
 export { decodeMessage as decodeMdns, encodeQuery as encodeMdnsQuery, encodeResponse as encodeMdnsResponse } from './onboard/mdns.ts';
diff --git a/src/core/ledger.ts b/src/core/ledger.ts
index a2599030..11301614 100644
--- a/src/core/ledger.ts
+++ b/src/core/ledger.ts
@@ -243,20 +243,21 @@ export class Ledger extends EventEmitter {
   }

   // The person asks for another go at a task that is waiting on something other than approval
   // (blocked, partly done, or out of local capacity).
   // A worker that stepped aside (a blocked report) and is ready again uses it too, with its reason.
   retry(id: string, reason = 'Trying again, as you asked.'): Task {
     const t = this.get(id);
     // Its worker is still running and waiting for the person (needsPerson): running it a second
     // time would race the first.
     if (this.#running.has(id)) throw new CoreError('conflict', 'This task is still running: it is waiting for you to do a step. Open it to take over.');
+    if (this.#inflight.has(id)) throw new CoreError('conflict', 'This task’s previous worker is still running. Wait for it to stop before retrying.');
     if (t.state !== 'waiting' || (t.approval_tier >= 2 && !t.approved_at)) throw new CoreError('conflict', "This task isn't waiting for a retry.");
     this.#db.run(`UPDATE task SET user_visibility = 'handling' WHERE id = ?`, id);
     // Running work with outside effects again is a new decision: the OK given for the first run
     // doesn't cover it, so a task that needs one asks again before it runs.
     const w = this.workers.get(t.owner);
     const reapprove = t.attempts > 0 && t.approval_tier >= 2 && !!w && effectsOf(w, t.brief) === 'external';
     if (reapprove) this.#db.run('UPDATE task SET approved_at = NULL WHERE id = ?', id);
     const next = this.#move(id, 'queued', reason, 'retried', reapprove ? { asks_again: true } : undefined);
     const gated = reapprove ? this.#gate(next) : next;
     void this.pump();
@@ -331,38 +332,40 @@ export class Ledger extends EventEmitter {
     this.#running.get(id)?.abort(new Error('cancelled'));
     return this.#move(id, 'cancelled', reason, 'cancelled');
   }

   // After a restart: work that was running goes back in the queue under the same idempotency
   // key, and a report that was waiting on verification is verified now.
   recover(): { requeued: string[]; reverified: string[] } {
     const requeued: string[] = [];
     const reverified: string[] = [];
     for (const found of this.list({ state: 'active', limit: 500 })) {
+      if (this.#inflight.has(found.id)) continue;
       // A worker that said its work never started, and then Nova stopped: that dispatch isn't counted.
       const unstarted = this.#claimedNotStarted(found.id);
       if (unstarted) this.#giveBack(found.id, unstarted);
       const t = unstarted ? this.get(found.id) : found;
       if (!this.#mayRerun(t)) {
         this.#hold(t.id, 'Nova restarted while this was running', 'recovered');
         continue;
       }
       if (t.attempts >= this.#maxAttempts) {
         this.#fail(t.id, `Nova restarted while this was running, ${t.attempts} times. Not trying again.`, undefined, 'recovered');
         continue;
       }
       this.#requeue(t, 'Nova restarted while this was running. It will run again.', 'recovered');
       requeued.push(t.id);
     }
     // A worker that was waiting for the person (needsPerson) was running too; what it had open is
     // gone, so it starts again from the beginning.
     for (const t of this.list({ state: 'waiting', limit: 500 })) {
+      if (this.#inflight.has(t.id)) continue;
       const last = this.#db.get<{ kind: string }>('SELECT kind FROM task_event WHERE task_id = ? AND to_state IS NOT NULL ORDER BY seq DESC LIMIT 1', t.id);
       if (last?.kind !== 'needs_person') continue;
       if (!this.#mayRerun(t)) {
         this.#hold(t.id, 'Nova restarted while this waited for you', 'recovered');
         continue;
       }
       if (t.attempts >= this.#maxAttempts) {
         this.#fail(t.id, `Nova restarted while this waited for you, ${t.attempts} times. Not trying again.`, undefined, 'recovered');
         continue;
       }
@@ -394,23 +397,30 @@ export class Ledger extends EventEmitter {
       try {
         for (;;) {
           this.#dirty = false;
           // No limit: a full lane with many queued tasks must not hide the tasks of other lanes.
           for (const row of this.#halted && !this.#keep ? [] : this.#db.all<Row>(`SELECT * FROM task WHERE state = 'queued' ORDER BY created_at, rowid`)) {
             const t = toTask(row);
             if (this.#halted && !this.#keep!(t)) continue;
             if (this.#inflight.has(t.id)) continue;
             const lane = this.#lane(t);
             if ([...this.#inflight.values()].filter((x) => x.lane === lane.key).length >= lane.max) continue;
+            let interrupted = false;
             const done = this.#runOne(t)
+              .then((stopped) => { interrupted = stopped === true; })
               .catch((e) => { this.#log.problem('ledger', 'The Work Ledger stumbled while running a task.', { detail: (e as Error)?.stack ?? String(e), taskId: t.id }); })
-              .finally(() => { this.#inflight.delete(t.id); });
+              .finally(() => {
+                this.#inflight.delete(t.id);
+                // A refused handover may have resumed while this worker was still stopping.
+                if (interrupted && !this.#halted) this.recover();
+                this.#wake?.();
+              });
             this.#inflight.set(t.id, { lane: lane.key, done });
           }
           if (this.#dirty) continue;
           if (!this.#inflight.size) break;
           const woken = new Promise<void>((r) => { this.#wake = r; });
           await Promise.race([woken, ...[...this.#inflight.values()].map((x) => x.done)]);
           this.#wake = null;
         }
       } finally {
         this.#pumping = null;
@@ -428,67 +438,72 @@ export class Ledger extends EventEmitter {
       if (l && typeof l.key === 'string' && Number.isInteger(l.max) && l.max >= 1) return { key: `${w!.id}:${l.key}`, max: l.max };
     } catch { /* a worker whose lane can't be worked out runs in the default lane */ }
     return DEFAULT_LANE;
   }

   // Before Nova restarts in place: every running task is stopped (its worker's signal), nothing
   // more is started, and the stopped tasks stay as they were, for the next start's recovery.
   halt(reason = 'Nova is restarting.'): string[] {
     this.#halted = true;
     this.#keep = null;
-    const ids = [...this.#running.keys()];
+    const ids = [...this.#inflight.keys()];
     for (const ac of this.#running.values()) ac.abort(new Error(reason));
     return ids;
   }

   // Before this hub hands the role to another node (M10g, the orchestration ADR's step 3): nothing new
   // starts except what `keep` allows (the promotion's own records); running work gets `boundMs` to
   // finish; a task past its commit point (its worker's `uncancellable` says why) is never cut, and is
   // waited for up to `commitMs`; anything else still running is stopped and stays active, so the next
-  // hub's recovery requeues it (or holds it, if it may have had an effect). `stuck`: work past its
-  // commit point still running at the end; the caller then gives up handing over and resumes.
+  // hub's recovery requeues it (or holds it, if it may have had an effect). Stopped workers get
+  // another `commitMs` to actually settle. `stuck`: any physical work still alive at the end;
+  // the caller must give up handing over and resume, even if its attempt already timed out.
   async drain(o: { boundMs: number; commitMs: number; keep: (t: Task) => boolean }): Promise<{ finished: string[]; handed: string[]; stuck: string[] }> {
     this.#halted = true;
     this.#keep = o.keep;
-    const mine = () => [...this.#running.keys()].filter((id) => { try { return !o.keep(this.get(id)); } catch { return true; } });
+    const mine = () => [...this.#inflight.keys()].filter((id) => { try { return !o.keep(this.get(id)); } catch { return true; } });
     const before = mine();
+    const live = (id: string) => this.#inflight.has(id);
     const wait = async (ids: string[], ms: number) => {
       const until = Date.now() + ms;
-      while (ids.some((id) => this.#running.has(id)) && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
+      while (ids.some(live) && Date.now() < until) await new Promise((r) => setTimeout(r, Math.min(50, until - Date.now())));
     };
     await wait(before, o.boundMs);
     const committed = (id: string) => { try { return !!this.workers.get(this.get(id).owner)?.uncancellable?.(this.get(id)); } catch { return false; } };
-    let left = before.filter((id) => this.#running.has(id));
-    const past = left.filter(committed);
+    const past = before.filter(live).filter(committed);
     if (past.length) await wait(past, o.commitMs);
-    const stuck = past.filter((id) => this.#running.has(id));
-    if (stuck.length) return { finished: before.filter((id) => !this.#running.has(id)), handed: [], stuck };
-    left = before.filter((id) => this.#running.has(id));
+    const stuck = past.filter(live);
+    if (stuck.length) return { finished: before.filter((id) => !live(id)), handed: [], stuck };
+    const left = before.filter(live);
     for (const id of left) this.#running.get(id)?.abort(new Error('This hub is handing over to another node.'));
-    return { finished: before.filter((id) => !left.includes(id)), handed: left, stuck: [] };
+    // Revocation is not settlement: handing an unresolved worker to another hub would overlap it.
+    await wait(left, o.commitMs);
+    return { finished: before.filter((id) => !left.includes(id)), handed: left.filter((id) => !live(id)), stuck: left.filter(live) };
   }

   // Nothing new starts but what `keep` allows, and nothing running is stopped: a hub that restarts
   // while it holds writes for a hand-over (M10g review, finding 4) starts like this, before recovery.
   pause(keep: (t: Task) => boolean): void {
     this.#halted = true;
     this.#keep = keep;
   }

   // A drain that didn't end in a handover: the queue runs again.
   resume(): void {
+    const interrupted = this.#halted;
     this.#halted = false;
     this.#keep = null;
-    void this.pump();
+    if (interrupted) this.recover();
+    else void this.pump();
   }

-  // Resolves when nothing is running or queued.
+  // Resolves when no physical worker remains and no queued work can currently start.
   async idle(): Promise<void> {
     while (this.#pumping) await this.#pumping;
   }

   counts(): Record<State, number> {
     const out = Object.fromEntries(STATES.map((s) => [s, 0])) as Record<State, number>;
     for (const r of this.#db.all<{ state: State; n: number }>('SELECT state, COUNT(*) AS n FROM task GROUP BY state')) out[r.state] = r.n;
     return out;
   }

@@ -501,76 +516,91 @@ export class Ledger extends EventEmitter {
     else if (!permits(t.privacy_mode, (() => { try { return egressOf(worker, t.brief); } catch { return 'remote'; } })())) wait = `Waiting on local capacity: ${worker.name} would send this off your devices, and this task is local-only.`;
     else if (t.approval_tier >= 2 && !t.approved_at) wait = 'Needs your OK before it runs.';
     if (wait && (t.state !== 'waiting' || t.reason !== wait)) {
       this.#db.run(`UPDATE task SET user_visibility = 'attention' WHERE id = ?`, t.id);
       return this.#move(t.id, 'waiting', wait, 'gated');
     }
     if (!wait && t.state === 'waiting') return this.#move(t.id, 'queued', null, 'released');
     return t;
   }

-  async #runOne(t: Task): Promise<void> {
+  async #runOne(t: Task): Promise<boolean | void> {
     const gated = this.#gate(t);
     if (gated.state !== 'queued') return;
     const worker = this.workers.get(t.owner)!;
     this.#db.run('UPDATE task SET attempts = attempts + 1 WHERE id = ?', t.id);
     this.#move(t.id, 'active', `${worker.name} is on it.`, 'dispatched', { attempt: t.attempts + 1 });
     const ac = new AbortController();
     this.#running.set(t.id, ac);
     const limit = worker.timeoutMs ?? this.#timeoutMs;
     const signal = AbortSignal.any([ac.signal, AbortSignal.timeout(limit)]);
-    // A worker that ignores the signal must not hold the queue: whichever comes first wins.
+    // Expiry revokes authority immediately, but the inflight slot outlives this race until the
+    // actual worker settles. Independent lanes can still run; this id/lane cannot overlap it.
+    let stop!: () => void;
     const stopped = new Promise<never>((_, fail) => {
-      if (signal.aborted) fail(signal.reason);
-      signal.addEventListener('abort', () => fail(signal.reason), { once: true });
+      stop = () => {
+        if (this.#running.get(t.id) === ac) this.#running.delete(t.id);
+        fail(signal.reason);
+      };
+      if (signal.aborted) stop();
+      else signal.addEventListener('abort', stop, { once: true });
     });
-    let raw: unknown;
+    const work = Promise.resolve().then(() => TASK_CONTEXT.run({ task_id: t.id, privacy_mode: t.brief.privacy_mode }, () => worker.run(t.brief, signal)));
     try {
-      raw = await Promise.race([TASK_CONTEXT.run({ task_id: t.id, privacy_mode: t.brief.privacy_mode }, () => worker.run(t.brief, signal)), stopped]);
-    } catch (e) {
+      let raw: unknown;
+      try {
+        raw = await Promise.race([work, stopped]);
+        if (signal.aborted) throw signal.reason;
+      } catch (e) {
+        this.#running.delete(t.id);
+        if (this.#halted && !this.#keep?.(t)) return true;
+        if (this.get(t.id).state === 'cancelled') return;
+        if (signal.aborted && (e as Error)?.name === 'TimeoutError') {
+          return this.#retryOrFail(t.id, `${worker.name} took longer than ${Math.round(limit / 1000)} s.`, undefined, 'timed_out');
+        }
+        return this.#retryOrFail(t.id, `${worker.name} stopped with an error: ${(e as Error).message}`, (e as Error).stack);
+      }
+      stopped.catch(() => {});
       this.#running.delete(t.id);
-      if (this.#halted && !this.#keep?.(t)) return;
       if (this.get(t.id).state === 'cancelled') return;
-      if (signal.aborted && (e as Error)?.name === 'TimeoutError') {
-        return this.#retryOrFail(t.id, `${worker.name} took longer than ${Math.round(limit / 1000)} s.`, undefined, 'timed_out');
-      }
-      return this.#retryOrFail(t.id, `${worker.name} stopped with an error: ${(e as Error).message}`, (e as Error).stack);
-    }
-    stopped.catch(() => {});
-    this.#running.delete(t.id);
-    if (this.get(t.id).state === 'cancelled') return;
-    // A worker that asked for the person and then finished without saying they were done.
-    if (this.get(t.id).state === 'waiting') this.#move(t.id, 'active', `${worker.name} is on it.`, 'person_done');
+      // A worker that asked for the person and then finished without saying they were done.
+      if (this.get(t.id).state === 'waiting') this.#move(t.id, 'active', `${worker.name} is on it.`, 'person_done');

-    let report: Report;
-    try {
-      report = validateReport(raw, t.brief);
-    } catch (e) {
-      const details = e instanceof CoreError ? e.details.join('; ') : String(e);
-      return this.#retryOrFail(t.id, `${worker.name} sent back a report Nova couldn't read.`, details);
-    }
-    const cost = { duration_ms: Math.round(report.usage.duration_ms), ...(report.usage.cost_usd ? { cost_usd: report.usage.cost_usd } : {}) };
-    this.#db.run('UPDATE task SET report = ?, cost = ? WHERE id = ?', JSON.stringify(report), JSON.stringify(cost), t.id);
-    this.#event(t.id, 'reported', null, null, { status: report.status, summary: report.summary });
-
-    if (report.status === 'failed') return this.#fail(t.id, `${worker.name} couldn't do it: ${report.summary}`);
-    if (report.status === 'blocked' || report.status === 'partial') {
-      // Only a blocked report can say the work never started; then the dispatch is given back.
-      const unstarted = report.status === 'blocked' ? this.#claimedNotStarted(t.id) : null;
-      if (unstarted) this.#giveBack(t.id, unstarted);
-      this.#db.run(`UPDATE task SET user_visibility = 'attention' WHERE id = ?`, t.id);
-      const why = report.status === 'blocked' ? `Blocked: ${report.blockers.join('; ') || report.summary}` : `Partly done: ${report.summary}`;
-      this.#move(t.id, 'waiting', why, report.status);
-      return;
+      let report: Report;
+      try {
+        report = validateReport(raw, t.brief);
+      } catch (e) {
+        const details = e instanceof CoreError ? e.details.join('; ') : String(e);
+        return this.#retryOrFail(t.id, `${worker.name} sent back a report Nova couldn't read.`, details);
+      }
+      const cost = { duration_ms: Math.round(report.usage.duration_ms), ...(report.usage.cost_usd ? { cost_usd: report.usage.cost_usd } : {}) };
+      this.#db.run('UPDATE task SET report = ?, cost = ? WHERE id = ?', JSON.stringify(report), JSON.stringify(cost), t.id);
+      this.#event(t.id, 'reported', null, null, { status: report.status, summary: report.summary });
+
+      if (report.status === 'failed') return this.#fail(t.id, `${worker.name} couldn't do it: ${report.summary}`);
+      if (report.status === 'blocked' || report.status === 'partial') {
+        // Only a blocked report can say the work never started; then the dispatch is given back.
+        const unstarted = report.status === 'blocked' ? this.#claimedNotStarted(t.id) : null;
+        if (unstarted) this.#giveBack(t.id, unstarted);
+        this.#db.run(`UPDATE task SET user_visibility = 'attention' WHERE id = ?`, t.id);
+        const why = report.status === 'blocked' ? `Blocked: ${report.blockers.join('; ') || report.summary}` : `Partly done: ${report.summary}`;
+        this.#move(t.id, 'waiting', why, report.status);
+        return;
+      }
+      this.#move(t.id, 'verifying', 'Checking the evidence.', 'verifying');
+      this.#verifyAndSettle(t.id, report);
+    } finally {
+      signal.removeEventListener('abort', stop);
+      // Observe late rejections as well as resolutions, without accepting their report or
+      // releasing capacity early. Keeping #runOne pending also makes idle/drain truthful.
+      await work.catch(() => {});
     }
-    this.#move(t.id, 'verifying', 'Checking the evidence.', 'verifying');
-    this.#verifyAndSettle(t.id, report);
   }

   #verifyAndSettle(id: string, report: Report): void {
     const t = this.get(id);
     const v = this.#verifier.verify(t.brief, report);
     this.#db.run('UPDATE task SET verification = ? WHERE id = ?', JSON.stringify(v), id);
     if (v.ok) {
       this.#move(id, 'done', report.summary, 'verified', { checks: v.checks.map((c) => c.why) });
       return;
     }
diff --git a/src/core/mesh/handover.ts b/src/core/mesh/handover.ts
index 08108e35..532402f2 100644
--- a/src/core/mesh/handover.ts
+++ b/src/core/mesh/handover.ts
@@ -622,22 +622,22 @@ export class Promotions {
     const caught = await this.#until(() => role.lag().acked_seq >= head, this.#o.catchupMs ?? 120_000);
     this.#task(r, 'catchup', 'Copied to the candidate', caught, caught ? `“${to.name}” has every change up to sequence ${head}.` : `“${to.name}” didn’t catch up to sequence ${head} in time.`, { head, acked: role.lag().acked_seq });
     if (!caught) { this.#save({ ...r, state: 'failed', said: `“${to.name}” didn’t catch up in time. Nothing changed.` }); return; }
     // Step 3: drain.
     r = this.#save({ ...r, state: 'draining' });
     role.emit('draining', { promotion: r.id });
     this.#o.stopWork();
     const d = await this.#o.ledger.drain({ boundMs: this.#o.drainMs ?? 60_000, commitMs: this.#o.commitMs ?? 5 * 60_000, keep: (t) => t.owner === PROMOTION_WORKER || t.owner === 'mesh' });
     if (d.stuck.length) {
       this.#resume();
-      this.#task(r, 'drain', 'Running work finished or handed over', false, `${d.stuck.length} ${d.stuck.length === 1 ? 'task is' : 'tasks are'} past the point where they change something outside Nova, and still running; Nova never cuts that short. Nothing changed: try again when ${d.stuck.length === 1 ? 'it is' : 'they are'} done.`, { stuck: d.stuck });
-      this.#save({ ...r, state: 'failed', said: 'Work past its commit point was still running. Nothing changed.' });
+      this.#task(r, 'drain', 'Running work finished or handed over', false, `${d.stuck.length} ${d.stuck.length === 1 ? 'task has' : 'tasks have'} work still running. It may be past its commit point or may not have stopped after cancellation or timeout. Handing over now could run the work twice. Nothing changed: try again when it has stopped.`, { stuck: d.stuck });
+      this.#save({ ...r, state: 'failed', said: 'Work was still running, so Nova could not safely hand over. Nothing changed.' });
       return;
     }
     const drained = this.#task(r, 'drain', 'Running work finished or handed over', true, `${d.finished.length} finished; ${d.handed.length} handed over to run again on the new hub.`, { finished: d.finished, handed: d.handed });
     await this.#settled(drained.id);
     // Writes held at the gate first; then the requests already past it finish; only then is the last
     // sequence fixed (finding 5). The log keeps recording: a change that lands after all (work that
     // ignored its stop) is in it, so the candidate copies it or it is kept here and said.
     role.hold(this.#holdWords(r));
     this.#o.quiet?.(true);
     r = this.#save({ ...r, state: 'holding' });
diff --git a/src/core/providers/cli.ts b/src/core/providers/cli.ts
index b93389c5..b27a6958 100644
--- a/src/core/providers/cli.ts
+++ b/src/core/providers/cli.ts
@@ -1,15 +1,16 @@
 // Running a provider's command line: found on PATH or by path, started without a shell in the
 // task's folder, its output read as lines, stopped (with everything it started) when the task is
 // cancelled or runs out of time. Nothing here runs a command just to check it is there.
 import { spawn } from 'node:child_process';
 import { trackChild } from '../children.ts';
+import { inheritedChildEnv } from '../child-env.ts';
 import { accessSync, constants, statSync } from 'node:fs';
 import { delimiter, isAbsolute, join } from 'node:path';

 // The words of a command as a person writes it in a setting: spaces separate, quotes group.
 export function words(command: string): string[] {
   const out: string[] = [];
   let cur = '';
   let quote: string | null = null;
   let any = false;
   for (const ch of command) {
@@ -31,29 +32,24 @@ export function which(program: string, path = process.env.PATH ?? ''): string |
     try { accessSync(p, constants.X_OK); return statSync(p).isFile(); } catch { return false; }
   };
   if (program.includes('/')) return isAbsolute(program) && ok(program) ? program : null;
   for (const dir of path.split(delimiter).filter(Boolean)) {
     const p = join(dir, program);
     if (ok(p)) return p;
   }
   return null;
 }

-// What a provider's command is never handed: Nova's own settings and secrets, and the variables
-// through which a Claude Code session Nova may itself be running in would leak into the child.
-// NODE_TEST_CONTEXT: set when Nova itself runs under `node --test`; a brief's own `node --test`
-// would otherwise report to Nova's test runner instead of exiting with its result.
-const LEAKY = /^(NOVA_|NODE_TEST_CONTEXT$|CLAUDE\w*(MEMORY|ADDITIONAL_DIRECTORIES|CLAUDE_MD|USER_EMAIL))/;
+// Inheritance is finite and shared with Era 2. Explicit extras are a trusted caller contract,
+// not another source of ambient parent data; no provider adapter currently supplies extras.
 export function childEnv(extra: Record<string, string> = {}, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
-  const out: Record<string, string> = {};
-  for (const [k, v] of Object.entries(env)) if (v !== undefined && !LEAKY.test(k)) out[k] = v;
-  return { ...out, ...extra };
+  return { ...inheritedChildEnv(env), ...extra };
 }

 export interface Ran { code: number | null; signal: string | null; stderr: string; aborted: boolean; timedOut: boolean; ms: number }

 // Starts `argv` in `cwd` in a process group of its own, writes `input` to its stdin, and hands each stdout line to `onLine`.
 // Resolves when it exits; never rejects for a failing command (the caller reads `code`).
 export function runLines(o: { argv: string[]; cwd: string; input?: string; env?: Record<string, string>; signal?: AbortSignal; timeoutMs?: number; onLine: (line: string) => void; shell?: boolean }): Promise<Ran> {
   const started = performance.now();
   return new Promise((resolveRun, rejectRun) => {
     const [cmd, ...args] = o.shell ? ['/bin/sh', '-c', o.argv.join(' ')] : o.argv;
diff --git a/src/tools.js b/src/tools.js
index aba9f479..a52bb6e5 100644
--- a/src/tools.js
+++ b/src/tools.js
@@ -1,18 +1,18 @@
 // Nova's tools, and the plain-text protocol the model uses to call them.
 //
 // The protocol is text so any agent_cmd can drive it: the model ends its
 // message with one <tool_call name="...">{json}</tool_call> block and stops.
 // Nova runs the tool (asking the user first where required) and calls the model
 // again with the result in the transcript.
 import { spawn } from 'node:child_process';
-import { trackChild } from './core/index.ts';
+import { inheritedChildEnv, trackChild } from './core/index.ts';
 import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, writeSync } from 'node:fs';
 import { basename, dirname, join, relative, resolve, sep } from 'node:path';
 import { inHome, inSecretDir } from './home.js';
 import { safeFetch } from './safe-fetch.js';

 const MAX_READ = 200_000;
 const MAX_OUTPUT = 16_000;
 const MAX_FETCH = 20_000;
 const UA = 'Nova/0.1 (personal agent)';
 export const SEARCH_URL = 'https://html.duckduckgo.com/html/';
@@ -585,22 +585,23 @@ export function parseToolCall(raw, names = Object.keys(TOOLS)) {
     if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('not an object');
   } catch {
     return { visible, call: { name, args: {} }, error: 'The tool arguments were not a JSON object.' };
   }
   return { visible, call: { name, args }, error: null };
 }

 export function runCommand(command, { cwd, signal, timeoutMs = 120_000 }) {
   return new Promise((resolvePromise) => {
     mkdirSync(cwd, { recursive: true });
-    const shell = process.env.SHELL || '/bin/sh';
-    const child = trackChild(spawn(shell, ['-lc', command], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }), { group: true });
+    // A login shell (or e.g. zsh's non-login .zshenv) can reintroduce credentials from
+    // startup files after filtering. Use a non-interactive POSIX shell with no profiles.
+    const child = trackChild(spawn('/bin/sh', ['-c', command], { cwd, env: inheritedChildEnv(), detached: true, stdio: ['ignore', 'pipe', 'pipe'] }), { group: true });
     let out = '';
     const take = (d) => { out += d; if (out.length > MAX_OUTPUT * 4) out = out.slice(-MAX_OUTPUT * 2); };
     child.stdout.on('data', take);
     child.stderr.on('data', take);
     const kill = () => { try { process.kill(-child.pid, 'SIGTERM'); } catch {} };
     const timer = setTimeout(() => { out += `\n[stopped after ${Math.round(timeoutMs / 1000)}s]`; kill(); }, timeoutMs);
     signal?.addEventListener('abort', kill, { once: true });
     child.on('error', (e) => { clearTimeout(timer); resolvePromise(`Could not start the command: ${e.message}`); });
     child.on('close', (code, sig) => {
       clearTimeout(timer);
diff --git a/tests/core/effects.test.ts b/tests/core/effects.test.ts
index 59db8485..ab54e05b 100644
--- a/tests/core/effects.test.ts
+++ b/tests/core/effects.test.ts
@@ -23,36 +23,37 @@ import { createCore, type Core } from '../../src/core/index.ts';
 import type { Effects, Worker } from '../../src/core/workers.ts';
 import { startFakeHomeAssistant } from '../../scripts/fake-home-assistant.js';
 import { startFakeN8n } from '../../scripts/stand-ins/fake-n8n.js';
 import { bootCore, until } from './connector-support.ts';

 const MAY = /^May already have happened: .*\. Check, then retry or cancel\.$/;

 // A worker that "sends" something each run. `how` decides what comes back.
 function sender(o: { effects?: Effects | (() => Effects); how: 'bad-evidence' | 'throw' | 'garbage' | 'hang'; commits?: boolean; ledger?: () => Ledger; commitFirst?: boolean; timeoutMs?: number }) {
   const runs: string[] = [];
+  let settle = () => {};
   const w: Worker = {
     id: 'sender', name: 'Sender', about: 'test', egress: 'none', evidence: ['read_back'], health: () => ({ ok: true }),
     ...(o.effects ? { effects: typeof o.effects === 'function' ? o.effects : () => o.effects as Effects } : {}),
     ...(o.commits !== undefined ? { commits: () => o.commits! } : {}),
     ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}),
     run: async (b: Brief) => {
       runs.push(b.task_id);
       if (o.commitFirst) o.ledger!().committing(b.task_id, 'Send the form');
       if (o.how === 'throw') throw new Error('the far end hung up');
       if (o.how === 'garbage') return { nonsense: true };
-      if (o.how === 'hang') return new Promise(() => {});
+      if (o.how === 'hang') return new Promise((resolve) => { settle = () => resolve(null); });
       const ev = { kind: 'read_back', target: 'note.md', sha256: 'f'.repeat(64), bytes: 9 };
       return { envelope: ENVELOPE_VERSION, task_id: b.task_id, status: 'done', summary: 'Sent it.', evidence: [ev], artifacts: [], blockers: [], usage: { duration_ms: 1 }, follow_up_suggestions: [] };
     },
   };
-  return { w, runs };
+  return { w, runs, settle: () => settle() };
 }

 function ledgerWith(w: Worker, o: { timeoutMs?: number; db?: Db } = {}) {
   const db = o.db ?? new Db(':memory:');
   if (!o.db) db.migrate();
   const ws = new Workspace(join(mkdtempSync(join(tmpdir(), 'nova-effects-')), 'workspace'));
   const ledger = new Ledger({ db, log: new Log(db, null), verifier: new Verifier(ws), workers: [w], defaultPrivacy: () => 'local-only', ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}) });
   return { db, ledger };
 }

@@ -62,40 +63,49 @@ const lastMove = (l: Ledger, id: string) => l.events(id).filter((e) => e.to_stat
 for (const [how, kind, why] of [
   ['bad-evidence', 'verification_failed', /The evidence didn't hold up: Nova looked for note\.md and it isn't there/],
   ['throw', 'attempt_failed', /Sender stopped with an error: the far end hung up/],
   ['garbage', 'attempt_failed', /Sender sent back a report Nova couldn't read/],
   ['hang', 'timed_out', /Sender took longer than/],
 ] as const) {
   test(`external work that fails after it was sent (${how}) waits for the person; it never reruns by itself`, async () => {
     const s = sender({ effects: 'external', how, ...(how === 'hang' ? { timeoutMs: 40 } : {}) });
     const { ledger } = ledgerWith(s.w);
     const t = ledger.create(input());
+    if (how === 'hang') {
+      assert.equal(await until(() => ledger.get(t.id).state, (s) => s === 'waiting'), 'waiting');
+      assert.throws(() => ledger.retry(t.id), /still running/, 'person cannot overlap an unresolved external attempt');
+      s.settle();
+    }
     await ledger.idle();
     const held = ledger.get(t.id);
     assert.equal(s.runs.length, 1, 'it ran once');
     assert.deepEqual([held.state, held.user_visibility], ['waiting', 'attention']);
     assert.match(held.reason!, MAY);
     assert.match(held.reason!, why);
     const ev = lastMove(ledger, t.id);
     assert.equal(ev.kind, kind);
     assert.equal((ev.detail as { held: boolean }).held, true);
     if (how === 'bad-evidence') {
       // The discrepancy is kept, for the person to check against.
       assert.match(JSON.stringify((ev.detail as { discrepancy: unknown }).discrepancy), /"kind":"read_back".*isn't there/);
       assert.equal(held.verification!.ok, false);
     }
     // Nothing moves it on by itself, not even a pump.
     await ledger.pump();
     assert.equal(ledger.get(t.id).state, 'waiting');
     assert.equal(s.runs.length, 1);
     // The person's retry is the one way to run it again.
     ledger.retry(t.id);
+    if (how === 'hang') {
+      assert.equal(await until(() => ledger.get(t.id).state, (s) => s === 'waiting'), 'waiting');
+      s.settle();
+    }
     await ledger.idle();
     assert.equal(s.runs.length, 2);
     ledger.cancel(t.id, 'Checked: it went through the first time.');
     assert.equal(ledger.get(t.id).state, 'cancelled');
   });
 }

 test('the same failures rerun by themselves for work with no outside effects, or that the far end takes twice as once', async () => {
   for (const effects of [undefined, 'none', 'idempotent'] as const) {
     const s = sender({ ...(effects ? { effects } : {}), how: 'bad-evidence' });
diff --git a/tests/core/ledger.test.ts b/tests/core/ledger.test.ts
index fde0cdac..5afdc088 100644
--- a/tests/core/ledger.test.ts
+++ b/tests/core/ledger.test.ts
@@ -1,32 +1,32 @@
 import { test } from 'node:test';
 import assert from 'node:assert/strict';
 import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
 import { tmpdir } from 'node:os';
 import { join } from 'node:path';
 import { Db } from '../../src/core/db.ts';
 import { Log } from '../../src/core/log.ts';
-import { Ledger, canMove, type TaskInput } from '../../src/core/ledger.ts';
+import { Ledger, canMove, type TaskInput, type LanedWorker } from '../../src/core/ledger.ts';
 import { Verifier } from '../../src/core/verify.ts';
 import { Workspace, sha256, workspaceWorker } from '../../src/core/workspace.ts';
 import { ENVELOPE_VERSION, type Brief, type PrivacyMode } from '../../src/core/envelope.ts';
 import type { Egress, Worker } from '../../src/core/workers.ts';

-function setup(opts: { workers?: (ws: Workspace) => Worker[]; privacy?: PrivacyMode; db?: Db; root?: string } = {}) {
+function setup(opts: { workers?: (ws: Workspace) => LanedWorker[]; privacy?: PrivacyMode; db?: Db; root?: string; timeoutMs?: number; maxAttempts?: number } = {}) {
   const root = opts.root ?? mkdtempSync(join(tmpdir(), 'nova-ledger-'));
   const db = opts.db ?? new Db(':memory:');
   if (!opts.db) db.migrate();
   const log = new Log(db, null);
   const ws = new Workspace(join(root, 'workspace'));
   const workers = [workspaceWorker(ws), ...(opts.workers?.(ws) ?? [])];
   const verifier = new Verifier(ws);
-  const ledger = new Ledger({ db, log, verifier, workers, defaultPrivacy: () => opts.privacy ?? 'local-only' });
+  const ledger = new Ledger({ db, log, verifier, workers, defaultPrivacy: () => opts.privacy ?? 'local-only', timeoutMs: opts.timeoutMs, maxAttempts: opts.maxAttempts });
   return { db, log, ws, ledger, root, verifier };
 }

 const writeNote = (over: Partial<TaskInput> = {}): TaskInput => ({
   title: 'Write a note',
   owner: 'workspace',
   goal: 'A note saying hello is in the workspace.',
   origin: { kind: 'user' },
   evidence_required: [{ kind: 'read_back', target: 'workspace:notes/hello.md' }],
   inputs: { action: 'write', path: 'notes/hello.md', content: 'hello\n' },
@@ -214,46 +214,56 @@ test('pumping an empty queue settles, so idle() returns (regression: it used to
   const { ledger } = setup();
   await ledger.pump();
   await ledger.idle();
   const t = ledger.create(writeNote());
   await ledger.idle();
   assert.equal(ledger.get(t.id).state, 'done');
 });

 // Review findings (PR #210): each of these failed before its fix.

-test('a worker that hangs past the timeout does not block the queue', async () => {
-  const hang = fake('hang', 'none', () => new Promise(() => {}));
-  const root = mkdtempSync(join(tmpdir(), 'nova-ledger-'));
-  const db = new Db(':memory:');
-  db.migrate();
-  const ws = new Workspace(join(root, 'workspace'));
-  const ledger = new Ledger({ db, log: new Log(db, null), verifier: new Verifier(ws), workers: [workspaceWorker(ws), hang(ws)], defaultPrivacy: () => 'local-only', timeoutMs: 40, maxAttempts: 1 });
-  const stuck = ledger.create(writeNote({ owner: 'hang', idempotency_key: 'h' }));
-  const next = ledger.create(writeNote({ idempotency_key: 'n' }));
-  await ledger.idle();
-  assert.equal(ledger.get(stuck.id).state, 'failed');
-  assert.match(ledger.get(stuck.id).reason ?? '', /took longer than/);
-  assert.equal(ledger.get(next.id).state, 'done', 'the next task still ran');
+test('a worker past its deadline fails promptly but retains its lane until physical settlement', { timeout: 5000 }, async () => {
+  const pending = Promise.withResolvers<unknown>();
+  const { ledger } = setup({ timeoutMs: 40, maxAttempts: 1, workers: (ws) => [fake('hang', 'none', () => pending.promise)(ws)] });
+  const stuck = ledger.create(writeNote({ owner: 'hang' }));
+  const next = ledger.create(writeNote());
+  try {
+    await eventually(() => ledger.get(stuck.id).state === 'failed');
+    assert.match(ledger.get(stuck.id).reason ?? '', /took longer than/);
+    assert.equal(ledger.get(next.id).state, 'queued', 'same lane cannot overlap even a terminal attempt');
+    assert.throws(() => ledger.committing(stuck.id, 'late commit'), /running/);
+    pending.resolve(report(stuck.brief));
+    await ledger.idle();
+    assert.equal(ledger.get(stuck.id).state, 'failed', 'late success cannot replace the deadline result');
+    assert.equal(ledger.get(stuck.id).report, null);
+    assert.equal(ledger.get(next.id).state, 'done');
+  } finally { pending.resolve(null); await ledger.idle(); }
 });

-test('cancelling a running task frees the queue', async () => {
-  const hang = fake('hang', 'none', () => new Promise(() => {}));
-  const { ledger } = setup({ workers: (ws) => [hang(ws)] });
-  const stuck = ledger.create(writeNote({ owner: 'hang', idempotency_key: 'h' }));
-  const next = ledger.create(writeNote({ idempotency_key: 'n' }));
-  await new Promise((r) => setTimeout(r, 20));
-  assert.equal(ledger.get(stuck.id).state, 'active');
-  ledger.cancel(stuck.id, 'Taking too long.');
-  await ledger.idle();
-  assert.equal(ledger.get(stuck.id).state, 'cancelled');
-  assert.equal(ledger.get(next.id).state, 'done');
+test('cancelling revokes authority immediately but frees the lane only when the worker settles', { timeout: 5000 }, async () => {
+  const pending = Promise.withResolvers<unknown>();
+  const { ledger } = setup({ workers: (ws) => [fake('hang', 'none', () => pending.promise)(ws)] });
+  const stuck = ledger.create(writeNote({ owner: 'hang' }));
+  const next = ledger.create(writeNote());
+  try {
+    await eventually(() => ledger.get(stuck.id).state === 'active');
+    ledger.cancel(stuck.id, 'Taking too long.');
+    assert.throws(() => ledger.committing(stuck.id, 'late commit'), /running/);
+    assert.throws(() => ledger.notStarted(stuck.id, 'late claim'), /running/);
+    await new Promise((r) => setTimeout(r, 10));
+    assert.equal(ledger.get(next.id).state, 'queued');
+    pending.reject(new Error('late cancellation rejection'));
+    await ledger.idle();
+    assert.equal(ledger.get(stuck.id).state, 'cancelled');
+    assert.equal(ledger.get(stuck.id).report, null);
+    assert.equal(ledger.get(next.id).state, 'done');
+  } finally { pending.resolve(null); await ledger.idle(); }
 });

 test('a read-back target matches however it is spelled, and an append is not repeated', async () => {
   const { ledger, ws } = setup();
   const t = ledger.create(writeNote({ evidence_required: [{ kind: 'read_back', target: 'notes/log.md' }], inputs: { action: 'append', path: 'notes/log.md', content: 'x\n' } }));
   await ledger.idle();
   assert.equal(ledger.get(t.id).state, 'done', ledger.get(t.id).reason ?? '');
   assert.equal(readFileSync(ws.resolve('notes/log.md'), 'utf8'), 'x\n');
 });

@@ -419,10 +429,151 @@ test('a worker can take longer than the default timeout when it says so', async
   const slow = (ws: Workspace): Worker => ({ ...fake('slow', 'none', (b) => new Promise((r) => setTimeout(() => r(workspaceWorker(ws).run(b, new AbortController().signal)), 80)))(ws), timeoutMs: 1000 });
   const root = mkdtempSync(join(tmpdir(), 'nova-ledger-'));
   const db = new Db(':memory:');
   db.migrate();
   const ws = new Workspace(join(root, 'workspace'));
   const ledger = new Ledger({ db, log: new Log(db, null), verifier: new Verifier(ws), workers: [workspaceWorker(ws), slow(ws)], defaultPrivacy: () => 'local-only', timeoutMs: 20, maxAttempts: 1 });
   const t = ledger.create(writeNote({ owner: 'slow' }));
   await ledger.idle();
   assert.equal(ledger.get(t.id).state, 'done', ledger.get(t.id).reason ?? '');
 });
+
+
+async function eventually(check: () => boolean): Promise<void> {
+  const until = Date.now() + 2000;
+  while (!check() && Date.now() < until) await new Promise((r) => setTimeout(r, 5));
+  assert.ok(check(), 'the expected state arrived within the bound');
+}
+
+// Physical worker settlement, not timeout bookkeeping, owns its id and lane slot.
+for (const max of [1, 2]) for (const late of ['resolve', 'reject'] as const) {
+  test(`timeout retains the live worker slot (max ${max}, late ${late})`, { timeout: 5000 }, async () => {
+    const pending = Promise.withResolvers<unknown>();
+    const retry = Promise.withResolvers<unknown>();
+    let firstBrief!: Brief;
+    const calls: string[] = [];
+    let firstSignal!: AbortSignal;
+    const { ledger, ws } = setup({ timeoutMs: 50, workers: (ws) => [{
+      ...fake('controlled', 'none', async () => null)(ws),
+      lane: () => ({ key: 'one', max }),
+      run: (b, signal) => {
+        calls.push(b.task_id);
+        if (!firstBrief) { firstBrief = b; firstSignal = signal; return pending.promise; }
+        if (b.task_id === firstBrief.task_id) return retry.promise;
+        return workspaceWorker(ws).run(b, signal);
+      },
+    }] });
+    const first = ledger.create(writeNote({ owner: 'controlled' }));
+    try {
+      await eventually(() => ledger.events(first.id).some((e) => e.kind === 'timed_out'));
+      void ledger.pump();
+      await new Promise((r) => setTimeout(r, 10));
+      assert.equal(calls.filter((id) => id === first.id).length, 1, 'no retry overlaps the unresolved first worker');
+      assert.equal(firstSignal.aborted, true);
+      assert.equal(ledger.get(first.id).state, 'queued');
+      assert.throws(() => ledger.committing(first.id, 'too late'), /running/);
+      assert.throws(() => ledger.notStarted(first.id, 'too late'), /running/);
+      const sibling = ledger.create(writeNote({ owner: 'controlled' }));
+      const other = ledger.create(writeNote());
+      await eventually(() => ledger.get(other.id).state === 'done');
+      if (max === 1) assert.equal(ledger.get(sibling.id).state, 'queued', 'same lane remains reserved');
+      else await eventually(() => ledger.get(sibling.id).state === 'done');
+      let idle = false;
+      void ledger.idle().then(() => { idle = true; });
+      await new Promise((r) => setTimeout(r, 10));
+      assert.equal(idle, false, 'idle cannot claim the unresolved worker is gone');
+      const expired = ledger.get(first.id);
+      assert.equal(expired.attempts, 1);
+      assert.equal(expired.report, null);
+      if (late === 'resolve') pending.resolve(report(firstBrief, { status: 'failed', summary: 'late result' }));
+      else pending.reject(new Error('late rejection'));
+      await eventually(() => calls.filter((id) => id === first.id).length === 2);
+      assert.equal(ledger.get(first.id).report, null, 'late result did not replace the current report');
+      assert.equal(ledger.events(first.id).filter((e) => e.kind === 'reported').length, 0);
+      retry.resolve(await workspaceWorker(ws).run(firstBrief, new AbortController().signal));
+      await ledger.idle();
+      assert.equal(ledger.get(first.id).state, 'done');
+      assert.equal(ledger.get(first.id).attempts, 2);
+      assert.equal(ledger.get(sibling.id).state, 'done', 'settlement wakes the blocked lane');
+      assert.equal(ledger.events(first.id).filter((e) => e.kind === 'commit_point' || e.kind === 'not_started').length, 0);
+    } finally {
+      pending.resolve(null);
+      retry.resolve(null);
+      ledger.halt();
+      await ledger.idle();
+    }
+  });
+}
+
+test('drain refuses live timed-out work and resume recovers stopped siblings without overlapping either', { timeout: 5000 }, async () => {
+  const orphan = Promise.withResolvers<unknown>();
+  const cooperative = Promise.withResolvers<unknown>();
+  let orphanRuns = 0;
+  let politeRuns = 0;
+  const { ledger, ws } = setup({ workers: (ws) => [{
+    ...fake('orphan', 'none', async () => null)(ws), timeoutMs: 30,
+    lane: () => ({ key: 'orphan', max: 1 }),
+    run: (b, signal) => ++orphanRuns === 1 ? orphan.promise : workspaceWorker(ws).run(b, signal),
+  }, {
+    ...fake('polite', 'none', async () => null)(ws),
+    lane: () => ({ key: 'polite', max: 1 }),
+    run: (b, signal) => {
+      if (++politeRuns > 1) return workspaceWorker(ws).run(b, signal);
+      signal.addEventListener('abort', () => cooperative.reject(signal.reason), { once: true });
+      return cooperative.promise;
+    },
+  }] });
+  const stuck = ledger.create(writeNote({ owner: 'orphan' }));
+  const polite = ledger.create(writeNote({ owner: 'polite' }));
+  try {
+    await eventually(() => ledger.events(stuck.id).some((e) => e.kind === 'timed_out'));
+    const start = Date.now();
+    const drained = await ledger.drain({ boundMs: 10, commitMs: 20, keep: () => false });
+    assert.ok(Date.now() - start < 500, 'drain is bounded');
+    assert.deepEqual(drained.stuck, [stuck.id], 'unresolved work prevents handover');
+    assert.ok(!drained.finished.includes(stuck.id) && !drained.handed.includes(stuck.id));
+    assert.throws(() => ledger.committing(polite.id, 'after abort'), /running/);
+    assert.throws(() => ledger.notStarted(polite.id, 'after abort'), /running/);
+    ledger.resume();
+    ledger.recover();
+    await eventually(() => ledger.get(polite.id).state === 'done');
+    assert.equal(politeRuns, 2, 'stopped cooperative task is recovered after refused drain');
+    assert.equal(orphanRuns, 1);
+    orphan.resolve(report(stuck.brief, { status: 'failed' }));
+    await ledger.idle();
+    assert.equal(ledger.get(stuck.id).state, 'done');
+    assert.equal(orphanRuns, 2);
+    assert.equal(readFileSync(ws.resolve('notes/hello.md'), 'utf8'), 'hello\n');
+  } finally {
+    orphan.resolve(null);
+    cooperative.resolve(null);
+    ledger.halt();
+    await ledger.idle();
+  }
+});
+
+
+test('halt revokes authority and resume waits for physical settlement before recovery', { timeout: 5000 }, async () => {
+  const pending = Promise.withResolvers<unknown>();
+  let runs = 0;
+  const { ledger } = setup({ workers: (ws) => [{
+    ...fake('halted', 'none', async () => null)(ws),
+    run: (b, signal) => ++runs === 1 ? pending.promise : workspaceWorker(ws).run(b, signal),
+  }] });
+  const first = ledger.create(writeNote({ owner: 'halted' }));
+  try {
+    await eventually(() => runs === 1);
+    assert.deepEqual(ledger.halt(), [first.id]);
+    assert.throws(() => ledger.committing(first.id, 'after halt'), /running/);
+    assert.throws(() => ledger.notStarted(first.id, 'after halt'), /running/);
+    await new Promise((r) => setTimeout(r, 10));
+    assert.equal(ledger.get(first.id).state, 'active');
+    ledger.resume();
+    assert.deepEqual(ledger.recover().requeued, [], 'recovery cannot change a still-live attempt');
+    assert.equal(ledger.get(first.id).attempts, 1);
+    pending.resolve(report(first.brief, { status: 'failed', summary: 'late halted report' }));
+    await ledger.idle();
+    assert.equal(runs, 2);
+    assert.equal(ledger.get(first.id).state, 'done');
+    assert.equal(ledger.events(first.id).filter((e) => e.kind === 'reported').length, 1);
+  } finally { pending.resolve(null); ledger.halt(); await ledger.idle(); }
+});
diff --git a/tests/core/mesh-promotion.test.ts b/tests/core/mesh-promotion.test.ts
index 9e8c58dc..1be8107b 100644
--- a/tests/core/mesh-promotion.test.ts
+++ b/tests/core/mesh-promotion.test.ts
@@ -229,20 +229,22 @@ test('the drain: nothing new starts but what is kept; running work gets the boun
     const slow = mk('slow', 'Slow work');
     await until(() => ledger.get(slow.id).state, (s) => s === 'active', 3000);
     const d = await ledger.drain({ boundMs: 200, commitMs: 200, keep: (t) => t.owner === 'mesh-promotion' });
     assert.deepEqual(d, { finished: [], handed: [slow.id], stuck: [] });
     await sleep(100);
     assert.equal(ledger.get(slow.id).state, 'active', 'handed over: still active, for the next hub’s recovery to requeue');
     const later = mk('slow', 'Queued during the drain');
     await sleep(200);
     assert.equal(ledger.get(later.id).state, 'queued', 'nothing new starts while it drains');
     ledger.resume();
+    assert.equal(await until(() => ledger.get(slow.id).state, (s) => s === 'active'), 'active');
+    ledger.cancel(slow.id);
     await until(() => ledger.get(later.id).state, (s) => s === 'active', 3000);
     ledger.cancel(later.id);
     const c = mk('committed', 'Past its commit point');
     await until(() => ledger.get(c.id).state, (s) => s === 'active', 3000);
     const d2 = await ledger.drain({ boundMs: 100, commitMs: 200, keep: () => false });
     assert.deepEqual(d2.stuck, [c.id], 'never cut: the hand-over stops instead');
     release();
     ledger.resume();
     assert.equal(await until(() => ledger.get(c.id).state, (s) => s !== 'active', 3000), 'failed', 'it ran to its end, uncut');
   } finally {
@@ -451,10 +453,51 @@ test('writes held: every change refused with the reason, the mesh’s own calls
     assert.equal(r.status, 409);
     assert.match(r.body.error, /handing the hub over/);
     assert.equal((await call(h.mesh, 'GET', '/api/v1/mesh/hello')).body.held, true);
     assert.equal((await dev.session()).status, 200, 'a device still signs in');
     h.core.mesh.role.release();
     assert.equal((await h.c('POST', '/memory', { kind: 'fact', content: 'x' })).status, 201);
   } finally {
     await h.stop();
   }
 });
+
+
+test('planned promotion refuses a timed-out live worker and keeps the old hub usable', { timeout: 30_000 }, async () => {
+  const p = await pair();
+  const pending = Promise.withResolvers<unknown>();
+  let runs = 0;
+  try {
+    const ledger = p.a.core.ledger;
+    ledger.workers.set('uncooperative', {
+      id: 'uncooperative', name: 'Uncooperative', about: 'Controlled test worker', egress: 'none', evidence: [], health: () => ({ ok: true }),
+      timeoutMs: 40, lane: () => ({ key: 'private', max: 1 }),
+      run: (b) => {
+        runs++;
+        return runs === 1 ? pending.promise : Promise.resolve({ envelope: '1', task_id: b.task_id, status: 'failed', summary: 'Finished test work.', evidence: [], artifacts: [], blockers: [], usage: { duration_ms: 0 }, follow_up_suggestions: [] });
+      },
+    });
+    const work = ledger.create({ title: 'Uncooperative test work', owner: 'uncooperative', goal: 'Test timeout.', origin: { kind: 'user' }, evidence_required: [{ kind: 'confirmation' }], approval_tier: 0 });
+    assert.equal(await until(() => ledger.events(work.id).some((e) => e.kind === 'timed_out'), Boolean), true);
+    backedUp(p.a.core);
+    await synced(p);
+    const started = await p.a.api('POST', '/mesh/promotions', { device_id: p.standbyId, confirm: true });
+    assert.equal(started.status, 202, JSON.stringify(started.body));
+    const rec = await until(() => p.a.core.mesh.promotions.record(), (r) => r?.state === 'failed');
+    assert.equal(rec?.state, 'failed');
+    assert.deepEqual([p.a.core.mesh.role.role(), p.b.core.mesh.role.role()], ['hub', 'standby']);
+    assert.equal(p.name.target(), p.a.mesh, 'stable name was never transferred');
+    assert.equal(runs, 1, 'refused drain cannot dispatch a concurrent retry');
+    assert.equal((await p.a.api('PUT', '/profile/user/drain_probe', { value: 'still usable' })).status, 200);
+    assert.doesNotMatch(rec!.said ?? '', /past its commit point/, 'a timed-out worker has not claimed a commit');
+    const drain = ledger.list().find((t) => t.parent_id === rec!.parent && t.title === 'Running work finished or handed over');
+    assert.ok(drain);
+    assert.doesNotMatch(drain.brief.goal, /past the point where they change/, 'drain explanation does not invent an outside effect');
+    pending.resolve(null);
+    await ledger.idle();
+    assert.equal(runs, 2, 'settlement lets the resumed hub retry');
+    assert.equal(ledger.get(work.id).state, 'failed');
+  } finally {
+    pending.resolve(null);
+    await stop(p);
+  }
+});
diff --git a/tests/subprocess-environment.test.js b/tests/subprocess-environment.test.js
new file mode 100644
index 00000000..ca0e6558
--- /dev/null
+++ b/tests/subprocess-environment.test.js
@@ -0,0 +1,74 @@
+// Exercise real child processes below a disposable parent, never the owner's environment.
+import { test } from 'node:test';
+import assert from 'node:assert/strict';
+import { execFileSync } from 'node:child_process';
+import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
+import { tmpdir } from 'node:os';
+import { dirname, join } from 'node:path';
+import { randomUUID } from 'node:crypto';
+import { childEnv } from '../src/core/providers/cli.ts';
+
+const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
+
+// Removing an env filter from any launch must make that path's test fail, including for a
+// previously unknown key. A fake model only prints selected fixture fields; no CLI auth runs.
+for (const path of ['exec', 'agent', 'provider-default', 'provider-childEnv']) {
+  test(`${path}: subprocess inherits public metadata and no private parent canaries`, () => {
+    const home = mkdtempSync(join(tmpdir(), 'nova-env-'));
+    try {
+      const innocent = `WEATHER_${randomUUID().replaceAll('-', '')}`;
+      const canaries = Object.fromEntries([
+        innocent, 'NOVA_SECRET_OPENAI', 'NOVA_SECRET_future', 'NOVA_MESH_NAME_TOKEN',
+        'NOVA_CALLBACK_TOKEN', 'NOVA_VAULT_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY',
+        'AWS_SESSION_TOKEN', 'GOOGLE_CLIENT_SECRET', 'SESSION_COOKIE', 'PRIVATE_KEY',
+        'CLAUDE_CODE_MEMORY_DIR', 'CLAUDE_CODE_USER_EMAIL', 'SSH_AUTH_SOCK',
+        'LC_FUTURE_SECRET', 'XDG_FUTURE_SECRET', 'PYTHONPATH', 'LD_LIBRARY_PATH',
+        'DYLD_INSERT_LIBRARIES', 'GIT_CONFIG_COUNT', 'NODE_TEST_CONTEXT',
+      ].map((k) => [k, `synthetic-${k}`]));
+      // Valid, harmless runtime injection values, installed only after the parent starts.
+      Object.assign(canaries, { NODE_OPTIONS: '--stack-trace-limit=17', BASH_ENV: join(home, 'startup.sh'), ENV: join(home, 'startup.sh'), ZDOTDIR: home });
+      writeFileSync(join(home, 'startup.sh'), 'export STARTUP_SECRET=synthetic-startup\n');
+      for (const file of ['.profile', '.bash_profile', '.zprofile', '.zshenv']) {
+        writeFileSync(join(home, file), 'export STARTUP_SECRET=synthetic-startup\n');
+      }
+      // Model a shell that loads a private startup file even for -c (like zsh's .zshenv).
+      // This fixture keeps the regression portable without requiring zsh on CI.
+      const shell = join(home, 'fixture-shell');
+      writeFileSync(shell, `#!/bin/sh\n. ${quote(join(home, 'startup.sh'))}\nif [ "$1" = '-lc' ]; then shift; exec /bin/sh -c "$1"; fi\nexec /bin/sh "$@"\n`, { mode: 0o700 });
+      const publicEnv = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, LANG: 'C', LC_ALL: 'C', LC_CTYPE: 'C', TZ: 'UTC', TMPDIR: home };
+      const keys = [...Object.keys(publicEnv), ...Object.keys(canaries), 'STARTUP_SECRET'];
+      const probe = join(home, 'fake-agent.mjs');
+      writeFileSync(probe, `console.log('ENV:' + JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.map(k => [k, process.env[k] ?? null]))));`);
+      const command = `${quote(process.execPath)} ${quote(probe)}`;
+      const parent = join(home, 'parent.mjs');
+      writeFileSync(parent, `
+        import { runCommand } from ${JSON.stringify(new URL('../src/tools.js', import.meta.url).href)};
+        import { runAgent } from ${JSON.stringify(new URL('../src/agent.js', import.meta.url).href)};
+        import { runLines, childEnv } from ${JSON.stringify(new URL('../src/core/providers/cli.ts', import.meta.url).href)};
+        Object.assign(process.env, ${JSON.stringify(canaries)});
+        process.env.SHELL = ${JSON.stringify(shell)};
+        let output = '';
+        if (${JSON.stringify(path)} === 'exec') output = await runCommand(${JSON.stringify(command)}, { cwd: ${JSON.stringify(home)} });
+        else if (${JSON.stringify(path)} === 'agent') output = (await runAgent({ cmd: ${JSON.stringify(command)}, system: 'fixture', prompt: 'fixture' })).text;
+        else {
+          const result = await runLines({ argv: ${JSON.stringify([process.execPath, probe])}, cwd: ${JSON.stringify(home)}, ${path === 'provider-childEnv' ? 'env: childEnv(),' : ''} onLine: line => { output += line + '\\n'; } });
+          if (result.code !== 0) throw new Error('fake provider failed: ' + result.stderr);
+        }
+        console.log(output);
+      `);
+      const output = execFileSync(process.execPath, [parent], { cwd: home, env: publicEnv, encoding: 'utf8', timeout: 15_000 });
+      const line = output.split('\n').find((s) => s.startsWith('ENV:'));
+      assert.ok(line, 'real child returned selected fields');
+      const seen = JSON.parse(line.slice(4));
+      assert.deepEqual(Object.fromEntries(Object.keys(publicEnv).map((k) => [k, seen[k]])), publicEnv);
+      const leaked = [...Object.keys(canaries), 'STARTUP_SECRET'].filter((k) => seen[k] !== null);
+      assert.deepEqual(leaked, [], `private fields reached ${path}: ${leaked.join(', ')}`);
+    } finally { rmSync(home, { recursive: true, force: true }); }
+  });
+}
+
+test('provider explicit extras remain trusted, separate from inherited parent data', () => {
+  assert.deepEqual(childEnv({ OPENAI_API_KEY: 'explicit-synthetic', HOME: '/explicit' }, { HOME: '/parent', OPENAI_API_KEY: 'parent-synthetic', UNKNOWN_SETTING: 'private' }), {
+    HOME: '/explicit', OPENAI_API_KEY: 'explicit-synthetic',
+  });
+});
````

## Complete Ledger implementation for unchanged-helper context

````ts
// The Work Ledger, v1 (WORK-LEDGER-AND-VERIFICATION). Every unit of work is a task with a brief,
// an owner and a state; every state change is an appended event. A task never just disappears:
// it ends done, failed or cancelled, with a reason. "Done" is reachable only through verification.
import { EventEmitter } from 'node:events';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { CoreError } from './errors.ts';
import { ENVELOPE_VERSION, validateBrief, validateReport, type Brief, type ContextRef, type EvidenceRequirement, type PrivacyMode, type Report, type Tier } from './envelope.ts';
import { effectsOf, egressOf, permits, type Worker } from './workers.ts';
import type { Db } from './db.ts';
import type { Log } from './log.ts';
import type { Verification, Verifier } from './verify.ts';

// The task a piece of work runs for, and its privacy mode, for whatever it calls while it runs
// (the ingest gate's screen reads it: a task's own mode tightens the screen, never loosens it).
export const TASK_CONTEXT = new AsyncLocalStorage<{ task_id: string; privacy_mode: PrivacyMode }>();

export const STATES = ['queued', 'active', 'waiting', 'verifying', 'done', 'failed', 'cancelled'] as const;
export type State = (typeof STATES)[number];
export const TERMINAL: readonly State[] = ['done', 'failed', 'cancelled'];

const MOVES: Record<State, State[]> = {
  queued: ['active', 'waiting', 'cancelled'],
  // waiting → active: a running worker that asked for the person carries on once they're done.
  waiting: ['queued', 'cancelled', 'failed', 'active'],
  active: ['verifying', 'waiting', 'failed', 'queued', 'cancelled'],
  // verifying → waiting: evidence that didn't hold up for work that may already have happened.
  verifying: ['done', 'queued', 'failed', 'waiting'],
  done: [],
  failed: [],
  cancelled: [],
};

export const canMove = (from: State, to: State): boolean => MOVES[from].includes(to);

export const VISIBILITY = ['silent', 'handling', 'attention'] as const;
export type Visibility = (typeof VISIBILITY)[number];
// `device`: asked for by a paired computer's agent (ref: the device id), through its queue.
export interface Origin { kind: 'user' | 'setup' | 'trigger' | 'device'; ref?: string }

export interface TaskInput {
  title: string;
  owner: string;
  goal: string;
  origin: Origin;
  evidence_required: EvidenceRequirement[];
  privacy_mode?: PrivacyMode;
  approval_tier?: Tier;
  context_refs?: ContextRef[];
  constraints?: Brief['constraints'];
  inputs?: Record<string, unknown>;
  idempotency_key?: string;
  parent_id?: string;
  user_visibility?: Visibility;
}

export interface Task {
  id: string;
  title: string;
  origin: Origin;
  state: State;
  reason: string | null;
  owner: string;
  brief: Brief;
  report: Report | null;
  verification: Verification | null;
  privacy_mode: PrivacyMode;
  approval_tier: Tier;
  approved_at: string | null;
  cost: Record<string, number>;
  parent_id: string | null;
  user_visibility: Visibility;
  idempotency_key: string;
  attempts: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface TaskEvent { seq: number; task_id: string; at: string; kind: string; from_state: State | null; to_state: State | null; detail: unknown }

type Row = Record<string, string | number | null>;
const parse = <T>(s: unknown): T => (typeof s === 'string' ? JSON.parse(s) : null) as T;

function toTask(r: Row): Task {
  return {
    ...(r as unknown as Task),
    origin: parse(r.origin),
    brief: parse(r.brief),
    report: parse(r.report),
    verification: parse(r.verification),
    cost: parse(r.cost),
  };
}

// Where a task waits its turn. Tasks in one lane run side by side up to `max`; a worker that
// names no lane shares the default one, which runs one task at a time.
export interface Lane { key: string; max: number }
// `minTier`: the least approval a task for this worker needs, whatever the caller asked for (a
// provider whose brief declares a test command for Nova to run asks first: tier 2, M5a).
// `internal`: a worker whose tasks only its own module makes (the change pipeline, the foundry).
// Anyone else asking — the API, a device, a connector, a trigger — is refused with `why`, so a
// brief can't be forged to drive it past the person's OK.
// `uncancellable`: why a running task can't be cancelled now (it is part way through a step that
// can't be stopped half done, such as moving a branch), or null. A cancel then is refused, so the
// record never says "cancelled" over work that went ahead.
export type LanedWorker = Worker & { lane?(brief: Brief): Lane; minTier?(input: Pick<TaskInput, 'inputs' | 'evidence_required'>): Tier; internal?: { key: symbol; why: string }; uncancellable?(t: Task): string | null };
const DEFAULT_LANE: Lane = { key: 'default', max: 1 };

export interface LedgerOptions {
  db: Db;
  log: Log;
  verifier: Verifier;
  workers: LanedWorker[];
  defaultPrivacy: () => PrivacyMode;
  now?: () => Date;
  maxAttempts?: number;
  timeoutMs?: number;
}

export class Ledger extends EventEmitter {
  readonly workers: Map<string, LanedWorker>;
  #db: Db;
  #log: Log;
  #verifier: Verifier;
  #now: () => Date;
  #defaultPrivacy: () => PrivacyMode;
  #maxAttempts: number;
  #timeoutMs: number;
  #pumping: Promise<void> | null = null;
  #wake: (() => void) | null = null;
  #dirty = false;
  #running = new Map<string, AbortController>();
  // Nova is about to restart: nothing new starts, and what was running is left for the next start.
  #halted = false;
  // While a hub drains before handing over (M10g): the only queued work that may still start.
  #keep: ((t: Task) => boolean) | null = null;
  #inflight = new Map<string, { lane: string; done: Promise<void> }>();

  constructor(o: LedgerOptions) {
    super();
    this.#db = o.db;
    this.#log = o.log;
    this.#verifier = o.verifier;
    this.workers = new Map(o.workers.map((w) => [w.id, w]));
    this.#now = o.now ?? (() => new Date());
    this.#defaultPrivacy = o.defaultPrivacy;
    this.#maxAttempts = o.maxAttempts ?? 3;
    this.#timeoutMs = o.timeoutMs ?? 10 * 60_000;
  }

  // `as`: the key of an internal worker, from the module that owns it.
  create(input: TaskInput, o: { as?: symbol } = {}): Task {
    // Before the idempotency look-up too: a forged key mustn't even read back the real task.
    const closed = this.closed(input?.owner);
    if (closed && o.as !== this.workers.get(input.owner)!.internal!.key) throw new CoreError('forbidden', closed);
    const key = input.idempotency_key ?? randomUUID();
    const existing = this.#db.get<Row>('SELECT * FROM task WHERE idempotency_key = ?', key);
    if (existing) return toTask(existing);

    if (typeof input.title !== 'string' || !input.title.trim()) throw new CoreError('validation', 'A task needs a title, in plain words.');
    const worker = this.workers.get(input.owner);
    if (!worker) throw new CoreError('validation', `There is no worker called "${input.owner}".`, [`Workers: ${[...this.workers.keys()].join(', ')}`]);
    if (!Array.isArray(input.evidence_required) || !input.evidence_required.length) {
      throw new CoreError('validation', 'A task must say what evidence will prove it done. "Done" without evidence is not done.');
    }
    // Otherwise any existing file with a known hash would pass as proof.
    if (input.evidence_required.some((r) => r?.kind === 'read_back' && !r.target)) {
      throw new CoreError('validation', 'A read-back requirement must name the file to read back.');
    }
    const mode = input.privacy_mode ?? this.#defaultPrivacy();
    if (input.parent_id !== undefined && !this.#db.get('SELECT 1 FROM task WHERE id = ?', input.parent_id)) throw new CoreError('validation', `No parent task ${input.parent_id}.`);
    if (input.user_visibility !== undefined && !VISIBILITY.includes(input.user_visibility)) throw new CoreError('validation', `user_visibility must be one of ${VISIBILITY.join(', ')}.`);
    const id = randomUUID();
    const brief = validateBrief({
      envelope: ENVELOPE_VERSION,
      task_id: id,
      goal: input.goal,
      context_refs: input.context_refs ?? [],
      constraints: input.constraints ?? {},
      privacy_mode: mode,
      approval_tier: Math.max(input.approval_tier ?? 1, worker.minTier?.(input) ?? 0) as Tier,
      evidence_required: input.evidence_required,
      idempotency_key: key,
      ...(input.inputs ? { inputs: input.inputs } : {}),
    });
    // Where this brief's data would go; a worker whose reach depends on the brief says so, and
    // refuses a brief it could never run.
    if (!permits(mode, egressOf(worker, brief))) {
      throw new CoreError('validation', `${worker.name} sends data off your devices, and this task is ${mode}. Pick a worker that keeps it local.`);
    }
    const at = this.#now().toISOString();
    this.#db.tx(() => {
      this.#db.run(
        `INSERT INTO task (id, title, origin, state, reason, owner, brief, privacy_mode, approval_tier, parent_id, user_visibility, idempotency_key, created_at, updated_at)
         VALUES (?, ?, ?, 'queued', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, input.title.trim(), JSON.stringify(input.origin), worker.id, JSON.stringify(brief), brief.privacy_mode, brief.approval_tier,
        input.parent_id ?? null, input.user_visibility ?? 'handling', key, at, at,
      );
      this.#event(id, 'created', null, 'queued', { owner: worker.id, privacy_mode: brief.privacy_mode, approval_tier: brief.approval_tier });
    });
    const gated = this.#gate(this.get(id));
    this.emit('task', gated);
    void this.pump();
    return gated;
  }

  // Why nobody but its own module may give this worker a task, or null when anyone may.
  closed(owner: unknown): string | null {
    return typeof owner === 'string' ? this.workers.get(owner)?.internal?.why ?? null : null;
  }

  get(id: string): Task {
    const row = this.#db.get<Row>('SELECT * FROM task WHERE id = ?', id);
    if (!row) throw new CoreError('not_found', `No task ${id}.`);
    return toTask(row);
  }

  list(opts: { state?: State; limit?: number } = {}): Task[] {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
    const rows = opts.state
      ? this.#db.all<Row>('SELECT * FROM task WHERE state = ? ORDER BY created_at DESC LIMIT ?', opts.state, limit)
      : this.#db.all<Row>('SELECT * FROM task ORDER BY created_at DESC LIMIT ?', limit);
    return rows.map(toTask);
  }

  events(id: string): TaskEvent[] {
    this.get(id);
    return this.#db.all<Row>('SELECT * FROM task_event WHERE task_id = ? ORDER BY seq', id).map((e) => ({ ...(e as unknown as TaskEvent), detail: parse(e.detail) }));
  }

  // Tier 2 asks first; tier 3 needs an explicit confirmation every time (NOVA-SPEC §6).
  approve(id: string, opts: { confirm?: boolean } = {}): Task {
    const t = this.get(id);
    if (t.approved_at) return t;
    if (t.state !== 'waiting' || t.approval_tier < 2) throw new CoreError('conflict', 'This task is not waiting for approval.');
    if (t.approval_tier === 3 && opts.confirm !== true) throw new CoreError('validation', 'This is a tier-3 task: approving it needs an explicit confirmation.');
    this.#db.run('UPDATE task SET approved_at = ? WHERE id = ?', this.#now().toISOString(), id);
    this.#event(id, 'approved', null, null, { tier: t.approval_tier });
    const next = this.#gate(this.get(id));
    void this.pump();
    return next;
  }

  // The person asks for another go at a task that is waiting on something other than approval
  // (blocked, partly done, or out of local capacity).
  // A worker that stepped aside (a blocked report) and is ready again uses it too, with its reason.
  retry(id: string, reason = 'Trying again, as you asked.'): Task {
    const t = this.get(id);
    // Its worker is still running and waiting for the person (needsPerson): running it a second
    // time would race the first.
    if (this.#running.has(id)) throw new CoreError('conflict', 'This task is still running: it is waiting for you to do a step. Open it to take over.');
    if (this.#inflight.has(id)) throw new CoreError('conflict', 'This task’s previous worker is still running. Wait for it to stop before retrying.');
    if (t.state !== 'waiting' || (t.approval_tier >= 2 && !t.approved_at)) throw new CoreError('conflict', "This task isn't waiting for a retry.");
    this.#db.run(`UPDATE task SET user_visibility = 'handling' WHERE id = ?`, id);
    // Running work with outside effects again is a new decision: the OK given for the first run
    // doesn't cover it, so a task that needs one asks again before it runs.
    const w = this.workers.get(t.owner);
    const reapprove = t.attempts > 0 && t.approval_tier >= 2 && !!w && effectsOf(w, t.brief) === 'external';
    if (reapprove) this.#db.run('UPDATE task SET approved_at = NULL WHERE id = ?', id);
    const next = this.#move(id, 'queued', reason, 'retried', reapprove ? { asks_again: true } : undefined);
    const gated = reapprove ? this.#gate(next) : next;
    void this.pump();
    return gated;
  }

  // A running worker needs the person for a step only they may do (a sign-in, a challenge): the
  // task waits, flagged for them, while the worker keeps running. `personDone` takes it back.
  needsPerson(id: string, why: string): Task {
    const t = this.get(id);
    if (!this.#running.has(id) || (t.state !== 'active' && t.state !== 'waiting')) throw new CoreError('conflict', 'Only a running task can ask for you.');
    this.#db.run(`UPDATE task SET user_visibility = 'attention' WHERE id = ?`, id);
    return this.#move(id, 'waiting', why, 'needs_person');
  }

  personDone(id: string, why: string): Task {
    const t = this.get(id);
    if (!this.#running.has(id) || t.state !== 'waiting') return t;
    this.#db.run(`UPDATE task SET user_visibility = 'handling' WHERE id = ?`, id);
    return this.#move(id, 'active', why, 'person_done');
  }

  // A running worker says its work never started this time: the service it hands work to turned it
  // away before anything existed (Relay's runtime_busy). Written down now; if the worker's report is
  // `blocked`, the ledger gives the dispatch back, so it isn't counted as an attempt. A done or
  // failed report is counted whatever was said here.
  notStarted(id: string, why: string): void {
    const t = this.get(id);
    if (!this.#running.has(id)) throw new CoreError('conflict', 'Only a running task can say its work never started.');
    this.#event(id, 'not_started', null, null, { why: String(why).slice(0, 300), attempt: t.attempts });
  }

  // What the worker said about this dispatch never starting (a not_started event since the last
  // dispatch), or null.
  #claimedNotStarted(id: string): string | null {
    const since = this.#db.get<{ seq: number | null }>(`SELECT MAX(seq) AS seq FROM task_event WHERE task_id = ? AND kind = 'dispatched'`, id)?.seq ?? 0;
    const row = this.#db.get<{ detail: string | null }>(`SELECT detail FROM task_event WHERE task_id = ? AND kind = 'not_started' AND seq > ? ORDER BY seq DESC LIMIT 1`, id, since);
    return row ? parse<{ why?: string }>(row.detail)?.why ?? 'The work never started' : null;
  }

  // The dispatch didn't count: its attempt is given back, and the record says so in plain words.
  #giveBack(id: string, why: string): void {
    this.#db.tx(() => {
      this.#db.run('UPDATE task SET attempts = MAX(attempts - 1, 0) WHERE id = ?', id);
      this.#event(id, 'attempt_returned', null, null, { reason: `${why.trim().replace(/[.;\s]+$/, '')}; this didn’t count as an attempt.`, attempts: this.get(id).attempts });
    });
  }

  // A running worker is about to do the thing that has the task's outside effect (a step flagged
  // `commits`). Written down first, so after a failure the ledger knows whether that point was
  // ever passed in this attempt.
  committing(id: string, what: string): void {
    const t = this.get(id);
    if (!this.#running.has(id)) throw new CoreError('conflict', 'Only a running task can pass its commit point.');
    this.#event(id, 'commit_point', null, null, { what, attempt: t.attempts });
  }

  // Something a worker wants in the task's record that isn't a change of state (a takeover, a
  // request it refused). It is appended like every other event.
  note(id: string, kind: string, detail?: unknown): void {
    const t = this.get(id);
    this.#event(id, kind, null, null, detail);
    this.emit('note', { task: t, kind, detail });
  }

  cancel(id: string, reason = 'Cancelled.'): Task {
    const t = this.get(id);
    if (TERMINAL.includes(t.state)) throw new CoreError('conflict', `This task is already ${t.state}.`);
    let no: string | null = null;
    try { no = this.workers.get(t.owner)?.uncancellable?.(t) ?? null; } catch { /* it can't say: cancellable */ }
    if (no) throw new CoreError('conflict', no);
    this.#running.get(id)?.abort(new Error('cancelled'));
    return this.#move(id, 'cancelled', reason, 'cancelled');
  }

  // After a restart: work that was running goes back in the queue under the same idempotency
  // key, and a report that was waiting on verification is verified now.
  recover(): { requeued: string[]; reverified: string[] } {
    const requeued: string[] = [];
    const reverified: string[] = [];
    for (const found of this.list({ state: 'active', limit: 500 })) {
      if (this.#inflight.has(found.id)) continue;
      // A worker that said its work never started, and then Nova stopped: that dispatch isn't counted.
      const unstarted = this.#claimedNotStarted(found.id);
      if (unstarted) this.#giveBack(found.id, unstarted);
      const t = unstarted ? this.get(found.id) : found;
      if (!this.#mayRerun(t)) {
        this.#hold(t.id, 'Nova restarted while this was running', 'recovered');
        continue;
      }
      if (t.attempts >= this.#maxAttempts) {
        this.#fail(t.id, `Nova restarted while this was running, ${t.attempts} times. Not trying again.`, undefined, 'recovered');
        continue;
      }
      this.#requeue(t, 'Nova restarted while this was running. It will run again.', 'recovered');
      requeued.push(t.id);
    }
    // A worker that was waiting for the person (needsPerson) was running too; what it had open is
    // gone, so it starts again from the beginning.
    for (const t of this.list({ state: 'waiting', limit: 500 })) {
      if (this.#inflight.has(t.id)) continue;
      const last = this.#db.get<{ kind: string }>('SELECT kind FROM task_event WHERE task_id = ? AND to_state IS NOT NULL ORDER BY seq DESC LIMIT 1', t.id);
      if (last?.kind !== 'needs_person') continue;
      if (!this.#mayRerun(t)) {
        this.#hold(t.id, 'Nova restarted while this waited for you', 'recovered');
        continue;
      }
      if (t.attempts >= this.#maxAttempts) {
        this.#fail(t.id, `Nova restarted while this waited for you, ${t.attempts} times. Not trying again.`, undefined, 'recovered');
        continue;
      }
      this.#db.run(`UPDATE task SET user_visibility = 'handling' WHERE id = ?`, t.id);
      this.#requeue(t, 'Nova restarted while this waited for you. It starts again from the beginning.', 'recovered');
      requeued.push(t.id);
    }
    for (const t of this.list({ state: 'verifying', limit: 500 })) {
      if (t.report) this.#verifyAndSettle(t.id, t.report);
      else if (!this.#mayRerun(t)) this.#hold(t.id, 'Nova restarted before the report arrived', 'recovered');
      else this.#move(t.id, 'queued', 'Nova restarted before the report arrived. It will run again.', 'recovered');
      reverified.push(t.id);
    }
    void this.pump();
    return { requeued, reverified };
  }

  // Run queued tasks, oldest first. Each lane runs up to its limit at once; a full lane doesn't
  // hold up the others. Calling it while it runs wakes it to look at the queue again.
  pump(): Promise<void> {
    if (this.#pumping) {
      this.#dirty = true;
      this.#wake?.();
      return this.#pumping;
    }
    const run = (async () => {
      // Yield first, so `#pumping` is set before the loop can finish and clear it.
      await null;
      try {
        for (;;) {
          this.#dirty = false;
          // No limit: a full lane with many queued tasks must not hide the tasks of other lanes.
          for (const row of this.#halted && !this.#keep ? [] : this.#db.all<Row>(`SELECT * FROM task WHERE state = 'queued' ORDER BY created_at, rowid`)) {
            const t = toTask(row);
            if (this.#halted && !this.#keep!(t)) continue;
            if (this.#inflight.has(t.id)) continue;
            const lane = this.#lane(t);
            if ([...this.#inflight.values()].filter((x) => x.lane === lane.key).length >= lane.max) continue;
            let interrupted = false;
            const done = this.#runOne(t)
              .then((stopped) => { interrupted = stopped === true; })
              .catch((e) => { this.#log.problem('ledger', 'The Work Ledger stumbled while running a task.', { detail: (e as Error)?.stack ?? String(e), taskId: t.id }); })
              .finally(() => {
                this.#inflight.delete(t.id);
                // A refused handover may have resumed while this worker was still stopping.
                if (interrupted && !this.#halted) this.recover();
                this.#wake?.();
              });
            this.#inflight.set(t.id, { lane: lane.key, done });
          }
          if (this.#dirty) continue;
          if (!this.#inflight.size) break;
          const woken = new Promise<void>((r) => { this.#wake = r; });
          await Promise.race([woken, ...[...this.#inflight.values()].map((x) => x.done)]);
          this.#wake = null;
        }
      } finally {
        this.#pumping = null;
        this.#wake = null;
      }
    })();
    this.#pumping = run;
    return run;
  }

  #lane(t: Task): Lane {
    const w = this.workers.get(t.owner);
    try {
      const l = w?.lane?.(t.brief);
      if (l && typeof l.key === 'string' && Number.isInteger(l.max) && l.max >= 1) return { key: `${w!.id}:${l.key}`, max: l.max };
    } catch { /* a worker whose lane can't be worked out runs in the default lane */ }
    return DEFAULT_LANE;
  }

  // Before Nova restarts in place: every running task is stopped (its worker's signal), nothing
  // more is started, and the stopped tasks stay as they were, for the next start's recovery.
  halt(reason = 'Nova is restarting.'): string[] {
    this.#halted = true;
    this.#keep = null;
    const ids = [...this.#inflight.keys()];
    for (const ac of this.#running.values()) ac.abort(new Error(reason));
    return ids;
  }

  // Before this hub hands the role to another node (M10g, the orchestration ADR's step 3): nothing new
  // starts except what `keep` allows (the promotion's own records); running work gets `boundMs` to
  // finish; a task past its commit point (its worker's `uncancellable` says why) is never cut, and is
  // waited for up to `commitMs`; anything else still running is stopped and stays active, so the next
  // hub's recovery requeues it (or holds it, if it may have had an effect). Stopped workers get
  // another `commitMs` to actually settle. `stuck`: any physical work still alive at the end;
  // the caller must give up handing over and resume, even if its attempt already timed out.
  async drain(o: { boundMs: number; commitMs: number; keep: (t: Task) => boolean }): Promise<{ finished: string[]; handed: string[]; stuck: string[] }> {
    this.#halted = true;
    this.#keep = o.keep;
    const mine = () => [...this.#inflight.keys()].filter((id) => { try { return !o.keep(this.get(id)); } catch { return true; } });
    const before = mine();
    const live = (id: string) => this.#inflight.has(id);
    const wait = async (ids: string[], ms: number) => {
      const until = Date.now() + ms;
      while (ids.some(live) && Date.now() < until) await new Promise((r) => setTimeout(r, Math.min(50, until - Date.now())));
    };
    await wait(before, o.boundMs);
    const committed = (id: string) => { try { return !!this.workers.get(this.get(id).owner)?.uncancellable?.(this.get(id)); } catch { return false; } };
    const past = before.filter(live).filter(committed);
    if (past.length) await wait(past, o.commitMs);
    const stuck = past.filter(live);
    if (stuck.length) return { finished: before.filter((id) => !live(id)), handed: [], stuck };
    const left = before.filter(live);
    for (const id of left) this.#running.get(id)?.abort(new Error('This hub is handing over to another node.'));
    // Revocation is not settlement: handing an unresolved worker to another hub would overlap it.
    await wait(left, o.commitMs);
    return { finished: before.filter((id) => !left.includes(id)), handed: left.filter((id) => !live(id)), stuck: left.filter(live) };
  }

  // Nothing new starts but what `keep` allows, and nothing running is stopped: a hub that restarts
  // while it holds writes for a hand-over (M10g review, finding 4) starts like this, before recovery.
  pause(keep: (t: Task) => boolean): void {
    this.#halted = true;
    this.#keep = keep;
  }

  // A drain that didn't end in a handover: the queue runs again.
  resume(): void {
    const interrupted = this.#halted;
    this.#halted = false;
    this.#keep = null;
    if (interrupted) this.recover();
    else void this.pump();
  }

  // Resolves when no physical worker remains and no queued work can currently start.
  async idle(): Promise<void> {
    while (this.#pumping) await this.#pumping;
  }

  counts(): Record<State, number> {
    const out = Object.fromEntries(STATES.map((s) => [s, 0])) as Record<State, number>;
    for (const r of this.#db.all<{ state: State; n: number }>('SELECT state, COUNT(*) AS n FROM task GROUP BY state')) out[r.state] = r.n;
    return out;
  }

  // Approval and privacy are checked before anything runs, and again after anything changes.
  #gate(t: Task): Task {
    if (t.state !== 'queued' && t.state !== 'waiting') return t;
    const worker = this.workers.get(t.owner);
    let wait: string | null = null;
    if (!worker) wait = `The worker "${t.owner}" isn't available.`;
    else if (!permits(t.privacy_mode, (() => { try { return egressOf(worker, t.brief); } catch { return 'remote'; } })())) wait = `Waiting on local capacity: ${worker.name} would send this off your devices, and this task is local-only.`;
    else if (t.approval_tier >= 2 && !t.approved_at) wait = 'Needs your OK before it runs.';
    if (wait && (t.state !== 'waiting' || t.reason !== wait)) {
      this.#db.run(`UPDATE task SET user_visibility = 'attention' WHERE id = ?`, t.id);
      return this.#move(t.id, 'waiting', wait, 'gated');
    }
    if (!wait && t.state === 'waiting') return this.#move(t.id, 'queued', null, 'released');
    return t;
  }

  async #runOne(t: Task): Promise<boolean | void> {
    const gated = this.#gate(t);
    if (gated.state !== 'queued') return;
    const worker = this.workers.get(t.owner)!;
    this.#db.run('UPDATE task SET attempts = attempts + 1 WHERE id = ?', t.id);
    this.#move(t.id, 'active', `${worker.name} is on it.`, 'dispatched', { attempt: t.attempts + 1 });
    const ac = new AbortController();
    this.#running.set(t.id, ac);
    const limit = worker.timeoutMs ?? this.#timeoutMs;
    const signal = AbortSignal.any([ac.signal, AbortSignal.timeout(limit)]);
    // Expiry revokes authority immediately, but the inflight slot outlives this race until the
    // actual worker settles. Independent lanes can still run; this id/lane cannot overlap it.
    let stop!: () => void;
    const stopped = new Promise<never>((_, fail) => {
      stop = () => {
        if (this.#running.get(t.id) === ac) this.#running.delete(t.id);
        fail(signal.reason);
      };
      if (signal.aborted) stop();
      else signal.addEventListener('abort', stop, { once: true });
    });
    const work = Promise.resolve().then(() => TASK_CONTEXT.run({ task_id: t.id, privacy_mode: t.brief.privacy_mode }, () => worker.run(t.brief, signal)));
    try {
      let raw: unknown;
      try {
        raw = await Promise.race([work, stopped]);
        if (signal.aborted) throw signal.reason;
      } catch (e) {
        this.#running.delete(t.id);
        if (this.#halted && !this.#keep?.(t)) return true;
        if (this.get(t.id).state === 'cancelled') return;
        if (signal.aborted && (e as Error)?.name === 'TimeoutError') {
          return this.#retryOrFail(t.id, `${worker.name} took longer than ${Math.round(limit / 1000)} s.`, undefined, 'timed_out');
        }
        return this.#retryOrFail(t.id, `${worker.name} stopped with an error: ${(e as Error).message}`, (e as Error).stack);
      }
      stopped.catch(() => {});
      this.#running.delete(t.id);
      if (this.get(t.id).state === 'cancelled') return;
      // A worker that asked for the person and then finished without saying they were done.
      if (this.get(t.id).state === 'waiting') this.#move(t.id, 'active', `${worker.name} is on it.`, 'person_done');

      let report: Report;
      try {
        report = validateReport(raw, t.brief);
      } catch (e) {
        const details = e instanceof CoreError ? e.details.join('; ') : String(e);
        return this.#retryOrFail(t.id, `${worker.name} sent back a report Nova couldn't read.`, details);
      }
      const cost = { duration_ms: Math.round(report.usage.duration_ms), ...(report.usage.cost_usd ? { cost_usd: report.usage.cost_usd } : {}) };
      this.#db.run('UPDATE task SET report = ?, cost = ? WHERE id = ?', JSON.stringify(report), JSON.stringify(cost), t.id);
      this.#event(t.id, 'reported', null, null, { status: report.status, summary: report.summary });

      if (report.status === 'failed') return this.#fail(t.id, `${worker.name} couldn't do it: ${report.summary}`);
      if (report.status === 'blocked' || report.status === 'partial') {
        // Only a blocked report can say the work never started; then the dispatch is given back.
        const unstarted = report.status === 'blocked' ? this.#claimedNotStarted(t.id) : null;
        if (unstarted) this.#giveBack(t.id, unstarted);
        this.#db.run(`UPDATE task SET user_visibility = 'attention' WHERE id = ?`, t.id);
        const why = report.status === 'blocked' ? `Blocked: ${report.blockers.join('; ') || report.summary}` : `Partly done: ${report.summary}`;
        this.#move(t.id, 'waiting', why, report.status);
        return;
      }
      this.#move(t.id, 'verifying', 'Checking the evidence.', 'verifying');
      this.#verifyAndSettle(t.id, report);
    } finally {
      signal.removeEventListener('abort', stop);
      // Observe late rejections as well as resolutions, without accepting their report or
      // releasing capacity early. Keeping #runOne pending also makes idle/drain truthful.
      await work.catch(() => {});
    }
  }

  #verifyAndSettle(id: string, report: Report): void {
    const t = this.get(id);
    const v = this.#verifier.verify(t.brief, report);
    this.#db.run('UPDATE task SET verification = ? WHERE id = ?', JSON.stringify(v), id);
    if (v.ok) {
      this.#move(id, 'done', report.summary, 'verified', { checks: v.checks.map((c) => c.why) });
      return;
    }
    const why = v.checks.filter((c) => !c.ok).map((c) => c.why).join(' ');
    // What didn't match, kept with the event: for work that may already have happened, it is
    // what the person checks before choosing to retry.
    const discrepancy = v.checks.filter((c) => !c.ok).map((c) => ({ kind: c.requirement.kind, why: c.why }));
    this.#retryOrFail(id, `The evidence didn't hold up: ${why}`, undefined, 'verification_failed', { discrepancy });
  }

  #retryOrFail(id: string, why: string, detail?: string, kind = 'attempt_failed', extra?: Record<string, unknown>): void {
    const t = this.get(id);
    if (!this.#mayRerun(t)) {
      this.#hold(id, why, kind, { ...(detail ? { detail } : {}), ...extra });
      return;
    }
    if (t.attempts < this.#maxAttempts) {
      this.#log.warn('ledger', why, { task: id, attempt: t.attempts, detail });
      this.#requeue(t, `${why} Trying again (attempt ${t.attempts + 1} of ${this.#maxAttempts}).`, kind, { detail });
      return;
    }
    this.#fail(id, `${why} Gave up after ${t.attempts} attempts.`, detail, kind);
  }

  // Whether a task that stopped after it was dispatched may run again by itself. Work with outside
  // effects may not: it may already have happened, and only the person can tell. The exception is
  // a brief that marks where its effect happens (`commits`): if this attempt never got there,
  // nothing has happened yet. That decision is written down either way.
  #mayRerun(t: Task): boolean {
    const w = this.workers.get(t.owner);
    if (!w || effectsOf(w, t.brief) !== 'external') return true;
    let marked = false;
    try { marked = w.commits?.(t.brief) === true; } catch { /* it can't say: as if unmarked */ }
    if (!marked) return false;
    const since = this.#db.get<{ seq: number | null }>(`SELECT MAX(seq) AS seq FROM task_event WHERE task_id = ? AND kind = 'dispatched'`, t.id)?.seq ?? 0;
    const passed = this.#db.get<{ detail: string | null }>(`SELECT detail FROM task_event WHERE task_id = ? AND kind = 'commit_point' AND seq > ? ORDER BY seq LIMIT 1`, t.id, since);
    const what = passed ? parse<{ what?: string }>(passed.detail)?.what : null;
    this.#event(t.id, 'rerun_decision', null, null, passed
      ? { rerun: false, why: `It got as far as “${what ?? 'the step that sends it'}”, so it may already have happened.` }
      : { rerun: true, why: 'It stopped before the step that has the outside effect, so nothing has happened yet; it may run again.' });
    return !passed;
  }

  // Work that may already have happened waits for the person: Needs you, with what went wrong, and
  // only their retry (or cancel) moves it on.
  #hold(id: string, why: string, kind: string, detail?: Record<string, unknown>): void {
    const reason = `May already have happened: ${why.trim().replace(/[.\s]+$/, '')}. Check, then retry or cancel.`;
    this.#log.warn('ledger', reason, { task: id });
    this.#db.run(`UPDATE task SET user_visibility = 'attention' WHERE id = ?`, id);
    this.#move(id, 'waiting', reason, kind, { ...detail, held: true });
  }

  // Tier 3 is confirmed every time it runs (NOVA-SPEC §6), so a rerun asks again.
  #requeue(t: Task, reason: string, kind: string, detail?: unknown): void {
    if (t.approval_tier === 3) this.#db.run('UPDATE task SET approved_at = NULL WHERE id = ?', t.id);
    this.#move(t.id, 'queued', reason, kind, detail);
  }

  #fail(id: string, why: string, detail?: string, kind = 'failed'): void {
    this.#db.run(`UPDATE task SET user_visibility = 'attention' WHERE id = ?`, id);
    this.#move(id, 'failed', why, kind, detail ? { detail } : undefined);
    // A task that failed is the Failed class: its work can't proceed (DESIGN-SYSTEM §1).
    this.#log.problem('ledger', `A task failed: ${this.get(id).title}. ${why}`, { detail, taskId: id, stops: true });
  }

  #move(id: string, to: State, reason: string | null, kind: string, detail?: unknown): Task {
    const t = this.get(id);
    if (t.state !== to && !canMove(t.state, to)) throw new CoreError('conflict', `A ${t.state} task can't become ${to}.`);
    const at = this.#now().toISOString();
    this.#db.tx(() => {
      this.#db.run('UPDATE task SET state = ?, reason = ?, updated_at = ?, completed_at = ? WHERE id = ?', to, reason, at, TERMINAL.includes(to) ? at : null, id);
      this.#event(id, kind, t.state, to, { reason, ...(detail && typeof detail === 'object' ? detail : {}) });
    });
    const next = this.get(id);
    this.emit('task', next);
    return next;
  }

  #event(id: string, kind: string, from: State | null, to: State | null, detail?: unknown): void {
    this.#db.run('INSERT INTO task_event (task_id, at, kind, from_state, to_state, detail) VALUES (?, ?, ?, ?, ?, ?)', id, this.#now().toISOString(), kind, from, to, detail === undefined ? null : JSON.stringify(detail));
  }
}
````
