// The shell's own settings (`shell.json` in its data folder): which Hub it uses and the pinned
// fingerprint (FR-134), the global shortcuts (docs/04 §5) and the apps attach never captures
// (FR-214). No secret is kept here: the session lives in the Hub session's cookie store.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { shellConfigSchema, type ShellConfig } from '@nova/shared';

export const CONFIG_FILE = 'shell.json';

export function defaultConfig(): ShellConfig {
  return shellConfigSchema.parse({ v: 1 });
}

/**
 * The settings in `dir`, or the defaults when there are none. A damaged file is set aside (so
 * the user can recover it) rather than silently overwritten, and the defaults are used.
 */
export function loadConfig(dir: string): { config: ShellConfig; problem: string | null } {
  const file = join(dir, CONFIG_FILE);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return { config: defaultConfig(), problem: null };
  }
  try {
    return { config: shellConfigSchema.parse(JSON.parse(text)), problem: null };
  } catch {
    try {
      renameSync(file, `${file}.damaged-${Date.now()}`);
    } catch {
      // leave it in place; the next save replaces it
    }
    return {
      config: defaultConfig(),
      problem: 'The app settings file was damaged and was set aside.',
    };
  }
}

/** Write atomically (a temporary file, then rename) and readable by this user only. */
export function saveConfig(dir: string, config: ShellConfig): void {
  const file = join(dir, CONFIG_FILE);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const valid = shellConfigSchema.parse(config);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(valid, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}
