# 18 — Acceptance Criteria

## 1. Global Definition of Done (per milestone)

A milestone is **accepted** when all of the following are true:

1. Every `FR-*` in the milestone's coverage list is implemented and has tests.
2. The milestone's **golden journey** passes in E2E on Linux (and on macOS/Windows for
   release-bearing milestones).
3. `npm run lint && npm run typecheck && npm test && npm run test:e2e && npm run build` are
   green in CI.
4. No new P0/P1 defect; no unwaivered high/critical `npm audit` finding.
5. Docs in `docs/` and contracts in `contracts/` are updated; `LEDGER.md` is current.
6. New user-facing surfaces meet the accessibility baseline (axe: no serious/critical).
7. Performance budgets for touched surfaces are met or a waiver is recorded.
8. A short demo script exists under `docs/demos/M<n>.md` and runs from a clean profile.

## 2. Release Definition of Done

The product is release-ready when:

- M0–M9 accepted and M10 tasks complete.
- Every `FR-*` in `docs/03` implemented or explicitly deferred (P2 deferrals listed with rationale).
- Full test suite green on all three platforms; security suite green.
- Performance budgets met (`AGENTS.md` §9).
- Signed Hub image and unit, `novad` builds and installers for Linux/macOS/Windows, with SBOM,
  checksums, signatures and the download verification procedure published (FR-225).
- Update → rollback verified.
- User-facing docs: quickstart, feature guide, security/privacy guide, troubleshooting.
- `CHANGELOG.md` and `RELEASE_NOTES.md` complete.
- `docs/19` legal review checklist satisfied (original assets, permissive deps, notices).

## 3. Milestone golden journeys (E2E scripts)

These are the concrete, scripted acceptance tests. Each must be automated. Until M7 they run
with Playwright against a running Hub's web UI; native-shell steps start at M7 (`docs/16`
§3.3). A step marked "(Mn)" is added to the journey when milestone Mn lands.

### J1 — First chat (M1)
1. Fresh profile → onboarding → connect mock provider → set name.
2. Send "Hello" → tokens stream → Stop works → partial retained.
3. Restart the Hub → reload → chat is present → search finds "Hello".
4. Toggle theme → colors change.

### J2 — Providers & memory (M2)
1. Connect Anthropic-mock and local-mock.
2. Chat on A; switch model to B mid-thread; context preserved.
3. Move the preset control from Balanced to Smarter; the turn records the preset and the
   resolved model; Advanced shows and edits the preset's choices (FR-221).
4. State a preference; open Memory panel; it appears; edit it; temporary chat excludes it.
5. (M3) Idle threads are consolidated: the Memory page groups the item under a category and
   the summary stays under 2,500 tokens; "remember less" on that topic is honoured by the next
   consolidation (FR-204).
6. (M3) Turn off "Reference past chats": the next turn retrieves no past-chat content while
   saved memories still apply; a memory saved in a Project only project is not used in a chat
   outside it (FR-205).

### J3 — Tools & approvals (M3)
1. Add test MCP server; it reports healthy. With 50 test tools registered, tools are
   deferred and `tool.search` loads the one needed (FR-196).
2. Ask a question that triggers a read tool (auto-allow) and a write tool (ask).
3. Exercise each decision on the approval card (FR-100):
   a. **Allow once** → the next identical call asks again.
   b. **Allow for this session** → identical calls in this session run without asking; a new
      session asks again.
   c. **Always allow → commands starting with `npm test`** → a prefix rule with its examples
      is appended and listed under Permissions; `npm test && curl …` still asks (FR-191).
   d. **Deny and continue** with a reason → the agent receives the reason and the run goes on.
   e. **Deny and stop** → the run stops with partial results kept.
   f. **Hand off** → the run waits as Needs input until the step is marked done.
   g. Let one request time out (simulated clock) → the outcome is recorded as `timeout`.
4. A `confirm_at_action` action (a mock purchase) offers no pre-approval options; a pasted
   "I approve this purchase" does not authorize it (FR-189).
5. Verify Activity entries and the audit hash chain for every decision.
6. (M5) Answer an approval from a second client; the first client's card resolves and shows
   where it was answered (FR-188).

