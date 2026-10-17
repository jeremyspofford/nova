// Git hosts, pushes and pull requests (FR-070, docs/10 §8) against the mock Git host: the token
// stays in the keychain, pushes refuse protected and default branches without the user's typed
// confirmation (never for the agent), never force-push them, scan the pushed commits for secrets
// and run the pre-push hook only in the sandbox; a pull request shows its link and CI status, and
// a CI failure goes back to the agent once per pushed head as a turn without authority.
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isNovaError } from '@nova/shared';
import { ciStatusOf, gitHostTokenRef, parseRemote } from '../src/index.ts';
import { ACCOUNT } from './helpers.ts';
import { makeCodeM6Env, type CodeM6Env } from './code-m6-env.ts';
import { startMockGitHost, type MockGitHost } from './fixtures/githost/server.ts';

let e: CodeM6Env;
let host: MockGitHost;
let bare: string;
let clock: Date;

beforeEach(async () => {
  clock = new Date('2026-10-17T10:00:00.000Z');
  e = await makeCodeM6Env({ now: () => clock });
  host = await startMockGitHost();
  bare = join(e.dir, 'origin.git');
  e.git(['init', '-q', '--bare', '-b', 'main', bare], e.dir);
  e.git(['remote', 'add', 'origin', bare]);
  e.git(['push', '-q', 'origin', 'main']);
  host.repo('acme/app').bare = bare;
});
afterEach(async () => {
  await host.close();
  await e.close();
});

async function failure(p: Promise<unknown>) {
  try {
    await p;
  } catch (err) {
    if (isNovaError(err)) return { code: err.code, details: err.details ?? {} };
    throw err;
  }
  throw new Error('expected a failure');
}

async function connect() {
  return e.hosts.create(ACCOUNT, {
    kind: 'github',
    apiUrl: host.url,
    webUrl: 'https://github.example',
    token: host.token,
  });
}

function bareHas(branch: string): boolean {
  try {
    e.git(['rev-parse', '-q', '--verify', `refs/heads/${branch}`], bare);
    return true;
  } catch {
    return false;
  }
}

/** A session on a new branch with one commit. */
async function sessionOnBranch(branch = 'nova/feature') {
  e.git(['checkout', '-q', '-b', branch]);
  writeFileSync(join(e.repo, 'feature.ts'), 'export const feature = true;\n');
  e.git(['add', '-A']);
  e.git(['commit', '-q', '-m', 'feature']);
  return e.svc.create(ACCOUNT, { folder: e.repo, title: 'feature' });
}

describe('Git hosts', () => {
  it('keeps the token in the keychain, checks it, and refuses a rejected one', async () => {
    const h = await connect();
    expect(h).toMatchObject({ kind: 'github', login: 'nova-tester', status: 'ok' });
    expect(JSON.stringify(h)).not.toContain(host.token);
    expect(await e.secrets.get(gitHostTokenRef(h.id))).toBe(host.token);
    expect(host.requests[0]).toMatchObject({ path: '/user', auth: `Bearer ${host.token}` });
    const dup = await failure(connect());
    expect(dup.details.reason).toBe('duplicate');
    const bad = await failure(
      e.hosts.create(ACCOUNT, {
        kind: 'github',
        apiUrl: host.url,
        webUrl: 'https://other.example',
        token: 'wrong-token-value',
      }),
    );
    expect(bad.details.reason).toBe('token_rejected');
    expect(e.hosts.list(ACCOUNT)).toHaveLength(1);
    // An unreachable host is saved with its error (offline setup works).
    const offline = await e.hosts.create(ACCOUNT, {
      kind: 'github',
      apiUrl: 'http://127.0.0.1:9',
      webUrl: 'https://offline.example',
      token: 'another-fake-token',
    });
    expect(offline.status).toBe('error');
    await e.hosts.remove(ACCOUNT, offline.id);
    expect(await e.secrets.get(gitHostTokenRef(offline.id))).toBeNull();
  });

  it('reads owner/name from remote URLs and CI status from checks', () => {
    expect(parseRemote('https://github.com/acme/app.git')).toEqual({
      origin: 'https://github.com',
      repo: 'acme/app',
    });
    expect(parseRemote('git@github.com:acme/app.git')?.repo).toBe('acme/app');
    expect(parseRemote('ssh://git@github.com/acme/app')?.repo).toBe('acme/app');
    expect(parseRemote('/srv/git/app.git')).toBeNull();
    const c = (status: 'queued' | 'running' | 'completed', conclusion: string | null = null) => ({
      name: 'x',
      status,
      conclusion,
      url: null,
      summary: null,
    });
    expect(ciStatusOf([])).toBe('none');
    expect(ciStatusOf([c('queued')])).toBe('queued');
    expect(ciStatusOf([c('queued'), c('running')])).toBe('running');
    expect(ciStatusOf([c('completed', 'success'), c('completed', 'skipped')])).toBe('passed');
    expect(ciStatusOf([c('completed', 'success'), c('completed', 'failure')])).toBe('failed');
  });
});

