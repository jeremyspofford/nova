// Test environment for the M7 Code additions: the M6 environment plus handoffs, merges, attempts
// and delegations, an SSH environment whose helper (the M6 test double) runs on this machine in a
// fake remote home, and a `cloud` environment reached through a stand-in transport (the cloudrun
// area implements the real one).
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { SETTINGS, uuidv7, type SettingKey } from '@nova/shared';
import {
  AttemptService,
  CodeDelegations,
  HandoffService,
  LocalTransport,
  MergeService,
  gitEnv,
} from '../src/index.ts';
import { ACCOUNT } from './helpers.ts';
import { makeCodeM6Env, type CodeM6Env, type CodeM6EnvOptions } from './code-m6-env.ts';

export interface CodeM7Env extends CodeM6Env {
  handoffs: HandoffService;
  merges: MergeService;
  attempts: AttemptService;
  delegations: CodeDelegations;
  /** A saved SSH environment whose helper runs here. */
  sshEnv: () => Promise<string>;
  /** A `cloud` environment reached through a LocalTransport. */
  cloudEnv: () => string;
  /** Run Git as the test user. */
  gitIn: (cwd: string, args: string[]) => string;
  /** A bare repository the test repository pushed `main` to (`origin`). */
  origin: string;
  /** A clone of origin (another machine's checkout). */
  clone: (name: string) => string;
}

export async function makeCodeM7Env(opts: CodeM6EnvOptions = {}): Promise<CodeM7Env> {
  const e = await makeCodeM6Env(opts);
  const gitIn = (cwd: string, args: string[]) =>
    execFileSync('git', args, {
      cwd,
      env: {
        ...gitEnv({ cwd }),
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@example.invalid',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@example.invalid',
      },
      encoding: 'utf8',
    });
  const origin = join(e.dir, 'origin.git');
  gitIn(e.dir, ['init', '-q', '--bare', '-b', 'main', origin]);
  e.git(['remote', 'add', 'origin', origin]);
  e.git(['push', '-q', 'origin', 'main']);
  e.git(['fetch', '-q', 'origin']);
  const merges = new MergeService({
    db: e.db,
    code: e.svc,
    events: e.events,
    audit: { append: (r) => Promise.resolve(void e.audit.push(r)) },
    dataDir: e.dataDir,
  });
  e.svc.useCommitGuard(merges.commitGuard);
  const auditSink = {
    append: (r: (typeof e.audit)[number]) => Promise.resolve(void e.audit.push(r)),
  };
  const read = ((key: SettingKey) =>
    Promise.resolve(key in e.values ? e.values[key] : SETTINGS[key].default)) as never;
  const handoffs = new HandoffService({
    db: e.db,
    code: e.svc,
    threads: e.threads,
    events: e.events,
    audit: auditSink,
    dataDir: e.dataDir,
    setting: read,
    turnWaitMs: 2_000,
    pollMs: 20,
  });
  const attempts = new AttemptService({
    db: e.db,
    code: e.svc,
    merges,
    verifier: e.verifier,
    audit: auditSink,
    setting: read,
  });
  const delegations = new CodeDelegations({
    db: e.db,
    code: e.svc,
    audit: auditSink,
    setting: read,
  });
  const cloudState = join(e.dir, 'cloud-state');
  e.svc.useEnvironmentTransport('cloud', () =>
    Promise.resolve(new LocalTransport({ label: 'the cloud runner', stateDir: cloudState })),
  );
  return {
    ...e,
    handoffs,
    merges,
    attempts,
    delegations,
    gitIn,
    origin,
    clone: (name) => {
      const dir = join(e.dir, name);
      gitIn(e.dir, ['clone', '-q', origin, dir]);
      gitIn(dir, ['config', 'user.name', 'Test']);
      gitIn(dir, ['config', 'user.email', 'test@example.invalid']);
      return dir;
    },
    sshEnv: async () =>
      (
        await e.svc.envs.create(ACCOUNT, {
          kind: 'ssh',
          label: 'build box',
          connection: { host: 'build.example', port: 22, user: 'dev', auth: 'key' },
          credential: { privateKey: 'PRIVATE KEY' },
        })
      ).id,
    cloudEnv: () => {
      const id = uuidv7();
      const now = new Date().toISOString();
      mkdirSync(cloudState, { recursive: true });
      e.db.raw
        .prepare(
          `INSERT INTO environment (id, account_id, kind, label, config_json, status, created_at,
             updated_at) VALUES (?, ?, 'cloud', 'cloud runner', '{}', 'ok', ?, ?)`,
        )
        .run(id, ACCOUNT, now, now);
      return id;
    },
    close: async () => {
      await handoffs.close();
      await attempts.close();
      await delegations.close();
      await e.close();
    },
  };
}
