// Connected Git hosts for pull requests (FR-070, docs/10 §8). GitHub first: the Hub talks to its
// REST API with a personal access token kept in the keychain (`secret://code/githost/<id>/token`,
// never in the database, logs or responses). The client reads the account, a repository's default
// branch, whether a branch is protected, opens pull requests and reads their CI checks (check runs
// and commit statuses). Everything the host returns is untrusted data (FR-189).
import {
  NovaError,
  createGitHostSchema,
  uuidv7,
  type CiCheckView,
  type CiStatus,
  type GitHostView,
} from '@nova/shared';
import type { SecretStore } from '@nova/secrets';
import { defaultRedactor } from '@nova/security';
import type { NovaDatabase } from '@nova/storage';
import type { z } from 'zod';
import type { AuditSink } from '../tools/types.ts';

export interface GitHostRepo {
  defaultBranch: string;
  private: boolean;
}

export interface GitHostPull {
  number: number;
  url: string;
  state: 'open' | 'closed' | 'merged';
  headSha: string | null;
}

/** What Nova needs from a Git host (GitHub now; GitLab and Gitea later, P1). */
export interface GitHostClient {
  whoami(signal?: AbortSignal): Promise<{ login: string }>;
  repo(repo: string, signal?: AbortSignal): Promise<GitHostRepo>;
  /** Whether a branch is protected on the host (false when it does not exist there yet). */
  branchProtected(repo: string, branch: string, signal?: AbortSignal): Promise<boolean>;
  createPull(
    repo: string,
    input: { title: string; body: string; head: string; base: string; draft: boolean },
    signal?: AbortSignal,
  ): Promise<GitHostPull>;
  /** An open pull request for `head`, if one exists. */
  findPull(repo: string, head: string, signal?: AbortSignal): Promise<GitHostPull | null>;
  pull(repo: string, number: number, signal?: AbortSignal): Promise<GitHostPull>;
  checks(repo: string, sha: string, signal?: AbortSignal): Promise<CiCheckView[]>;
}

/** The GitHub REST API (https://api.github.com or GitHub Enterprise's `<host>/api/v3`). */
export class GitHubClient implements GitHostClient {
  readonly #api: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;

  constructor(opts: { apiUrl: string; token: string; fetch?: typeof fetch }) {
    this.#api = opts.apiUrl.replace(/\/+$/, '');
    this.#token = opts.token;
    this.#fetch = opts.fetch ?? fetch;
  }

  async whoami(signal?: AbortSignal) {
    const u = (await this.#get('/user', signal)) as { login?: unknown };
    if (typeof u.login !== 'string') throw hostError('the host did not say who the token is');
    return { login: u.login };
  }

  async repo(repo: string, signal?: AbortSignal): Promise<GitHostRepo> {
    const r = (await this.#get(`/repos/${repoPath(repo)}`, signal)) as {
      default_branch?: unknown;
      private?: unknown;
    };
    return {
      defaultBranch: typeof r.default_branch === 'string' ? r.default_branch : 'main',
      private: r.private === true,
    };
  }

  async branchProtected(repo: string, branch: string, signal?: AbortSignal): Promise<boolean> {
    const res = await this.#request(
      'GET',
      `/repos/${repoPath(repo)}/branches/${encodeURIComponent(branch)}`,
      undefined,
      signal,
    );
    if (res.status === 404) return false;
    const body = (await readJson(res)) as { protected?: unknown };
    return body.protected === true;
  }

