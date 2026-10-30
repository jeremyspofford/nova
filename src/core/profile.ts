// The profile (PROFILES-AND-CUSTOMIZATION): everything specific to one person, as records Nova
// loads at runtime. Core ships with none. Setup, settings and conversation all write the same
// records, so there is one source of truth however a choice was made.
import { EventEmitter } from 'node:events';
import { CoreError } from './errors.ts';
import { PRIVACY_MODES, type PrivacyMode } from './envelope.ts';
import type { Db } from './db.ts';

export const SECTIONS = ['identity', 'user', 'tuning', 'privacy', 'policy', 'appearance', 'setup'] as const;
export type Section = (typeof SECTIONS)[number];
export type Source = 'setup' | 'settings' | 'conversation' | 'import';

export class Profile extends EventEmitter {
  #db: Db;
  #now: () => Date;

  constructor(db: Db, now: () => Date = () => new Date()) {
    super();
    this.#db = db;
    this.#now = now;
  }

  get<T>(section: Section, key: string): T | undefined {
    const row = this.#db.get<{ value: string }>('SELECT value FROM profile WHERE section = ? AND key = ?', section, key);
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  set(section: Section, key: string, value: unknown, source: Source): void {
    if (!SECTIONS.includes(section)) throw new CoreError('validation', `There is no profile section called "${section}".`);
    if (value === undefined) throw new CoreError('validation', `A value is required for ${section}.${key}.`);
    this.#db.run(
      `INSERT INTO profile (section, key, value, source, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (section, key) DO UPDATE SET value = excluded.value, source = excluded.source, updated_at = excluded.updated_at`,
      section, key, JSON.stringify(value), source, this.#now().toISOString(),
    );
    this.emit('change', { section, key });
  }

  section(section: Section): Record<string, unknown> {
    const rows = this.#db.all<{ key: string; value: string }>('SELECT key, value FROM profile WHERE section = ? ORDER BY key', section);
    return Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]));
  }

  // The whole profile, minus setup's working state. Secrets are never stored here (names only).
  all(): Record<string, Record<string, unknown>> {
    return Object.fromEntries(SECTIONS.filter((s) => s !== 'setup').map((s) => [s, this.section(s)]));
  }

  // Local-only until the person says otherwise (LOCAL-FIRST-AND-DEVICE-MESH §1).
  privacyDefault(): PrivacyMode {
    const v = this.get<string>('privacy', 'default');
    return PRIVACY_MODES.includes(v as PrivacyMode) ? (v as PrivacyMode) : 'local-only';
  }

  isEmpty(): boolean {
    return !this.#db.get('SELECT 1 FROM profile LIMIT 1');
  }
}
