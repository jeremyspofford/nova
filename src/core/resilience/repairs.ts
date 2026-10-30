// Which playbook fits the problems other modules open in their own words, and the repairs that
// need those modules: checking a worker again and requeueing work that was only waiting on it,
// reconnecting a connection, letting the standby copy again, asking a computer's boot agent to
// start its runtime again. Each is safe: none deletes or changes the person's data, and none
// runs work again that may already have had an outside effect (the ledger's own rule decides).
import type { Problem } from '../log.ts';
import type { Ledger } from '../ledger.ts';
import type { Providers } from '../providers/registry.ts';
import type { Models } from '../models/index.ts';
import type { Connectors } from '../connectors/index.ts';
import type { MeshRole } from '../mesh/promote.ts';
import type { Spokes } from '../mesh/spokes.ts';
import type { Devices } from '../mesh/devices.ts';
import type { Playbooks } from './playbooks.ts';
import { WORKER_ID } from './index.ts';

export interface RepairDeps {
  ledger: Ledger;
  providers: Providers;
  models: Models;
  connectors: Connectors;
  role: MeshRole;
  spokes: Spokes;
  devices: Devices;
}

const FULL = /ENOSPC|disk is full|SQLITE_FULL|no space left/i;
const LOOKUP = /ENOTFOUND|EAI_AGAIN|getaddrinfo|name (couldn’t|could not) be (looked up|resolved)/i;

