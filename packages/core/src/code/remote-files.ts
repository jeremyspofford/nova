// The file tools' view of a Code session folder on another machine (M7 security fix; docs/10 §2):
// SSH, WSL and device sessions. The tools (`fs.*`, tools/fs-remote.ts) act on that folder through
// the session's transport, never on the Hub's disk at the same path. Every operation checks there
// that the parent folder, resolved, is still inside the session folder (resolved), and never
// follows a link: a link is reported, removed as itself, and never read or written through.
// The session's commands go to the same machine (`RemoteSessionSandbox` wraps its helper
// sandbox and carries the files), so a thread whose machine cannot be reached fails closed rather
// than falling back to the Hub's own sandbox.
import { NovaError } from '@nova/shared';
import type { RemoteFileEntry, RemoteFileStat, RemoteFiles } from '../tools/fs-remote.ts';
import { PathDenied } from '../tools/roots.ts';
import type { ExecRequest, ExecResult, SandboxClient } from '../tools/types.ts';
import type { CodeWorkspace } from './transport.ts';

/** Folders `fs.list` names but does not walk into. */
const SKIP_DIRS = ['.git', 'node_modules', '.hg', '.svn', '__pycache__'];

/**
 * Resolves `$t` (the target) for `$1` (the folder) and `$2` (a path relative to it): the parent,
 * resolved, must stay inside the resolved folder (exit 5 otherwise); a missing parent is exit 4.
 */
const LOCATE = [
  'r=$(cd "$1" 2>/dev/null && pwd -P) || exit 3',
  'if [ -z "$2" ]; then t="$r"; else',
  '  pd=$(cd "$(dirname "$1/$2")" 2>/dev/null && pwd -P) || exit 4',
  '  case "$pd/" in "$r"/*) ;; *) exit 5;; esac',
  '  t="$pd/$(basename "$2")"',
  'fi',
].join('\n');

const STAT = `${LOCATE}
if [ -L "$t" ]; then echo "symlink 0"
elif [ -d "$t" ]; then echo "dir 0"
elif [ -f "$t" ]; then echo "file $(wc -c < "$t" | tr -d ' ')"
elif [ -e "$t" ]; then echo "other 0"
else echo none; fi`;

const READ = `${LOCATE}
[ -L "$t" ] && exit 6
[ -f "$t" ] || exit 7
wc -c < "$t" | tr -d ' '
head -c "$3" "$t"`;

const ENTRY =
  'for f; do if [ -L "$f" ]; then printf "symlink 0 %s\\0" "$f"; elif [ -d "$f" ]; then printf "dir 0 %s\\0" "$f"; elif [ -f "$f" ]; then printf "file %s %s\\0" "$(wc -c < "$f" | tr -d " ")" "$f"; else printf "other 0 %s\\0" "$f"; fi; done';

const LIST = `${LOCATE}
[ -L "$t" ] && exit 6
[ -d "$t" ] || exit 7
cd "$t" || exit 4
find . -mindepth 1 -maxdepth "$3" \\( -type d \\( ${SKIP_DIRS.map((d) => `-name '${d}'`).join(' -o ')} \\) -prune -exec sh -c '${ENTRY}' nova {} + \\) -o -exec sh -c '${ENTRY}' nova {} +`;

const REMOVE = `${LOCATE}
[ -z "$2" ] && exit 5
if [ -L "$t" ] || [ ! -d "$t" ]; then rm -f -- "$t"; elif [ "$3" = 1 ]; then rm -rf -- "$t"; else exit 7; fi`;

/** A session folder on another machine, through its workspace's transport. */
export class WorkspaceRemoteFiles implements RemoteFiles {
  readonly label: string;
  readonly root: string;
  readonly access: 'read' | 'write';
  readonly #ws: CodeWorkspace;

  constructor(ws: CodeWorkspace, root: string, access: 'read' | 'write', label: string) {
    this.#ws = ws;
    this.root = root;
    this.access = access;
    this.label = label;
  }

  async stat(rel: string): Promise<RemoteFileStat | null> {
    const r = await this.#sh(STAT, [rel]);
    if (r.code === 4) return null;
    this.#check(r.code, rel);
    const [kind, size] = r.stdout.toString('utf8').trim().split(' ');
    if (!kind || kind === 'none') return null;
    return { kind: kind as RemoteFileStat['kind'], size: Number(size) || 0 };
  }

  async read(rel: string, maxBytes: number): Promise<{ data: Buffer; size: number }> {
    const r = await this.#sh(READ, [rel, String(maxBytes)], undefined, maxBytes + 64);
    this.#check(r.code, rel);
    const nl = r.stdout.indexOf(10);
    if (nl < 0) throw new NovaError('server_error', `${rel} could not be read in ${this.label}`);
    return {
      size: Number(r.stdout.subarray(0, nl).toString('utf8')) || 0,
      data: r.stdout.subarray(nl + 1),
    };
  }

