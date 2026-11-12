// Which playbook fits the problems other modules open in their own words, and the repairs that
// need those modules: checking a worker again and requeueing work that was only waiting on it,
// reconnecting a connection, letting the standby copy again, asking a computer's boot agent to
// start its runtime again. Each is safe: none deletes or changes the person's data, and none
// runs work again that may already have had an outside effect (the ledger's own rule decides).
// And the independent checks that close those problems: never the repair's own word (owner,
// 2026-11-11), but the detector's re-read of what went wrong (the model's probe, the connection's
// own state, the standby's copying, the computer's heartbeat).
import { lookup as dnsLookup } from 'node:dns/promises';
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
    return { ok: true, said: `The local model answers again.${released.length ? ` ${released.length} waiting task${released.length === 1 ? '' : 's'} can run now.` : ''}` };
  });
  // Its check: the model manager's own probe of every role placed on a local model, run by the
  // heartbeat, not by the repair.
  pb.check('local-model-down', 'Nova’s own probe of the local model gets an answer', async () => {
    let placed = 0;
    for (const role of ['triage-text', 'reasoner', 'embedder'] as const) {
      if (!d.models.placement(role)) continue;
      placed++;
      const problem = await d.models.probe(role).catch((e: Error) => e.message);
      if (problem) return { holds: false, said: `The local model still isn’t answering: ${problem}` };
    }
    return { holds: true, said: placed ? 'Nova’s own probe got an answer from the local model.' : 'No work is placed on a local model any more.' };
  });

  // A connection: stop and start it, so it tries now instead of after its longest pause.
  pb.repair('reconnect', async (subject) => {
    if (!subject || !d.connectors.has(subject)) return { ok: false, said: 'That connection isn’t there any more.' };
    await d.connectors.restart(subject);
    const v = d.connectors.view(subject);
    if (v.broken) return { ok: false, said: `${v.name} needs connecting again: the service no longer accepts Nova.` };
    const up = v.connected && v.live === 'listening';
    return { ok: up, said: up ? `${v.name} is connected again.` : `${v.name} is still trying to reconnect.` };
  });
  // Its check: the connection's own state, as the connection watch reads it (connectorWatch).
  const listening = (subject: string | null) => {
    if (!subject || !d.connectors.has(subject)) return { holds: false, said: 'That connection isn’t there any more.' };
    const v = d.connectors.view(subject);
    const up = v.connected && v.live === 'listening';
    return { holds: up, said: up ? `${v.name} is connected and listening again.` : `${v.name} isn’t listening yet.` };
  };
  pb.check('connector-down', 'Nova’s connection watch sees it connected and listening', listening);
  pb.check('name-lookup', 'Nova’s connection watch sees it connected and listening', listening);

  // The standby: on the standby, copy now; on the hub, see whether it caught up.
  pb.repair('resync', async () => {
    if (d.role.role() === 'hub') {
      const lag = d.role.lag();
      const behind = lag?.behind ?? false;
      return { ok: !behind, said: behind ? 'The standby still hasn’t copied the newest changes; it copies again as soon as it reaches the hub.' : 'The standby has caught up.' };
    }
    const ok = await d.role.resync();
    return { ok, said: ok ? 'Copied from the hub again; this standby is up to date.' : 'The hub still can’t be reached; this standby keeps trying.' };
  });
  // Its check. On the hub: the standby's acknowledgements, as the lag watch reads them. On the
  // standby: its own copying loop got through to the hub after the problem and after the last
  // repair (the repair's own copy doesn't count).
  pb.check('standby-behind', 'the standby is seen copying from the hub again', (_subject, p, after) => {
    if (d.role.role() === 'hub') {
      const lag = d.role.lag();
      return lag.behind ? { holds: false, said: `The standby still has ${lag.rows} change${lag.rows === 1 ? '' : 's'} to copy.` } : { holds: true, said: 'The hub sees the standby caught up.' };
    }
    const okAt = d.role.status().replica?.sync?.last_ok_at ?? null;
    const since = Math.max(Date.parse(p.at), after ? Date.parse(after) : 0);
    return okAt && Date.parse(okAt) > since ? { holds: true, said: 'This standby’s own copying reached the hub again.' } : { holds: false, said: 'This standby hasn’t copied from the hub since.' };
  });

  // A computer in safe mode: its boot agent is asked, at its next heartbeat, to start the runtime
  // again (once per problem). If the runtime crashes three times again, it goes back to safe mode.
  pb.repair('restart-runtime', async (subject) => {
    if (!subject) return { ok: false, said: 'Nova doesn’t know which computer this was.' };
    const a = d.spokes.agent(subject);
    const name = d.devices.find(subject)?.name ?? 'that computer';
    if (a && !a.safe_mode) return { ok: true, said: `The runtime on ${name} is running again.` };
    const asked = d.spokes.restartRuntime(subject);
    return { ok: false, said: asked ? `Asked ${name}’s boot agent to start its runtime again; it does at its next heartbeat.` : `Waiting for ${name}’s boot agent to take the restart.` };
  });
  // Its check: that computer's own heartbeat, which says whether it is in safe mode.
  pb.check('device-safe-mode', 'that computer’s own heartbeat says its runtime is running', (subject) => {
    if (!subject) return { holds: false, said: 'Nova doesn’t know which computer this was.' };
    const a = d.spokes.agent(subject);
    const name = d.devices.find(subject)?.name ?? 'That computer';
    if (!a) return { holds: false, said: `No heartbeat from ${name} yet.` };
    return a.safe_mode ? { holds: false, said: `${name}’s heartbeat still says it is in safe mode.` } : { holds: true, said: `${name}’s heartbeat says its runtime is running again.` };
  });
}

// Connections that keep failing to reconnect become a problem on the second look in a row (one
// failed reconnect is ordinary); when the service's name doesn't resolve, the problem says the
// name lookup is what fails. A connection listening again closes its problem through the check
// wireRepairs registers (the heartbeat's sweep), the one way such a problem closes by itself.
export function connectorWatch(pb: Playbooks, connectors: Connectors, lookup: (host: string) => Promise<unknown> = (h) => dnsLookup(h)): () => Promise<void> {
  const seen = new Map<string, number>();
  return async () => {
    for (const v of connectors.list()) {
      if (v.connected && v.live === 'listening') {
        seen.delete(v.id);
        continue;
      }
      if (!v.connected || v.live !== 'reconnecting') { seen.delete(v.id); continue; }
      const n = (seen.get(v.id) ?? 0) + 1;
      seen.set(v.id, n);
      if (n < 2) continue;
      const host = connectors.get(v.id).host?.() ?? null;
      const lookupFails = host ? await lookup(host).then(() => null, (e: NodeJS.ErrnoException) => (LOOKUP.test(`${e.code ?? ''} ${e.message}`) ? e.message : null)) : null;
      if (lookupFails) pb.open('connectors', `Nova can’t look up the name ${host}, where ${v.name} is, so it can’t reconnect. It keeps trying; nothing is sent anywhere else instead.`, 'name-lookup', { subject: v.id, detail: lookupFails });
      else pb.open('connectors', `${v.name} lost its connection and hasn’t come back yet. Nova keeps reconnecting.`, 'connector-down', { subject: v.id });
    }
  };
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
