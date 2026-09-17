/**
 * Scenario 7 — the Slice 2 definition of done: she writes a file and reads
 * it back, and the file is really there.
 *
 * The prompt is the DoD's own sentence. What makes this a test rather than a
 * demo is that NOTHING here is taken from the reply. "I created groceries.md
 * with five items" is the cheapest sentence in the system to produce without
 * having called anything, so the claim is checked in two places the model
 * cannot reach:
 *
 *   1. the file, cat'ed inside core's container on the workspace volume;
 *   2. the turn ledger, where each span's ok flag was set by dispatch()
 *      rather than by anything that read the prose.
 *
 * And then the two are checked against each other: the write tool reports
 * how many bytes it landed, and that number has to equal the size of the
 * file actually on disk. A fabricated call cannot produce a matching pair.
 *
 * This scenario also discharges a carry from the task that built the tools:
 * the workspace mkdir in services/core/Dockerfile was only ever verified by
 * reading it. A named volume takes its ownership from the image path it is
 * mounted over, so without that line the volume arrives root-owned and the
 * first write fails with a permission error. Here the volume is genuinely
 * fresh (compose created nova-e2e_v4_workspace for this walk), the process
 * is uid 1000, and a real write goes through it — which is the only thing
 * that can settle the question.
 */
import { expect, test } from '@playwright/test'
import { sendMessage } from '../lib/app'
import { config, GROCERIES } from '../lib/env'
import {
  describeToolSpans,
  listWorkspace,
  newestTurnId,
  readWorkspaceFile,
  spansForTool,
  turnAfter,
  turnDetail,
  workspaceOwnership,
} from '../lib/activity'

test.use({ storageState: config.storageStatePath })

const DOD_PROMPT =
  'create a file called groceries.md with five items, then read it back and confirm'

test('tool loop: she writes groceries.md, reads it back, and the file is really there', async ({
  page,
}) => {
  // Several rounds of a CPU-served model, plus the tool calls between them.
  test.setTimeout(config.replyTimeoutMs * 2 + 5 * 60 * 1000)

  await page.goto('/chat')
  await expect(page.getByRole('heading', { name: 'Chat' })).toBeVisible()

  // The mount point, as the process that writes to it sees it. Asserted
  // before the turn so a root-owned volume is reported as itself rather
  // than as "the model did not call the tool".
  const ownership = await workspaceOwnership()
  console.log(`[scenario 7] workspace ownership: ${ownership}`)
  const [processIds, mountIds] = [
    /process=(\d+:\d+)/.exec(ownership)?.[1],
    /mount=(\d+:\d+)/.exec(ownership)?.[1],
  ]
  expect(
    mountIds,
    `could not read the workspace ownership at all: ${ownership}`,
  ).toBeDefined()
  expect(
    mountIds?.split(':')[0],
    `the workspace volume is owned by uid ${mountIds?.split(':')[0]} but core runs as ` +
      `${processIds} — the Dockerfile's mkdir/chown of WORKSPACE_ROOT is what stops a fresh ` +
      'named volume from arriving root-owned, and this is the check that it works',
  ).toBe(processIds?.split(':')[0])

  const before = await newestTurnId(page)
  const outcome = await sendMessage(page, DOD_PROMPT, config.replyTimeoutMs * 2)
  expect(outcome.kind, `the DoD turn did not produce a reply: ${outcome.text}`).toBe('reply')
  expect(outcome.text.length).toBeGreaterThan(0)
  console.log(`[scenario 7] reply: ${outcome.text.replace(/\s+/g, ' ').slice(0, 300)}`)

  // ── the ledger's account of the same turn ───────────────────────────────
  const turn = await turnAfter(page, before)
  const { spans } = await turnDetail(page, turn.id)
  console.log(
    `[scenario 7] turn ${turn.id} status=${turn.status} rounds=${turn.llm_round_count} ` +
      `tools=${turn.tool_call_count}\n    ${describeToolSpans(spans)}`,
  )
  expect(turn.status).toBe('ok')

  const writes = spansForTool(spans, 'workspace_write_file')
  const reads = spansForTool(spans, 'workspace_read_file')
  const write = writes.find(s => s.meta.ok === true)
  const read = reads.find(s => s.meta.ok === true)
  expect(
    write,
    `no successful workspace_write_file span on this turn — spans were:\n    ` +
      describeToolSpans(spans),
  ).toBeDefined()
  expect(
    read,
    `no successful workspace_read_file span on this turn — she has to read the file back before ` +
      `saying it worked. Spans were:\n    ${describeToolSpans(spans)}`,
  ).toBeDefined()
  // Written first, then read: "read it back" means after, not instead.
  expect(
    Date.parse(read!.started_at) >= Date.parse(write!.started_at),
    `the read span (${read!.started_at}) is older than the write (${write!.started_at})`,
  ).toBeTruthy()

  // ── the file, on the volume, read where it lives ────────────────────────
  let onDisk: string
  try {
    onDisk = await readWorkspaceFile(GROCERIES)
  } catch (err) {
    throw new Error(
      `the reply claimed the file was written, but it is not on the workspace volume: ` +
        `${err instanceof Error ? err.message : String(err)}\n` +
        `workspace now holds:\n${await listWorkspace()}`,
    )
  }
  expect(onDisk.length, `${GROCERIES} exists but is empty`).toBeGreaterThan(0)
  console.log(`[scenario 7] ${GROCERIES} on disk (${Buffer.byteLength(onDisk)} bytes):\n${onDisk}`)

  // ── the two accounts have to agree ──────────────────────────────────────
  // The write tool verifies its own result and reports the size it found on
  // disk. That number and the file's real size are produced by two different
  // processes at two different times, so a call that never happened cannot
  // make them match.
  const reported = /Wrote .*? \((\d+) bytes\)/.exec(String(write!.meta.result_head ?? ''))
  expect(
    reported,
    `workspace_write_file's result did not state a byte count: ` +
      JSON.stringify(write!.meta.result_head),
  ).not.toBeNull()
  expect(
    Number(reported![1]),
    `the write span says it landed ${reported![1]} bytes but the file on the volume is ` +
      `${Buffer.byteLength(onDisk)}`,
  ).toBe(Buffer.byteLength(onDisk))

  // And what she read back is what is there — not a paraphrase of it.
  const resultHead = String(read!.meta.result_head ?? '')
  expect(
    onDisk.startsWith(resultHead) || resultHead.startsWith(onDisk),
    `workspace_read_file returned text that is not the file's content.\n  span: ` +
      `${JSON.stringify(resultHead.slice(0, 200))}\n  disk: ${JSON.stringify(onDisk.slice(0, 200))}`,
  ).toBeTruthy()

  // The DoD asked for five items. How many actually landed is the model's
  // doing, not the loop's, so it is reported rather than asserted — the
  // machinery under test is "a file she wrote is really there", and a
  // four-item file would still prove that while a hard 5 here would turn a
  // small model's counting into a broken-plumbing failure.
  const items = onDisk.split('\n').filter(line => /^\s*([-*+]|\d+[.)])\s+\S/.test(line))
  console.log(`[scenario 7] ${items.length} list item(s) in ${GROCERIES}`)
})
