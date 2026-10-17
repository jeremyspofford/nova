// Shared setup for the computers and egress tests: a migrated database with an account, an
// agent and its thread, and a stand-in sandbox that runs commands with the host's shell (it
// records every request; the real substrates have their own tests).
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import {
  ProcessSandbox,
  type LaunchPlan,
  type SandboxExecRequest,
} from '../src/tools/sandbox-process.ts';

export const ACCOUNT = '01920000-0000-7000-8000-0000000000c1';
export const OTHER = '01920000-0000-7000-8000-0000000000c2';
export const AGENT = '01920000-0000-7000-8000-0000000000a1';
export const AGENT_THREAD = '01920000-0000-7000-8000-0000000000d1';
export const PLAIN_THREAD = '01920000-0000-7000-8000-0000000000d2';

export async function computersDb(): Promise<NovaDatabase> {
  const db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const now = new Date().toISOString();
  for (const id of [ACCOUNT, OTHER])
    db.raw
      .prepare(
        "INSERT INTO account (id, kind, display_name, created_at, updated_at) VALUES (?, 'local', 'Owner', ?, ?)",
      )
      .run(id, now, now);
  for (const [id, mode] of [
    [AGENT_THREAD, 'agent'],
    [PLAIN_THREAD, 'chat'],
  ] as const)
    db.raw
      .prepare(
        'INSERT INTO thread (id, account_id, mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, ACCOUNT, mode, now, now);
  db.raw
    .prepare(
      `INSERT INTO agent (id, account_id, name, time_budget_s, token_budget, created_at, updated_at)
       VALUES (?, ?, 'Researcher', 3600, 100000, ?, ?)`,
    )
    .run(AGENT, ACCOUNT, now, now);
  db.raw
    .prepare(
      "INSERT INTO agent_thread (thread_id, agent_id, account_id, kind, created_at) VALUES (?, ?, ?, 'main', ?)",
    )
    .run(AGENT_THREAD, AGENT, ACCOUNT, now);
  return db;
}

/** Runs commands with the host shell in their cwd; records requests. Not a sandbox. */
export class HostShellSandbox extends ProcessSandbox {
  readonly substrate = 'container' as const;
  readonly requests: SandboxExecRequest[] = [];
  up = true;
  available() {
    return Promise.resolve(
      this.up ? { ok: true, detail: 'host shell (test)' } : { ok: false, detail: 'engine down' },
    );
  }
  protected plan(req: SandboxExecRequest): Promise<LaunchPlan> {
    this.requests.push(req);
    const env = Object.entries(req.env ?? {})
      .map(([k, v]) => `${k}='${v.replace(/'/g, `'\\''`)}'`)
      .join(' ');
    return Promise.resolve({
      bin: 'sh',
      args: ['-c', `cd "$1" && exec env ${env} sh -c "$2"`, 'x', req.cwd, req.cmd],
    });
  }
}