  async list(rel: string, depth: number, max: number): Promise<RemoteFileEntry[]> {
    const r = await this.#sh(LIST, [rel, String(Math.max(1, depth))], undefined, 32 * 1024 * 1024);
    this.#check(r.code, rel);
    const entries: RemoteFileEntry[] = [];
    for (const rec of r.stdout.toString('utf8').split('\0')) {
      if (!rec) continue;
      const m = /^(symlink|dir|file|other) (\d+) \.\/(.*)$/s.exec(rec);
      if (!m) continue;
      entries.push({ kind: m[1] as RemoteFileEntry['kind'], size: Number(m[2]), rel: m[3]! });
    }
    // Tree order: by path, a folder's entries after it, folders first among siblings.
    const key = (e: RemoteFileEntry) =>
      e.rel
        .split('/')
        .map((part, i, all) => (i < all.length - 1 || e.kind === 'dir' ? `0${part}` : `1${part}`));
    entries.sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      for (let i = 0; i < Math.min(ka.length, kb.length); i++)
        if (ka[i] !== kb[i]) return ka[i]!.localeCompare(kb[i]!);
      return ka.length - kb.length;
    });
    return entries.slice(0, max);
  }

  async write(rel: string, data: Buffer): Promise<void> {
    if (this.access !== 'write') throw new PathDenied(rel, 'the session folder is read-only here');
    await this.#ws.fs.writeWithin(this.root, rel, data, 0o644);
  }

  async remove(rel: string, recursive: boolean): Promise<void> {
    if (this.access !== 'write') throw new PathDenied(rel, 'the session folder is read-only here');
    const r = await this.#sh(REMOVE, [rel, recursive ? '1' : '0']);
    this.#check(r.code, rel);
  }

  async #sh(script: string, args: string[], input?: Buffer, maxBytes?: number) {
    const t = this.#ws.transport;
    if (!t)
      throw new NovaError('capability_missing', `the files in ${this.label} are not reachable`);
    return t.run({
      argv: ['sh', '-c', script, 'nova-files', this.root, ...args],
      cwd: '/',
      ...(input ? { input } : {}),
      ...(maxBytes ? { maxBytes } : {}),
    });
  }

  #check(code: number, rel: string): void {
    if (code === 0) return;
    if (code === 3)
      throw new NovaError('not_found', `the session folder is missing in ${this.label}`);
    if (code === 4) throw new NovaError('not_found', `${rel || '.'} does not exist`);
    if (code === 5) throw new PathDenied(rel, 'a link leads outside the session folder');
    if (code === 6) throw new PathDenied(rel, 'links are not followed in a remote session folder');
    if (code === 7) throw new PathDenied(rel, 'not a regular file or folder');
    throw new NovaError(
      'server_error',
      `the file operation failed in ${this.label} (exit ${code})`,
    );
  }
}

/**
 * The sandbox of a session on another machine (SSH, WSL, a device): its helper runs the
 * commands, and it carries the session folder's files for the file tools. When the machine
 * cannot be reached, commands are refused and `files` is null: nothing falls back to the Hub.
 */
export class RemoteSessionSandbox implements SandboxClient {
  readonly files: RemoteFiles | null;
  readonly #inner: SandboxClient | null;
  readonly #why: string;

  constructor(inner: SandboxClient | null, files: RemoteFiles | null, why = 'unreachable') {
    this.#inner = inner;
    this.files = files;
    this.#why = why;
  }

  get substrate(): SandboxClient['substrate'] {
    return this.#inner?.substrate ?? null;
  }

  available(): Promise<{ ok: boolean; detail: string }> {
    return this.#inner
      ? this.#inner.available()
      : Promise.resolve({ ok: false, detail: `the session's machine is ${this.#why}` });
  }

  exec(req: ExecRequest): Promise<ExecResult> {
    return this.#use().exec(req);
  }

  poll(sessionId: string, yieldMs: number, signal: AbortSignal): Promise<ExecResult> {
    return this.#use().poll(sessionId, yieldMs, signal);
  }

  write(
    sessionId: string,
    input: { text?: string; closeStdin?: boolean; signal?: 'interrupt' | 'terminate' },
  ): Promise<void> {
    return this.#use().write(sessionId, input);
  }

  killTurn(turnId: string): Promise<void> {
    return this.#inner ? this.#inner.killTurn(turnId) : Promise.resolve();
  }

  #use(): SandboxClient {
    if (!this.#inner)
      throw new NovaError('sandbox_unavailable', `the session's machine is ${this.#why}`, {
        details: { reason: 'remote_unavailable' },
      });
    return this.#inner;
  }
}
