/**
 * Container control over the Docker Engine socket.
 *
 * Two scenarios need it: the restart-persistence walk restarts the whole
 * stack, and the honest-failure walk stops the gateway. Both are done through
 * the engine API rather than by shelling out to `docker compose`, because the
 * suite has to work identically from the host and from inside the playwright
 * container (which has the socket mounted but no docker CLI).
 *
 * Nothing here can touch a volume: the only verbs are list, inspect, start,
 * stop and restart, and every one of them is scoped by the compose project
 * label. A container outside the project is not addressable from this module.
 *
 * WHICH project is not taken on trust. When this suite runs as a service on
 * the stack under test — the documented shape — the project is read off this
 * very container's own compose label, so "the stack I may stop and restart"
 * is the stack I am part of, as a fact rather than as a configuration
 * anybody has to keep in step. An env var that disagrees is a refusal, not a
 * preference: a walk that restarts somebody else's instance because a
 * default said `nova` is the exact accident this file exists to make
 * impossible.
 */
import http from 'node:http'
import { config } from './env'

export interface ContainerInfo {
  id: string
  name: string
  service: string
  state: string
}

function request(
  method: string,
  path: string,
  body?: unknown,
  timeoutMs = 120_000,
): Promise<{ status: number; body: string; raw: Buffer }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const req = http.request(
      {
        socketPath: config.dockerSocket,
        path,
        method,
        timeout: timeoutMs,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {},
      },
      res => {
        const chunks: Buffer[] = []
        res.on('data', chunk => chunks.push(Buffer.from(chunk)))
        res.on('end', () => {
          const raw = Buffer.concat(chunks)
          resolve({ status: res.statusCode ?? 0, body: raw.toString('utf8'), raw })
        })
      },
    )
    req.on('timeout', () => req.destroy(new Error(`docker API timed out after ${timeoutMs}ms`)))
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

/**
 * Un-frame docker's multiplexed exec output.
 *
 * Without a TTY the daemon prefixes every write with an 8-byte header
 * (stream id, then a big-endian length), interleaving stdout and stderr on
 * one connection. Both are wanted here — a psql error message is exactly as
 * interesting as its answer — so both are concatenated in arrival order.
 */
function demultiplex(raw: Buffer): string {
  let out = ''
  let at = 0
  while (at + 8 <= raw.length) {
    const size = raw.readUInt32BE(at + 4)
    out += raw.subarray(at + 8, at + 8 + size).toString('utf8')
    at += 8 + size
  }
  return out
}

/**
 * Run a command inside a project container and return what it printed.
 *
 * This is how the suite reads the turn ledger: postgres is not published to
 * the host (deliberately — nothing outside the compose network has any
 * business talking to it), so `psql` runs where the database already is.
 *
 * Explicitly NOT a TTY. A TTY would spare us the demultiplexing below, but it
 * also makes the command believe a human is watching: psql starts its pager,
 * prints `(END)`, and waits for a keypress that never comes — which shows up
 * as this whole helper hanging until the socket timeout. Costing ten lines of
 * framing to keep every command non-interactive is the right trade.
 */
export async function execInContainer(c: ContainerInfo, cmd: string[]): Promise<string> {
  const created = await request('POST', `/containers/${c.id}/exec`, {
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    Cmd: cmd,
  })
  if (created.status !== 201) {
    throw new Error(`docker: exec create in ${c.name} failed (${created.status}): ${created.body}`)
  }
  const execId = JSON.parse(created.body).Id as string
  const started = await request('POST', `/exec/${execId}/start`, { Detach: false, Tty: false })
  if (started.status !== 200) {
    throw new Error(`docker: exec start in ${c.name} failed (${started.status}): ${started.body}`)
  }
  const output = demultiplex(started.raw)
  const inspected = await request('GET', `/exec/${execId}/json`)
  const exitCode = JSON.parse(inspected.body).ExitCode
  if (exitCode !== 0) {
    throw new Error(
      `docker: ${cmd.join(' ')} exited ${exitCode} in ${c.name}: ${output.trim().slice(0, 400)}`,
    )
  }
  return output
}

/** True when this run can control containers at all — never guessed. */
export async function dockerAvailable(): Promise<boolean> {
  try {
    const res = await request('GET', '/version', undefined, 5_000)
    return res.status === 200
  } catch {
    return false
  }
}

const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project'

let projectPromise: Promise<string> | null = null

/**
 * The compose project every verb in this module is scoped to.
 *
 * In-container: this container's own `com.docker.compose.project` label,
 * full stop. A container with no such label is not part of a compose project
 * at all, and guessing one for it would be inventing the answer — so that is
 * an error with the reason. An explicitly-set NOVA_E2E_PROJECT that names a
 * different project is also an error: one of the two is wrong, and silently
 * picking either would mean touching containers on somebody else's say-so.
 *
 * On the host there is no label to read, so the configured value stands.
 */
async function resolveProject(): Promise<string> {
  const self = selfContainerIdPrefix()
  if (!self) return config.project

  const res = await request('GET', `/containers/${self}/json`, undefined, 15_000)
  if (res.status !== 200) {
    throw new Error(
      `docker: could not inspect this suite's own container ${self} (${res.status}) — the ` +
        'compose project it belongs to is what scopes every container verb here, so it cannot ' +
        `be assumed: ${res.body.slice(0, 200)}`,
    )
  }
  const derived = JSON.parse(res.body).Config?.Labels?.[COMPOSE_PROJECT_LABEL]
  if (typeof derived !== 'string' || derived === '') {
    throw new Error(
      `docker: container ${self} carries no ${COMPOSE_PROJECT_LABEL} label, so which stack this ` +
        'suite may stop and restart is unknown — run it as the `e2e` service of the stack under ' +
        'test rather than as a bare container',
    )
  }
  const declared = process.env.NOVA_E2E_PROJECT
  if (declared && declared !== derived) {
    throw new Error(
      `docker: NOVA_E2E_PROJECT=${declared} but this suite is running inside compose project ` +
        `${derived}. Refusing to act: one of those names a stack this walk has no business ` +
        'restarting. Unset NOVA_E2E_PROJECT to use the project this container belongs to.',
    )
  }
  return derived
}

