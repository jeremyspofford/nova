// Run the native-shell journeys (docs/16 §3.3). Electron needs a display: on Linux without one
// the run is wrapped in `xvfb-run -a` (the Playwright image ships it), elsewhere it runs as is.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('..', import.meta.url));
const args = ['playwright', 'test', '-c', 'playwright.config.ts', ...process.argv.slice(2)];
const headless =
  process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
const [cmd, argv] = headless
  ? ['xvfb-run', ['-a', '--server-args=-screen 0 1600x1000x24', 'npx', ...args]]
  : ['npx', args];
const res = spawnSync(cmd, argv, { cwd, stdio: 'inherit' });
if (res.error) {
  console.error(
    headless && res.error.code === 'ENOENT'
      ? 'xvfb-run is needed to run the shell without a display (apt install xvfb), or set DISPLAY.'
      : String(res.error),
  );
  process.exit(1);
}
process.exit(res.status ?? 1);
