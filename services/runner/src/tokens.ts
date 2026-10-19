// Runner tokens (contracts/rest-api.md §5, docs/12): one bearer token per Hub. Only a hash of each
// token is kept at rest: the token file holds `sha256:<hex> <label>` lines, and the token itself is
// shown once, when `nova-runner token add` creates it. A plaintext token in the file is refused, so
// a copied token never sits on the runner's disk. Each token is a tenant: it sees only the
// environments, runs and snapshots it created.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

export const RUNNER_TOKEN_PREFIX = 'nvrun_';
const TOKEN = /^nvrun_[A-Za-z0-9_-]{43}$/;
const HASH_LINE = /^sha256:([0-9a-f]{64})(?:\s+(\S.{0,99}))?$/;

export interface RunnerToken {
  /** A stable id derived from the hash (owner of environments, runs and snapshots). */
  id: string;
  hash: string;
  label: string;
}

/** A new random token (32 bytes, base64url). */
export function newRunnerToken(): string {
  return `${RUNNER_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
}

export function tokenHash(token: string): string {
  return createHash('sha256').update('nova-runner-token\0').update(token, 'utf8').digest('hex');
}

export function tokenRecord(hash: string, label = 'hub'): RunnerToken {
  return { id: hash.slice(0, 16), hash, label };
}

/** Parse a token file; throws with the line number on anything that is not a hash line. */
export function parseTokenFile(text: string): RunnerToken[] {
  const out: RunnerToken[] = [];
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    if (TOKEN.test(line.split(/\s+/)[0] ?? ''))
      throw new Error(
        `token file line ${i + 1} holds a plaintext token; store only its hash (sha256:${tokenHash(line.split(/\s+/)[0]!)})`,
      );
    const m = HASH_LINE.exec(line);
    if (!m) throw new Error(`token file line ${i + 1} is not "sha256:<64 hex> [label]"`);
    out.push(tokenRecord(m[1]!, m[2]?.trim() || 'hub'));
  });
  return out;
}

export function readTokenFile(path: string): RunnerToken[] {
  return parseTokenFile(readFileSync(path, 'utf8'));
}

/** Create a token, append its hash to the file (mode 0600) and return the token (shown once). */
export function addToken(path: string, label = 'hub'): { token: string; record: RunnerToken } {
  const clean = label.replace(/\s+/g, '-').slice(0, 100) || 'hub';
  const token = newRunnerToken();
  const hash = tokenHash(token);
  if (!existsSync(path))
    writeFileSync(path, '# Nova runner tokens: sha256 hashes only (nova-runner token add)\n', {
      mode: 0o600,
    });
  appendFileSync(path, `sha256:${hash} ${clean}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return { token, record: tokenRecord(hash, clean) };
}

/** Look a presented token up by its hash (constant-time compare on the match). */
export function findToken(tokens: Map<string, RunnerToken>, presented: string): RunnerToken | null {
  if (!TOKEN.test(presented)) return null;
  const hash = tokenHash(presented);
  const hit = tokens.get(hash);
  if (!hit) return null;
  const a = Buffer.from(hit.hash, 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b) ? hit : null;
}
