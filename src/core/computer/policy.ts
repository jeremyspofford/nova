// Nova Computer's rules (M10a, docs/plans/M10a.md), pure so they are tested without Docker: how a
// workspace's container is started and a command run in it, which folders may be a project, what an
// egress declaration may say, and the tier each action takes.
import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { CoreError } from '../errors.ts';
import { HOST, normalizeHost } from '../browser/plan.ts';
import type { Tier } from '../envelope.ts';
import type { Egress } from '../workers.ts';

// The one image, pinned by digest (Docker's official node image: Node 26.13.0, git 2.47.3 and a
// shell, on Debian 13). The slim and Alpine variants have no git, and installing it on top would be
// a second download. LEDGER, dependencies.
export const IMAGE = 'node:26-trixie@sha256:6d2c7d5d074bf72f81ddc252b4fbb5d625bc028eeda49cb4b8c2ff8eda1ee617';
export const IMAGE_ABOUT = 'Node 26, git and a shell (Docker’s official node:26-trixie image, pinned by digest)';
export const WORKDIR = '/workspace';
// Where the egress relay listens inside a workspace that may reach outside (egress.ts).
export const RELAY_PORT = 3128;
export const PROXY_URL = `http://127.0.0.1:${RELAY_PORT}`;
export const LIMITS = Object.freeze({ memory: '2g', cpus: '2', pids: 512, nofile: 4096 });
// HOME inside: /tmp is in the container's own layer (so checkpoints keep it) and writable by
// whichever uid the workspace runs as.
export const INNER_HOME = '/tmp';
export const MAX_TIMEOUT_S = 3600;
export const DEFAULT_TIMEOUT_S = 120;

// Disk, which a container's limits don't cover: the project folder is the host's disk, and so are
// the checkpoint copies and the machine's own layer. Each is capped (docs/plans/M10a.md, "Disk").
//  - workspaces: how many this Nova keeps;
//  - folderBytes: what a project folder may hold (checked when asked, before every checkpoint, and
//    while a command runs);
//  - checkpointBytes: all of one workspace's folder copies together (clean, automatic and named);
//  - layerBytes: the machine's own filesystem beyond its image (Docker's --storage-opt where the
//    storage driver enforces it, otherwise checked while a command runs);
//  - watchMs: how often a running command is checked against them.
export interface DiskLimits { workspaces: number; folderBytes: number; checkpointBytes: number; layerBytes: number; watchMs: number }
const GiB = 1024 ** 3;
export const DISK: Readonly<DiskLimits> = Object.freeze({ workspaces: 20, folderBytes: 4 * GiB, checkpointBytes: 16 * GiB, layerBytes: 8 * GiB, watchMs: 5000 });

// Bytes in words a person reads: 2 MiB, 4 GiB.
export function sizeWords(n: number): string {
  for (const [u, b] of [['GiB', GiB], ['MiB', 1024 ** 2], ['KiB', 1024]] as const) if (n >= b) return `${Number((n / b).toFixed(n % b ? 1 : 0))} ${u}`;
  return `${n} bytes`;
}

// Files in a project that tools on this computer run by themselves, outside any workspace: git's
// own folder (its hooks and its config, whose fsmonitor runs on a plain `git status`), direnv's
// .envrc, editor and devcontainer settings, git hooks managers. A command that changes one is
// reported (and .git, when it is there, is read-only inside unless the person chose otherwise).
export const HOST_RUN = ['.devcontainer', '.envrc', '.git', '.gitmodules', '.husky', '.idea', '.vscode'] as const;

// The package registries `registries` may reach, over HTTPS only.
export const REGISTRIES: readonly string[] = Object.freeze([
  'registry.npmjs.org:443', 'registry.yarnpkg.com:443',
  'pypi.org:443', 'files.pythonhosted.org:443',
  'crates.io:443', 'index.crates.io:443', 'static.crates.io:443',
]);

