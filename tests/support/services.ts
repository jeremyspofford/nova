// Service definitions for tests (M10e): the stand-in service (scripts/stand-ins/fake-service.js) as a
// plain program, installed from a file: address and pinned by its SHA-256, on this machine's
// platform. Ports are free ones on 127.0.0.1.
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { request } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { platformKey, type ServiceDefinition } from '../../src/core/index.ts';

export const ROOT = join(import.meta.dirname, '..', '..');
export const STAND_IN = join(ROOT, 'scripts', 'stand-ins', 'fake-service.js');

export const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

const bindable = (port: number) => new Promise<boolean>((resolve) => {
  const s = createServer();
  s.once('error', () => resolve(false));
  s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
});

// A free port for a service's stable port. Chosen below the system's ephemeral range (32768 and up
// on Linux), where every `listen(0)` in other tests running at the same time picks its ports, so
// none of them takes it between now and the promotion that binds it.
export async function freePort(): Promise<number> {
  for (let i = 0; i < 200; i++) {
    const port = 20_000 + Math.floor(Math.random() * 12_000);
    if (await bindable(port)) return port;
  }
  throw new Error('No free port between 20000 and 32000 on 127.0.0.1.');
}

// A copy of the stand-in in `dir`, so a test can remove it (nothing to download any more).
export function standInFile(dir: string, name = 'fake-service.js'): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  copyFileSync(STAND_IN, file);
  return file;
}

export function standIn(o: { version: string; port: number; file?: string; service?: string; flags?: string[]; command?: string[]; alongside?: ServiceDefinition['alongside']; soak_s?: number; contract?: string[]; state?: boolean; extra?: Partial<ServiceDefinition> }): ServiceDefinition {
  const file = o.file ?? STAND_IN;
  const name = file.split('/').pop()!;
  return {
    service: o.service ?? 'stand-in',
    version: o.version,
    artifact: { program: { [platformKey()]: { url: pathToFileURL(file).href, sha256: sha256(file), command: o.command ?? ['node', name, ...(o.flags ?? [])] } } },
    ports: [{ name: 'api', port: o.port }],
    health: { http: '/health', every_s: 30 },
    contract_tests: o.contract ?? ['http:/contract'],
    alongside: o.alongside ?? 'full',
    placement: { mode: 'pinned', device: 'hub' },
    ...(o.state ? { state: { volume: 'data' } } : {}),
    secrets: [],
    egress: 'none',
    os_permissions: [],
    ...(o.soak_s === undefined ? {} : { soak_s: o.soak_s }),
    ...o.extra,
  };
}

// One request on a new connection (no keep-alive), so each one says who answers now.
export function call(port: number, path: string, o: { method?: string; body?: string } = {}): Promise<{ status: number; body: any } | null> {
  return new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port, path, method: o.method ?? 'GET', agent: false, timeout: 3000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let body: any = text; try { body = JSON.parse(text); } catch { /* text */ } resolve({ status: res.statusCode ?? 0, body }); });
      res.on('error', () => resolve(null));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end(o.body);
  });
}

export async function whoami(port: number): Promise<{ version: string; pid: number; flavour: string | null; home: string } | null> {
  const r = await call(port, '/whoami');
  return r && r.status === 200 ? r.body as { version: string; pid: number; flavour: string | null; home: string } : null;
}

export function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}
