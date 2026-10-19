// Shared setup of the team area's tests: the fully wired Hub (buildHub, whose app.ts sets up the
// team area, its chat seam and its agents), and helpers to sign people in.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FetchLike } from '@nova/core';
import { MemorySecretStore } from '@nova/secrets';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger, MemorySink } from '@nova/telemetry';
import { SESSION_COOKIE, buildHub, type Hub } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import type { TeamArea, TeamDeps } from '../src/team.ts';

export const HOST = { host: '127.0.0.1:7419' };

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped wire JSON read by tests
export type WireJson = Record<string, any>;

export interface TeamHub {
  dir: string;
  db: NovaDatabase;
  hub: Hub;
  area: TeamArea;
  secrets: MemorySecretStore;
  owner: { accountId: string; headers: Record<string, string> };
  /** Invite and join a member; returns their id and auth headers. */
  join(name: string): Promise<{ accountId: string; headers: Record<string, string> }>;
  put(key: string, value: unknown): void;
  close(): Promise<void>;
}

export function cookieOf(res: { cookies: { name: string; value: string }[] }): string | null {
  return res.cookies.find((c) => c.name === SESSION_COOKIE)?.value ?? null;
}

export async function makeTeamHub(
  over: Pick<TeamDeps, 'fetch' | 'now' | 'limits'> = {},
): Promise<TeamHub> {
  const dir = mkdtempSync(join(tmpdir(), 'nova-hub-team-'));
  const config = loadConfig(
    { NOVA_DATA_DIR: join(dir, 'data'), NOVA_WEB_DIR: join(dir, 'noweb') },
    [],
  );
  const db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const secrets = new MemorySecretStore();
  const log = new Logger({ module: 'hub', sinks: [new MemorySink()] });
  const hub = await buildHub({
    config,
    db,
    log,
    secrets,
    chat: { deltaIntervalMs: 0, flushIntervalMs: 20 },
    team: over,
  });
  const area = hub.team;

  const code = await hub.auth.issueSetupCode();
  const res = await hub.app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    headers: HOST,
    payload: { code, displayName: 'Owner' },
  });
  const ownerId = res.json<{ accountId: string }>().accountId;
  const owner = {
    accountId: ownerId,
    headers: { ...HOST, authorization: `Bearer ${cookieOf(res)!}` },
  };

  const joinMember = async (name: string) => {
    const inv = await hub.app.inject({
      method: 'POST',
      url: '/api/v1/team/invitations',
      headers: owner.headers,
      payload: {},
    });
    const token = inv.json<{ token: string }>().token;
    const joined = await hub.app.inject({
      method: 'POST',
      url: '/api/v1/team/join',
      headers: HOST,
      payload: { token, displayName: name },
    });
    if (joined.statusCode !== 201) throw new Error(`join failed: ${joined.body}`);
    return {
      accountId: joined.json<{ accountId: string }>().accountId,
      headers: { ...HOST, authorization: `Bearer ${cookieOf(joined)!}` },
    };
  };

  const put = (key: string, value: unknown) => {
    db.raw
      .prepare("DELETE FROM setting WHERE key = ? AND scope_kind = 'global' AND scope_ref = ''")
      .run(key);
    db.raw
      .prepare(
        "INSERT INTO setting (key, scope_kind, scope_ref, value_json, updated_at) VALUES (?, 'global', '', ?, ?)",
      )
      .run(key, JSON.stringify(value), new Date().toISOString());
  };

  return {
    dir,
    db,
    hub,
    area,
    secrets,
    owner,
    join: joinMember,
    put,
    close: async () => {
      await hub.app.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export type { FetchLike };