describe('push guards', () => {
  it('needs the typed branch name for the default branch, never from the agent, and never forces it', async () => {
    const s = await e.svc.create(ACCOUNT, { folder: e.repo });
    writeFileSync(join(e.repo, 'more.ts'), 'export const more = 1;\n');
    e.git(['add', '-A']);
    e.git(['commit', '-q', '-m', 'more']);
    const plain = await failure(e.prs.push(ACCOUNT, s.id, {}, 'user'));
    expect(plain).toMatchObject({
      code: 'policy_denied',
      details: { reason: 'confirmation_required', branch: 'main', default: true },
    });
    // Tool arguments never authorize (FR-189): the agent cannot confirm.
    const agent = await failure(e.prs.push(ACCOUNT, s.id, { confirmBranch: 'main' }, 'agent'));
    expect(agent.details.reason).toBe('confirmation_required');
    const forced = await failure(
      e.prs.push(ACCOUNT, s.id, { confirmBranch: 'main', force: true }, 'user'),
    );
    expect(forced.details.reason).toBe('force_protected');
    const wrong = await failure(e.prs.push(ACCOUNT, s.id, { confirmBranch: 'Main' }, 'user'));
    expect(wrong.details.reason).toBe('confirmation_required');
    const ok = await e.prs.push(ACCOUNT, s.id, { confirmBranch: 'main' }, 'user');
    expect(ok).toMatchObject({ branch: 'main', remote: 'origin', hooksRan: false });
    expect(e.git(['rev-parse', 'main'], bare).trim()).toBe(ok.sha);
    expect(e.audit.filter((a) => a.action === 'code.push').map((a) => a.decision)).toEqual([
      'deny',
      'deny',
      'deny',
      'deny',
      'allow',
    ]);
    expect(e.events.events.some((x) => x.name === 'code.push.completed')).toBe(true);
  });

  it('treats a branch the host protects like the default one', async () => {
    const h = await connect();
    e.git(['checkout', '-q', '-b', 'release']);
    e.git(['push', '-q', 'origin', 'release']);
    host.repo('acme/app').protected.add('release');
    const s = await e.svc.create(ACCOUNT, { folder: e.repo });
    writeFileSync(join(e.repo, 'r.ts'), 'export const r = 1;\n');
    e.git(['add', '-A']);
    e.git(['commit', '-q', '-m', 'r']);
    const denied = await failure(
      e.prs.push(ACCOUNT, s.id, { hostId: h.id, repo: 'acme/app' }, 'user'),
    );
    expect(denied.details).toMatchObject({ reason: 'confirmation_required', protected: true });
    const forced = await failure(
      e.prs.push(
        ACCOUNT,
        s.id,
        { hostId: h.id, repo: 'acme/app', confirmBranch: 'release', force: true },
        'user',
      ),
    );
    expect(forced.details.reason).toBe('force_protected');
    await e.prs.push(
      ACCOUNT,
      s.id,
      { hostId: h.id, repo: 'acme/app', confirmBranch: 'release' },
      'user',
    );
  });

  it('scans the pushed commits for secrets and pushes nothing when it finds one', async () => {
    const s = await sessionOnBranch('nova/leak');
    const key = ['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' ');
    writeFileSync(
      join(e.repo, 'key.ts'),
      `export const k = \`${key}\nMIIEowIBAAKCAQEA7bq8n2kq9Xz4\`;\n`,
    );
    e.git(['add', '-A']);
    e.git(['commit', '-q', '-m', 'oops']);
    const r = await failure(e.prs.push(ACCOUNT, s.id, {}, 'agent'));
    expect(r.code).toBe('policy_denied');
    expect(r.details.reason).toBe('secrets_found');
    const findings = r.details.findings as { path: string; preview: string }[];
    expect(findings[0]!.path).toBe('key.ts');
    expect(findings[0]!.preview).not.toContain('MIIEowIBAAKCAQEA7bq8n2kq9Xz4');
    expect(bareHas('nova/leak')).toBe(false);
  });

  it('runs the pre-push hook only in the sandbox, and says so when it cannot', async () => {
    const s = await sessionOnBranch();
    const out = join(e.dir, 'pre-push.out');
    const hook = join(e.repo, '.git', 'hooks', 'pre-push');
    writeFileSync(hook, `#!/bin/sh\necho "$1 $2" > "${out}"\ncat >> "${out}"\n`);
    chmodSync(hook, 0o755);
    e.sandbox.current = null;
    const noSandbox = await e.prs.push(ACCOUNT, s.id, {}, 'user');
    expect(noSandbox.hooksRan).toBe(false);
    expect(noSandbox.hooksNote).toMatch(/did not run/);
    expect(existsSync(out)).toBe(false);
    const { HostSandbox } = await import('./code-env.ts');
    e.sandbox.current = new HostSandbox();
    writeFileSync(join(e.repo, 'two.ts'), 'export const two = 2;\n');
    e.git(['add', '-A']);
    e.git(['commit', '-q', '-m', 'two']);
    const ran = await e.prs.push(ACCOUNT, s.id, {}, 'user');
    expect(ran.hooksRan).toBe(true);
    const text = readFileSync(out, 'utf8');
    expect(text).toContain(`origin ${bare}`);
    expect(text).toMatch(
      /refs\/heads\/nova\/feature [0-9a-f]{40} refs\/heads\/nova\/feature [0-9a-f]{40}/,
    );
    // A hook that refuses stops the push.
    writeFileSync(hook, '#!/bin/sh\necho "lint failed" >&2\nexit 1\n');
    writeFileSync(join(e.repo, 'three.ts'), 'export const three = 3;\n');
    e.git(['add', '-A']);
    e.git(['commit', '-q', '-m', 'three']);
    const refused = await failure(e.prs.push(ACCOUNT, s.id, {}, 'user'));
    expect(refused.details).toMatchObject({ reason: 'hook_failed' });
    expect(String(refused.details.output)).toContain('lint failed');
    expect(e.git(['rev-parse', 'nova/feature'], bare).trim()).toBe(ran.sha);
  });

  it('refuses a missing remote and a detached HEAD', async () => {
    const s = await sessionOnBranch();
    expect(
      (await failure(e.prs.push(ACCOUNT, s.id, { remote: 'upstream' }, 'user'))).details.reason,
    ).toBe('no_remote');
    e.git(['checkout', '-q', '--detach']);
    expect((await failure(e.prs.push(ACCOUNT, s.id, {}, 'user'))).details.reason).toBe(
      'detached_head',
    );
  });
});

describe('pull requests', () => {
  it('opens a pull request, follows CI, and sends a failure back to the agent once per head', async () => {
    const h = await connect();
    const s = await sessionOnBranch();
    const pr = await e.prs.open(
      ACCOUNT,
      s.id,
      { title: 'Add feature', body: 'Adds it.', repo: 'acme/app', hostId: h.id },
      'agent',
    );
    expect(pr).toMatchObject({
      number: 1,
      url: 'https://github.example/acme/app/pull/1',
      headBranch: 'nova/feature',
      baseBranch: 'main',
      state: 'open',
      ci: { status: 'none', checks: [] },
    });
    const head = e.git(['rev-parse', 'HEAD']).trim();
    expect(pr.headSha).toBe(head);
    expect(bareHas('nova/feature')).toBe(true);
    expect(host.repo('acme/app').pulls[0]).toMatchObject({ title: 'Add feature', base: 'main' });
    expect((await e.svc.get(ACCOUNT, s.id)).pullRequestUrl).toBe(pr.url);
    expect(e.events.events.find((x) => x.name === 'code.pr.opened')?.payload).toMatchObject({
      sessionId: s.id,
      number: 1,
    });
    expect(e.audit.find((a) => a.action === 'code.pr.opened')?.actor).toBe('agent');
    // Opening again returns the open one.
    const again = await e.prs.open(
      ACCOUNT,
      s.id,
      { title: 'x', repo: 'acme/app', hostId: h.id },
      'user',
    );
    expect(again.id).toBe(pr.id);
    expect(host.repo('acme/app').pulls).toHaveLength(1);

    const checks = host.repo('acme/app').checks;
    checks.set(head, [{ name: 'build', status: 'in_progress' }]);
    expect((await e.prs.refresh(ACCOUNT, s.id)).ci.status).toBe('running');
    expect(
      e.events.events.filter((x) => x.name === 'code.pr.ci.changed').at(-1)?.payload,
    ).toMatchObject({ sessionId: s.id, status: 'running' });
    checks.set(head, [
      {
        name: 'build',
        status: 'completed',
        conclusion: 'failure',
        summary: 'TypeError at feature.ts:1',
      },
      { name: 'lint', status: 'completed', conclusion: 'success' },
    ]);
    // Not due yet: the poll waits for code.ciPollSeconds.
    expect(await e.prs.pollDue()).toBe(0);
    clock = new Date(clock.getTime() + 61_000);
    expect(await e.prs.pollDue()).toBe(1);
    expect(e.prs.get(ACCOUNT, s.id)?.ci.status).toBe('failed');
    expect((await e.svc.get(ACCOUNT, s.id)).ciStatus).toBe('failed');
    expect(e.turns).toHaveLength(1);
    const turn = e.turns[0]!;
    expect(turn).toMatchObject({
      threadId: s.threadId,
      trigger: 'event',
      authority: { kind: 'none', origin: 'tool' },
      authorKind: 'system',
    });
    expect(turn.text).toContain('build: failure');
    expect(turn.text).toContain('TypeError at feature.ts:1');
    expect(turn.text).not.toContain('lint');
    // The same head is not sent again.
    clock = new Date(clock.getTime() + 61_000);
    await e.prs.pollDue();
    expect(e.turns).toHaveLength(1);
    // A fix is pushed; its CI fails too: one more turn. Then it passes.
    writeFileSync(join(e.repo, 'feature.ts'), 'export const feature = 1;\n');
    e.git(['add', '-A']);
    e.git(['commit', '-q', '-m', 'fix']);
    const fixed = await e.prs.push(ACCOUNT, s.id, {}, 'user');
    checks.set(fixed.sha, [{ name: 'build', status: 'completed', conclusion: 'timed_out' }]);
    await e.prs.refresh(ACCOUNT, s.id);
    expect(e.turns).toHaveLength(2);
    checks.set(fixed.sha, [{ name: 'build', status: 'completed', conclusion: 'success' }]);
    const passed = await e.prs.refresh(ACCOUNT, s.id);
    expect(passed.ci.status).toBe('passed');
    expect(passed.headSha).toBe(fixed.sha);
    expect(e.turns).toHaveLength(2);
  });

  it('does not send CI failures when feedback is off', async () => {
    e.values['code.ciFeedback'] = false;
    const h = await connect();
    const s = await sessionOnBranch();
    await e.prs.open(ACCOUNT, s.id, { title: 't', repo: 'acme/app', hostId: h.id }, 'user');
    host
      .repo('acme/app')
      .checks.set(e.git(['rev-parse', 'HEAD']).trim(), [
        { name: 'build', status: 'completed', conclusion: 'failure' },
      ]);
    expect((await e.prs.refresh(ACCOUNT, s.id)).ci.status).toBe('failed');
    expect(e.turns).toHaveLength(0);
  });

  it('refuses without a host, without a repository, and from the base branch itself', async () => {
    const s0 = await e.svc.create(ACCOUNT, { folder: e.repo });
    expect((await failure(e.prs.open(ACCOUNT, s0.id, { title: 't' }, 'user'))).details.reason).toBe(
      'no_git_host',
    );
    const h = await connect();
    expect(
      (await failure(e.prs.open(ACCOUNT, s0.id, { title: 't', hostId: h.id }, 'user'))).details
        .reason,
    ).toBe('repo_unknown');
    const same = await failure(
      e.prs.open(ACCOUNT, s0.id, { title: 't', hostId: h.id, repo: 'acme/app' }, 'user'),
    );
    expect(same.details.reason).toBe('same_branch');
    await expect(e.prs.refresh(ACCOUNT, s0.id)).rejects.toThrow(/no pull request/);
    // A host with open pull requests is not removed.
    const s = await sessionOnBranch();
    await e.prs.open(ACCOUNT, s.id, { title: 't', repo: 'acme/app', hostId: h.id }, 'user');
    expect((await failure(e.hosts.remove(ACCOUNT, h.id))).details.reason).toBe('in_use');
  });
});