  async createPull(
    repo: string,
    input: { title: string; body: string; head: string; base: string; draft: boolean },
    signal?: AbortSignal,
  ): Promise<GitHostPull> {
    const res = await this.#request(
      'POST',
      `/repos/${repoPath(repo)}/pulls`,
      {
        title: input.title,
        body: input.body,
        head: input.head,
        base: input.base,
        draft: input.draft,
      },
      signal,
    );
    return pullOf(await readJson(res));
  }

  async findPull(repo: string, head: string, signal?: AbortSignal): Promise<GitHostPull | null> {
    const owner = repo.split('/')[0] ?? '';
    const list = (await this.#get(
      `/repos/${repoPath(repo)}/pulls?state=open&head=${encodeURIComponent(`${owner}:${head}`)}`,
      signal,
    )) as unknown[];
    const first = Array.isArray(list) ? list[0] : undefined;
    return first ? pullOf(first) : null;
  }

  async pull(repo: string, number: number, signal?: AbortSignal): Promise<GitHostPull> {
    return pullOf(await this.#get(`/repos/${repoPath(repo)}/pulls/${number}`, signal));
  }

  async checks(repo: string, sha: string, signal?: AbortSignal): Promise<CiCheckView[]> {
    const runs = (await this.#get(
      `/repos/${repoPath(repo)}/commits/${encodeURIComponent(sha)}/check-runs?per_page=100`,
      signal,
    )) as { check_runs?: unknown[] };
    const out: CiCheckView[] = [];
    for (const c of runs.check_runs ?? []) {
      const r = c as {
        name?: unknown;
        status?: unknown;
        conclusion?: unknown;
        html_url?: unknown;
        output?: { title?: unknown; summary?: unknown };
      };
      out.push({
        name: typeof r.name === 'string' ? r.name.slice(0, 200) : 'check',
        status:
          r.status === 'completed'
            ? 'completed'
            : r.status === 'in_progress'
              ? 'running'
              : 'queued',
        conclusion: typeof r.conclusion === 'string' ? r.conclusion : null,
        url: typeof r.html_url === 'string' ? r.html_url : null,
        summary: clip(
          [r.output?.title, r.output?.summary].filter((x) => typeof x === 'string').join(': '),
        ),
      });
    }
    // Commit statuses (older integrations report these instead of check runs).
    const combined = (await this.#get(
      `/repos/${repoPath(repo)}/commits/${encodeURIComponent(sha)}/status`,
      signal,
    )) as { statuses?: unknown[] };
    for (const s of combined.statuses ?? []) {
      const r = s as {
        context?: unknown;
        state?: unknown;
        target_url?: unknown;
        description?: unknown;
      };
      const state = typeof r.state === 'string' ? r.state : 'pending';
      out.push({
        name: typeof r.context === 'string' ? r.context.slice(0, 200) : 'status',
        status: state === 'pending' ? 'running' : 'completed',
        conclusion: state === 'pending' ? null : state === 'error' ? 'failure' : state,
        url: typeof r.target_url === 'string' ? r.target_url : null,
        summary: clip(typeof r.description === 'string' ? r.description : ''),
      });
    }
    return out;
  }

  async #get(path: string, signal?: AbortSignal): Promise<unknown> {
    return readJson(await this.#request('GET', path, undefined, signal));
  }

  async #request(
    method: string,
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<Response> {
    let res: Response;
    try {
      res = await this.#fetch(`${this.#api}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.#token}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'nova-hub',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        redirect: 'error',
        signal: signal ?? AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new NovaError('server_error', `the Git host could not be reached: ${errText(err)}`, {
        retryable: true,
        details: { reason: 'host_unreachable' },
      });
    }
    if (res.status === 401)
      throw new NovaError('validation', 'the Git host rejected the token', {
        details: { reason: 'token_rejected' },
      });
    if (res.status === 404 && method === 'GET' && path.includes('/branches/')) return res;
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let message = text.slice(0, 500);
      try {
        const j = JSON.parse(text) as { message?: unknown; errors?: { message?: unknown }[] };
        message = [j.message, ...(j.errors ?? []).map((e) => e.message)]
          .filter((m) => typeof m === 'string')
          .join('; ');
      } catch {
        // Not JSON.
      }
      throw new NovaError(
        res.status === 404 ? 'not_found' : res.status === 403 ? 'policy_denied' : 'conflict',
        `the Git host answered ${res.status}: ${defaultRedactor.redactString(message) || res.statusText}`,
        { details: { reason: 'host_error', status: res.status } },
      );
    }
    return res;
  }
}

function pullOf(v: unknown): GitHostPull {
  const p = v as {
    number?: unknown;
    html_url?: unknown;
    state?: unknown;
    merged?: unknown;
    merged_at?: unknown;
    head?: { sha?: unknown };
  };
  if (typeof p.number !== 'number' || typeof p.html_url !== 'string')
    throw hostError('the host returned an unexpected pull request');
  const merged = p.merged === true || typeof p.merged_at === 'string';
  return {
    number: p.number,
    url: p.html_url,
    state: merged ? 'merged' : p.state === 'closed' ? 'closed' : 'open',
    headSha: typeof p.head?.sha === 'string' ? p.head.sha : null,
  };
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    throw hostError('the Git host returned something that is not JSON');
  }
}

