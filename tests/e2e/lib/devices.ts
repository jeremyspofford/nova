/**
 * Deterministic device seeding, for the Settings → Devices UI scenario (16).
 *
 * The behaviour-changing halves of the S5 DoD — pair a REAL machine with the
 * printed code, ask Nova to read a file / open an app on it — need a live novad
 * holding an authenticated socket, which is the OWNER's live gate (walked with a
 * real daemon on Jeremy's laptop after review; see task-5-report.md). What this
 * scenario proves instead is that the WEB surface renders and DECIDES real
 * backend state, and for that the state has to arrive deterministically, not on
 * a daemon's cooperation.
 *
 * So a paired+granted device (and, via lib/policy.ts, a pending device_run
 * consent) is seeded where the database already is — inside the project's
 * postgres container over the docker socket, exactly as lib/policy.ts seeds the
 * policy rows and lib/evidence.ts READS the turn ledger (postgres is
 * deliberately not published outside the compose network). The UI then fetches
 * it through the real authenticated API and the scenario decides it through the
 * real UI, so the assertion is on the app, not on the seed. The values are fixed
 * test constants — no external input reaches these statements.
 *
 * The `sql()` helper mirrors lib/policy.ts's (kept local so this module does not
 * reach into policy.ts's internals — it is the same twelve-line psql-in-the-
 * container shape, on purpose).
 */
import { containerFor, execInContainer } from './docker'

async function sql(statement: string): Promise<string> {
  const postgres = await containerFor('postgres')
  const out = await execInContainer(postgres, [
    'psql',
    '-U',
    'postgres',
    '-d',
    'nova_core',
    '-t',
    '-A',
    '-c',
    statement.replace(/\s+/g, ' ').trim(),
  ])
  return out.trim()
}

export interface SeedDevice {
  name: string
  /** The owner's person id (whoAmI) — a device is bound to whoever paired it. */
  ownerPerson: string
  platform?: string
  hostname?: string
  capabilities?: string[]
  fsRoots?: string[]
  /**
   * 'now' → last_seen = now(), so the tile derives ONLINE (a heartbeat within
   * the 60s threshold). 'never' → last_seen NULL, so the tile reads "never
   * connected", NOT a green dot (DoD item 5). Liveness is DERIVED from
   * last_seen, never from the REST `connected` flag (T4 / controller ruling R2).
   */
  lastSeen?: 'now' | 'never'
}

/**
 * Insert one paired device and return its id. The pubkey is a fixed 64-hex
 * placeholder that satisfies the column CHECK — nothing in the render-or-grant
 * path this scenario drives verifies a signature against it (that is the live
 * daemon's socket, the owner's gate). capabilities / fs_roots are what the
 * grants editor actually shows and edits, so those are real.
 */
export async function seedDevice(seed: SeedDevice): Promise<string> {
  const caps = JSON.stringify(seed.capabilities ?? ['system.info'])
  const roots = JSON.stringify(seed.fsRoots ?? [])
  const lastSeen = seed.lastSeen === 'now' ? 'now()' : 'NULL'
  const pubkey = 'ab'.repeat(32) // 64 hex chars — satisfies devices.pubkey CHECK
  return sql(`
    INSERT INTO devices
      (name, platform, hostname, pubkey, owner_person, capabilities, fs_roots, last_seen)
    VALUES
      ('${seed.name}', '${seed.platform ?? 'linux'}', '${seed.hostname ?? 'host'}',
       '${pubkey}', '${seed.ownerPerson}', '${caps}'::jsonb, '${roots}'::jsonb, ${lastSeen})
    RETURNING id
  `)
}

/** The stored capabilities of one device — read after a UI grants-save to prove
 * the edit hit the database, not just the DOM (returns the jsonb as text). */
export async function deviceCapabilities(id: string): Promise<string> {
  return sql(`SELECT capabilities FROM devices WHERE id = '${id}'`)
}

export async function deleteDevice(id: string): Promise<void> {
  // device_audit FKs devices ON DELETE CASCADE, but this scenario seeds no
  // audit rows; delete the device row directly.
  await sql(`DELETE FROM devices WHERE id = '${id}'`)
}
