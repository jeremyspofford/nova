// Where managed policy comes from (FR-106, docs/12 §10, ADR-078, ADR-097 D4).
//
// The local file sits in an OS-protected place: Linux `/etc/nova/managed-settings.json`, macOS
// `/Library/Application Support/Nova/managed-settings.json`, Windows
// `%ProgramData%\Nova\managed-settings.json`. It is trusted because only an administrator can
// write it, so it is read only when it is a regular file owned by root, writable by nobody else,
// in folders only root (or a sticky folder's rules) lets anyone change. A file that fails these
// checks is ignored and reported, never partially applied. Windows file ACLs cannot be read with
// Node's file API, so there the file is ignored and reported until an ACL check exists.
// `NOVA_MANAGED_SETTINGS_FILE` adds a file only in tests (NODE_ENV=test, or a Hub started with
// --allow-test-policy), layered over the protected one and owned by the Hub's own user.
//
// The remote policy is fetched from the URL the local file names and must be signed by the
// Ed25519 key it pins: `{v: 1, policy: <base64 of the policy JSON>, signature: <base64url>}`,
// signed over "nova-managed-policy-v1\n" + the SHA-256 (hex) of the policy bytes. The last good
// copy is kept on disk and checked again against the pinned key whenever it is read.
import { createHash, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { managedPolicySchema, type ManagedPolicyDocument, type ManagedRemote } from '@nova/shared';

/** The signature's domain tag (a remote policy signature cannot be replayed as another kind). */
export const MANAGED_SIGNATURE_DOMAIN = 'nova-managed-policy-v1\n';
/** Policy documents above this size are refused. */
export const MANAGED_MAX_BYTES = 1024 * 1024;

/** What the file checks read; tests replace it to stand in for root-owned files. */
export interface ManagedFileInfo {
  uid: number;
  mode: number;
  isFile(): boolean;
  isDirectory(): boolean;
}

export interface ManagedFs {
  stat(path: string): Promise<ManagedFileInfo>;
  realpath(path: string): Promise<string>;
  readFile(path: string): Promise<Buffer>;
}

export const nodeManagedFs: ManagedFs = {
  stat: (p) => stat(p),
  realpath: (p) => realpath(p),
  readFile: (p) => readFile(p),
};

/** The OS-protected location of the local policy file (ADR-097 D4). */
export function defaultManagedPath(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  switch (platform) {
    case 'darwin':
      return '/Library/Application Support/Nova/managed-settings.json';
    case 'win32':
      return join(env.ProgramData ?? 'C:\\ProgramData', 'Nova', 'managed-settings.json');
    default:
      return '/etc/nova/managed-settings.json';
  }
}

export interface ManagedPathChoice {
  /** The OS-protected file: always read. */
  path: string;
  /** NOVA_MANAGED_SETTINGS_FILE when honoured: layered over the protected file, never instead. */
  testPath: string | null;
  /** The override was set but not honoured (not a test run): reported. */
  overrideRefused: string | null;
}

/**
 * The local policy paths: the platform's protected location, always; and NOVA_MANAGED_SETTINGS_FILE
 * as an extra layer only when NODE_ENV is `test` or the Hub was started with --allow-test-policy
 * (ADR-097 D4). The layer can only add restrictions, so neither switch weakens what the
 * administrator's file sets.
 */
export function resolveManagedPath(
  opts: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    argv?: readonly string[];
    allowTestPolicy?: boolean;
  } = {},
): ManagedPathChoice {
  const env = opts.env ?? process.env;
  const argv = opts.argv ?? process.argv;
  const path = defaultManagedPath(opts.platform, env);
  const override = env.NOVA_MANAGED_SETTINGS_FILE;
  if (!override) return { path, testPath: null, overrideRefused: null };
  const allowed =
    env.NODE_ENV === 'test' ||
    opts.allowTestPolicy === true ||
    argv.includes('--allow-test-policy');
  if (allowed) return { path, testPath: resolve(override), overrideRefused: null };
  return {
    path,
    testPath: null,
    overrideRefused:
      'NOVA_MANAGED_SETTINGS_FILE is honoured only in tests (NODE_ENV=test or --allow-test-policy); it was ignored',
  };
}

