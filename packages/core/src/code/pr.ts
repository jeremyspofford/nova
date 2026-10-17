// Pushes and pull requests of Code sessions (FR-070, docs/10 §8). A push sends the session's
// branch to a remote with Nova's hook-free Git (FR-211); the repository's pre-push hook runs only
// inside the session sandbox (network off), and when no sandbox with Git is available it does not
// run and the result says so. Guards: a protected or default branch is never pushed without the
// user typing its exact name (`confirmBranch`, which the agent's tools cannot pass: tool arguments
// never authorize, FR-189), a protected or default branch is never force-pushed, and the commits
// being pushed are scanned for secrets first, like a commit. The token of a connected host is sent
// as an HTTP header for that one call (through Git's environment config), never stored in a
// remote URL or config file.
//
// A pull request is opened on the connected host for the pushed branch; its link and CI status
// (queued, running, passed, failed, with checks) are kept on the session and refreshed by
// polling (`code.ciPollSeconds`). When CI fails for a pushed head, the failed checks are sent to
// the agent once as a turn without the user's authority (the summaries are the host's text).
import {
  NovaError,
  uuidv7,
  type CiCheckView,
  type CiStatus,
  type GitHostView,
  type PullRequestView,
  type PushResultView,
  type createPullRequestSchema,
  type pushSchema,
} from '@nova/shared';
import { defaultRedactor, scanText, type ScanFinding } from '@nova/security';
import type { NovaDatabase } from '@nova/storage';
import { Logger } from '@nova/telemetry';
import type { z } from 'zod';
import type { SettingReader } from '../approvals/gate.ts';
import type { AuditSink, SandboxClient, ToolRoot } from '../tools/types.ts';
import { hookFile, sandboxHasGit } from './commit.ts';
import { diffAddedLines } from './diff.ts';
import { isDefaultBranch, repoInfo, type HookFreeGit } from './git.ts';
import { ciStatusOf, parseRemote, type GitHostService } from './githost.ts';
import type { CodeService, CodeSessionInfo } from './service.ts';

export type CodePushRequest = z.input<typeof pushSchema> & { repo?: string };
export type CodeCreatePullRequest = z.input<typeof createPullRequestSchema>;

/** Commits a push scans for secrets at most (newest first). */
const MAX_SCANNED_COMMITS = 200;
/** Files bigger than this are not scanned (binary or generated). */
const MAX_SCANNED_BYTES = 1024 * 1024;
const ZERO_SHA = '0'.repeat(40);

interface PrRow {
  id: string;
  accountId: string;
  sessionId: string;
  hostId: string;
  repo: string;
  number: number;
  url: string;
  title: string;
  headBranch: string;
  baseBranch: string;
  headSha: string | null;
  state: PullRequestView['state'];
  ciStatus: CiStatus;
  checksJson: string;
  feedbackSha: string | null;
  lastPolledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface PushTarget {
  root: string;
  branch: string;
  head: string | null;
  remote: string;
  url: string;
  host: GitHostView | null;
  repo: string | null;
}

const PR_COLUMNS = `id, account_id AS accountId, session_id AS sessionId, host_id AS hostId, repo,
  number, url, title, head_branch AS headBranch, base_branch AS baseBranch, head_sha AS headSha,
  state, ci_status AS ciStatus, checks_json AS checksJson, feedback_sha AS feedbackSha,
  last_polled_at AS lastPolledAt, created_at AS createdAt, updated_at AS updatedAt`;

export interface PullRequestServiceOptions {
  db: NovaDatabase;
  code: CodeService;
  hosts: GitHostService;
  audit: AuditSink;
  setting: SettingReader;
  now?: () => Date;
  log?: Logger;
}

export class PullRequestService {
  readonly #o: PullRequestServiceOptions;
  readonly #git: HookFreeGit;
  readonly #now: () => Date;
  readonly #log: Logger;
  readonly #polling = new Set<string>();

  constructor(opts: PullRequestServiceOptions) {
    this.#o = opts;
    this.#git = opts.code.git;
    this.#now = opts.now ?? (() => new Date());
    this.#log = opts.log ?? new Logger({ module: 'core.code.pr', sinks: [] });
  }

  // ---- push --------------------------------------------------------------------------------

