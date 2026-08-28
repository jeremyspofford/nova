/**
 * Where this run points and what it may use.
 *
 * Two shapes are supported and neither is special-cased anywhere else:
 *   host       — `npm run e2e` from tests/e2e, talking to 127.0.0.1 ports
 *   in-compose — the `e2e` profile service, talking to service names
 * Everything that differs between them is one environment variable with a
 * host default, so a test never asks which shape it is running in.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = resolve(here, '../../..')
export const E2E_DIR = resolve(here, '..')

/**
 * deploy/.env, parsed. The secrets install.sh generated are the only place
 * the per-link bearer tokens exist, and a host run can read the file
 * directly. In-compose runs get them injected as environment variables
 * instead, so a missing file is not an error here — an unresolvable token is,
 * and that is raised at the point of use with the reason.
 */
function readDeployEnv(): Record<string, string> {
  const out: Record<string, string> = {}
  let raw: string
  try {
    raw = readFileSync(resolve(REPO_ROOT, 'deploy/.env'), 'utf8')
  } catch {
    return out
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
  }
  return out
}

const deployEnv = readDeployEnv()

function env(name: string, fallback: string): string {
  const value = process.env[name] ?? deployEnv[name]
  return value === undefined || value === '' ? fallback : value
}

export const config = {
  /** The one origin a browser sees. */
  baseUrl: env('NOVA_E2E_BASE_URL', 'http://127.0.0.1:3000'),
  /** The memory service, asked directly to prove what survived a restart. */
  memoryUrl: env('NOVA_E2E_MEMORY_URL', 'http://127.0.0.1:8002'),
  /** core→memory bearer; memory refuses every request without it. */
  memoryToken: env('CORE_MEMORY_TOKEN', ''),
  /** The compose project the stack runs under. */
  project: env('NOVA_E2E_PROJECT', 'nova'),
  dockerSocket: env('NOVA_E2E_DOCKER_SOCKET', '/var/run/docker.sock'),
  /**
   * The wizard's model. Defaults to the smallest curated slug so a CI-speed
   * pull is feasible; on a host whose VRAM tier does not offer that slug, set
   * this to one the wizard actually lists (the model step only ever offers
   * curated slugs for the detected tier).
   */
  model: env('NOVA_E2E_MODEL', 'qwen3:1.7b'),
  /**
   * The owner this walk mints. Registration closes after the FIRST owner, so
   * whatever is used here is the credential that instance keeps, permanently,
   * until somebody resets its database.
   *
   * The password therefore has no default and never will. A default would be
   * a password committed to a public repository that silently becomes the
   * real one on every machine that runs this suite without reading the
   * README — and "the owner account of a self-hosted assistant" is the worst
   * possible thing to hand a known credential. Unset means scenario 1
   * refuses, with the reason.
   */
  ownerName: env('NOVA_E2E_OWNER_NAME', 'Jeremy'),
  ownerPassword: env('NOVA_E2E_OWNER_PASSWORD', ''),
  /** Where the signed-in browser state is parked between scenario files. */
  storageStatePath: resolve(E2E_DIR, '.auth/owner.json'),
  /** A first pull of an 18 GB model is minutes, not seconds. */
  pullTimeoutMs: Number(env('NOVA_E2E_PULL_TIMEOUT_MS', String(45 * 60 * 1000))),
  /** A cold model load after a restart, plus generation. */
  replyTimeoutMs: Number(env('NOVA_E2E_REPLY_TIMEOUT_MS', String(6 * 60 * 1000))),
}

/** The exact phrase scenario 2 plants and scenario 3 goes looking for. */
export const MEMORY_FACT = 'My favorite color is teal-green, remember that.'
export const MEMORY_NEEDLE = /teal|colou?r/i