export type ProtectedFileCheck =
  | { status: 'absent' }
  | { status: 'ok'; realPath: string; note: string | null }
  | { status: 'ignored'; problem: string };

export interface ProtectedFileOptions {
  fs?: ManagedFs;
  platform?: NodeJS.Platform;
  /** The user the file must belong to: root (0), or the Hub's user under the test override. */
  ownerUid?: number;
  /** The user the Hub runs as (null where there is none). */
  hubUid?: number | null;
}

function ancestors(path: string): string[] {
  const out: string[] = [];
  let d = dirname(path);
  for (;;) {
    out.push(d);
    const up = dirname(d);
    if (up === d) return out;
    d = up;
  }
}

const GROUP_OR_OTHER_WRITE = 0o022;
const STICKY = 0o1000;

/**
 * Whether the policy file may be trusted (ADR-078): a regular file owned by `ownerUid`, not
 * writable by group or others, and every folder above it (of the path given and of its real path)
 * owned by root or `ownerUid` and not writable by group or others unless sticky.
 */
export async function checkProtectedFile(
  path: string,
  opts: ProtectedFileOptions = {},
): Promise<ProtectedFileCheck> {
  const fs = opts.fs ?? nodeManagedFs;
  const ownerUid = opts.ownerUid ?? 0;
  const hubUid = opts.hubUid === undefined ? (process.getuid?.() ?? null) : opts.hubUid;
  let file: ManagedFileInfo;
  try {
    file = await fs.stat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'absent' };
    return { status: 'ignored', problem: `the file cannot be read (${errCode(err)})` };
  }
  if ((opts.platform ?? process.platform) === 'win32' && ownerUid === 0)
    return {
      status: 'ignored',
      problem:
        'Nova cannot check who may change this file on Windows yet, so it is not trusted (ADR-097)',
    };
  let real: string;
  try {
    real = await fs.realpath(path);
  } catch (err) {
    return { status: 'ignored', problem: `the file cannot be resolved (${errCode(err)})` };
  }
  if (!file.isFile()) return { status: 'ignored', problem: 'it is not a regular file' };
  if (hubUid !== null && hubUid !== ownerUid && file.uid === hubUid)
    return {
      status: 'ignored',
      problem: 'it is owned by the user the Hub runs as, who must not be able to change it',
    };
  if (file.uid !== ownerUid)
    return {
      status: 'ignored',
      problem: `it is owned by user ${file.uid}, not ${ownerUid === 0 ? 'root' : `user ${ownerUid}`}`,
    };
  if (file.mode & GROUP_OR_OTHER_WRITE)
    return { status: 'ignored', problem: 'it is writable by its group or by other users' };
  for (const dir of new Set([...ancestors(real), ...ancestors(resolve(path))])) {
    let d: ManagedFileInfo;
    try {
      d = await fs.stat(dir);
    } catch (err) {
      return { status: 'ignored', problem: `the folder ${dir} cannot be read (${errCode(err)})` };
    }
    if (d.uid !== 0 && d.uid !== ownerUid)
      return {
        status: 'ignored',
        problem: `the folder ${dir} is owned by user ${d.uid}, who could replace the file`,
      };
    if (d.mode & GROUP_OR_OTHER_WRITE && !(d.mode & STICKY))
      return {
        status: 'ignored',
        problem: `the folder ${dir} is writable by its group or by other users`,
      };
  }
  const note =
    hubUid !== null && hubUid === 0 && ownerUid === 0
      ? 'the Hub runs as root, so nothing separates the policy from the Hub itself'
      : null;
  return { status: 'ok', realPath: real, note };
}

function errCode(err: unknown): string {
  return (err as NodeJS.ErrnoException).code ?? (err instanceof Error ? err.message : 'error');
}

export type ParsedPolicy =
  { ok: true; doc: ManagedPolicyDocument } | { ok: false; problem: string };

