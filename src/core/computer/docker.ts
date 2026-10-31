// Nova Computer's first adapter (M10a): workspaces as containers on this machine's Docker. Docker is
// reached through its CLI with argv arrays (never a shell string), always at a unix socket named
// with -H, so neither a Docker context nor a DOCKER_HOST can send a workspace to another machine
// (the ADR's hard limit: containers run only on this machine).
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { trackChild } from '../children.ts';
import { CoreError } from '../errors.ts';
import { FOLDER_COPY, copyTree, replaceContents, treeDigest, type Computer, type ExecRequest, type ExecResult, type Machine, type Saved } from './computer.ts';
import { IMAGE, containerName, createArgs, execArgs, homeTag, imageRef, runUser } from './policy.ts';

const DEFAULT_SOCKET = 'unix:///var/run/docker.sock';
const MAX_BYTES = 1_000_000;

// Where the local daemon is: DOCKER_HOST when it is a unix socket, else the default one. A DOCKER_HOST
// pointing anywhere else is refused, not followed.
export function dockerHost(env: NodeJS.ProcessEnv = process.env): string {
  const h = env.DOCKER_HOST?.trim();
  if (!h) return DEFAULT_SOCKET;
  if (!h.startsWith('unix://')) throw new CoreError('conflict', `DOCKER_HOST is ${h}: Nova’s computer runs only on this machine’s own Docker (a unix socket).`);
  return h;
}

export interface Run { code: number; stdout: string; stderr: string }

export interface DockerOptions { home: string; env?: NodeJS.ProcessEnv; user?: string; program?: string }

export class DockerComputer implements Computer {
  readonly kind = 'docker';
  readonly tag: string;
  readonly user: string;
  #o: DockerOptions;

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

  // One CLI call, its output kept up to `maxBytes` each.
  run(args: string[], o: { maxBytes?: number; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<Run & { truncated: boolean }> {
    return new Promise((ok, fail) => {
      let p: ChildProcess;
      try { p = this.#spawn(args); } catch (e) { fail(e); return; }
      p.stdin?.end();
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
    if (r.code !== 0) throw new CoreError('conflict', `Docker couldn’t ${what}: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ')}`);
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

  // Makes the machine from `image` and starts it; one left over under the same name goes first.
  async #make(m: Machine, image: string): Promise<string> {
    await this.run(['rm', '-f', this.#name(m)], { timeoutMs: 60_000 });
    const id = await this.#must(createArgs({ name: this.#name(m), image, folder: m.folder, tag: this.tag, ws: m.id, user: this.user }), 'make the workspace');
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
  // removed it), started if it stopped (the computer restarted).
  async #ensure(m: Machine): Promise<string> {
    if (m.container) {
      const s = await this.run(['container', 'inspect', '--format', '{{.State.Running}}', m.container], { timeoutMs: 15_000 });
      if (s.code === 0 && s.stdout.trim() === 'true') return m.container;
      if (s.code === 0) { await this.#must(['start', m.container], 'start the workspace'); return m.container; }
    }
    m.container = await this.#make(m, m.image);
    return m.container;
  }

  async exec(m: Machine, r: ExecRequest, signal?: AbortSignal): Promise<ExecResult> {
    const container = await this.#ensure(m);
    const began = performance.now();
    const res = await this.run(execArgs({ container, user: this.user, argv: r.argv, timeoutS: r.timeoutS, egress: m.egress.mode !== 'none' }), {
      maxBytes: r.maxBytes ?? MAX_BYTES, ...(signal ? { signal } : {}), timeoutMs: (r.timeoutS + 30) * 1000,
    });
    const duration_ms = Math.round(performance.now() - began);
    // Stopped part way (the task cancelled): the machine is restarted, so nothing it started runs on.
    if (signal?.aborted) await this.run(['restart', '--time', '0', container], { timeoutMs: 60_000 });
    // `timeout` exits 124 when the time ran out (137 when it had to kill).
    const timed_out = res.code === 124 || (res.code === 137 && duration_ms >= r.timeoutS * 1000);
    return { exit: res.code, stdout: res.stdout, stderr: res.stderr, timed_out, truncated: res.truncated, duration_ms };
  }

  async checkpoint(m: Machine, cp: { id: string; dir: string }): Promise<Saved> {
    const container = await this.#ensure(m);
    const image = imageRef(this.tag, m.id, cp.id);
    // Paused while the image is taken, so it is one moment's picture.
    await this.#must(['commit', '--pause=true', container, image], 'take the checkpoint’s image', 600_000);
    try {
      copyTree(m.folder, join(cp.dir, FOLDER_COPY));
      const d = treeDigest(join(cp.dir, FOLDER_COPY));
      return { image, ...d };
    } catch (e) {
      await this.run(['rmi', '-f', image], { timeoutMs: 60_000 });
      throw e;
    }
  }

  async reset(m: Machine, to: { image: string; dir: string }): Promise<{ container: string }> {
    // The machine goes first, so nothing writes into the folder while it is put back.
    await this.run(['rm', '-f', m.container ?? this.#name(m)], { timeoutMs: 60_000 });
    await this.run(['rm', '-f', this.#name(m)], { timeoutMs: 60_000 });
    m.container = null;
    replaceContents(m.folder, join(to.dir, FOLDER_COPY));
    m.image = to.image;
    const container = await this.#make(m, to.image);
    m.container = container;
    return { container };
  }

  async destroy(m: Machine, images: string[]): Promise<void> {
    await this.run(['rm', '-f', m.container ?? this.#name(m)], { timeoutMs: 60_000 });
    await this.run(['rm', '-f', this.#name(m)], { timeoutMs: 60_000 });
    // Only this workspace's own images: never the pinned base image.
    const own = images.filter((i) => i.startsWith(`nova-computer:${this.tag}-${m.id}-`));
    if (own.length) await this.run(['rmi', '-f', ...own], { timeoutMs: 120_000 });
    m.container = null;
  }

  async changes(m: Machine): Promise<string[]> {
    const container = await this.#ensure(m);
    const r = await this.run(['diff', container], { timeoutMs: 60_000, maxBytes: 20_000_000 });
    return r.stdout.split('\n').filter(Boolean).sort();
  }

  attach(m: Machine, argv: string[], user: string): ChildProcess {
    if (!m.container) throw new CoreError('conflict', 'The workspace isn’t running.');
    return this.#spawn(['exec', '-i', '--user', user, m.container, ...argv]);
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