export const EGRESS_MODES = ['none', 'registries', 'hosts'] as const;
export type EgressMode = (typeof EGRESS_MODES)[number];
export interface EgressDecl { mode: EgressMode; hosts: string[] }
const MAX_HOSTS = 20;

const bad = (msg: string, details: string[] = []) => new CoreError('validation', msg, details);

export function validateEgress(v: unknown): EgressDecl {
  if (v === undefined || v === null) return { mode: 'none', hosts: [] };
  if (typeof v !== 'object' || Array.isArray(v)) throw bad('egress must be {mode: none | registries | hosts, hosts?}.');
  const o = v as { mode?: unknown; hosts?: unknown };
  if (!EGRESS_MODES.includes(o.mode as EgressMode)) throw bad(`egress.mode must be one of ${EGRESS_MODES.join(', ')}.`);
  const mode = o.mode as EgressMode;
  if (mode !== 'hosts') {
    if (o.hosts !== undefined && !(Array.isArray(o.hosts) && o.hosts.length === 0)) throw bad(`egress.hosts is only for mode "hosts"; "${mode}" takes none.`);
    return { mode, hosts: [] };
  }
  if (!Array.isArray(o.hosts) || !o.hosts.length || o.hosts.length > MAX_HOSTS) throw bad(`egress.hosts must list the hosts this workspace may reach (1 to ${MAX_HOSTS}).`);
  const hosts = o.hosts.map((h, i) => {
    const n = typeof h === 'string' ? normalizeHost(h) : '';
    if (!n || !HOST.test(n)) throw bad(`egress.hosts[${i}] must be a host name, host:port or *.host.`);
    return n;
  });
  return { mode, hosts };
}

// The hosts a declaration lets the proxy reach.
export function declaredHosts(e: EgressDecl): string[] {
  return e.mode === 'registries' ? [...REGISTRIES] : e.mode === 'hosts' ? [...e.hosts] : [];
}

// Where a workspace's data could go, for the ledger's privacy gate (workers.ts `permits`).
export const egressOf = (e: EgressDecl): Egress => (e.mode === 'none' ? 'none' : 'remote');

// This Nova's home, by a hash: in container names and labels, so one Nova only ever touches its own.
export function homeTag(home: string): string {
  let real = resolve(home);
  try { real = realpathSync(home); } catch { /* not made yet */ }
  return createHash('sha256').update(real).digest('hex').slice(0, 12);
}

const ID = /^[a-z0-9][a-z0-9-]{0,40}$/;
export const containerName = (tag: string, ws: string) => `nova-computer-${tag}-${ws}`;
export const imageRef = (tag: string, ws: string, cp: string) => `nova-computer:${tag}-${ws}-${cp}`;

// Never root inside: Nova's own uid:gid, so files in the project stay the person's; if Nova itself
// runs as root, the image's unprivileged user.
export function runUser(uid = process.getuid?.() ?? 1000, gid = process.getgid?.() ?? 1000): string {
  return uid === 0 ? '1000:1000' : `${uid}:${gid}`;
}

const USER = /^[1-9]\d{0,9}:\d{1,10}$/;

export interface CreateArgs {
  name: string; image: string; folder: string; tag: string; ws: string; user: string;
  // Labels beyond Nova's own (tests mark their containers with one).
  labels?: Record<string, string>;
  // The project's .git folders and files (the top one and nested ones), each mounted again
  // read-only over itself (none when there are none, or the person chose to let commands change
  // them; a link never).
  gitReadOnly?: string[];
  // Docker's --storage-opt size, where the storage driver enforces it.
  layerBytes?: number | null;
}

const LABEL = /^[a-z0-9][a-z0-9.-]{0,62}$/;
const LABEL_VALUE = /^[A-Za-z0-9._-]{1,64}$/;

