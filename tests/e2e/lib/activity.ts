/**
 * The mechanical half of the tool-loop scenarios: what the ledger says
 * happened, and what is actually on the workspace volume.
 *
 * The reason these exist as a pair is the whole point of the walk. A reply
 * that says "I wrote groceries.md with five items" is a sentence a model can
 * produce without having called anything at all — it is the single easiest
 * thing in this system to fake, and the only defence is not to read it. So
 * every tool claim in these scenarios is checked twice, from two places
 * neither the model nor the prose can reach:
 *
 *   readWorkspaceFile()  — cats the file inside core's own container, under
 *                          the WORKSPACE_ROOT that container is configured
 *                          with, on the docker volume the tool writes to.
 *   turnAfter()/spans    — reads the turn ledger through the Activity API,
 *                          where a span's ok flag was set by dispatch()
 *                          rather than by anything that looked at the text.
 *
 * If those two disagree with each other, or with the reply, the disagreement
 * is the finding.
 */
import { expect, type Page } from '@playwright/test'
import { containerFor, execInContainer } from './docker'

export interface ActivityTurn {
  id: string
  kind: string
  model: string | null
  status: string | null
  started_at: string
  duration_ms: number | null
  tool_call_count: number
  llm_round_count: number
  conversation_id: string | null
}

export interface ActivitySpan {
  kind: string
  name: string | null
  started_at: string
  duration_ms: number | null
  meta: Record<string, unknown>
}

export interface TurnDetail {
  turn: ActivityTurn
  spans: ActivitySpan[]
}

export async function listTurns(page: Page, limit = 20): Promise<ActivityTurn[]> {
  const res = await page.request.get(`/api/v1/activity?limit=${limit}`)
  expect(res.ok(), `GET /api/v1/activity -> ${res.status()}`).toBeTruthy()
  return (await res.json()).turns as ActivityTurn[]
}

export async function turnDetail(page: Page, id: string): Promise<TurnDetail> {
  const res = await page.request.get(`/api/v1/activity/${id}`)
  expect(res.ok(), `GET /api/v1/activity/${id} -> ${res.status()}`).toBeTruthy()
  return (await res.json()) as TurnDetail
}

/** The newest turn's id, or null on an instance that has taken none. */
export async function newestTurnId(page: Page): Promise<string | null> {
  const turns = await listTurns(page, 1)
  return turns[0]?.id ?? null
}

/**
 * The one turn that ran since `previousNewestId`.
 *
 * Deliberately not "the newest turn": a scenario that reads the newest row
 * would happily attribute a turn some other tab, retry or background job
 * produced to the message it just sent, and pass on somebody else's
 * evidence. Requiring EXACTLY one new turn makes that misattribution a
 * failure with both ids in the message instead.
 */
export async function turnAfter(page: Page, previousNewestId: string | null): Promise<ActivityTurn> {
  const turns = await listTurns(page)
  const fresh: ActivityTurn[] = []
  for (const turn of turns) {
    if (turn.id === previousNewestId) break
    fresh.push(turn)
  }
  expect(
    fresh.length,
    `expected exactly one new turn since ${previousNewestId ?? '(none)'}, got ${fresh.length}: ` +
      JSON.stringify(fresh.map(t => ({ id: t.id, status: t.status, tools: t.tool_call_count }))),
  ).toBe(1)
  return fresh[0]
}

export const toolSpans = (spans: ActivitySpan[]) => spans.filter(s => s.kind === 'tool')

/** Every tool span for `name`, oldest first, in the order they ran. */
export const spansForTool = (spans: ActivitySpan[], name: string) =>
  toolSpans(spans).filter(s => s.name === name)

/**
 * One line per tool span, for a failure message or the console — the whole
 * point being that a scenario which goes red says what the loop actually
 * did, not merely that an expectation was not met.
 */
export function describeToolSpans(spans: ActivitySpan[]): string {
  const rows = toolSpans(spans)
  if (rows.length === 0) return '(no tool spans at all)'
  return rows
    .map(s => {
      const head = typeof s.meta.result_head === 'string' ? s.meta.result_head : ''
      return `${s.name} ok=${s.meta.ok} args=${JSON.stringify(s.meta.args_redacted)} ` +
        `result=${JSON.stringify(head.slice(0, 120))}`
    })
    .join('\n    ')
}

/**
 * A file on the workspace volume, read inside core's own container.
 *
 * The root comes from that container's WORKSPACE_ROOT rather than being
 * written out here, so this reads wherever the tools are actually
 * configured to write — a compose change that moves the mount makes this
 * follow it instead of quietly checking the wrong empty directory. The path
 * is passed as an argument, not interpolated into the shell string.
 */
export async function readWorkspaceFile(relPath: string): Promise<string> {
  const core = await containerFor('core')
  return execInContainer(core, ['sh', '-c', 'cat "$WORKSPACE_ROOT/$1"', 'sh', relPath])
}

/** The workspace as core sees it: `ls -la`, for evidence in a failure. */
export async function listWorkspace(): Promise<string> {
  const core = await containerFor('core')
  return execInContainer(core, ['sh', '-c', 'ls -la "$WORKSPACE_ROOT"'])
}

/** uid:gid and mode of the workspace mount point, as the writing process sees it. */
export async function workspaceOwnership(): Promise<string> {
  const core = await containerFor('core')
  return (
    await execInContainer(core, [
      'sh',
      '-c',
      'printf "process=%s mount=" "$(id -u):$(id -g)"; stat -c "%u:%g %a" "$WORKSPACE_ROOT"',
    ])
  ).trim()
}
