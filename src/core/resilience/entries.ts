// Nova's own entries at the top of its home, by name (M7 amendment). Checkpoints copy only these,
// a restore swaps only these, and a factory reset wipes only these: anything else in the folder
// isn't Nova's (the owner's preview home holds a script of their own) and is never copied, moved,
// undone or deleted.
//
// Derived from the code, every place that writes under the home (2026-10-30), not from memory:
//  - nova.db (+ -wal, -shm, -journal)        core/index.ts, db.ts (SQLite's own side files)
//  - AGENTS.md SOUL.md IDENTITY.md USER.md    home.js seedHome (templates/home), changes/sandbox.ts
//  - MEMORY.md, memory/                       memory.js (Era 2's render, day notes, .rendered.json)
//  - sessions/                                sessions.js
//  - schedules/                               schedules.js (runs.jsonl)
//  - skills/                                  skills.js
//  - permissions.md                           permissions.js, server.js
//  - connectors/                              connectors/gmail.js (Era 2's connection files)
//  - workspace/                               core/index.ts, tools.js, providers/taskspace.ts
//  - extensions/                              extensions.ts, changes/pipeline.ts
//  - changes/                                 changes/pipeline.ts (released changes)
//  - vault/                                   vault.ts
//  - mesh/                                    mesh/identity.ts, mesh/replica.ts (role.json), mesh/promote.ts
//  - logs/                                    core/index.ts (log.ts)
//  - workers/                                 core/index.ts, browser/evidence.ts, providers/registry.ts, changes/*
//  - kept/                                    extensions.ts, resilience/backup.ts (owed forgets)
//  - exports/                                 extensions.ts, memory.ts
//  - backups/                                 core/index.ts (pre-upgrade copies)
//  - checkpoints/                             resilience/checkpoints.ts
//  - nova.pid                                 server.js, home.js
//  - .git, .gitignore                         home.js (the home's history)
//  - factory-reset.json, reset-report.json    resilience/reset.ts (a reset staged, and its result)
// Capture keeps everything in the database: it has no folder of its own. The standby's sync writes
// only paths the hub journalled, and its temporary files (<name>.nova-sync-<pid>.tmp) are Nova's
// when <name> is.
import { readdirSync } from 'node:fs';

export const NOVA_ENTRIES: readonly string[] = [
  'nova.db', 'nova.db-wal', 'nova.db-shm', 'nova.db-journal',
  'AGENTS.md', 'SOUL.md', 'IDENTITY.md', 'USER.md',
  'MEMORY.md', 'memory', 'sessions', 'schedules', 'skills', 'permissions.md', 'connectors',
  'workspace', 'extensions', 'changes', 'vault', 'mesh',
  'logs', 'workers', 'kept', 'exports', 'backups', 'checkpoints', 'nova.pid',
  '.git', '.gitignore',
  'factory-reset.json', 'reset-report.json',
];

const OWN = new Set(NOVA_ENTRIES);
const SYNC_TMP = /^(.+)\.nova-sync-\d+\.tmp$/;

// Whether a top-level name in a home is one of Nova's own.
export function isNovaEntry(name: string): boolean {
  if (OWN.has(name)) return true;
  const m = SYNC_TMP.exec(name);
  return !!m && OWN.has(m[1]!);
}

// The top-level entries of a home that aren't Nova's, sorted: left exactly as they are.
// Nova's mark on its home (home-mark.ts) is neither: it stays, and is never copied or swapped.
export function foreignEntries(home: string): string[] {
  let names: string[] = [];
  try { names = readdirSync(home); } catch { return []; }
  return names.filter((n) => !isNovaEntry(n) && n !== '.nova-home' && n !== '.nova-home.tmp').sort();
}
