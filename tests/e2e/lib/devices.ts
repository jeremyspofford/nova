/**
 * Deterministic device seeding, for the Settings → Devices UI scenario (16).
 *
 * The behaviour-changing halves of the S5 DoD — pair a REAL machine with the
 * printed code, ask Nova to read a file / open an app on it — need a live novad
 * holding an authenticated socket, which is the OWNER's live gate (walked with a
 * real daemon on Jeremy's laptop after review; see task-5-report.md). What this
 * scenario proves instead is that the WEB surface renders and ACTS ON real
 * backend state, and for that the state has to arrive deterministically, not on
 * a daemon's cooperation.
 *
 * So a paired device is seeded where the database already is — inside the
 * project's postgres container over the docker socket, exactly as
 * lib/evidence.ts READS the turn ledger (postgres is deliberately not published
 * outside the compose network). The UI then fetches it through the real
 * authenticated API and the scenario acts on it through the real UI, so the
 * assertion is on the app, not on the seed. The values are fixed test constants
 * — no external input reaches these statements.
 *
 * A device row carries identity only (name, platform, hostname, pubkey, owner)
 * plus liveness: there is no per-device grant to seed, because there is no
 * grant — a paired device does everything the user novad runs as can do (owner
 * ruling 2026-09-03; services/core/migrations/017_no_approvals.sql dropped the
 * columns).
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
 * placeholder that satisfies the column CHECK — nothing in the render-or-revoke
 * path this scenario drives verifies a signature against it (that is the live
 * daemon's socket, the owner's gate).
 */
export async function seedDevice(seed: SeedDevice): Promise<string> {
  const lastSeen = seed.lastSeen === 'now' ? 'now()' : 'NULL'
  const pubkey = 'ab'.repeat(32) // 64 hex chars — satisfies devices.pubkey CHECK
  return sql(`
    INSERT INTO devices
      (name, platform, hostname, pubkey, owner_person, last_seen)
    VALUES
      ('${seed.name}', '${seed.platform ?? 'linux'}', '${seed.hostname ?? 'host'}',
       '${pubkey}', '${seed.ownerPerson}', ${lastSeen})
    RETURNING id
  `)
}

/** The stored revoked_at of one device, as text — empty when NULL. Read after a
 * UI revoke to prove the click hit the database, not just the DOM. */
export async function deviceRevokedAt(id: string): Promise<string> {
  return sql(`SELECT revoked_at FROM devices WHERE id = '${id}'`)
}

export async function deleteDevice(id: string): Promise<void> {
  // device_audit FKs devices ON DELETE CASCADE, but this scenario seeds no
  // audit rows; delete the device row directly. The governance row a revoke
  // wrote is append-only by design and is left in the ledger.
  await sql(`DELETE FROM devices WHERE id = '${id}'`)
}
