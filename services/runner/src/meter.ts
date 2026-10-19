// Resource metering (FR-108, FR-116; docs/13 §3: metering and a hard stop at the cap). CPU time of
// a running bubblewrap sandbox is the sum over its process tree in /proc (user and system time of
// every live process, plus what the ones that ended left to their parents); when a command ends,
// its sandbox shell's `times` report gives the final figure, and the larger of the two counts.
// Disk use is the size on disk of an environment's folders, walked without following links.
import { readFile, readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';

/** Clock ticks per second for /proc times (USER_HZ is 100 on every Linux the runner supports). */
export const CLOCK_TICKS = 100;

interface ProcEntry {
  ppid: number;
  /** utime + stime + cutime + cstime, in ticks. */
  ticks: number;
}

/** Parse one /proc/<pid>/stat line. */
export function parseProcStat(text: string): ProcEntry | null {
  const close = text.lastIndexOf(')');
  if (close < 0) return null;
  const f = text
    .slice(close + 2)
    .trim()
    .split(/\s+/);
  // After the command name: state(0) ppid(1) ... utime(11) stime(12) cutime(13) cstime(14).
  const n = (i: number) => Number(f[i] ?? NaN);
  const ppid = n(1);
  const ticks = n(11) + n(12) + n(13) + n(14);
  if (!Number.isFinite(ppid) || !Number.isFinite(ticks)) return null;
  return { ppid, ticks };
}

/** One pass over /proc: every process with its parent and CPU ticks. */
export async function scanProcesses(procDir = '/proc'): Promise<Map<number, ProcEntry>> {
  const out = new Map<number, ProcEntry>();
  let names: string[];
  try {
    names = await readdir(procDir);
  } catch {
    return out;
  }
  await Promise.all(
    names
      .filter((n) => /^\d+$/.test(n))
      .map(async (n) => {
        try {
          const e = parseProcStat(await readFile(join(procDir, n, 'stat'), 'utf8'));
          if (e) out.set(Number(n), e);
        } catch {
          // The process ended while we looked.
        }
      }),
  );
  return out;
}

/** Every pid in the tree under `root` (root included). */
export function treeOf(procs: Map<number, ProcEntry>, root: number): number[] {
  const children = new Map<number, number[]>();
  for (const [pid, e] of procs) {
    const list = children.get(e.ppid) ?? [];
    list.push(pid);
    children.set(e.ppid, list);
  }
  const out: number[] = [];
  const stack = procs.has(root) ? [root] : [];
  const seen = new Set<number>();
  while (stack.length) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    out.push(pid);
    for (const c of children.get(pid) ?? []) stack.push(c);
  }
  return out;
}

/** CPU seconds used by the tree under `root` so far (0 when it is gone). */
export function treeCpuSeconds(procs: Map<number, ProcEntry>, root: number): number {
  let ticks = 0;
  for (const pid of treeOf(procs, root)) ticks += procs.get(pid)?.ticks ?? 0;
  return ticks / CLOCK_TICKS;
}

/** The CPU seconds in a shell's `times` output (its own line and its children's). */
export function parseTimes(text: string): number | null {
  let total = 0;
  let found = 0;
  for (const m of text.matchAll(/(\d+)m(\d+(?:[.,]\d+)?)s/g)) {
    total += Number(m[1]) * 60 + Number(m[2]!.replace(',', '.'));
    found++;
  }
  return found ? total : null;
}

/** Signal every process of a tree (interrupts reach the processes inside a sandbox). */
export async function signalTree(root: number, signal: NodeJS.Signals): Promise<number> {
  const procs = await scanProcesses();
  let n = 0;
  for (const pid of treeOf(procs, root).reverse()) {
    try {
      process.kill(pid, signal);
      n++;
    } catch {
      // Gone or not ours.
    }
  }
  return n;
}

export interface DiskUsage {
  bytes: number;
  entries: number;
  /** The walk stopped at the entry limit; `bytes` is a lower bound. */
  partial: boolean;
}

/** Bytes on disk under the given folders (links are counted, never followed). */
export async function diskUsage(dirs: string[], maxEntries = 500_000): Promise<DiskUsage> {
  let bytes = 0;
  let entries = 0;
  const stack = [...dirs];
  while (stack.length) {
    const dir = stack.pop()!;
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (++entries > maxEntries) return { bytes, entries, partial: true };
      const p = join(dir, name);
      try {
        const st = await lstat(p);
        bytes += st.blocks ? st.blocks * 512 : st.size;
        if (st.isDirectory()) stack.push(p);
      } catch {
        // Removed while walking.
      }
    }
  }
  return { bytes, entries, partial: false };
}
