// Stand-ins for infrastructure and networking through chat (M10d). Everything is made under a new
// mkdtemp folder in the system's temp folder: the stand-in `tofu` on a PATH of the test's own (no
// real OpenTofu is ever run, and none is installed), a project folder with its configuration, and
// fake tokens made per test. Names are placeholders.
import { randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const ROOT = join(import.meta.dirname, '..', '..');
export const FAKE_TOFU = join(ROOT, 'scripts/stand-ins/fake-tofu.js');
export const FAKE_NETCONFIG = join(ROOT, 'scripts/stand-ins/fake-netconfig.js');

// A folder holding only `tofu`, the stand-in, and the PATH to find it on (nothing else of this
// machine's: the stand-in is started with Node's own absolute path).
export function tofuOnPath(): { bin: string; path: string } {
  const bin = mkdtempSync(join(tmpdir(), 'nova-tofu-bin-'));
  const tofu = join(bin, 'tofu');
  writeFileSync(tofu, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_TOFU}" "$@"\n`);
  chmodSync(tofu, 0o755);
  return { bin, path: bin };
}

export const fakeToken = () => `example-token-${randomBytes(12).toString('hex')}`;

// The configuration: OpenTofu's JSON syntax, stand-in resource types.
export function config(resources: Record<string, Record<string, Record<string, unknown>>>) {
  return JSON.stringify({ resource: resources }, null, 2);
}
export const SMALL = config({ standin_server: { web: { size: 'small', region: 'example-1' } }, standin_dns_record: { www: { name: 'www.example.test', value: '192.0.2.10' } } });
// Prices a month: a server by size, a DNS record free.
export const PRICES = { standin_server: { by: 'size', prices: { small: 5, large: 40 } }, standin_dns_record: 0 };

export function makeProject(conf = SMALL): { dir: string; folder: string } {
  const dir = mkdtempSync(join(tmpdir(), 'nova-infra-'));
  const folder = join(dir, 'project');
  mkdirSync(folder);
  writeFileSync(join(folder, 'main.tf.json'), conf);
  return { dir, folder };
}

// The stand-in's own record of each call: its arguments and the names of its environment.
export function tofuCalls(folder: string): { args: string[]; env: string[] }[] {
  try { return readFileSync(join(folder, '.fake-tofu-calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
}

// Every file under a folder, byte by byte, that holds any of the values (UTF-8 and UTF-16): the
// proof that a secret went nowhere Nova writes.
export function filesHolding(root: string, values: string[]): string[] {
  const hits: string[] = [];
  const needles = values.flatMap((v) => [Buffer.from(v, 'utf8'), Buffer.from(v, 'utf16le')]);
  const walk = (dir: string, depth = 0) => {
    if (depth > 30) return;
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { return; }
    for (const n of names) {
      const p = join(dir, n);
      let st;
      try { st = lstatSync(p); } catch { continue; }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) { walk(p, depth + 1); continue; }
      if (!st.isFile() || st.size > 64 * 1024 * 1024) continue;
      let data: Buffer;
      try { data = readFileSync(p); } catch { continue; }
      if (needles.some((x) => data.includes(x))) hits.push(p);
    }
  };
  walk(root);
  return hits;
}
