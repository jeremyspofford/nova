// Every process Nova starts on its own behalf (a provider's or a tool's command in a process group
// of its own, a sandbox Nova, a browser), so that none outlives Nova when it restarts in place: an
// in-place restart keeps the pid (resilience/restart.ts), and a detached command would otherwise go
// on writing into a home that was just restored or wiped.
import type { ChildProcess } from 'node:child_process';

interface Tracked { child: ChildProcess; group: boolean; exited: Promise<void> }
const live = new Set<Tracked>();

// `group`: it was started detached, as the leader of a process group; the whole group is ended.
export function trackChild<T extends ChildProcess>(child: T, o: { group?: boolean } = {}): T {
  if (!child.pid) return child;
  let done!: () => void;
  const t: Tracked = { child, group: o.group === true, exited: new Promise<void>((r) => { done = r; }) };
  live.add(t);
  child.once('exit', () => { live.delete(t); done(); });
  child.once('error', () => { live.delete(t); done(); });
  return child;
}

const signal = (t: Tracked, s: NodeJS.Signals) => {
  try { if (t.group) process.kill(-t.child.pid!, s); else t.child.kill(s); } catch { /* already gone */ }
};

// Ends every process Nova started: asked to stop (SIGTERM), then, after `graceMs` at most, made to
// (SIGKILL), whole process groups included. Resolves once they are gone or the bound has passed.
export async function stopChildren(graceMs = 3000): Promise<number> {
  const all = [...live];
  for (const t of all) signal(t, 'SIGTERM');
  let timer: ReturnType<typeof setTimeout> | null = null;
  await Promise.race([Promise.all(all.map((t) => t.exited)), new Promise<void>((r) => { timer = setTimeout(r, graceMs); })]);
  if (timer) clearTimeout(timer);
  // What a group leader left behind goes too, whether or not the leader has exited.
  for (const t of all) signal(t, 'SIGKILL');
  return all.length;
}