function repoPath(repo: string): string {
  const [owner, name] = repo.split('/');
  if (!owner || !name) throw new NovaError('validation', 'a repository is `owner/name`');
  return `${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

function hostError(message: string): NovaError {
  return new NovaError('server_error', message, { details: { reason: 'host_error' } });
}

function clip(s: string): string | null {
  const t = s.trim();
  return t ? defaultRedactor.redactString(t).slice(0, 2000) : null;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * CI status of a set of checks: none without checks; queued or running while any is; failed when
 * every check finished and one failed; passed otherwise.
 */
export function ciStatusOf(checks: readonly CiCheckView[]): CiStatus {
  if (!checks.length) return 'none';
  if (checks.some((c) => c.status === 'running')) return 'running';
  if (checks.some((c) => c.status === 'queued')) return 'queued';
  const bad = new Set([
    'failure',
    'timed_out',
    'cancelled',
    'action_required',
    'startup_failure',
    'error',
  ]);
  return checks.some((c) => c.conclusion !== null && bad.has(c.conclusion)) ? 'failed' : 'passed';
}

/** `owner/name` and the web origin of a remote URL (https, ssh or scp-like), if it has one. */
export function parseRemote(url: string): { origin: string; repo: string } | null {
  const u = url.trim();
  let host: string;
  let path: string;
  const scp = /^[A-Za-z0-9._-]+@([A-Za-z0-9.-]+):(.+)$/.exec(u);
  if (scp) {
    host = scp[1]!;
    path = scp[2]!;
  } else {
    let parsed: URL;
    try {
      parsed = new URL(u);
    } catch {
      return null;
    }
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(parsed.protocol)) return null;
    host = parsed.host;
    path = parsed.pathname;
  }
  const parts = path
    .replace(/^\/+/, '')
    .replace(/\.git\/?$/, '')
    .split('/')
    .filter(Boolean);
  if (parts.length < 2) return null;
  const repo = `${parts.at(-2)}/${parts.at(-1)}`;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return null;
  return { origin: `https://${host.replace(/:\d+$/, '')}`, repo };
}

// ---- connected hosts ---------------------------------------------------------------------------

interface HostRow {
  id: string;
  accountId: string;
  kind: 'github';
  label: string;
  apiUrl: string;
  webUrl: string;
  login: string | null;
  tokenRef: string;
  status: GitHostView['status'];
  statusDetail: string | null;
  lastCheckAt: string | null;
  createdAt: string;
}

const HOST_COLUMNS = `id, account_id AS accountId, kind, label, api_url AS apiUrl, web_url AS webUrl,
  login, token_ref AS tokenRef, status, status_detail AS statusDetail, last_check_at AS lastCheckAt,
  created_at AS createdAt`;

export function gitHostTokenRef(id: string): string {
  return `secret://code/githost/${id}/token`;
}

export type CreateGitHostRequest = z.input<typeof createGitHostSchema>;

export interface GitHostServiceOptions {
  db: NovaDatabase;
  secrets: SecretStore;
  audit: AuditSink;
  /** Build a client (tests point it at a mock host). */
  client?: (host: { kind: 'github'; apiUrl: string; token: string }) => GitHostClient;
  now?: () => Date;
}

export class GitHostService {
  readonly #o: GitHostServiceOptions;
  readonly #now: () => Date;

  constructor(opts: GitHostServiceOptions) {
    this.#o = opts;
    this.#now = opts.now ?? (() => new Date());
  }

  list(accountId: string): GitHostView[] {
    const rows = this.#o.db.raw
      .prepare(`SELECT ${HOST_COLUMNS} FROM git_host WHERE account_id = ? ORDER BY created_at, id`)
      .all(accountId) as unknown as HostRow[];
    return rows.map(hostView);
  }

