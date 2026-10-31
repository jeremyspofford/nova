// Nova Computer's first adapter (M10a): workspaces as containers on this machine's Docker. Docker is
// reached through its CLI with argv arrays (never a shell string), always at a unix socket named
// with -H, so neither a Docker context nor a DOCKER_HOST can send a workspace to another machine
// (the ADR's hard limit: containers run only on this machine).
//
// What it guarantees beyond the container's own isolation (the PR #236 review):
//  - the folder is the one the workspace was made with (checkFolderId) before every mount, start,
//    copy and reset;
//  - nothing but the machine's own two processes runs between commands: before a command (and so
//    before its egress relay starts), and after it, anything else is stopped by restarting the
//    machine;
//  - a checkpoint is one moment's picture: the machine is paused for the image, the copy and the
//    digest;
//  - the project's .git is read-only inside unless the person chose otherwise.
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { trackChild } from '../children.ts';
import { CoreError } from '../errors.ts';
import { FOLDER_COPY, checkFolderId, copyTree, findPaths, removeTree, replaceContents, treeDigest, type Computer, type ExecRequest, type ExecResult, type Machine, type Saved, type Tunnelled } from './computer.ts';
import { IMAGE, containerName, createArgs, execArgs, homeTag, imageRef, runUser } from './policy.ts';
import { RELAY_USER } from './egress.ts';

const DEFAULT_SOCKET = 'unix:///var/run/docker.sock';
const MAX_BYTES = 1_000_000;
const RELAY_UID = RELAY_USER.split(':')[0]!;
// The most .git folders and files of a project mounted read-only (see #gitReadOnly).
export const MAX_GIT_MOUNTS = 64;

