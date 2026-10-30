// Nova's own scratch folders (the drill's restored home, an encrypted copy opened to clean it, a
// release's sandbox and tests), and the one repair that deletes them when a disk fills. Each name
// carries the process that made it, so that repair can tell its own leftovers from folders another
// Nova process (or a test running beside it) is using right now: it deletes only folders this
// process made and has finished with, and folders whose process is gone. Never anyone else's.
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type ScratchKind = 'drill' | 'drill-open' | 'forget' | 'sandbox' | 'release-tests' | 'export';

const NAME = /^nova-(drill|drill-open|forget|sandbox|release-tests|export)-p(\d+)-[A-Za-z0-9]{6}$/;

// Made by this process and not yet given back.
const inUse = new Set<string>();

export function makeScratch(kind: ScratchKind, root = tmpdir()): string {
  const dir = mkdtempSync(join(root, `nova-${kind}-p${process.pid}-`));
  inUse.add(dir);
  return dir;
}

// Done with it: deleted now. If that fails (a full disk can make even this fail), it stays a
// leftover that freeScratch may delete later.
export function dropScratch(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } finally { inUse.delete(dir); }
}

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
};

// Deletes leftovers: this process's folders it no longer uses, and folders of processes that have
// stopped. A folder another running process made is never touched, whatever its name.
export function freeScratch(root = tmpdir()): { deleted: string[] } {
  const deleted: string[] = [];
  let names: string[] = [];
  try { names = readdirSync(root); } catch { return { deleted }; }
  for (const name of names) {
    const m = NAME.exec(name);
    if (!m) continue;
    const dir = join(root, name);
    const pid = Number(m[2]);
    const mine = pid === process.pid;
    if (mine ? inUse.has(dir) : alive(pid)) continue;
    try { rmSync(dir, { recursive: true, force: true }); deleted.push(dir); } catch { /* still held open: left */ }
  }
  return { deleted };
}

export const scratchInUse = (): string[] => [...inUse];
