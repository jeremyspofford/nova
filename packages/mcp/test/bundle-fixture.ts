// Bundle archives for tests (FR-199), built in memory from examples/bundles/hello; no binary is
// committed. `over` may change the files and the parsed manifest before zipping.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strToU8, zipSync, type Zippable } from 'fflate';

export const SAMPLE_BUNDLE = fileURLToPath(
  new URL('../../../examples/bundles/hello/', import.meta.url),
);

function folder(dir: string): Zippable {
  const out: Zippable = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p).split('\\').join('/')] = readFileSync(p);
    }
  };
  walk(dir);
  return out;
}

export function sampleZip(
  over: (files: Zippable, manifest: Record<string, unknown>) => void = () => undefined,
): Uint8Array {
  const files = folder(SAMPLE_BUNDLE);
  const manifest = JSON.parse(
    Buffer.from(files['manifest.json'] as Uint8Array).toString('utf8'),
  ) as Record<string, unknown>;
  over(files, manifest);
  files['manifest.json'] = strToU8(JSON.stringify(manifest));
  return zipSync(files);
}

/** Any files as a zip (for archives that are wrong on purpose). */
export function zipOf(files: Record<string, string>): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));
}
