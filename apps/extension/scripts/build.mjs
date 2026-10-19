// Builds the extension into dist/ (load it unpacked from there): TypeScript compiled with the
// repo's own tsc, the manifest and pages copied, and the icons drawn by icons.mjs. No bundler
// and no dependency beyond the repo's.
import { execFileSync } from 'node:child_process';
import { copyFileSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeIcons } from './icons.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const require = createRequire(import.meta.url);

rmSync(dist, { recursive: true, force: true });
execFileSync(
  process.execPath,
  [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.build.json'],
  {
    cwd: root,
    stdio: 'inherit',
  },
);
for (const f of ['manifest.json', 'popup.html', 'prompt.html', 'pages.css'])
  copyFileSync(join(root, 'src', f), join(dist, f));
writeIcons(join(dist, 'icons'));

const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (manifest.version !== pkg.version)
  throw new Error(`manifest version ${manifest.version} is not the package's ${pkg.version}`);
for (const f of ['background.js', 'popup.js', 'prompt.js', 'bridge.js', 'protocol.js'])
  readFileSync(join(dist, f));
process.stdout.write(`built ${dist}\n`);