export function wireRepairs(pb: Playbooks, d: RepairDeps): void {
  // The device or connection a message names (the longest name that fits, so "Desk" doesn't win
  // over "Desk upstairs").
  const byName = <T extends { name: string }>(list: T[], text: string) => list.filter((x) => x.name && text.includes(x.name)).sort((a, b) => b.name.length - a.name.length)[0] ?? null;

  pb.classify((p: Problem) => {
    const text = `${p.message}\n${p.detail ?? ''}`;
    if (FULL.test(text)) return { playbook: 'disk-full', subject: p.source === 'ledger' ? null : p.source };
    if (p.source === 'ledger' && p.task_id) {
      let owner: string | null = null;
      try { owner = d.ledger.get(p.task_id).owner; } catch { /* gone */ }
      if (!owner || owner === WORKER_ID) return null;
      return { playbook: 'provider-failed', subject: owner };
    }
    if (p.source === 'models' && /isn’t answering/.test(p.message)) return { playbook: 'local-model-down', subject: null };
    if (p.source === 'sync' && /fallen behind|can’t copy the hub|hasn’t reached the hub/.test(p.message)) return { playbook: 'standby-behind', subject: null };
    if (p.source === 'mesh' && /is in safe mode/.test(p.message)) {
      const dev = byName(d.devices.list().map((x) => ({ id: x.id, name: x.name })), p.message);
      return { playbook: 'device-safe-mode', subject: dev?.id ?? null };
    }
    if (p.source === 'mesh' && /making itself the hub/.test(p.message)) return { playbook: 'hub-failover', subject: null };
    if (p.source === 'connectors') {
      const c = byName(d.connectors.list().map((x) => ({ id: x.id, name: x.name })), p.message);
      if (c) return { playbook: LOOKUP.test(text) ? 'name-lookup' : 'connector-down', subject: c.id };
    }
    return null;
  });

  // A worker failed: check it again (a provider's probe starts its program or asks its address
  // anew), and once it is healthy, put back in the queue the work that was only waiting on it.
  pb.repair('recheck-worker', async (subject) => {
    if (!subject) return { ok: false, said: 'Nova doesn’t know which worker this was.' };
    const w = d.ledger.workers.get(subject);
    if (!w) return { ok: false, said: `The worker ${subject} isn’t there any more.` };
    let healthy = true;
    let words = '';
    if (d.providers.list().some((p) => p.id === subject)) {
      const v = await d.providers.check(subject);
      healthy = v.health.state === 'ready' || v.health.state === 'unchecked';
      words = v.health.words;
    } else {
      const h = w.health();
      healthy = h.ok;
      words = h.detail ?? '';
    }
    if (!healthy) return { ok: false, said: `${w.name} still isn’t healthy: ${words}` };
    const requeued = requeueWaiting(d.ledger, subject);
    // The problem stays open: a task that failed is the person's to retry or cancel.
    return { ok: true, said: `${w.name} answers again${words ? ` (${words.replace(/\.$/, '')})` : ''}.${requeued ? ` Put ${requeued} waiting task${requeued === 1 ? '' : 's'} back in the queue.` : ''} A failed task is yours to retry or cancel.` };
  });

  // The local model: the model manager's own check releases waiting work once it answers.
  pb.repair('recheck-models', async () => {
    const released = await d.models.check();
    for (const role of ['triage-text', 'reasoner', 'embedder'] as const) {
      if (!d.models.placement(role)) continue;
      const problem = await d.models.probe(role).catch((e: Error) => e.message);
      if (problem) return { ok: false, said: `Still not answering: ${problem}` };
    }
    return { ok: true, said: `The local model answers again.${released.length ? ` ${released.length} waiting task${released.length === 1 ? '' : 's'} can run now.` : ''}`, resolved: true };
  });

  // A connection: stop and start it, so it tries now instead of after its longest pause.
  pb.repair('reconnect', async (subject) => {
    if (!subject || !d.connectors.has(subject)) return { ok: false, said: 'That connection isn’t there any more.' };
    await d.connectors.restart(subject);
    const v = d.connectors.view(subject);
    if (v.broken) return { ok: false, said: `${v.name} needs connecting again: the service no longer accepts Nova.` };
    const up = v.connected && v.live !== 'reconnecting';
    return { ok: up, said: up ? `${v.name} is connected again.` : `${v.name} is still trying to reconnect.`, resolved: up };
  });

  // The standby: on the standby, copy now; on the hub, see whether it caught up.
  pb.repair('resync', async () => {
    if (d.role.role() === 'hub') {
      const lag = d.role.lag();
      const behind = lag?.behind ?? false;
      return { ok: !behind, said: behind ? 'The standby still hasn’t copied the newest changes; it copies again as soon as it reaches the hub.' : 'The standby has caught up.', resolved: !behind };
    }
    const ok = await d.role.resync();
    return { ok, said: ok ? 'Copied from the hub again; this standby is up to date.' : 'The hub still can’t be reached; this standby keeps trying.', resolved: ok };
  });

  // A computer in safe mode: its boot agent is asked, at its next heartbeat, to start the runtime
  // again (once per problem). If the runtime crashes three times again, it goes back to safe mode.
  pb.repair('restart-runtime', async (subject) => {
    if (!subject) return { ok: false, said: 'Nova doesn’t know which computer this was.' };
    const a = d.spokes.agent(subject);
    const name = d.devices.find(subject)?.name ?? 'that computer';
    if (a && !a.safe_mode) return { ok: true, said: `The runtime on ${name} is running again.`, resolved: true };
    const asked = d.spokes.restartRuntime(subject);
    return { ok: false, said: asked ? `Asked ${name}’s boot agent to start its runtime again; it does at its next heartbeat.` : `Waiting for ${name}’s boot agent to take the restart.` };
  });
}

// Tasks of this worker waiting only because it couldn't run (not for an OK, not held because it
// may already have happened) go back in the queue.
export function requeueWaiting(ledger: Ledger, owner: string): number {
  let n = 0;
  for (const t of ledger.list({ state: 'waiting', limit: 500 })) {
    if (t.owner !== owner || (t.approval_tier >= 2 && !t.approved_at)) continue;
    if (!t.reason || /^May already have happened/.test(t.reason) || !/^(Blocked|Waiting on local capacity)/.test(t.reason)) continue;
    try { ledger.retry(t.id, 'The worker answers again, so Nova put this back in the queue.'); n++; } catch { /* moved on meanwhile */ }
  }
  return n;
}
