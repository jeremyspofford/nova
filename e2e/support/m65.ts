// Shared steps of the M6.5 journey (J8.5): a Hub listening on every interface and opened at this
// machine's LAN address (the Hub builds no install command for a loopback address, by design),
// serving the real novad build from its dist folder and running the fake mesh CLIs of
// packages/core/test/fixtures/mesh for Network Setup; the real novad binary; and a self-hosted
// Relay (services/relay) on loopback.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Page } from '@playwright/test';
import { TOOLS, defaultMeshState } from '../../packages/core/test/fixtures/mesh/world.ts';
import { startHub, type RunningHub } from './hub.ts';
import { until } from './m6.ts';

export const FAKE_MESH = resolve('packages/core/test/fixtures/mesh/fake-mesh.mjs');
const RELAY_MAIN = resolve('services/relay/src/main.ts');

/** The novad build the journey runs and the Hub serves. */
export function novadBinary(): string {
  const given = process.env.NOVA_NOVAD_BIN;
  if (given) {
    if (!existsSync(given)) throw new Error(`NOVA_NOVAD_BIN does not exist: ${given}`);
    return given;
  }
  const found = ['release', 'debug']
    .map((p) => resolve(`services/novad/target/${p}/novad`))
    .find((p) => existsSync(p));
  if (!found)
    throw new Error(
      'J8.5 runs the real novad and no build was found: run `node scripts/cargo.mjs build --release` ' +
        '(CI builds it in the e2e job), or set NOVA_NOVAD_BIN',
    );
  return found;
}

/** The dist file name for this machine (agent-dist: `novad-<os>-<arch>`). */
export function novadDistName(): string {
  if (process.platform !== 'linux') throw new Error('J8.5 serves a Linux novad build');
  if (process.arch === 'x64') return 'novad-linux-amd64';
  if (process.arch === 'arm64') return 'novad-linux-arm64';
  throw new Error(`no novad build name for ${process.arch}`);
}

const isMeshIp = (ip: string) => {
  const [a = 0, b = 0] = ip.split('.').map(Number);
  return a === 100 && b >= 64 && b < 128;
};

/**
 * This machine's LAN address: the first non-internal IPv4 that is neither a mesh (100.64/10) nor
 * a link-local address, else the first non-internal IPv4.
 */
export function lanAddress(): string {
  const all = Object.values(networkInterfaces())
    .flat()
    .filter((a) => a !== undefined && a.family === 'IPv4' && !a.internal)
    .map((a) => a!.address);
  const pick = all.find((ip) => !isMeshIp(ip) && !ip.startsWith('169.254.')) ?? all[0];
  if (!pick) throw new Error('J8.5 needs a non-loopback IPv4 address on this machine');
  return pick;
}

export async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address() as { port: number };
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

export interface M65Hub extends RunningHub {
  /** The Hub at the LAN address, where the owner's browser has it open. */
  lan: string;
  /** The build in the Hub's dist folder. */
  build: { path: string; sha256: string };
  /** The fake mesh's world (`state.json`, `calls.jsonl`). */
  meshDir: string;
}

/**
 * A Hub on every interface with the novad build in NOVA_NOVAD_DIST and the fake mesh CLIs in
 * NOVA_NETWORK_TOOLS_FILE, set up through onboarding at its LAN address.
 */
export async function setUpM65Hub(page: Page, port: number): Promise<M65Hub> {
  const root = mkdtempSync(join(tmpdir(), 'nova-e2e-m65-'));
  const dist = join(root, 'dist');
  mkdirSync(dist);
  const build = join(dist, novadDistName());
  copyFileSync(novadBinary(), build);
  const sha256 = createHash('sha256').update(readFileSync(build)).digest('hex');
  // The fake mesh starts as world.ts's default host: Tailscale and Headscale installed, logged out.
  const meshDir = join(root, 'mesh');
  mkdirSync(meshDir);
  writeFileSync(join(meshDir, 'state.json'), JSON.stringify(defaultMeshState(), null, 2));
  const tools = join(root, 'network-tools.json');
  writeFileSync(
    tools,
    JSON.stringify({
      bins: Object.fromEntries(TOOLS.map((t) => [t, [process.execPath, FAKE_MESH, t]])),
      baseEnv: { NOVA_FAKE_MESH_DIR: meshDir },
    }),
  );
  const hub = await startHub({
    port,
    env: { NOVA_NOVAD_DIST: dist, NOVA_NETWORK_TOOLS_FILE: tools, NOVA_HOST: '0.0.0.0' },
  });
  const lan = `http://${lanAddress()}:${port}`;
  await page.goto(`${lan}/#setup=${hub.setupCode}`);
  await page.getByRole('button', { name: 'Finish setup' }).click();
  await page.getByRole('button', { name: 'Skip setup' }).click();
  return { ...hub, lan, build: { path: build, sha256 }, meshDir };
}

export interface Process {
  stdout(): string;
  stderr(): string;
  exited: Promise<number | null>;
  kill(): void;
}

/** Run a program with `input` on its standard input. */
export function run(bin: string, args: string[], input = ''): Process {
  const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (d: Buffer) => (out += d.toString()));
  child.stderr.on('data', (d: Buffer) => (err += d.toString()));
  const exited = new Promise<number | null>((r) => child.on('close', (code) => r(code)));
  child.stdin.end(input);
  return {
    stdout: () => out,
    stderr: () => err,
    exited,
    kill: () => {
      if (child.exitCode === null) child.kill('SIGKILL');
    },
  };
}

export interface RelayService {
  /** What the Hub connects to: `ws://127.0.0.1:<port>`. */
  url: string;
  stop(): Promise<void>;
}

/** `node services/relay/src/main.ts` on loopback, on a free port. */
export async function startRelayService(): Promise<RelayService> {
  const dir = mkdtempSync(join(tmpdir(), 'nova-e2e-relay-'));
  const child = spawn(
    process.execPath,
    [RELAY_MAIN, '--host', '127.0.0.1', '--port', '0', '--data-dir', dir],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let out = '';
  let err = '';
  child.stdout.on('data', (d: Buffer) => (out += d.toString()));
  child.stderr.on('data', (d: Buffer) => (err += d.toString()));
  const address = await until(
    'the Relay listens',
    () => {
      if (child.exitCode !== null) throw new Error(`the Relay exited: ${err}`);
      return Promise.resolve(/Nova Relay listening on http:\/\/(\S+)/.exec(out)?.[1]);
    },
    20_000,
  );
  return {
    url: `ws://${address}`,
    stop: () =>
      new Promise<void>((r) => {
        if (child.exitCode !== null) return r();
        child.once('exit', () => r());
        child.kill('SIGTERM');
      }),
  };
}