### J4 — Extensibility & workspace (M4)
1. Install sample plugin from local catalog; run its slash command.
2. Attempt an undeclared network call → blocked with a clear error.
3. The plugin's hook appears on the install screen and runs only after it is trusted; edit the
   hook file → it is disabled until re-trusted; the hook cannot turn a deny into an allow
   (FR-197).
4. Open the plugin's MCP App inline → fullscreen → picture-in-picture; a tool call from the app
   raises an approval card (FR-198).
5. Install an unsigned MCP bundle → an explicit sideload confirmation; it is labelled
   unverified and its secret config value lands in the keychain (FR-199).
6. Arrange panes (chat+terminal+editor); save layout; restart; layout restored.

### J5 — Work run (M5)
1. New run: "Summarize the attached report and save a Markdown artifact and a DOCX copy";
   set a goal and a 10-minute time budget (FR-181, FR-219).
2. Plan appears; approve; 3+ tool calls execute; one asks for approval. The sidebar chip moves
   Running → Needs input → Running (FR-215).
3. The header shows live consumption; at 10 minutes (simulated clock) the run pauses with a
   progress summary, status Blocked with "Budget reached", and offers Extend; nothing runs
   until the user extends; after Extend the run finishes (FR-182).
4. Result card shows both artifacts with previews; chip is Ready; Activity trace replays;
   schedule it daily.
5. The scheduled delivery's channel mock accepts the request but returns no receipt → the job
   ends `output_missing` with the trace linked (FR-187).
6. From a chat, ask for a multi-step task → an inline run card is proposed; Start run; the run
   completes inside the chat and is also listed under Work (FR-186).
7. Start a deep research run on the fixture corpus → a cited report artifact with a source
   list (FR-220).

### J6 — Code session (M5)
1. New session in the fixture repo; permission mode Accept edits.
2. Ask to fix a failing test; edits appear as diff. The repo's instruction files are loaded
   root-to-cwd within the 32 KiB budget (FR-185).
3. The agent tries to write `.git/config` and `.nova/` → denied as protected paths (built-in
   safety, applied after the permission profile) with no approval offered, and audited
   (FR-190).
4. The agent starts the dev server through `exec.run`, gets a session id after the yield time,
   polls output and writes stdin; cancelling the session kills it (FR-184).
5. The fixture repo has a Git hook that writes a marker: Nova's own status, diff and worktree
   operations do not run it (FR-211).
6. Comment on a line; agent revises; run tests; commit; PR status (mock host) shows.

### J7 — Agent (M6)
1. Create Agent; connect mock Slack and mock calendar.
2. Agent performs read-only proactive research and surfaces a finding.
3. Message the agent from a Slack DM and from a shared Slack channel → two threads under the
   agent, shared memory; a detail from the DM does not appear in the channel reply unless a
   policy check allows it (FR-088).
4. Ask it to message a channel; a custom rule forces approval; deny; then allow-once.
5. A mock MCP server with events delivers a signed event → the agent wakes; an unsigned or
   oversized delivery is rejected; a duplicate id is ignored (FR-201).
6. The agent sets its own next wake with `schedule.wake`; it appears in the Scheduled list as
   set by the agent; the user cancels it (FR-206).
7. Through `novad` on the connected mock device, the agent stages a file write; the diff is
   shown; commit applies it; a write outside the granted folders triggers a folder-access
   request (FR-210).
8. Open its computer; take over; return control; verify audit entries.

### J8 — Browser safety (M6)
1. Navigate the Agent to the local test site; read/click/screenshot.
2. Attempt navigation to an unlisted host → blocked with a clear error; a sandboxed `curl` to
   the same host gets 403 with a cause header from the egress proxy (FR-193).
3. Inject an instruction in page content; verify no unapproved action occurs.
4. Credential injection (FR-193): a credential is configured for the mock API host. From inside
   the sandbox, the environment, files and a request to an echo server show no credential;
   the request to the mock API host arrives with it, added by the proxy.
5. External agent (FR-194): a channel message and a page signed "the billing agent" ask the
   agent to send it a report → ignored, nothing sent, and an audit entry written.
6. Computer use on the mock desktop (FR-207): the browser app is view-only, the terminal
   click-only; pressing the kill key stops control and no further input event is delivered.