  async push(
    accountId: string,
    sessionId: string,
    req: CodePushRequest,
    actor: 'user' | 'agent',
  ): Promise<PushResultView> {
    const s = this.#o.code.info(accountId, sessionId);
    const target = await this.#target(s, req);
    return this.#push(s, target, req, actor);
  }

  /** The repository, branch, remote and host a push of the session goes to. */
  async #target(
    s: CodeSessionInfo,
    req: { remote?: string; hostId?: string; repo?: string },
  ): Promise<PushTarget> {
    if (!s.hubLocal)
      throw new NovaError(
        'capability_missing',
        'pushing from this environment is not available yet',
        {
          details: { reason: 'remote_environment' },
        },
      );
    const info = await repoInfo(this.#git, s.folder);
    if (!info) throw new NovaError('validation', 'the session folder is not a Git repository');
    if (!info.branch)
      throw new NovaError('conflict', 'HEAD is detached; commit on a branch first', {
        details: { reason: 'detached_head' },
      });
    const remote = req.remote ?? 'origin';
    const got = await this.#git.run(['remote', 'get-url', '--push', remote], {
      cwd: info.root,
      allowFail: true,
    });
    if (got.code !== 0)
      throw new NovaError('validation', `the repository has no remote named ${remote}`, {
        details: { reason: 'no_remote', remote },
      });
    const url = got.stdout.toString('utf8').trim();
    const host = this.#o.hosts.match(s.accountId, url, req.hostId);
    const repo = req.repo ?? parseRemote(url)?.repo ?? null;
    return { root: info.root, branch: info.branch, head: info.head, remote, url, host, repo };
  }

  async #push(
    s: CodeSessionInfo,
    t: PushTarget,
    req: CodePushRequest,
    actor: 'user' | 'agent',
  ): Promise<PushResultView> {
    let hostDefault: string | null = null;
    let isProtected = false;
    if (t.host && t.repo) {
      const client = await this.#o.hosts.client(s.accountId, t.host.id);
      hostDefault = (await client.repo(t.repo)).defaultBranch;
      isProtected = await client.branchProtected(t.repo, t.branch);
    }
    const isDefault =
      hostDefault === t.branch || (await isDefaultBranch(this.#git, t.root, t.branch));
    // Never force-push a protected (or the default) branch, whatever was typed (docs/10 §8).
    if (req.force && (isProtected || isDefault))
      throw this.#denied(s, actor, t, 'force_protected', isProtected, isDefault);
    // A protected or default branch needs the user's typed confirmation of its exact name.
    if ((isProtected || isDefault) && (actor !== 'user' || req.confirmBranch !== t.branch))
      throw this.#denied(s, actor, t, 'confirmation_required', isProtected, isDefault);

    const shas = await this.#unpushed(t.root, t.remote);
    const findings = await this.#scan(t.root, shas);
    if (findings.length) {
      await this.#audit(s, actor, 'code.push', t, 'deny', { reason: 'secrets_found' });
      throw new NovaError('policy_denied', 'the commits to push look like they contain secrets', {
        details: {
          reason: 'secrets_found',
          findings: findings.map((f) => ({
            path: f.path,
            line: f.line,
            rule: f.rule,
            preview: f.preview,
          })),
        },
      });
    }
    const hook = await this.#prePush(s, t);
    const env: Record<string, string> = {};
    if (t.host && /^https?:\/\//i.test(t.url)) {
      const token = await this.#o.hosts.token(s.accountId, t.host.id);
      if (token) {
        // The header lives in this call's environment only; nothing is written to a config file.
        env.GIT_CONFIG_COUNT = '1';
        env.GIT_CONFIG_KEY_0 = `http.${new URL(t.url).origin}/.extraheader`;
        env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
      }
    }
    const r = await this.#git.run(
      [
        'push',
        '--porcelain',
        ...(req.force ? ['--force-with-lease'] : []),
        t.remote,
        `HEAD:refs/heads/${t.branch}`,
      ],
      { cwd: t.root, env, allowFail: true, timeoutMs: 5 * 60_000 },
    );
    if (r.code !== 0) {
      const output = defaultRedactor
        .redactString(`${r.stdout.toString('utf8')}\n${r.stderr}`)
        .trim()
        .slice(0, 4000);
      await this.#audit(s, actor, 'code.push', t, 'allow', { result: 'error' });
      throw new NovaError(
        'conflict',
        `the push failed: ${output.split('\n').find((l) => l.trim()) ?? ''}`,
        {
          details: { reason: 'push_failed', output },
        },
      );
    }
    const sha = await this.#git.text(['rev-parse', 'HEAD'], { cwd: t.root });
    await this.#audit(s, actor, 'code.push', t, 'allow', {
      sha,
      force: req.force === true,
      commits: shas.length,
      hooksRan: hook.ran,
    });
    await this.#o.code.announce(s, 'code.push.completed', {
      sessionId: s.id,
      remote: t.remote,
      branch: t.branch,
      sha,
    });
    return {
      sessionId: s.id,
      remote: t.remote,
      branch: t.branch,
      sha,
      hooksRan: hook.ran,
      hooksNote: hook.note,
    };
  }

  #denied(
    s: CodeSessionInfo,
    actor: 'user' | 'agent',
    t: { branch: string; remote: string; root: string },
    reason: 'force_protected' | 'confirmation_required',
    isProtected: boolean,
    isDefault: boolean,
  ): NovaError {
    void this.#audit(s, actor, 'code.push', t, 'deny', { reason }).catch(() => undefined);
    const what = isProtected ? 'a protected branch' : 'the default branch';
    return new NovaError(
      'policy_denied',
      reason === 'force_protected'
        ? `force-pushing ${what} (${t.branch}) is never allowed`
        : actor === 'agent'
          ? `pushing ${what} (${t.branch}) needs the user's typed confirmation; push from the session header or work on a nova/ branch`
          : `pushing ${what} (${t.branch}) needs its name typed as confirmation`,
      {
        details: { reason, branch: t.branch, protected: isProtected, default: isDefault },
      },
    );
  }

  /** Commits HEAD has that no ref of the remote has (newest first, capped). */
  async #unpushed(root: string, remote: string): Promise<string[]> {
    const r = await this.#git.run(
      ['rev-list', `--max-count=${MAX_SCANNED_COMMITS}`, 'HEAD', '--not', `--remotes=${remote}`],
      { cwd: root, allowFail: true },
    );
    if (r.code !== 0) return [];
    return r.stdout
      .toString('utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  }

  /** Secrets on lines the commits add (FR-101); previews are masked. */
  async #scan(root: string, shas: readonly string[]): Promise<ScanFinding[]> {
    const out: ScanFinding[] = [];
    const seen = new Set<string>();
    for (const sha of shas) {
      const patch = await this.#git.run(
        [
          'diff-tree',
          '-p',
          '-r',
          '--root',
          '--no-ext-diff',
          '--no-textconv',
          '--no-color',
          '--no-renames',
          '--src-prefix=a/',
          '--dst-prefix=b/',
          '-U0',
          sha,
        ],
        { cwd: root, allowFail: true, maxBytes: 32 * 1024 * 1024 },
      );
      if (patch.code !== 0) continue;
      for (const [path, lines] of diffAddedLines(patch.stdout.toString('utf8'))) {
        if (!lines.size) continue;
        const blob = await this.#git.run(['cat-file', 'blob', `${sha}:${path}`], {
          cwd: root,
          allowFail: true,
          maxBytes: MAX_SCANNED_BYTES * 2,
        });
        if (blob.code !== 0 || blob.stdout.length > MAX_SCANNED_BYTES) continue;
        if (blob.stdout.subarray(0, 8192).includes(0)) continue;
        for (const f of scanText(path, blob.stdout.toString('utf8'))) {
          if (!lines.has(f.line)) continue;
          const key = `${f.path}:${f.rule}:${f.preview}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(f);
        }
      }
    }
    return out;
  }

  /**
   * Run the repository's pre-push hook inside the session sandbox (FR-211): repository writable,
   * network off. Without a sandbox with Git the hook does not run and the result says so.
   */
  async #prePush(
    s: CodeSessionInfo,
    t: { root: string; branch: string; head: string | null; remote: string; url: string },
  ): Promise<{ ran: boolean; note: string | null }> {
    const hook = await hookFile(this.#git, t.root, 'pre-push');
    if (!hook) return { ran: false, note: null };
    const sandbox: SandboxClient | null = this.#o.code.sandboxFor(s) ?? this.#o.code.hubSandbox();
    const roots: ToolRoot[] = [{ path: t.root, access: 'write', label: 'repository' }];
    if (!hook.startsWith(`${t.root}/`))
      roots.push({ path: hook.slice(0, hook.lastIndexOf('/')), access: 'read', label: 'hooks' });
    const signal = AbortSignal.timeout(10 * 60_000);
    if (!sandbox || !(await sandboxHasGit(sandbox, t.root, roots, signal)))
      return {
        ran: false,
        note: "The repository's pre-push hook did not run: no sandbox with Git is available on this Hub.",
      };
    const remoteSha =
      (
        await this.#git.run(
          ['rev-parse', '-q', '--verify', `refs/remotes/${t.remote}/${t.branch}`],
          { cwd: t.root, allowFail: true },
        )
      ).stdout
        .toString('utf8')
        .trim() || ZERO_SHA;
    const ref = `refs/heads/${t.branch}`;
    const r = await sandbox.exec({
      cmd: 'printf "%s\\n" "$NOVA_PUSH_LINE" | "$NOVA_HOOK" "$NOVA_REMOTE" "$NOVA_URL"',
      cwd: t.root,
      roots,
      network: 'off',
      env: {
        NOVA_PUSH_LINE: `${ref} ${t.head ?? ZERO_SHA} ${ref} ${remoteSha}`,
        NOVA_HOOK: hook,
        NOVA_REMOTE: t.remote,
        NOVA_URL: t.url,
      },
      yieldMs: 5 * 60_000,
      signal,
      turnId: `code-push:${s.id}`,
    });
    if (r.status !== 'exited') {
      await sandbox.killTurn(`code-push:${s.id}`).catch(() => undefined);
      throw new NovaError('conflict', 'the pre-push hook did not finish in time', {
        details: { reason: 'hook_failed' },
      });
    }
    if (r.exitCode !== 0) {
      const output = defaultRedactor.redactString(r.output).trim().slice(0, 4000);
      throw new NovaError('conflict', 'the pre-push hook refused the push', {
        details: { reason: 'hook_failed', output },
      });
    }
    return { ran: true, note: null };
  }

  // ---- pull requests -------------------------------------------------------------------------

  /** Push the session's branch and open a pull request for it (or return the open one). */
  async open(
    accountId: string,
    sessionId: string,
    req: CodeCreatePullRequest,
    actor: 'user' | 'agent',
  ): Promise<PullRequestView> {
    const s = this.#o.code.info(accountId, sessionId);
    const t = await this.#target(s, req);
    if (!t.host)
      throw new NovaError('validation', 'connect a Git host for this remote first', {
        details: { reason: 'no_git_host' },
      });
    if (!t.repo)
      throw new NovaError('validation', 'the remote does not name a repository; give `repo`', {
        details: { reason: 'repo_unknown' },
      });
    const client = await this.#o.hosts.client(accountId, t.host.id);
    const base = req.base ?? (await client.repo(t.repo)).defaultBranch;
    if (base === t.branch)
      throw new NovaError(
        'validation',
        `the session works on ${base}, the branch the pull request would merge into; commit on a nova/ branch first`,
        { details: { reason: 'same_branch', branch: base } },
      );
    await this.#push(
      s,
      t,
      {
        ...(req.confirmBranch !== undefined ? { confirmBranch: req.confirmBranch } : {}),
      },
      actor,
    );
    const headSha = await this.#git.text(['rev-parse', 'HEAD'], { cwd: t.root });
    const known = this.#o.db.raw
      .prepare(
        `SELECT ${PR_COLUMNS} FROM code_pull_request
         WHERE session_id = ? AND repo = ? AND head_branch = ? AND state = 'open'
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(s.id, t.repo, t.branch) as PrRow | undefined;
    let row: PrRow;
    if (known) {
      row = known;
    } else {
      const pull =
        (await client.findPull(t.repo, t.branch)) ??
        (await client.createPull(t.repo, {
          title: req.title,
          body: req.body ?? '',
          head: t.branch,
          base,
          draft: req.draft === true,
        }));
      const now = this.#iso();
      row = {
        id: uuidv7(),
        accountId,
        sessionId: s.id,
        hostId: t.host.id,
        repo: t.repo,
        number: pull.number,
        url: pull.url,
        title: req.title,
        headBranch: t.branch,
        baseBranch: base,
        headSha: pull.headSha ?? headSha,
        state: pull.state,
        ciStatus: 'none',
        checksJson: '[]',
        feedbackSha: null,
        lastPolledAt: null,
        createdAt: now,
        updatedAt: now,
      };
      await this.#o.db.transaction(() => {
        this.#o.db.raw
          .prepare(
            `INSERT INTO code_pull_request (id, account_id, session_id, host_id, repo, number, url,
               title, head_branch, base_branch, head_sha, state, ci_status, checks_json,
               created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'none', '[]', ?, ?)`,
          )
          .run(
            row.id,
            accountId,
            s.id,
            row.hostId,
            row.repo,
            row.number,
            row.url,
            row.title,
            row.headBranch,
            row.baseBranch,
            row.headSha,
            row.state,
            now,
            now,
          );
      });
      await this.#o.code.setPullRequest(s.id, row.url, 'none');
      await this.#o.audit.append({
        accountId,
        actor,
        kind: 'code',
        action: 'code.pr.opened',
        resource: row.url,
        result: 'ok',
        threadId: s.threadId,
        detail: { sessionId: s.id, repo: row.repo, number: row.number, base, head: t.branch },
      });
      await this.#o.code.announce(s, 'code.pr.opened', {
        sessionId: s.id,
        url: row.url,
        number: row.number,
      });
    }
    await this.#poll(row, headSha).catch((err: unknown) =>
      this.#log.warn('reading CI status failed', { err, pullRequestId: row.id }),
    );
    return this.#view(this.#row(row.id));
  }

  /** The session's newest pull request, or null. */
  get(accountId: string, sessionId: string): PullRequestView | null {
    const s = this.#o.code.info(accountId, sessionId);
    const r = this.#o.db.raw
      .prepare(
        `SELECT ${PR_COLUMNS} FROM code_pull_request WHERE session_id = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(s.id) as PrRow | undefined;
    return r ? this.#view(r) : null;
  }

  /** Read the pull request's state and CI from the host now. */
  async refresh(accountId: string, sessionId: string): Promise<PullRequestView> {
    const v = this.get(accountId, sessionId);
    if (!v) throw new NovaError('not_found', 'this session has no pull request');
    await this.#poll(this.#row(v.id));
    return this.#view(this.#row(v.id));
  }

  /** Poll every open pull request whose last poll is older than `code.ciPollSeconds`. */
  async pollDue(): Promise<number> {
    const seconds = await this.#o.setting('code.ciPollSeconds');
    const due = new Date(this.#now().getTime() - seconds * 1000).toISOString();
    const rows = this.#o.db.raw
      .prepare(
        `SELECT ${PR_COLUMNS} FROM code_pull_request
         WHERE state = 'open' AND (last_polled_at IS NULL OR last_polled_at <= ?)
         ORDER BY last_polled_at LIMIT 50`,
      )
      .all(due) as unknown as PrRow[];
    let n = 0;
    for (const r of rows) {
      try {
        await this.#poll(r);
        n++;
      } catch (err) {
        this.#log.warn('polling a pull request failed', { err, pullRequestId: r.id });
      }
    }
    return n;
  }

  async #poll(r: PrRow, knownHead?: string): Promise<void> {
    if (this.#polling.has(r.id)) return;
    this.#polling.add(r.id);
    try {
      const client = await this.#o.hosts.client(r.accountId, r.hostId);
      const pull = await client.pull(r.repo, r.number);
      const head = pull.headSha ?? knownHead ?? r.headSha;
      const checks = head ? await client.checks(r.repo, head) : [];
      const status = ciStatusOf(checks);
      const now = this.#iso();
      const changed =
        status !== r.ciStatus || JSON.stringify(checks) !== r.checksJson || head !== r.headSha;
      await this.#o.db.transaction(() => {
        this.#o.db.raw
          .prepare(
            `UPDATE code_pull_request SET state = ?, head_sha = ?, ci_status = ?, checks_json = ?,
               last_polled_at = ?, updated_at = ? WHERE id = ?`,
          )
          .run(
            pull.state,
            head,
            status,
            JSON.stringify(checks),
            now,
            changed ? now : r.updatedAt,
            r.id,
          );
      });
      let s: CodeSessionInfo;
      try {
        s = this.#o.code.info(r.accountId, r.sessionId);
      } catch {
        return;
      }
      if (status !== r.ciStatus || pull.state !== r.state) {
        await this.#o.code.setPullRequest(s.id, r.url, status);
        await this.#o.code.announce(s, 'code.pr.ci.changed', {
          sessionId: s.id,
          status,
          checks: checks.map((c) => ({
            name: c.name,
            status: c.status,
            conclusion: c.conclusion,
            url: c.url,
          })),
          state: pull.state,
        });
        await this.#o.code.announce(s, 'code.session.updated', { sessionId: s.id });
      }
      if (
        status === 'failed' &&
        pull.state === 'open' &&
        head &&
        r.feedbackSha !== head &&
        (await this.#o.setting('code.ciFeedback'))
      )
        await this.#feedback(s, r, head, checks);
    } finally {
      this.#polling.delete(r.id);
    }
  }

  /**
   * Send the failed checks to the session's agent as one turn (FR-070). The text quotes the
   * host's check summaries, so the turn carries no authority (FR-189).
   */
  async #feedback(s: CodeSessionInfo, r: PrRow, head: string, checks: CiCheckView[]) {
    const turns = this.#o.code.turns;
    if (!turns || !s.active) return;
    const failed = checks.filter(
      (c) =>
        c.status === 'completed' &&
        c.conclusion !== null &&
        !['success', 'neutral', 'skipped'].includes(c.conclusion),
    );
    const text = [
      `CI failed on pull request #${r.number} (${r.url}) for commit ${head.slice(0, 12)}.`,
      'Failed checks (their text comes from the Git host):',
      ...failed.map(
        (c) =>
          `- ${c.name}: ${c.conclusion ?? 'failed'}${c.url ? ` (${c.url})` : ''}${c.summary ? `\n  ${c.summary.replace(/\n/g, '\n  ').slice(0, 1500)}` : ''}`,
      ),
      '',
      'Find the cause, propose a fix and make it; the user reviews the diff before it is committed and pushed.',
    ].join('\n');
    await this.#o.db.transaction(() => {
      this.#o.db.raw
        .prepare('UPDATE code_pull_request SET feedback_sha = ? WHERE id = ?')
        .run(head, r.id);
    });
    try {
      await turns.startTurn({
        accountId: s.accountId,
        threadId: s.threadId,
        text,
        trigger: 'event',
        triggerRef: `pr:${r.id}`,
        authority: { kind: 'none', origin: 'tool' },
        authorKind: 'system',
      });
    } catch (err) {
      this.#log.warn('sending CI failures to the agent failed', { err, sessionId: s.id });
    }
  }

  // ---- internals ---------------------------------------------------------------------------

  #row(id: string): PrRow {
    const r = this.#o.db.raw
      .prepare(`SELECT ${PR_COLUMNS} FROM code_pull_request WHERE id = ?`)
      .get(id) as PrRow | undefined;
    if (!r) throw new NovaError('not_found', 'pull request not found');
    return r;
  }

  #view(r: PrRow): PullRequestView {
    let checks: CiCheckView[];
    try {
      checks = JSON.parse(r.checksJson) as CiCheckView[];
    } catch {
      checks = [];
    }
    return {
      id: r.id,
      sessionId: r.sessionId,
      hostId: r.hostId,
      repo: r.repo,
      number: r.number,
      url: r.url,
      title: r.title,
      state: r.state,
      headBranch: r.headBranch,
      baseBranch: r.baseBranch,
      headSha: r.headSha,
      ci: { status: r.ciStatus, checks },
      polledAt: r.lastPolledAt,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  async #audit(
    s: CodeSessionInfo,
    actor: string,
    action: string,
    t: { branch: string; remote: string; root: string },
    decision: 'allow' | 'deny',
    detail: Record<string, unknown>,
  ): Promise<void> {
    await this.#o.audit.append({
      accountId: s.accountId,
      actor,
      kind: 'code',
      action,
      resource: t.root,
      decision,
      result: decision === 'deny' ? 'denied' : ((detail.result as string | undefined) ?? 'ok'),
      threadId: s.threadId,
      detail: { sessionId: s.id, remote: t.remote, branch: t.branch, ...detail },
    });
  }

  #iso(): string {
    return this.#now().toISOString();
  }
}
