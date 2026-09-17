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
  /**
   * The compose project the stack runs under — a HOST-run fallback only.
   *
   * When the suite runs as the stack's own `e2e` service (the documented
   * shape) this value is not used: lib/docker.ts reads the project off the
   * container's own compose label instead, and refuses outright if this is
   * set to something else. Which containers a walk may stop and restart is
   * too dangerous a fact to take from a default.
   *
   * The default is the throwaway project, never `nova`. A default that names
   * somebody's real instance is a loaded gun pointed at it by whichever code
   * path forgets to set this — and `restartProject()` restarts every
   * container in whatever it is given. A host run against another stack has
   * to say so out loud.
   */
  project: env('NOVA_E2E_PROJECT', 'nova-e2e'),
  dockerSocket: env('NOVA_E2E_DOCKER_SOCKET', '/var/run/docker.sock'),
  /**
   * The wizard's model. Defaults to the smallest curated slug so a CI-speed
   * pull is feasible; on a host whose VRAM tier does not offer that slug, set
   * this to one the wizard actually lists (the model step only ever offers
   * curated slugs for the detected tier).
   */
  model: env('NOVA_E2E_MODEL', 'qwen3:1.7b'),
  /**
   * The change-model scenario's switch target (S2e-T4, scenario 11) — has
   * to be a curated slug distinct from `model` above, small enough that
   * pulling it in-scenario is cheap. Not `model` itself: the scenario is
   * pulling AND switching, and switching to what is already current would
   * prove nothing about either half.
   */
  secondModel: env('NOVA_E2E_SECOND_MODEL', 'qwen3:4b'),
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
/**
 * The fact itself, and ONLY the fact.
 *
 * This used to be `/teal|colou?r/i`, which was defensible while scenario 3
 * asked the open question "What did we talk about earlier?" — a reply that
 * volunteered the word "colour" at least showed the topic had survived.
 * It stopped being defensible the moment that question became "What colour
 * did I tell you was my favourite?", because the question hands the answer
 * its own needle: "I don't know what colour you told me" matches, and so
 * does naming the wrong colour. An assertion that a wrong answer passes is
 * not an assertion.
 */
export const MEMORY_NEEDLE = /teal/i

/**
 * The file the tool-loop scenarios write, read back and add to.
 *
 * Here rather than exported from the scenario that creates it: importing one
 * spec file from another runs its module body, which re-registers its
 * `test()` calls under the importing file and quietly doubles the walk.
 */
export const GROCERIES = 'groceries.md'