/** Parse and validate a policy document (JSON). */
export function parseManagedPolicy(bytes: Buffer): ParsedPolicy {
  if (bytes.length > MANAGED_MAX_BYTES) return { ok: false, problem: 'larger than 1 MB' };
  let json: unknown;
  try {
    json = JSON.parse(bytes.toString('utf8'));
  } catch (err) {
    return {
      ok: false,
      problem: `not valid JSON (${err instanceof Error ? err.message : 'error'})`,
    };
  }
  const parsed = managedPolicySchema.safeParse(json);
  if (!parsed.success)
    return {
      ok: false,
      problem: parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join('.') || '(top)'}: ${i.message}`)
        .join('; '),
    };
  return { ok: true, doc: parsed.data };
}

// ---- the signed remote policy -----------------------------------------------------------------

export const managedEnvelopeSchema = z
  .object({
    v: z.literal(1),
    policy: z
      .string()
      .min(1)
      .max(Math.ceil((MANAGED_MAX_BYTES * 4) / 3) + 8)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/),
    signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
  })
  .strict();
export type ManagedEnvelope = z.infer<typeof managedEnvelopeSchema>;

function signedMessage(policy: Buffer): Buffer {
  return Buffer.from(
    MANAGED_SIGNATURE_DOMAIN + createHash('sha256').update(policy).digest('hex'),
    'utf8',
  );
}

/** Sign a policy document for remote delivery (administrators' tooling and tests). */
export function signManagedPolicy(policy: Buffer, privateKey: KeyObject): ManagedEnvelope {
  return {
    v: 1,
    policy: policy.toString('base64'),
    signature: sign(null, signedMessage(policy), privateKey).toString('base64url'),
  };
}

/** The raw public key, base64url, as a policy's `remote.publicKey` pins it. */
export function managedPublicKey(key: KeyObject): string {
  const jwk = key.export({ format: 'jwk' }) as { x?: string };
  if (!jwk.x) throw new Error('not an Ed25519 key');
  return jwk.x;
}

export type VerifiedEnvelope = { ok: true; bytes: Buffer } | { ok: false; problem: string };

/** Check a remote policy envelope against the pinned key; the policy bytes when it verifies. */
export function verifyManagedEnvelope(raw: unknown, publicKey: string): VerifiedEnvelope {
  const env = managedEnvelopeSchema.safeParse(raw);
  if (!env.success) return { ok: false, problem: 'not a signed policy envelope' };
  let key: KeyObject;
  try {
    key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: publicKey }, format: 'jwk' });
  } catch {
    return { ok: false, problem: 'the pinned public key is not an Ed25519 key' };
  }
  const bytes = Buffer.from(env.data.policy, 'base64');
  const signature = Buffer.from(env.data.signature, 'base64url');
  const good = (() => {
    try {
      return verify(null, signedMessage(bytes), key, signature);
    } catch {
      return false;
    }
  })();
  return good
    ? { ok: true, bytes }
    : { ok: false, problem: 'the signature does not match the pinned key' };
}

export type ManagedFetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Fetch the remote policy envelope: https only (plain http only when `allowInsecure`, for tests
 * against 127.0.0.1), no redirects, at most 1 MB, bounded in time.
 */
export async function fetchManagedEnvelope(
  remote: Pick<ManagedRemote, 'url'>,
  opts: { fetch?: ManagedFetch; timeoutMs?: number; allowInsecure?: boolean } = {},
): Promise<{ ok: true; body: unknown } | { ok: false; problem: string }> {
  let url: URL;
  try {
    url = new URL(remote.url);
  } catch {
    return { ok: false, problem: 'the remote policy URL is not a URL' };
  }
  if (url.protocol !== 'https:' && !(opts.allowInsecure && url.protocol === 'http:'))
    return { ok: false, problem: 'the remote policy URL must use https' };
  const doFetch = opts.fetch ?? ((u: string, i: RequestInit) => fetch(u, i));
  try {
    const res = await doFetch(url.toString(), {
      redirect: 'error',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
    if (!res.ok) return { ok: false, problem: `the server answered HTTP ${res.status}` };
    const len = Number(res.headers.get('content-length') ?? '0');
    if (len > MANAGED_MAX_BYTES * 2) return { ok: false, problem: 'the response is too large' };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MANAGED_MAX_BYTES * 2)
      return { ok: false, problem: 'the response is too large' };
    try {
      return { ok: true, body: JSON.parse(buf.toString('utf8')) as unknown };
    } catch {
      return { ok: false, problem: 'the response is not JSON' };
    }
  } catch (err) {
    return {
      ok: false,
      problem: `the remote policy could not be fetched (${err instanceof Error ? err.message : 'error'})`,
    };
  }
}
