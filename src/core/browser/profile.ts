// Nova's own browser profile (M10b plan, "The profile"): one persistent Chromium profile under
// Nova's home, never the person's own. Sites keep what Nova was signed in with between tasks
// (the owner's open question 3, answered with the ADR's proposed default until the owner says
// otherwise), and each site's kept data can be deleted from Settings.
//
// Before every launch its Preferences turn Chromium's password manager and autofill off, so a
// password Nova types is never saved by the browser. After the browser closes, the session-restore
// files (the last pages and their form state) are removed.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const PROFILE_DIR = 'browser-profile';
export const profileDir = (home: string) => join(home, 'workers', PROFILE_DIR);

// What Nova's profile never does: save passwords, fill forms, sign in by itself, check passwords
// against a service, restore the last session.
export const PREFS = {
  credentials_enable_service: false,
  credentials_enable_autosignin: false,
  profile: { password_manager_enabled: false, password_manager_leak_detection: false, exit_type: 'Normal', exited_cleanly: true },
  autofill: { enabled: false, profile_enabled: false, credit_card_enabled: false },
  password_manager: { leak_detection: false },
  session: { restore_on_startup: 5 },
  safebrowsing: { enabled: false },
  translate: { enabled: false },
};

function merge(into: Record<string, unknown>, from: Record<string, unknown>): Record<string, unknown> {
  for (const [k, v] of Object.entries(from)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) into[k] = merge((into[k] && typeof into[k] === 'object' ? into[k] : {}) as Record<string, unknown>, v as Record<string, unknown>);
    else into[k] = v;
  }
  return into;
}

// Makes the profile folder (0700) and sets its Preferences, keeping whatever else Chromium wrote.
export function prepareProfile(dir: string): void {
  mkdirSync(join(dir, 'Default'), { recursive: true, mode: 0o700 });
  const file = join(dir, 'Default', 'Preferences');
  let prefs: Record<string, unknown> = {};
  try { prefs = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>; } catch { /* first launch, or unreadable: start from Nova's */ }
  writeFileSync(file, JSON.stringify(merge(prefs, PREFS)), { mode: 0o600 });
}

// Session restore keeps the last pages and what was typed into their forms.
const RESTORE = ['Sessions', 'Current Session', 'Current Tabs', 'Last Session', 'Last Tabs'];
export function afterClose(dir: string): void {
  for (const f of RESTORE) {
    const p = join(dir, 'Default', f);
    if (existsSync(p)) { try { rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* next time */ } }
  }
}
