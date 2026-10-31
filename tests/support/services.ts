// Service definitions for tests (M10e): the stand-in service (scripts/stand-ins/fake-service.js) as a
// plain program, installed from a file: address and pinned by its SHA-256, on this machine's
// platform. Ports are free ones on 127.0.0.1.
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { platformKey, type ServiceDefinition } from '../../src/core/index.ts';

export const ROOT = join(import.meta.dirname, '..', '..');
export const STAND_IN = join(ROOT, 'scripts', 'stand-ins', 'fake-service.js');

export const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
  });
}

// A copy of the stand-in in `dir`, so a test can remove it (nothing to download any more).
export function standInFile(dir: string, name = 'fake-service.js'): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  copyFileSync(STAND_IN, file);
  return file;
}

export function standIn(o: { version: string; port: number; file?: string; service?: string; flags?: string[]; alongside?: ServiceDefinition['alongside']; soak_s?: number; contract?: string[]; state?: boolean; extra?: Partial<ServiceDefinition> }): ServiceDefinition {
  const file = o.file ?? STAND_IN;
  const name = file.split('/').pop()!;
  return {
    service: o.service ?? 'stand-in',
    version: o.version,
    artifact: { program: { [platformKey()]: { url: pathToFileURL(file).href, sha256: sha256(file), command: ['node', name, '--flavour', o.version, ...(o.flags ?? [])] } } },
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

export async function whoami(port: number): Promise<{ version: string; pid: number; flavour: string | null; home: string } | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/whoami`, { signal: AbortSignal.timeout(3000) });
    return r.ok ? await r.json() as { version: string; pid: number; flavour: string | null; home: string } : null;
  } catch {
    return null;
  }
}

export function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}
