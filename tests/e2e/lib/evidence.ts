/**
 * The two mechanical proofs that a reply mentioning "teal" is really the
 * memory path and not the model reading it back out of the conversation
 * history it was also handed.
 *
 *   recall()               — asks the memory service the same question core
 *                            asks it. A hit here after a restart means the
 *                            markdown file survived on the volume and the
 *                            BM25 index was rebuilt at startup, which is the
 *                            whole of the S1 memory claim.
 *   newestTurnRecallSpan() — reads the turn ledger for the turn that just ran
 *                            and reports how many snippets core's
 *                            memory_recall span actually put into the prompt.
 *                            Zero means the reply came from somewhere else,
 *                            whatever it said.
 *
 * The ledger is not readable in every run shape, so it says plainly when it
 * could not look rather than returning a comfortable zero.
 */
import { config } from './env'
import { containerFor, dockerAvailable, execInContainer } from './docker'

export interface RecallHit {
  path: string
  title: string
  kind: string
  snippet: string
  score: number
}

export async function recall(query: string, personId: string, k = 5): Promise<RecallHit[]> {
  if (!config.memoryToken) {
    throw new Error(
      'CORE_MEMORY_TOKEN is not set and deploy/.env did not carry it — memory refuses every ' +
        'unauthenticated request, so this check cannot run',
    )
  }
  const res = await fetch(`${config.memoryUrl}/recall`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.memoryToken}`,
    },
    body: JSON.stringify({ query, person_id: personId, k }),
  })
  const body = await res.text()
  if (!res.ok) throw new Error(`memory /recall refused (${res.status}): ${body.slice(0, 300)}`)
  return JSON.parse(body) as RecallHit[]
}

/** Poll recall until something matches, or say how long we waited for nothing. */
export async function recallUntil(
  query: string,
  personId: string,
  matcher: RegExp,
  timeoutMs = 30_000,
): Promise<RecallHit[]> {
  const deadline = Date.now() + timeoutMs
  let hits: RecallHit[] = []
  for (;;) {
    hits = await recall(query, personId)
    if (hits.some(h => matcher.test(h.snippet) || matcher.test(h.title))) return hits
    if (Date.now() > deadline) {
      throw new Error(
        `memory never recalled anything matching ${matcher} for ${JSON.stringify(query)} within ` +
          `${timeoutMs}ms — last hits: ${JSON.stringify(hits).slice(0, 400)}`,
      )
    }
    await new Promise(r => setTimeout(r, 1500))
  }
}

export interface SpanEvidence {
  available: boolean
  reason?: string
  turnId?: string
  status?: string
  model?: string
  /** Whether core recorded a memory_recall span for the turn at all. */
  recallSpanFound?: boolean
  /** How many snippets that span put into the prompt. */
  recallHits?: number
}

const LEDGER_QUERY = `
SELECT t.id, coalesce(t.status, '(open)'), coalesce(t.model, ''),
       coalesce(s.meta ->> 'hits', 'none')
FROM turns t
LEFT JOIN turn_spans s ON s.turn_id = t.id AND s.kind = 'memory_recall'
WHERE t.kind = 'chat'
ORDER BY t.started_at DESC
LIMIT 1
`

/**
 * The newest chat turn's memory_recall span, read where the database already
 * is. postgres is deliberately not published outside the compose network, so
 * psql runs inside its own container over the docker socket rather than this
 * suite holding a database port open to the host.
 */
export async function newestTurnRecallSpan(): Promise<SpanEvidence> {
  if (!(await dockerAvailable())) {
    return {
      available: false,
      reason: `no docker socket at ${config.dockerSocket} — the turn ledger lives inside the ` +
        'compose network and cannot be read from this run shape',
    }
  }
  const postgres = await containerFor('postgres')
  const raw = await execInContainer(postgres, [
    'psql',
    '-U',
    'postgres',
    '-d',
    'nova_core',
    '-t',
    '-A',
    '-F',
    '|',
    '-c',
    LEDGER_QUERY.trim().replace(/\s+/g, ' '),
  ])
  const line = raw
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .find(l => l.includes('|'))
  if (!line) {
    // This is only ever called straight after a turn, so an empty ledger is
    // not "could not look" — it is the trace ledger failing to record, and it
    // has to be as loud as any other broken assertion.
    throw new Error(
      `the turn ledger has no chat turns at all, immediately after one ran (psql said: ` +
        `${raw.trim().slice(0, 200) || '(nothing)'})`,
    )
  }

  const [turnId, status, model, hits] = line.split('|')
  // "none" is the LEFT JOIN's miss: core recorded no memory_recall span at
  // all for this turn, which is a different fact from "it looked and found
  // nothing" and is kept distinct rather than collapsed into a zero.
  const found = hits !== 'none'
  return {
    available: true,
    turnId,
    status,
    model,
    recallSpanFound: found,
    recallHits: found && hits !== '' ? Number(hits) : 0,
  }
}