// `docker create` for a workspace. The network is none whatever the egress declaration: a workspace
// that may reach outside does so only through Nova's proxy, over its relay's stdio (egress.ts).
export function createArgs(o: CreateArgs): string[] {
  if (!USER.test(o.user)) throw bad('A workspace never runs as root.');
  if (!ID.test(o.ws) || !/^[a-z0-9]{1,16}$/.test(o.tag)) throw bad('A workspace id is lower-case letters, digits and dashes.');
  if (!isAbsolute(o.folder) || /[,\n\r\u0000]/.test(o.folder)) throw bad('A project folder must be a full path without commas or line breaks.');
  if (o.image.startsWith('-') || o.name.startsWith('-')) throw bad('Not an image or a name.');
  const extra = Object.entries(o.labels ?? {}).flatMap(([k, v]) => {
    if (!LABEL.test(k) || k === 'nova.computer' || k === 'nova.computer.home' || k === 'nova.computer.workspace' || !LABEL_VALUE.test(v)) throw bad(`Not a label Nova adds: ${k}.`);
    return ['--label', `${k}=${v}`];
  });
  const dotgit = (o.gitReadOnly ?? []).flatMap((g) => {
    const rel = g.startsWith(`${o.folder}/`) ? g.slice(o.folder.length + 1) : '';
    if (!rel || (rel !== '.git' && !rel.endsWith('/.git')) || rel.split('/').some((x) => x === '..' || x === '.' || x === '') || /[,"\n\r\u0000]/.test(rel)) throw bad('Only a .git inside the project is mounted read-only.');
    return ['--mount', `type=bind,source=${g},target=${WORKDIR}/${rel},readonly`];
  });
  const storage = o.layerBytes ? ['--storage-opt', `size=${Math.max(1, Math.floor(o.layerBytes / 1024 ** 2))}M`] : [];
  return [
    'create', '--name', o.name, '--hostname', 'nova-computer',
    '--label', 'nova.computer=1', '--label', `nova.computer.home=${o.tag}`, '--label', `nova.computer.workspace=${o.ws}`, ...extra,
    '--network', 'none',
    '--user', o.user,
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--ipc', 'private',
    '--init',
    '--memory', LIMITS.memory, '--memory-swap', LIMITS.memory, '--cpus', LIMITS.cpus,
    '--pids-limit', String(LIMITS.pids), '--ulimit', `nofile=${LIMITS.nofile}:${LIMITS.nofile}`,
    '--mount', `type=bind,source=${o.folder},target=${WORKDIR}`,
    ...dotgit,
    ...storage,
    '--workdir', WORKDIR,
    '--env', `HOME=${INNER_HOME}`,
    '--entrypoint', '',
    '--stop-timeout', '5',
    o.image, 'sleep', 'infinity',
  ];
}

export interface ExecArgs { container: string; user: string; argv: string[]; timeoutS: number; egress: boolean }

// `docker exec` for one command. The time limit is `timeout` inside the container, so the process
// itself stops, not only the CLI waiting for it.
export function execArgs(o: ExecArgs): string[] {
  if (!USER.test(o.user)) throw bad('A workspace never runs as root.');
  const env = ['--env', `HOME=${INNER_HOME}`];
  if (o.egress) for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) env.push('--env', `${k}=${PROXY_URL}`);
  const secs = Math.max(1, Math.min(MAX_TIMEOUT_S, Math.round(o.timeoutS)));
  return ['exec', '-i', '--user', o.user, '--workdir', WORKDIR, ...env, o.container, 'timeout', '--kill-after=2', `${secs}s`, ...o.argv];
}

const MAX_ARGS = 256;
const MAX_ARG = 32_768;

// A command is a list of words, never a shell string: a shell runs only if the list names one.
export function validateArgv(v: unknown): string[] {
  if (!Array.isArray(v) || !v.length || v.length > MAX_ARGS) throw bad(`argv must be the command as a list of 1 to ${MAX_ARGS} words, like ["npm", "test"]. To use a shell, name it: ["sh", "-c", "…"].`);
  return v.map((a, i) => {
    if (typeof a !== 'string' || !a.length || a.length > MAX_ARG || a.includes('\u0000')) throw bad(`argv[${i}] must be a non-empty string without NUL, at most ${MAX_ARG} characters.`);
    return a;
  });
}

// Folders that are the system's, never a project.
const SYSTEM = ['/bin', '/boot', '/dev', '/etc', '/lib', '/lib32', '/lib64', '/libx32', '/proc', '/root', '/run', '/sbin', '/sys', '/usr', '/var', '/snap', '/opt', '/srv', '/mnt', '/media', '/tmp', '/home'];
const SYSTEM_DEEP = ['/bin', '/boot', '/dev', '/etc', '/lib', '/lib32', '/lib64', '/proc', '/root', '/run', '/sbin', '/sys', '/usr', '/var'];

const within = (child: string, parent: string) => { const r = relative(parent, child); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); };

