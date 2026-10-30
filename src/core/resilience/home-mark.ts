// Nova's mark on its home (M7 amendment review): `.nova-home`, holding the home's id and the key
// that seals a factory reset's marker. A factory reset erases only a folder that carries it, and
// never a folder that is the computer's root, the person's own home folder, or one that contains
// it, whatever it carries.
//
// Nova writes the mark when it sets up a home: a new folder, or one whose nova.db has Nova's
// schema (homes from before the mark get it at their next start). It is never in a backup, a
// checkpoint, an export or the standby's copy, and the agent's file tools can't read or write it.
// A factory reset leaves it in place (the folder stays Nova's home) and gives it a new key.
//
// Why a key in the home is enough: what can write the home is either the person's own programs,
// which can already delete anything there, or Nova, whose agent writes only its workspace and
// standing files (src/tools.js). The seal stops a marker Nova didn't write (copied, planted by a
// file write, or damaged) from ever being acted on, and it survives a crash, so a reset stopped
// part way still finishes.
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const HOME_MARK = '.nova-home';

export interface HomeMark { v: 1; id: string; created_at: string; seal: string }

const realOf = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
const within = (path: string, root: string) => {
  const r = relative(root, path);
  return r === '' || (!r.startsWith(`..${sep}`) && r !== '..' && !isAbsolute(r));
};

// Why this folder can never be erased as Nova's home, or null.
export function unsafeHome(home: string, o: { userHome?: string } = {}): string | null {
  const real = realOf(home);
  const mine = realOf(o.userHome ?? homedir());
  if (real === resolve('/')) return `${real} is the computer’s root folder, not a folder only Nova uses`;
  if (real === mine) return `${real} is your own home folder, not a folder only Nova uses`;
  if (within(mine, real)) return `${real} contains your own home folder, so it isn’t a folder only Nova uses`;
  return null;
}

export function readMark(home: string): HomeMark | null {
  try {
    const m = JSON.parse(readFileSync(join(home, HOME_MARK), 'utf8')) as HomeMark;
    return m?.v === 1 && typeof m.id === 'string' && typeof m.seal === 'string' && Buffer.from(m.seal, 'base64').length === 32 ? m : null;
  } catch {
    return null;
  }
}

function write(home: string, m: HomeMark): void {
  const file = join(home, HOME_MARK);
  writeFileSync(`${file}.tmp`, `${JSON.stringify(m, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

// Whether a database file is Nova's (it has Nova's migrations table).
function novaSchema(db: string): boolean {
  let d: DatabaseSync | null = null;
  try {
    d = new DatabaseSync(db, { readOnly: true });
    return !!d.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
  } catch {
    return false;
  } finally {
    d?.close();
  }
}

// The home's mark, written now when the folder is clearly Nova's: new, or holding Nova's database.
// Null for a folder that can never be Nova's home alone (unsafeHome) or that holds another database.
export function ensureMark(home: string, o: { now?: () => Date; userHome?: string } = {}): HomeMark | null {
  const have = readMark(home);
  if (have) return have;
  if (unsafeHome(home, o)) return null;
  const db = join(home, 'nova.db');
  if (existsSync(db) && !novaSchema(db)) return null;
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const m: HomeMark = { v: 1, id: randomUUID(), created_at: (o.now?.() ?? new Date()).toISOString(), seal: randomBytes(32).toString('base64') };
  write(home, m);
  return m;
}

// A new key, same id: after a reset, nothing sealed before opens again.
export function rekeyMark(home: string): void {
  const m = readMark(home);
  if (m) write(home, { ...m, seal: randomBytes(32).toString('base64') });
}

export function sealWith(mark: HomeMark, text: string): string {
  return createHmac('sha256', Buffer.from(mark.seal, 'base64')).update(text).digest('hex');
}

export function sealOk(mark: HomeMark, text: string, seal: unknown): boolean {
  if (typeof seal !== 'string' || !/^[0-9a-f]{64}$/.test(seal)) return false;
  return timingSafeEqual(Buffer.from(seal, 'hex'), Buffer.from(sealWith(mark, text), 'hex'));
}
