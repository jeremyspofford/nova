// A mock Git host for offline tests (FR-070): an in-process HTTP server answering the GitHub REST
// endpoints Nova uses (the account, a repository, branch protection, pull requests, check runs and
// commit statuses). It checks the bearer token, records every request, and lets a test set
// protected branches and the checks of a commit.
import { execFileSync } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockCheck {
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion?: 'success' | 'failure' | 'neutral' | 'cancelled' | 'timed_out' | null;
  summary?: string;
}

export interface MockPull {
  number: number;
  title: string;
  body: string;
  head: string;
  base: string;
  draft: boolean;
  state: 'open' | 'closed';
  merged: boolean;
  headSha: string;
}

export interface MockRepo {
  defaultBranch: string;
  protected: Set<string>;
  /** Branch name → its head sha; pulls read their head from here, else from `bare`. */
  heads: Map<string, string>;
  /** A bare repository standing for the host's copy: pushed branches are read from it. */
  bare: string | null;
  pulls: MockPull[];
  checks: Map<string, MockCheck[]>;
  statuses: Map<string, { context: string; state: 'pending' | 'success' | 'failure' | 'error' }[]>;
}

export interface MockGitHost {
  url: string;
  token: string;
  login: string;
  repos: Map<string, MockRepo>;
  requests: { method: string; path: string; auth: string | null }[];
  repo(name: string): MockRepo;
  close(): Promise<void>;
}

export async function startMockGitHost(
  opts: { token?: string; login?: string } = {},
): Promise<MockGitHost> {
  const token = opts.token ?? 'ghp_faketoken0123456789abcdefABCDEF01';
  const login = opts.login ?? 'nova-tester';
  const repos = new Map<string, MockRepo>();
  const requests: MockGitHost['requests'] = [];
  const repo = (name: string): MockRepo => {
    let r = repos.get(name);
    if (!r) {
      r = {
        defaultBranch: 'main',
        protected: new Set(),
        heads: new Map(),
        bare: null,
        pulls: [],
        checks: new Map(),
        statuses: new Map(),
      };
      repos.set(name, r);
    }
    return r;
  };

  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const readBody = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let b = '';
      req.on('data', (c: Buffer) => (b += c.toString('utf8')));
      req.on('end', () => resolve(b));
    });
  /** The head of a branch: set by the test, else read from the bare repository. */
  const headOf = (r: MockRepo, branch: string): string | null => {
    const set = r.heads.get(branch);
    if (set) return set;
    if (!r.bare) return null;
    try {
      return execFileSync('git', ['rev-parse', '-q', '--verify', `refs/heads/${branch}`], {
        cwd: r.bare,
        encoding: 'utf8',
      }).trim();
    } catch {
      return null;
    }
  };
  const pullJson = (name: string, p: MockPull) => ({
    number: p.number,
    html_url: `https://github.example/${name}/pull/${p.number}`,
    state: p.state,
    merged: p.merged,
    draft: p.draft,
    title: p.title,
    head: { ref: p.head, sha: headOf(repo(name), p.head) ?? p.headSha },
    base: { ref: p.base },
  });

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const auth = req.headers.authorization ?? null;
      requests.push({ method: req.method ?? 'GET', path: url.pathname + url.search, auth });
      if (auth !== `Bearer ${token}`) return send(res, 401, { message: 'Bad credentials' });
      const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      if (req.method === 'GET' && url.pathname === '/user') return send(res, 200, { login });
      if (parts[0] !== 'repos' || parts.length < 3) return send(res, 404, { message: 'Not Found' });
      const name = `${parts[1]}/${parts[2]}`;
      const r = repo(name);
      const rest = parts.slice(3);
      if (req.method === 'GET' && rest.length === 0)
        return send(res, 200, { full_name: name, default_branch: r.defaultBranch, private: true });
      if (req.method === 'GET' && rest[0] === 'branches' && rest[1]) {
        const branch = rest.slice(1).join('/');
        if (!headOf(r, branch) && branch !== r.defaultBranch)
          return send(res, 404, { message: 'Branch not found' });
        return send(res, 200, { name: branch, protected: r.protected.has(branch) });
      }
      if (rest[0] === 'pulls' && rest.length === 1 && req.method === 'POST') {
        const body = JSON.parse(await readBody(req)) as {
          title: string;
          body: string;
          head: string;
          base: string;
          draft: boolean;
        };
        if (body.head === body.base)
          return send(res, 422, {
            message: 'Validation Failed',
            errors: [{ message: 'same branch' }],
          });
        const p: MockPull = {
          number: r.pulls.length + 1,
          title: body.title,
          body: body.body,
          head: body.head,
          base: body.base,
          draft: body.draft,
          state: 'open',
          merged: false,
          headSha: headOf(r, body.head) ?? '0'.repeat(40),
        };
        r.pulls.push(p);
        return send(res, 201, pullJson(name, p));
      }
      if (rest[0] === 'pulls' && rest.length === 1 && req.method === 'GET') {
        const head = url.searchParams.get('head')?.split(':').pop();
        const state = url.searchParams.get('state') ?? 'open';
        return send(
          res,
          200,
          r.pulls
            .filter((p) => (!head || p.head === head) && (state === 'all' || p.state === state))
            .map((p) => pullJson(name, p)),
        );
      }
      if (rest[0] === 'pulls' && rest[1] && req.method === 'GET') {
        const p = r.pulls.find((x) => x.number === Number(rest[1]));
        return p ? send(res, 200, pullJson(name, p)) : send(res, 404, { message: 'Not Found' });
      }
      if (rest[0] === 'commits' && rest[1] && rest[2] === 'check-runs' && req.method === 'GET') {
        const checks = r.checks.get(rest[1]) ?? [];
        return send(res, 200, {
          total_count: checks.length,
          check_runs: checks.map((c, i) => ({
            id: i + 1,
            name: c.name,
            status: c.status,
            conclusion: c.conclusion ?? null,
            html_url: `https://github.example/${name}/runs/${i + 1}`,
            output: { title: c.name, summary: c.summary ?? null },
          })),
        });
      }
      if (rest[0] === 'commits' && rest[1] && rest[2] === 'status' && req.method === 'GET') {
        const statuses = r.statuses.get(rest[1]) ?? [];
        return send(res, 200, {
          state: 'pending',
          statuses: statuses.map((s) => ({ ...s, target_url: null, description: null })),
        });
      }
      return send(res, 404, { message: 'Not Found' });
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    token,
    login,
    repos,
    requests,
    repo,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
