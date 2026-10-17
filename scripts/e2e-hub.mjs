// Start a Hub with a fresh data directory for E2E runs. The web UI must be built first.
import { rmSync } from 'node:fs';
import { spawn } from 'node:child_process';

const dataDir = process.env.NOVA_DATA_DIR;
if (!dataDir) throw new Error('NOVA_DATA_DIR is required');
rmSync(dataDir, { recursive: true, force: true });
const child = spawn(process.execPath, ['apps/hub/src/main.ts'], {
  stdio: 'inherit',
  env: process.env,
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('exit', (code) => process.exit(code ?? 0));