// What the docker CLI said, as it may be shown: one line, printable, no paths (a path in an error
// can name something a command inside made), at most 200 characters.
export const dockerWords = (s: string) => (s.trim().split('\n').filter(Boolean).at(-1) ?? 'no reason given').replace(/[^\x20-\x7e]/g, '').replace(/\/[^\s"']*/g, '…').slice(0, 200);

// Where the local daemon is: DOCKER_HOST when it is a unix socket, else the default one. A DOCKER_HOST
// pointing anywhere else is refused, not followed.
export function dockerHost(env: NodeJS.ProcessEnv = process.env): string {
  const h = env.DOCKER_HOST?.trim();
  if (!h) return DEFAULT_SOCKET;
  if (!h.startsWith('unix://')) throw new CoreError('conflict', `DOCKER_HOST is ${h}: Nova’s computer runs only on this machine’s own Docker (a unix socket).`);
  return h;
}

export interface Run { code: number; stdout: string; stderr: string }

export interface DockerOptions {
  home: string; env?: NodeJS.ProcessEnv; user?: string; program?: string;
  // Labels beyond Nova's own on every container (tests mark theirs).
  labels?: Record<string, string>;
  // The machine's own filesystem cap, set with --storage-opt where the storage driver enforces it.
  layerBytes?: number;
}

// Inside, for a read's check: each path's mode, owner, size, times (ctime included, which no process
// there can set back) and, for a file up to 1 MiB, its bytes' hash. Opened without following links.
const SIGNATURES = `
const fs = require('fs'), crypto = require('crypto');
let s = '';
process.stdin.on('data', (d) => { s += d; }).on('end', () => {
  const out = [];
  for (const p of JSON.parse(s)) {
    let st;
    try { st = fs.lstatSync(p, { bigint: true }); } catch { out.push('gone'); continue; }
    let h = '-';
    if (st.isFile() && st.size <= 1048576n) {
      try {
        const fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        try { h = crypto.createHash('sha256').update(fs.readFileSync(fd)).digest('hex'); } finally { fs.closeSync(fd); }
      } catch { h = 'unreadable'; }
    }
    out.push([st.mode.toString(8), st.uid, st.size, st.mtimeNs, st.ctimeNs, h].join(' '));
  }
  process.stdout.write(JSON.stringify(out));
});
`;

export class DockerComputer implements Computer {
  readonly kind = 'docker';
  readonly tag: string;
  readonly user: string;
  #o: DockerOptions;
  #attached = new Map<string, Set<ChildProcess>>();
  #quota: Promise<boolean> | null = null;

  constructor(o: DockerOptions) {
    this.#o = o;
    this.tag = homeTag(o.home);
    this.user = o.user ?? runUser();
  }

  // The CLI's environment: what it needs to run, nothing of Nova's (no secrets, no contexts).
  #env(): NodeJS.ProcessEnv {
    const e = this.#o.env ?? process.env;
    const out: NodeJS.ProcessEnv = { PATH: e.PATH ?? '/usr/bin:/bin', DOCKER_CLI_HINTS: 'false' };
    if (e.HOME) out.HOME = e.HOME;
    return out;
  }

  #spawn(args: string[], stdio: 'pipe' | 'ignore' = 'pipe'): ChildProcess {
    const host = dockerHost(this.#o.env ?? process.env);
    return trackChild(spawn(this.#o.program ?? 'docker', ['-H', host, ...args], { env: this.#env(), stdio: [stdio, 'pipe', 'pipe'] }));
  }

  // One CLI call, its output kept up to `maxBytes` each; `input` is written to its stdin.
  run(args: string[], o: { maxBytes?: number; signal?: AbortSignal; timeoutMs?: number; input?: string } = {}): Promise<Run & { truncated: boolean }> {
    return new Promise((ok, fail) => {
      let p: ChildProcess;
      try { p = this.#spawn(args); } catch (e) { fail(e); return; }
      p.stdin?.on('error', () => {});
      p.stdin?.end(o.input);
      const max = o.maxBytes ?? MAX_BYTES;
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let sizes = [0, 0];
      let truncated = false;
      const keep = (into: Buffer[], i: 0 | 1) => (d: Buffer) => {
        const room = max - sizes[i]!;
        if (room <= 0) { truncated = true; return; }
        if (d.length > room) truncated = true;
        const part = d.length > room ? d.subarray(0, room) : d;
        into.push(part);
        sizes[i]! += part.length;
      };
      p.stdout!.on('data', keep(out, 0));
      p.stderr!.on('data', keep(err, 1));
      const timer = o.timeoutMs ? setTimeout(() => p.kill('SIGKILL'), o.timeoutMs) : null;
      const abort = () => p.kill('SIGKILL');
      if (o.signal?.aborted) abort();
      o.signal?.addEventListener('abort', abort, { once: true });
      p.on('error', (e) => {
        if (timer) clearTimeout(timer);
        fail((e as NodeJS.ErrnoException).code === 'ENOENT' ? new CoreError('conflict', 'Docker isn’t installed on this machine, so Nova’s computer can’t run.') : e);
      });
      p.on('close', (code) => {
        if (timer) clearTimeout(timer);
        o.signal?.removeEventListener('abort', abort);
        sizes = [0, 0];
        ok({ code: code ?? -1, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), truncated });
      });
    });
  }

  async #must(args: string[], what: string, timeoutMs = 120_000): Promise<string> {
    const r = await this.run(args, { timeoutMs });
    if (r.code !== 0) throw new CoreError('conflict', `Docker couldn’t ${what}: ${dockerWords(r.stderr || r.stdout)}`);
    return r.stdout.trim();
  }

  async available(): Promise<{ ok: boolean; detail: string }> {
    let v: Run;
    try { v = await this.run(['version', '--format', '{{.Server.Version}}'], { timeoutMs: 15_000 }); } catch (e) { return { ok: false, detail: (e as Error).message }; }
    if (v.code !== 0) return { ok: false, detail: `Docker isn’t answering on this machine: ${v.stderr.trim().split('\n')[0] ?? ''}` };
    const img = await this.run(['image', 'inspect', '--format', '{{.Id}}', IMAGE], { timeoutMs: 15_000 });
    if (img.code !== 0) return { ok: false, detail: `Docker ${v.stdout.trim()} is here, but Nova’s computer image isn’t yet. Get it once with: docker pull ${IMAGE}` };
    return { ok: true, detail: `Docker ${v.stdout.trim()}, with Nova’s computer image.` };
  }

  #name(m: Machine): string { return containerName(this.tag, m.id); }

  // Whether this Docker's storage driver really enforces --storage-opt size (overlay2 on xfs with
  // pquota, btrfs, zfs). Some accept the option and ignore it (Docker Desktop's containerd store), so
  // it is tried once: a throwaway machine with a 16 MiB cap writes 32 MiB.
  layerQuota(): Promise<boolean> {
    this.#quota ??= (async () => {
      if (!this.#o.layerBytes) return false;
      const name = `${containerName(this.tag, 'probe')}`;
      await this.run(['rm', '-f', name], { timeoutMs: 30_000 });
      const made = await this.run(createArgs({ name, image: IMAGE, folder: join(this.#o.home, 'workers', 'computer'), tag: this.tag, ws: 'probe', user: this.user, labels: this.#o.labels ?? {}, layerBytes: 16 * 1024 ** 2 }).filter((a, i, all) => !(all[i - 1] === '--mount' || a === '--mount')), { timeoutMs: 60_000 });
      try {
        if (made.code !== 0) return false;
        if ((await this.run(['start', name], { timeoutMs: 60_000 })).code !== 0) return false;
        const w = await this.run(['exec', '--user', this.user, name, 'sh', '-c', 'head -c 33554432 /dev/zero > /tmp/fill'], { timeoutMs: 60_000 });
        return w.code !== 0;
      } finally { await this.run(['rm', '-f', name], { timeoutMs: 30_000 }); }
    })();
    return this.#quota;
  }

  // Every .git in the project, the top one and any nested (a nested repository's folder, or the
  // .git file of a submodule or worktree, which names its git folder), each to be mounted
  // read-only over itself. Only a real folder or file: a link would be followed by Docker to
  // wherever it points, so a link is never mounted. A path Docker's --mount can't carry, or more
  // than MAX_GIT_MOUNTS of them, and the machine isn't made (failing closed).
  #gitReadOnly(m: Machine): string[] {
    if (m.gitWritable) return [];
    const found = findPaths(m.folder, ['.git']).filter((x) => x.kind === 'dir' || x.kind === 'file');
    if (found.length > MAX_GIT_MOUNTS) throw new CoreError('conflict', `The project holds ${found.length} git repositories (.git), more than the ${MAX_GIT_MOUNTS} Nova keeps read-only inside, so the machine wasn’t made. Make the workspace with git_writable, or on a smaller folder.`);
    if (found.some((x) => /[,"\n\r]/.test(x.rel))) throw new CoreError('conflict', 'A .git in the project sits under a folder whose name has a comma, a quote or a line break, which Docker can’t mount read-only, so the machine wasn’t made. Rename that folder.');
    return found.map((x) => `${m.folder}/${x.rel}`);
  }

  // Makes the machine from `image` and starts it; one left over under the same name goes first.
  async #make(m: Machine, image: string): Promise<string> {
    await this.run(['rm', '-f', this.#name(m)], { timeoutMs: 60_000 });
    checkFolderId(m.folder, m.folderId);
    const layerBytes = this.#o.layerBytes && await this.layerQuota() ? this.#o.layerBytes : null;
    const id = await this.#must(createArgs({ name: this.#name(m), image, folder: m.folder, tag: this.tag, ws: m.id, user: this.user, labels: this.#o.labels ?? {}, gitReadOnly: this.#gitReadOnly(m), layerBytes }), 'make the workspace');
    checkFolderId(m.folder, m.folderId);
    await this.#must(['start', id], 'start the workspace');
    return id;
  }

  async create(m: Machine): Promise<{ container: string }> {
    if ((await this.run(['image', 'inspect', '--format', '{{.Id}}', m.image], { timeoutMs: 15_000 })).code !== 0) {
      throw new CoreError('conflict', `Nova’s computer image isn’t on this machine. Get it once with: docker pull ${IMAGE}`);
    }
    const container = await this.#make(m, m.image);
    m.container = container;
    return { container };
  }

  // The machine running, made again from its image if it went missing (Docker restarted, a person
  // removed it), started if it stopped (the computer restarted). A start mounts the folder again, so
  // its identity is checked first either way.
  async #ensure(m: Machine): Promise<string> {
    checkFolderId(m.folder, m.folderId);
    if (m.container) {
      const s = await this.run(['container', 'inspect', '--format', '{{.State.Running}}', m.container], { timeoutMs: 15_000 });
      if (s.code === 0 && s.stdout.trim() === 'true') return m.container;
      if (s.code === 0) { await this.#must(['start', m.container], 'start the workspace'); return m.container; }
    }
    m.container = await this.#make(m, m.image);
    return m.container;
  }

  #relays(container: string): boolean {
    const set = this.#attached.get(container);
    if (!set) return false;
    for (const c of set) if (c.exitCode !== null || c.signalCode !== null) set.delete(c);
    return set.size > 0;
  }

  // What runs in the machine now, as the host sees it.
  async #processes(container: string): Promise<{ pid: string; ppid: string; uid: string; args: string }[] | null> {
    const r = await this.run(['top', container, '-o', 'pid,ppid,uid,args'], { timeoutMs: 30_000 });
    if (r.code !== 0) return null;
    return r.stdout.split('\n').slice(1).map((l) => l.trim()).filter(Boolean).map((l) => {
      const [pid = '', ppid = '', uid = '', ...rest] = l.split(/\s+/);
      return { pid, ppid, uid, args: rest.join(' ') };
    });
  }

  // Nothing but the machine's own processes (its init and the `sleep` it keeps running) and, while
  // Nova holds one open, its egress relay (which runs as `nobody`, a user no process of the
  // workspace's can become). Anything else is stopped by restarting the machine, and the machine is
  // checked again. Returns how many processes were stopped. When Nova can't see what runs (`docker
  // top` fails on a running machine) that isn't "nothing": it counts as something left running,
  // and if it still can't see after the restart, nothing runs.
  async #settle(container: string): Promise<number> {
    const UNSEEN = { pid: '?', ppid: '?', uid: '?', args: '(unseen)' };
    const extra = async () => {
      const ps = await this.#processes(container);
      if (ps === null) {
        const s = await this.run(['container', 'inspect', '--format', '{{.State.Running}}', container], { timeoutMs: 15_000 });
        return s.code === 0 && s.stdout.trim() === 'false' ? [] : [UNSEEN];
      }
      const init = ps.find((p) => p.args.startsWith('/sbin/docker-init') || p.args.startsWith('/dev/init'));
      const keep = ps.find((p) => init && p.ppid === init.pid && p.args === 'sleep infinity');
      const relays = this.#relays(container);
      return ps.filter((p) => p !== init && p !== keep && !(relays && p.uid === RELAY_UID));
    };
    const left = await extra();
    if (!left.length) return 0;
    await this.#must(['restart', '--time', '0', container], 'stop what the command left running');
    const still = await extra();
    if (still.includes(UNSEEN)) throw new CoreError('conflict', 'Nova couldn’t see what runs in the workspace (Docker didn’t list its processes), even after restarting it, so it runs nothing in it.');
    if (still.length) throw new CoreError('conflict', `The workspace still runs ${still.length} process${still.length === 1 ? '' : 'es'} after a restart, so Nova won’t run anything in it.`);
    return left.length;
  }

  async exec(m: Machine, r: ExecRequest, signal?: AbortSignal): Promise<ExecResult> {
    const container = await this.#ensure(m);
    // Before the command (and before its relay): nothing left over from before.
    await this.#settle(container);
    let tunnel: Tunnelled | null = null;
    let stopped: string | null = null;
    const stop = new AbortController();
    const both = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal;
    let res: Run & { truncated: boolean };
    const began = performance.now();
    let watch: ReturnType<typeof setInterval> | null = null;
    try {
      if (r.tunnel) tunnel = await r.tunnel((argv, user) => this.attach(m, argv, user));
      if (r.watch) {
        let busy = false;
        watch = setInterval(() => {
          if (busy || stopped) return;
          busy = true;
          // A check that fails is never taken as "within the caps": it stops the command too.
          r.watch!.check()
            .catch((e: Error) => `Nova couldn’t check the workspace’s disk (${e.message})`)
            .then((why) => { if (why && !stopped) { stopped = why; stop.abort(); } })
            .finally(() => { busy = false; });
        }, r.watch.everyMs);
      }
      res = await this.run(execArgs({ container, user: this.user, argv: r.argv, timeoutS: r.timeoutS, egress: m.egress.mode !== 'none' }), {
        maxBytes: r.maxBytes ?? MAX_BYTES, signal: both, timeoutMs: (r.timeoutS + 30) * 1000,
      });
    } finally {
      if (watch) clearInterval(watch);
      // Stopped part way (the task cancelled, a cap reached): the machine is restarted at once, so
      // nothing the command started writes on.
      if (both.aborted) await this.run(['restart', '--time', '0', container], { timeoutMs: 60_000 });
      if (tunnel) await tunnel.close();
    }
    const duration_ms = Math.round(performance.now() - began);
    // After it: whatever it left running is stopped.
    const stray = await this.#settle(container);
    // `timeout` exits 124 when the time ran out (137 when it had to kill).
    const timed_out = res.code === 124 || (res.code === 137 && duration_ms >= r.timeoutS * 1000);
    return { exit: res.code, stdout: res.stdout, stderr: res.stderr, timed_out, truncated: res.truncated, duration_ms, stray, stopped };
  }

  async checkpoint(m: Machine, cp: { id: string; dir: string }): Promise<Saved> {
    const container = await this.#ensure(m);
    const image = imageRef(this.tag, m.id, cp.id);
    // Paused for the image, the folder's copy and its digest, so all three are one moment's picture
    // (nothing inside can change the folder while it is read). A machine that isn't running can't
    // change it either.
    const paused = (await this.run(['pause', container], { timeoutMs: 60_000 })).code === 0;
    if (!paused) {
      const s = await this.run(['container', 'inspect', '--format', '{{.State.Running}}', container], { timeoutMs: 15_000 });
      if (s.stdout.trim() !== 'false') throw new CoreError('conflict', 'Docker couldn’t pause the workspace for its checkpoint, so none was taken.');
    }
    let committed = false;
    try {
      await this.#must(['commit', '--pause=false', container, image], 'take the checkpoint’s image', 600_000);
      committed = true;
      checkFolderId(m.folder, m.folderId);
      const skipped = copyTree(m.folder, join(cp.dir, FOLDER_COPY));
      const d = treeDigest(join(cp.dir, FOLDER_COPY));
      return { image, ...d, skipped };
    } catch (e) {
      if (committed) await this.run(['rmi', '-f', image], { timeoutMs: 60_000 });
      // A copy that stopped part way isn't a checkpoint, and would hold disk no cap counts.
      removeTree(cp.dir);
      throw e;
    } finally {
      if (paused) await this.run(['unpause', container], { timeoutMs: 60_000 });
    }
  }

  async reset(m: Machine, to: { image: string; dir: string }): Promise<{ container: string }> {
    // The machine goes first, so nothing writes into the folder while it is put back.
    await this.run(['rm', '-f', m.container ?? this.#name(m)], { timeoutMs: 60_000 });
    await this.run(['rm', '-f', this.#name(m)], { timeoutMs: 60_000 });
    m.container = null;
    checkFolderId(m.folder, m.folderId);
    replaceContents(m.folder, join(to.dir, FOLDER_COPY));
    m.image = to.image;
    const container = await this.#make(m, to.image);
    m.container = container;
    return { container };
  }

  async destroy(m: Machine, images: string[]): Promise<void> {
    await this.run(['rm', '-f', m.container ?? this.#name(m)], { timeoutMs: 60_000 });
    await this.run(['rm', '-f', this.#name(m)], { timeoutMs: 60_000 });
    m.container = null;
    await this.drop(m, images);
  }

  // Only this workspace's own checkpoint images, never the pinned base image or the one its machine
  // is made from now.
  async drop(m: Machine, images: string[]): Promise<void> {
    const own = images.filter((i) => i.startsWith(`nova-computer:${this.tag}-${m.id}-`) && (m.container === null || i !== m.image));
    if (own.length) await this.run(['rmi', '-f', ...own], { timeoutMs: 120_000 });
  }

  // `docker diff`, and what each changed path is now, read inside as the workspace's user (paths
  // in the list since the image are compared by what they are, not only by being listed).
  async changes(m: Machine): Promise<string[]> {
    const container = await this.#ensure(m);
    const r = await this.run(['diff', container], { timeoutMs: 60_000, maxBytes: 20_000_000 });
    const lines = r.stdout.split('\n').filter(Boolean).sort();
    if (!lines.length) return [];
    const paths = lines.map((l) => l.slice(2));
    const sig = await this.run(['exec', '-i', '--user', this.user, '--workdir', '/', container, 'node', '-e', SIGNATURES], { timeoutMs: 120_000, maxBytes: 64_000_000, input: JSON.stringify(paths) });
    let sigs: string[];
    try { sigs = JSON.parse(sig.stdout) as string[]; } catch { throw new CoreError('conflict', 'Nova couldn’t read what changed in the workspace’s machine.'); }
    if (sigs.length !== lines.length) throw new CoreError('conflict', 'Nova couldn’t read what changed in the workspace’s machine.');
    return lines.map((l, i) => `${l}\t${sigs[i]}`);
  }

  async layerBytes(m: Machine): Promise<number | null> {
    if (!m.container) return null;
    const r = await this.run(['container', 'inspect', '--size', '--format', '{{.SizeRw}}', m.container], { timeoutMs: 60_000 });
    const n = Number(r.stdout.trim());
    return r.code === 0 && Number.isFinite(n) ? n : null;
  }

  attach(m: Machine, argv: string[], user: string): ChildProcess {
    if (!m.container) throw new CoreError('conflict', 'The workspace isn’t running.');
    const child = this.#spawn(['exec', '-i', '--user', user, m.container, ...argv]);
    const set = this.#attached.get(m.container) ?? new Set<ChildProcess>();
    set.add(child);
    this.#attached.set(m.container, set);
    child.on('exit', () => set.delete(child));
    return child;
  }

  // This Nova's containers and images whose workspace is gone (a factory reset, a crash part way):
  // removed. Only ones labelled and named for this home.
  async sweep(keep: Set<string>): Promise<string[]> {
    const gone: string[] = [];
    const ps = await this.run(['ps', '-a', '--filter', `label=nova.computer.home=${this.tag}`, '--format', '{{.ID}} {{.Label "nova.computer.workspace"}}'], { timeoutMs: 30_000 });
    for (const line of ps.stdout.split('\n').filter(Boolean)) {
      const [id, ws] = line.split(' ');
      if (id && ws && !keep.has(ws)) { await this.run(['rm', '-f', id], { timeoutMs: 60_000 }); gone.push(ws); }
    }
    const im = await this.run(['images', 'nova-computer', '--format', '{{.Repository}}:{{.Tag}}'], { timeoutMs: 30_000 });
    const stale = im.stdout.split('\n').filter((ref) => {
      const m = new RegExp(`^nova-computer:${this.tag}-([a-z0-9]+)-[a-z0-9]+$`).exec(ref);
      return !!m && !keep.has(m[1]!);
    });
    if (stale.length) await this.run(['rmi', '-f', ...stale], { timeoutMs: 120_000 });
    return gone;
  }
}
