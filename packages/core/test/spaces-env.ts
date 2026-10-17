// Test environment for the spaces area (FR-036, FR-037, FR-076): a migrated in-memory database
// with an account, a simulated clock, collected events and audit records, and the services.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import type { SpaceAgentEdits } from '@nova/shared';
import {
  ArtifactService,
  MemoryEventSink,
  SiteService,
  SpaceService,
  type AuditRecord,
} from '../src/index.ts';

export const ACCOUNT = '01920000-0000-7000-8000-0000000000a1';
export const OTHER = '01920000-0000-7000-8000-0000000000a2';

/** The spaces tables come from migration 0026_spaces.sql. */
export async function spacesDb(): Promise<NovaDatabase> {
  const db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const now = new Date().toISOString();
  for (const id of [ACCOUNT, OTHER])
    db.raw
      .prepare(
        "INSERT OR IGNORE INTO account (id, kind, display_name, created_at, updated_at) VALUES (?, 'local', 'Owner', ?, ?)",
      )
      .run(id, now, now);
  return db;
}

export class Clock {
  t = Date.parse('2026-10-17T09:00:00.000Z');
  now = () => new Date(this.t);
  tick(ms = 1000) {
    this.t += ms;
  }
}

export interface SpacesEnv {
  db: NovaDatabase;
  dir: string;
  dataDir: string;
  events: MemoryEventSink;
  audit: AuditRecord[];
  clock: Clock;
  spaces: SpaceService;
  sites: SiteService;
  artifacts: ArtifactService;
  publishRoot: { value: string | null };
  defaultEdits: { value: SpaceAgentEdits };
  close: () => void;
}

export async function spacesEnv(): Promise<SpacesEnv> {
  const db = await spacesDb();
  const dir = mkdtempSync(join(tmpdir(), 'nova-spaces-'));
  const dataDir = join(dir, 'data');
  const events = new MemoryEventSink();
  const audit: AuditRecord[] = [];
  const clock = new Clock();
  const publishRoot = { value: null as string | null };
  const defaultEdits = { value: 'propose' as SpaceAgentEdits };
  const sink = { append: (r: AuditRecord) => Promise.resolve(void audit.push(r)) };
  const spaces = new SpaceService({
    db,
    events,
    audit: sink,
    now: clock.now,
    defaultAgentEdits: () => Promise.resolve(defaultEdits.value),
  });
  const artifacts = new ArtifactService({ db, events, dataDir, now: clock.now });
  const sites = new SiteService({
    db,
    events,
    dataDir,
    spaces,
    artifacts,
    audit: sink,
    now: clock.now,
    publishRoot: () => Promise.resolve(publishRoot.value),
  });
  return {
    db,
    dir,
    dataDir,
    events,
    audit,
    clock,
    spaces,
    sites,
    artifacts,
    publishRoot,
    defaultEdits,
    close: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
