// Which processes are whose, read from /proc (Linux). A process is named by its pid and its start
// time (clock ticks since boot, field 22 of /proc/<pid>/stat): a pid can be reused, the pair can't
// within one boot. A process group's number is the pid of the process that made it; Linux never
// hands that number out again while any member of the group is alive, so a group that still has a
// member is still the same group. Everywhere else these return null or nothing, and callers that
// would signal a process they can't identify don't.
import { readFileSync, readdirSync } from 'node:fs';

export interface ProcId { pid: number; start: number }
export interface ProcInfo extends ProcId { pgrp: number }

export const hasProc = (() => { try { readFileSync('/proc/self/stat', 'utf8'); return true; } catch { return false; } })();

// pid, process group and start time of one process, or null when it is gone (or there is no /proc).
export function stat(pid: number): ProcInfo | null {
  if (!hasProc || !Number.isInteger(pid) || pid <= 0) return null;
  let text: string;
  try { text = readFileSync(`/proc/${pid}/stat`, 'utf8'); } catch { return null; }
  // The command's name is in parentheses and may hold spaces: the fields start after the last ")".
  const rest = text.slice(text.lastIndexOf(')') + 2).split(' ');
  // rest[0] is field 3 (state), so field n is rest[n - 3].
  if (rest[0] === 'Z') return null;
  const pgrp = Number(rest[2]);
  const start = Number(rest[19]);
  return Number.isFinite(pgrp) && Number.isFinite(start) ? { pid, pgrp, start } : null;
}

// Every live process in the group `pgid`.
export function members(pgid: number): ProcInfo[] {
  if (!hasProc || !Number.isInteger(pgid) || pgid <= 1) return [];
  const out: ProcInfo[] = [];
  let names: string[];
  try { names = readdirSync('/proc'); } catch { return []; }
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue;
    const s = stat(Number(n));
    if (s && s.pgrp === pgid) out.push(s);
  }
  return out;
}

// This boot's id: start times mean nothing across a reboot.
export function bootId(): string | null {
  try { return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch { return null; }
}

// Whether `id` is still that very process (same pid, same start time).
export const same = (id: ProcId): boolean => stat(id.pid)?.start === id.start;