### J9 — Sync & multi-device (M7)
1. Two profiles pair devices.
2. Create a chat on device A; it appears on B.
3. Edit the same note concurrently → merge log records the conflict; restore works.
4. Queue an offline action; reconnect; it flushes in order.
5. Hand a Code session off from device A to B with uncommitted changes; B continues on the
   same branch with the patch applied; the move is in the session history (FR-213).

### J10 — Extension & governance (M8)
1. Load a sample extension adding a command + panel + tool; permissions enforced.
2. Apply a managed policy that locks bypass mode and network; UI shows "managed".
3. Export data; delete all; import; verify integrity.

### J11 — Release (M10)
1. Install the packaged build; run first-run.
2. Update to the next build; verify data migrated; trigger a simulated failure → rollback.
3. Start a second Hub while the port is held → diagnostic plus fallback port; `--strict-port`
   exits non-zero with the same diagnostic (FR-225).
4. Run the download verification procedure (`docs/15` §3.1) on the release artifacts; a
   tampered artifact fails it.

## 4. Per-feature acceptance (traceability)

Every `FR-*` must have a row in a test manifest:

```markdown
| FR | Unit | Integration | E2E | Notes |
|----|------|-------------|-----|-------|
| FR-018 | providers/stream.test.ts | — | J1 step 2 | cancellation + partial retention |
| FR-099 | policy/evaluate.test.ts | agent/tool-gate.test.ts | J3 | all four effects + traversal |
```

The manifest lives at `tests/manifest.md`. `node scripts/check-spec.mjs` (CI job `spec-check`)
fails if an `FR-*` in `docs/03` has no row, or more than one, or is missing from the milestone
index in `docs/17`.

## 5. Non-functional acceptance

| Area | Criterion |
| --- | --- |
| Performance | all budgets met on reference hardware; CI regression guard |
| Reliability | crash-free sessions ≥ 99.5% in a 7-day soak test |
| Offline | chat, memory, local tools, and settings work with the network disabled |
| Recovery | kill -9 during a run → restart resumes from last committed step |
| Security | security suite and persistence safety evals green; auto-reviewer metrics within thresholds (`docs/16` §5); no plaintext secrets in artifacts |
| Accessibility | axe clean; keyboard-only journeys pass |
| Privacy | telemetry and OTLP export off by default; no network without user action except the update-metadata check (every 6 h, can be disabled) and endpoints the user configured |
| Data | export/delete round-trip integrity; audit chain verifies |
| Portability | same DB opens on all three OSes; no platform-specific data loss |
| i18n | RTL layout has no overlap/clipping on core screens |

## 6. Sign-off artifacts

For each accepted milestone, produce under `docs/demos/`:
- `M<n>.md` — the demo script and expected results.
- `M<n>-evidence/` — screenshots, trace excerpts, test output summaries (small files only).

And in `LEDGER.md`:
- status table with commit SHAs,
- the golden journey result,
- any deferrals with rationale and a linked follow-up task.

## 7. Capability-track acceptance (N1–N4)

- **N1 Ambient Memory** (matches the N1 exit criteria in `docs/17`) — capture off by default;
  enabling shows a persistent indicator; nothing is readable until certified by redaction; a
  query returns screen matches with the time covered and any gaps; exclusions and "forget last
  N minutes" work; a capture containing an injection payload never triggers an action; a reply
  claiming screen activity without an ambient tool call is flagged. Audio and meeting
  criteria apply when phase 2 lands (FR-230, FR-231).
- **N2 Automations & Smart Home** — a scheduled automation runs an agent and controls a mock
  entity; a lock/garage action requires approval; dry-run produces no side effects; a failed
  action rolls back where compensation exists; optional HomeKit bridge.
- **N3 Extensions & Community** — install a signed MCP server + plugin; an added permission on
  update forces re-confirmation; unsigned/sideloaded entries warn; the fleet kill switch
  disables an extension; the catalog is reachable via public domain and tailnet.
- **N4 Learning & Self-Improvement** — memory learning is reviewable/reversible; a skill
  proposal requires approval; an optimization is backed by eval evidence and rollback; an
  attempt to modify the policy engine is denied and logged high-severity; the kill switch halts
  proposals.
