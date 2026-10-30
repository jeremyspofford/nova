// Shared by the chaos pass (M7 plan §3): waiting for a task to settle, and for a problem with a
// given playbook, checked the same way in every scenario: it is in plain words (no stack, no
// code-speak in the message), it has steps for the person, and what Nova repaired is recorded.
import assert from 'node:assert/strict';
import type { Core } from '../../src/core/index.ts';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function until<T>(read: () => T | Promise<T>, ok: (v: T) => boolean, ms = 15_000, what = 'a condition'): Promise<T> {
  const end = Date.now() + ms;
  let v = await read();
  while (!ok(v)) {
    if (Date.now() > end) assert.fail(`Timed out waiting for ${what}: ${JSON.stringify(v)?.slice(0, 600)}`);
    await sleep(25);
    v = await read();
  }
  return v;
}

export async function settle(core: Core, id: string, done = (s: string) => ['done', 'failed', 'cancelled', 'waiting'].includes(s), ms = 30_000) {
  return until(async () => { await core.ledger.idle(); return core.ledger.get(id); }, (t) => done(t.state), ms, `task ${id} to settle`);
}

export type Opened = ReturnType<Core['resilience']['playbooks']['list']>[number];

// The open problem that follows `playbook` (and, if given, is about `subject`), checked for plain
// words and steps.
export async function problemWith(core: Core, playbook: string, o: { subject?: string | null; ms?: number } = {}): Promise<Opened> {
  const p = await until(() => core.resilience.playbooks.list().find((x) => x.playbook?.id === playbook && (o.subject === undefined || x.playbook.subject === o.subject)), (x) => !!x, o.ms ?? 15_000, `a problem with the ${playbook} playbook`);
  plain(p!.message);
  assert.ok(p!.playbook!.steps.length >= 1, 'the playbook has steps for the person');
  return p!;
}

// A message a person reads: sentences, not a stack trace or an error class.
export function plain(message: string): void {
  assert.ok(message.length > 10 && message.length < 800, `a short message: ${message}`);
  assert.doesNotMatch(message, /\n\s+at |Error:|TypeError|ECONN|ENOENT|undefined|\[object/, `plain words: ${message}`);
}

// The repairs Nova made by itself on that problem, once it has made `n`.
export async function repairs(core: Core, id: number, n = 1, ms = 15_000) {
  return until(() => core.resilience.playbooks.view(id)?.repairs ?? [], (r) => r.length >= n, ms, `${n} repair(s) on problem ${id}`);
}