  get(accountId: string, id: string): GitHostView {
    return hostView(this.#row(accountId, id));
  }

  /**
   * Connect a host: the token goes to the keychain and is checked against the host. A rejected
   * token is not saved; an unreachable host is saved with status `error` (offline setup works).
   */
  async create(accountId: string, input: CreateGitHostRequest): Promise<GitHostView> {
    const req = createGitHostSchema.parse(input);
    const apiUrl = (req.apiUrl ?? 'https://api.github.com').replace(/\/+$/, '');
    const webUrl = (req.webUrl ?? 'https://github.com').replace(/\/+$/, '');
    const dup = this.#o.db.raw
      .prepare('SELECT id FROM git_host WHERE account_id = ? AND web_url = ?')
      .get(accountId, webUrl);
    if (dup)
      throw new NovaError('conflict', `${webUrl} is already connected`, {
        details: { reason: 'duplicate' },
      });
    const id = uuidv7();
    const ref = gitHostTokenRef(id);
    await this.#o.secrets.put(ref, req.token);
    let login: string | null = null;
    let status: GitHostView['status'] = 'ok';
    let detail: string | null = null;
    try {
      login = (await this.#client(req.kind, apiUrl, req.token).whoami()).login;
    } catch (err) {
      const reason = (err as NovaError).details as { reason?: unknown } | undefined;
      if (reason?.reason === 'token_rejected') {
        await this.#o.secrets.delete(ref).catch(() => false);
        throw err;
      }
      status = 'error';
      detail = errText(err);
    }
    const now = this.#now().toISOString();
    await this.#o.db.transaction(() => {
      this.#o.db.raw
        .prepare(
          `INSERT INTO git_host (id, account_id, kind, label, api_url, web_url, login, token_ref,
             status, status_detail, last_check_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          accountId,
          req.kind,
          req.label ?? new URL(webUrl).host,
          apiUrl,
          webUrl,
          login,
          ref,
          status,
          detail,
          now,
          now,
          now,
        );
    });
    await this.#o.audit.append({
      accountId,
      actor: 'user',
      kind: 'secret',
      action: 'code.githost.connected',
      resource: webUrl,
      result: status,
      detail: { hostId: id, kind: req.kind, login },
    });
    return this.get(accountId, id);
  }

  async check(accountId: string, id: string): Promise<GitHostView> {
    const r = this.#row(accountId, id);
    let login = r.login;
    let status: GitHostView['status'] = 'ok';
    let detail: string | null = null;
    try {
      login = (await (await this.client(accountId, id)).whoami()).login;
    } catch (err) {
      status = 'error';
      detail = errText(err);
    }
    const now = this.#now().toISOString();
    await this.#o.db.transaction(() => {
      this.#o.db.raw
        .prepare(
          `UPDATE git_host SET login = ?, status = ?, status_detail = ?, last_check_at = ?,
             updated_at = ? WHERE id = ?`,
        )
        .run(login, status, detail, now, now, id);
    });
    return this.get(accountId, id);
  }

  async remove(accountId: string, id: string): Promise<void> {
    const r = this.#row(accountId, id);
    const open = this.#o.db.raw
      .prepare("SELECT COUNT(*) AS n FROM code_pull_request WHERE host_id = ? AND state = 'open'")
      .get(id) as { n: number };
    if (open.n)
      throw new NovaError('conflict', 'pull requests opened through this host are still open', {
        details: { reason: 'in_use', pullRequests: open.n },
      });
    await this.#o.db.transaction(() => {
      this.#o.db.raw.prepare('DELETE FROM code_pull_request WHERE host_id = ?').run(id);
      this.#o.db.raw.prepare('DELETE FROM git_host WHERE id = ?').run(id);
    });
    await this.#o.secrets.delete(r.tokenRef).catch(() => false);
    await this.#o.audit.append({
      accountId,
      actor: 'user',
      kind: 'secret',
      action: 'code.githost.removed',
      resource: r.webUrl,
      result: 'ok',
      detail: { hostId: id },
    });
  }

  /** A client signed in with the host's token. */
  async client(accountId: string, id: string): Promise<GitHostClient> {
    const r = this.#row(accountId, id);
    const token = await this.#o.secrets.get(r.tokenRef);
    if (!token)
      throw new NovaError('validation', "the host's token is missing from the keychain", {
        details: { reason: 'token_missing' },
      });
    return this.#client(r.kind, r.apiUrl, token);
  }

  /** The token, for authenticating a push to the host's web origin. */
  async token(accountId: string, id: string): Promise<string | null> {
    return this.#o.secrets.get(this.#row(accountId, id).tokenRef);
  }

  /** The host a remote URL points at (by web origin), or the given one. */
  match(accountId: string, remoteUrl: string, hostId?: string): GitHostView | null {
    if (hostId) return this.get(accountId, hostId);
    const parsed = parseRemote(remoteUrl);
    if (!parsed) return null;
    return (
      this.list(accountId).find(
        (h) => h.webUrl.toLowerCase().replace(/^http:/, 'https:') === parsed.origin.toLowerCase(),
      ) ?? null
    );
  }

  #client(kind: 'github', apiUrl: string, token: string): GitHostClient {
    if (this.#o.client) return this.#o.client({ kind, apiUrl, token });
    return new GitHubClient({ apiUrl, token });
  }

  #row(accountId: string, id: string): HostRow {
    const r = this.#o.db.raw
      .prepare(`SELECT ${HOST_COLUMNS} FROM git_host WHERE id = ? AND account_id = ?`)
      .get(id, accountId) as HostRow | undefined;
    if (!r) throw new NovaError('not_found', 'Git host not found');
    return r;
  }
}

function hostView(r: HostRow): GitHostView {
  return {
    id: r.id,
    kind: r.kind,
    label: r.label,
    apiUrl: r.apiUrl,
    webUrl: r.webUrl,
    login: r.login,
    status: r.status,
    detail: r.statusDetail,
    checkedAt: r.lastCheckAt,
    createdAt: r.createdAt,
  };
}
