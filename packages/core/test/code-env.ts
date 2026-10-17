// Test environment for Code sessions: a core Env, a Git repository inside a fake home folder,
// settings the tests can change, a recording audit sink and an optional fake sandbox that runs
// commands on the host (so a test can prove which path a commit took).
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SETTINGS, type PermissionMode, type SettingKey } from '@nova/shared';
import {
  CodeService,
  gitEnv,
  type AuditRecord,
  type ExecRequest,
  type ExecResult,
  type SandboxClient,
} from '../src/index.ts';
import { makeEnv, type Env, type EnvOptions } from './helpers.ts';

/** Runs commands on the host as if it were a container sandbox (tests only). */
export class HostSandbox implements SandboxClient {
  readonly substrate = 'container' as const;
  readonly reqs: ExecRequest[] = [];
  ok = true;
  hasGit = true;

  available() {
    return Promise.resolve({ ok: this.ok, detail: this.ok ? 'host' : 'down' });
  }
  exec(req: ExecRequest): Promise<ExecResult> {
    this.reqs.push(req);
    if (req.cmd.startsWith('command -v git'))
      return Promise.resolve({ status: 'exited', exitCode: this.hasGit ? 0 : 1, output: '' });
    return new Promise((resolve) => {
      const child = spawn('sh', ['-c', req.cmd], {
        cwd: req.cwd,
        env: { ...gitEnv({ cwd: req.cwd }), ...req.env },
      });
      let output = '';
      child.stdout.on('data', (b: Buffer) => (output += b.toString('utf8')));
      child.stderr.on('data', (b: Buffer) => (output += b.toString('utf8')));
      child.on('close', (code) => resolve({ status: 'exited', exitCode: code ?? 1, output }));
    });
  }
  poll(): Promise<ExecResult> {
    return Promise.reject(new Error('no sessions'));
  }
  write(): Promise<void> {
    return Promise.resolve();
  }
  killTurn(): Promise<void> {
    return Promise.resolve();
  }
}

export interface CodeEnv extends Env {
  svc: CodeService;
  home: string;
  repo: string;
  dataDir: string;
  audit: AuditRecord[];
  /** Settings the service reads (defaults otherwise). */
  values: Partial<Record<SettingKey, unknown>>;
  remembered: { folder: string; mode: PermissionMode }[];
  sandbox: { current: SandboxClient | null };
  git: (args: string[], cwd?: string) => string;
}

export interface CodeEnvOptions extends EnvOptions {
  sandbox?: SandboxClient | null;
  values?: Partial<Record<SettingKey, unknown>>;
}

export async function makeCodeEnv(opts: CodeEnvOptions = {}): Promise<CodeEnv> {
  const env = await makeEnv(opts);
  const home = join(env.dir, 'home');
  const repo = join(home, 'repo');
  mkdirSync(repo, { recursive: true });
  const git = (args: string[], cwd = repo) =>
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
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'user.email', 'test@example.invalid']);
  writeFileSync(
    join(repo, 'app.ts'),
    Array.from({ length: 30 }, (_, i) => `export const v${i + 1} = ${i + 1};`).join('\n') + '\n',
  );
  writeFileSync(join(repo, '.gitignore'), 'dist/\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'init']);
  const dataDir = join(env.dir, 'data');
  const audit: AuditRecord[] = [];
  const values: Partial<Record<SettingKey, unknown>> = { ...opts.values };
  const remembered: CodeEnv['remembered'] = [];
  const sandbox = { current: opts.sandbox === undefined ? null : opts.sandbox };
  const svc = new CodeService({
    db: env.db,
    events: env.events,
    audit: { append: (r) => Promise.resolve(void audit.push(r)) },
    threads: env.threads,
    router: env.router,
    dataDir,
    setting: ((key: SettingKey) =>
      Promise.resolve(key in values ? values[key] : SETTINGS[key].default)) as never,
    rememberMode: (_accountId, folder, mode) => {
      remembered.push({ folder, mode });
      const modes = { ...(values['code.folderModes'] as Record<string, string> | undefined) };
      modes[folder] = mode;
      values['code.folderModes'] = modes;
      return Promise.resolve();
    },
    sandbox: () => sandbox.current,
    home,
  });
  return {
    ...env,
    svc,
    home,
    repo,
    dataDir,
    audit,
    values,
    remembered,
    sandbox,
    git,
    close: async () => {
      await svc.close();
      await env.close();
    },
  };
}
