// Shared by the resilience tests: a scratch home, a backup folder and a second folder for the
// encrypted copy, and a core on that home with its vault key in a file.
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore, type Core, type CoreOptions } from '../../src/core/index.ts';

export function world(prefix = 'nova-bk-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const home = join(dir, 'home');
  const target = join(dir, 'backups');
  const second = join(dir, 'encrypted');
  mkdirSync(target);
  mkdirSync(second);
  return { dir, home, target, second };
}

export function open(home: string, o: Partial<CoreOptions> = {}): Core {
  return createCore({ home, version: '0.1.0', trustedOrigin: () => true, vault: { mode: 'file', keychain: null }, ...o });
}
