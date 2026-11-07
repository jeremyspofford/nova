// Which build this Nova is running, and whether it is the latest one merged (the owner's versioning
// item: docs/builder-packet/nova-versioning-changelog-2026-11-03.md and its 2026-11-06 delta). The
// version is package.json's, handed in by the server. The commit comes from NOVA_BUILD_COMMIT, set
// by whatever launched Nova, or else the code's own git checkout. "Latest merged" comes only from a
// file the deploy step writes (scripts/deploy-record.sh): never from GitHub or any network.
//
// Read once at startup, except the latest-merged file, read on every ask: it changes under a running
// Nova (the merge queue writes it before it redeploys), which is exactly when "behind" is true.
import { execFileSync } from 'node:child_process';
import { closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { join, resolve } from 'node:path';

// The latest-merged file is two short fields; anything bigger isn't one.
export const LATEST_MAX_BYTES = 4096;
// A commit's short form, as git shows it in this repository.
export const SHORT = 8;
const COMMIT = /^[0-9a-f]{40}$/;
// An ISO 8601 date and time with its zone, as git (%cI), GitHub and `date -u +%Y-%m-%dT%H:%M:%SZ` write it.
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

export interface BuildIdentity {
  version: string;
  commit: string | null;
  commit_short: string | null;
  // Exactly one of the two: built_at when the launcher said when the build was made (NOVA_BUILD_DATE),
  // started_at (this process's start) when it didn't. Never one passed off as the other.
  built_at?: string;
  started_at?: string;
}
export interface Latest { commit: string; merged_at: string; source: string }
export type VersionView = BuildIdentity & { latest: Latest | null; behind: boolean | null; words: string };

export interface BuildOptions {
  version: string;
  // Where the code runs from (a git checkout, a release slot or the preview worktree).
  codeRoot: string;
  // Nova's data home: the latest-merged file is <home>/deploy/latest.json unless NOVA_LATEST_FILE says.
  home: string;
  env?: Record<string, string | undefined>;
  // When this process started (tests fix it).
  startedAt?: Date;
}

export const commitOf = (s: unknown): string | null => {
  const c = typeof s === 'string' ? s.trim().toLowerCase() : '';
  return COMMIT.test(c) ? c : null;
};
export const isoOf = (s: unknown): string | null => {
  if (typeof s !== 'string' || !ISO.test(s.trim())) return null;
  const t = Date.parse(s.trim());
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
const short = (c: string | null) => (c ? c.slice(0, SHORT) : null);

// The commit the code at codeRoot is checked out at, or null when it isn't a checkout git can read.
function gitHead(codeRoot: string): string | null {
  try {
    return commitOf(execFileSync('git', ['-C', codeRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch {
    return null;
  }
}

export function identity(o: BuildOptions): BuildIdentity {
  const env = o.env ?? process.env;
  // A NOVA_BUILD_COMMIT that isn't a full commit is ignored, and git asked instead.
  const commit = commitOf(env.NOVA_BUILD_COMMIT) ?? gitHead(o.codeRoot);
  const built = isoOf(env.NOVA_BUILD_DATE);
  return {
    version: o.version, commit, commit_short: short(commit),
    ...(built ? { built_at: built } : { started_at: (o.startedAt ?? new Date(performance.timeOrigin)).toISOString() }),
  };
}

// The deploy step's record, checked at the boundary: a plain file (not a link), small, JSON with a
// full commit and an ISO date. Anything else, or no file, is "not known": null.
export function readLatest(path: string): Latest | null {
  let fd: number | null = null;
  try {
    if (!lstatSync(path).isFile()) return null;
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    if (size > LATEST_MAX_BYTES) return null;
    const buf = Buffer.alloc(size);
    readSync(fd, buf, 0, size, 0);
    const j = JSON.parse(buf.toString('utf8')) as unknown;
    if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
    const r = j as Record<string, unknown>;
    const commit = commitOf(r.commit);
    const merged_at = isoOf(r.merged_at);
    return commit && merged_at ? { commit, merged_at, source: path } : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

// What Nova says about it, in the About area, the footer and chat alike.
export function words(v: Pick<VersionView, 'commit' | 'latest' | 'behind'>): string {
  const running = short(v.commit);
  if (!running) return v.latest ? `Nova doesn't know which commit it is running; latest merged ${short(v.latest.commit)}.` : "Nova doesn't know which commit it is running, or the latest merged build.";
  if (!v.latest) return `Running ${running}; Nova doesn't know the latest merged build.`;
  return v.behind ? `Running ${running}, latest merged ${short(v.latest.commit)} — redeploy pending.` : `Running ${running}, the latest merged build.`;
}

export class Build {
  readonly identity: BuildIdentity;
  readonly latestPath: string;

  constructor(o: BuildOptions) {
    const env = o.env ?? process.env;
    this.identity = identity({ ...o, env });
    this.latestPath = env.NOVA_LATEST_FILE?.trim() ? resolve(env.NOVA_LATEST_FILE.trim()) : join(o.home, 'deploy', 'latest.json');
  }

  // GET /api/v1/version. behind is null whenever either side isn't known.
  view(): VersionView {
    const latest = readLatest(this.latestPath);
    const behind = latest && this.identity.commit ? latest.commit !== this.identity.commit : null;
    return { ...this.identity, latest, behind, words: words({ commit: this.identity.commit, latest, behind }) };
  }
}
