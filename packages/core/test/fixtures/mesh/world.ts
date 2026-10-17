// A fake host for the Network Setup tests: a temp folder holding the fake CLIs' state, and a real
// ProcessMeshRunner whose programs all map to fake-mesh.mjs (so tests exercise spawn, argv,
// stdin, environment and timeouts for real, against a world they control).
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ProcessMeshRunner,
  type MeshCommandResult,
  type MeshCommandRunner,
  type ResolvedMeshCommand,
} from '../../../src/network/mesh/runner.ts';

export const FAKE_MESH = fileURLToPath(new URL('./fake-mesh.mjs', import.meta.url));
export const TOOLS = [
  'tailscale',
  'headscale',
  'netbird',
  'wg',
  'wg-quick',
  'ufw',
  'apt-get',
  'dnf',
  'brew',
  'winget',
];

export interface FakeHeadscaleNode {
  id: string;
  name: string;
  given_name: string;
  ip_addresses: string[];
  online: boolean;
  user: { id: string; name: string };
  forced_tags: string[];
  valid_tags: string[];
  approved_routes: string[];
  available_routes: string[];
}

export interface FakeMeshState {
  installed: Record<string, boolean>;
  fail: Record<string, string>;
  joinState?: string;
  tailscaleAuthKeys: string[];
  cert?: { certPem: string; keyPem: string };
  tailscale: {
    backendState: string;
    controlUrl: string | null;
    hostname: string | null;
    ips: string[];
    dnsName: string | null;
    tags: string[];
    acceptDns: boolean;
    routes: string[];
    wantRunning: boolean;
    loggedOut: boolean;
    peers: { name: string; ips: string[]; online: boolean; os: string }[];
  };
  headscale: {
    users: { id: string; name: string }[];
    nodes: FakeHeadscaleNode[];
    policy: string | null;
    policyMode: 'database' | 'file';
    nextUserId: number;
    nextNodeId: number;
    keys: { key: string; user: string; used: boolean; tags: string[] }[];
    apiKey?: string;
  };
  netbird: {
    connected: boolean;
    managementUrl: string | null;
    hostname: string | null;
    setupKeys: string[];
  };
  wg: { interfaces: string[]; lastConfig?: string };
  ufw: { active: boolean; added: string[] };
}

export interface FakeCall {
  tool: string;
  args: string[];
  stdin: string;
  env: Record<string, string>;
}

export function defaultMeshState(): FakeMeshState {
  return {
    installed: {
      tailscale: true,
      headscale: true,
      netbird: false,
      wg: false,
      ufw: true,
      'apt-get': true,
    },
    fail: {},
    tailscaleAuthKeys: [],
    tailscale: {
      backendState: 'NeedsLogin',
      controlUrl: null,
      hostname: null,
      ips: [],
      dnsName: null,
      tags: [],
      acceptDns: true,
      routes: [],
      wantRunning: false,
      loggedOut: true,
      peers: [{ name: 'laptop', ips: ['100.64.0.9'], online: true, os: 'macOS' }],
    },
    headscale: {
      users: [{ id: '1', name: 'admin' }],
      nodes: [],
      policy: null,
      policyMode: 'database',
      nextUserId: 2,
      nextNodeId: 1,
      keys: [],
    },
    netbird: { connected: false, managementUrl: null, hostname: null, setupKeys: [] },
    wg: { interfaces: [] },
    ufw: { active: true, added: ['allow 22/tcp'] },
  };
}

export class FakeMeshWorld {
  readonly dir: string;
  readonly runner: ProcessMeshRunner;

  constructor(patch?: (s: FakeMeshState) => void) {
    this.dir = mkdtempSync(join(tmpdir(), 'nova-mesh-'));
    const s = defaultMeshState();
    patch?.(s);
    this.#write(s);
    this.runner = new ProcessMeshRunner({
      bins: Object.fromEntries(TOOLS.map((t) => [t, [process.execPath, FAKE_MESH, t]])),
      baseEnv: { NOVA_FAKE_MESH_DIR: this.dir },
    });
  }

  get state(): FakeMeshState {
    return JSON.parse(readFileSync(join(this.dir, 'state.json'), 'utf8')) as FakeMeshState;
  }

  update(fn: (s: FakeMeshState) => void): void {
    const s = this.state;
    fn(s);
    this.#write(s);
  }

  calls(): FakeCall[] {
    const path = join(this.dir, 'calls.jsonl');
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as FakeCall);
  }

  /** Calls that change something (not version, status, list, show or get). */
  changes(): FakeCall[] {
    const reads = /^(version|--version|status|debug|list|show|get)$/;
    return this.calls().filter((c) => !reads.test(c.args[0] ?? '') && !reads.test(c.args[1] ?? ''));
  }

  clearCalls(): void {
    writeFileSync(join(this.dir, 'calls.jsonl'), '');
  }

  close(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }

  #write(s: FakeMeshState): void {
    writeFileSync(join(this.dir, 'state.json'), JSON.stringify(s, null, 2));
  }
}

/** One line per call: `tool arg arg …`. */
export function argvOf(c: FakeCall): string {
  return [c.tool, ...c.args].join(' ');
}

/** A rule for `FlakyRunner`: fail the nth call whose argv matches (every one without `nth`). */
export interface FlakyRule {
  match: (argv: string[]) => boolean;
  nth?: number;
  stderr?: string;
  /** Run this instead of failing (e.g. a command that hangs). */
  replace?: (cmd: ResolvedMeshCommand) => Promise<MeshCommandResult>;
  seen?: number;
}

/** Wraps a runner and injects one-off failures (a server that blips, an undo that fails). */
export class FlakyRunner implements MeshCommandRunner {
  readonly rules: FlakyRule[] = [];
  readonly #inner: MeshCommandRunner;

  constructor(inner: MeshCommandRunner) {
    this.#inner = inner;
  }

  run(cmd: ResolvedMeshCommand): Promise<MeshCommandResult> {
    for (const r of this.rules) {
      if (!r.match(cmd.argv)) continue;
      r.seen = (r.seen ?? 0) + 1;
      if (r.nth !== undefined && r.nth !== r.seen) continue;
      if (r.replace) return r.replace(cmd);
      return Promise.resolve({
        code: 1,
        stdout: '',
        stderr: r.stderr ?? 'rpc error: code = Unavailable desc = connection refused',
        timedOut: false,
        error: null,
      });
    }
    return this.#inner.run(cmd);
  }
}

/** Whether argv starts with these words. */
export function argvStarts(...words: string[]): (argv: string[]) => boolean {
  return (argv) => words.every((w, i) => argv[i] === w);
}