export function projectName(): Promise<string> {
  projectPromise ??= resolveProject()
  return projectPromise
}

function filters(project: string, extra: Record<string, string[]> = {}): string {
  const labels = [`${COMPOSE_PROJECT_LABEL}=${project}`]
  return encodeURIComponent(JSON.stringify({ label: labels, ...extra }))
}

/** Every container in the compose project, running or not. */
export async function listProjectContainers(): Promise<ContainerInfo[]> {
  const project = await projectName()
  const res = await request('GET', `/containers/json?all=true&filters=${filters(project)}`)
  if (res.status !== 200) {
    throw new Error(`docker: listing project ${project} failed (${res.status}): ${res.body}`)
  }
  return (JSON.parse(res.body) as Array<Record<string, any>>).map(c => ({
    id: c.Id as string,
    name: ((c.Names as string[]) ?? ['?'])[0].replace(/^\//, ''),
    service: (c.Labels?.['com.docker.compose.service'] as string) ?? '?',
    state: c.State as string,
  }))
}

export async function containerFor(service: string): Promise<ContainerInfo> {
  const project = await projectName()
  const found = (await listProjectContainers()).filter(c => c.service === service)
  if (found.length !== 1) {
    throw new Error(
      `docker: expected exactly one ${project}/${service} container, found ${found.length}` +
        ` (${found.map(c => c.name).join(', ') || 'none'})`,
    )
  }
  return found[0]
}

async function act(verb: 'start' | 'stop' | 'restart', id: string, name: string): Promise<void> {
  const res = await request('POST', `/containers/${id}/${verb}`, undefined)
  // 304 is "already in that state" — the requested end state holds, which is
  // all a caller asked for.
  if (res.status !== 204 && res.status !== 304) {
    throw new Error(`docker: ${verb} ${name} failed (${res.status}): ${res.body}`)
  }
}

export const stopContainer = (c: ContainerInfo) => act('stop', c.id, c.name)
export const startContainer = (c: ContainerInfo) => act('start', c.id, c.name)
export const restartContainer = (c: ContainerInfo) => act('restart', c.id, c.name)

export interface ContainerStatus {
  service: string
  name: string
  state: string
  /** "healthy"/"starting"/"unhealthy", or "none" for a container with no healthcheck. */
  health: string
}

export async function statusOf(id: string): Promise<ContainerStatus> {
  const res = await request('GET', `/containers/${id}/json`)
  if (res.status !== 200) throw new Error(`docker: inspect failed (${res.status}): ${res.body}`)
  const data = JSON.parse(res.body)
  return {
    service: data.Config?.Labels?.['com.docker.compose.service'] ?? '?',
    name: (data.Name as string).replace(/^\//, ''),
    state: data.State?.Status ?? '?',
    health: data.State?.Health?.Status ?? 'none',
  }
}

/** The health table, exactly as the engine reports it. */
export async function healthTable(): Promise<ContainerStatus[]> {
  const containers = await listProjectContainers()
  const rows = await Promise.all(containers.map(c => statusOf(c.id)))
  return rows.sort((a, b) => a.service.localeCompare(b.service))
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/**
 * Wait until every named service is running AND (if it has a healthcheck)
 * healthy. Times out with the last observed table in the message — a wait
 * that gives up silently is the failure mode this whole repo bans.
 */
export async function waitForHealthy(services: string[], timeoutMs = 180_000): Promise<ContainerStatus[]> {
  const deadline = Date.now() + timeoutMs
  let last: ContainerStatus[] = []
  for (;;) {
    last = (await healthTable()).filter(r => services.includes(r.service))
    const missing = services.filter(s => !last.some(r => r.service === s))
    const bad = last.filter(r => r.state !== 'running' || (r.health !== 'none' && r.health !== 'healthy'))
    if (missing.length === 0 && bad.length === 0) return last
    if (Date.now() > deadline) {
      const table = last.map(r => `${r.service}=${r.state}/${r.health}`).join(' ')
      throw new Error(
        `services not healthy within ${timeoutMs}ms — missing: [${missing.join(', ')}], table: ${table || '(empty)'}`,
      )
    }
    await sleep(2000)
  }
}

/**
 * The container this process is running in, if it is running in one.
 *
 * Docker sets the container's hostname to its own short id unless told
 * otherwise, and compose does not override it — so HOSTNAME identifies us.
 * A host run has a hostname that matches no container, which is the right
 * answer there too.
 */
function selfContainerIdPrefix(): string {
  const hostname = process.env.HOSTNAME ?? ''
  return /^[0-9a-f]{12,64}$/.test(hostname) ? hostname : ''
}

/**
 * `docker compose restart` for the whole project, one container at a time.
 *
 * Deliberately never restarts the container this suite is running in. The e2e
 * service is a member of the same compose project, so "restart everything in
 * the project" includes the process doing the restarting — which kills the run
 * mid-scenario and looks exactly like the stack failing to come back.
 */
export async function restartProject(): Promise<string[]> {
  const self = selfContainerIdPrefix()
  const running = (await listProjectContainers()).filter(
    c => c.state === 'running' && c.service !== 'e2e' && !(self && c.id.startsWith(self)),
  )
  for (const c of running) await restartContainer(c)
  return running.map(c => c.service).sort()
}