// A folder of the person's that may be a project's: it is mounted into the workspace, so it must be
// one project, not their home, a hidden folder of theirs (keys, settings), Nova's own home, the
// system's, or one that holds or is inside another workspace's folder (`others`: those folders'
// real paths), since that workspace could then change this one's folder under it. Returns the real
// path, which is what is mounted.
export function checkFolder(folder: unknown, o: { home: string; userHome: string; others?: string[] }): string {
  if (typeof folder !== 'string' || !isAbsolute(folder)) throw bad('folder must be a full path to the project’s folder.');
  let real: string;
  try { real = realpathSync(folder); } catch { throw bad(`${folder} isn’t there.`); }
  if (!lstatSync(real).isDirectory()) throw bad(`${folder} is not a folder.`);
  if (real === '/') throw bad('The whole computer can’t be a project: name the project’s own folder.');
  if (SYSTEM.includes(real) || SYSTEM_DEEP.some((s) => within(real, s))) throw bad(`${folder} is a system folder, not a project.`);
  const real2 = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
  const userHome = real2(o.userHome);
  const home = real2(o.home);
  if (within(userHome, real)) throw bad(`${folder} is your home folder, or holds it: name one project’s folder instead.`);
  if (within(home, real) || within(real, home)) throw bad(`${folder} is in Nova’s own home, or holds it: a workspace never sees Nova’s data.`);
  if (within(real, userHome) && relative(userHome, real).split(sep)[0]!.startsWith('.')) throw bad(`${folder} is a hidden folder of yours (settings, keys): it is never a project.`);
  if (/[,\n\r]/.test(real)) throw bad('A project folder’s path can’t contain commas or line breaks.');
  for (const other of o.others ?? []) {
    if (within(real, other) || within(other, real)) throw bad(`${folder} ${real === other ? 'is' : within(real, other) ? 'is inside' : 'holds'} another workspace’s folder (${other}): two workspaces never share a folder, or one could change the other’s under it.`);
  }
  return real;
}

export type Op = 'create' | 'exec' | 'checkpoint' | 'reset' | 'destroy';
export const OPS: readonly Op[] = ['create', 'exec', 'checkpoint', 'reset', 'destroy'];

// The ledger tier of each action (docs/plans/M10a.md, "Tiers"). The ledger's numbers are
// NOVA-SPEC §6's: 0 silent, 1 act and report (undo), 2 ask first, 3 confirm every time. A reversible
// write inside the workspace is "do, notify, undo" (the amendment), which is tier 1 here.
// Two more: a workspace whose commands may change the project's .git asks first even on Nova's own
// folder (git on this computer would run what they put there); a reset that can't checkpoint what
// is there first (it is over the disk cap) asks first, since it couldn't be undone.
export function tierFor(o: { op: Op; egress: EgressDecl; access?: 'read' | 'write'; ownFolder?: boolean; gitWritable?: boolean; discard?: boolean }): Tier {
  const outside = o.egress.mode !== 'none';
  switch (o.op) {
    case 'exec': return outside ? 3 : o.access === 'read' ? 0 : 1;
    case 'create': return outside ? 3 : o.ownFolder && !o.gitWritable ? 1 : 2;
    case 'checkpoint': return 1;
    case 'reset': return o.discard ? 2 : 1;
    case 'destroy': return 3;
  }
}
