# Slice 2 — Tool Loop + Activity View

Parent: the Master Roadmap (approved 2026-08-27); inputs:
docs/plans/rebuild/slice-01-carries.md (S1 hand-offs) and the owner's live
S1 walk findings (2026-08-28). Slice type: additive. Size: M+.

Goal: Nova DOES things — a bounded tool loop over a deliberately small
toolset, with every call recorded as a span and visible to the operator on
a new Activity page. This is the 27B-class stress test the roadmap
front-loaded: if a local model can't hold a 3-5 step loop here, we learn it
now. Ships with the S1 bug fix and the seam-hygiene batch the reviews
queued.

## Definition of done (operator-visible, walked in the running app)

1. In chat: "create a file called groceries.md with five items, then read
   it back and confirm" → Nova replies correctly; the file genuinely
   exists in her workspace volume.
2. Open Activity: the turn shows its real tool calls (names, args, result
   heads, durations) matching what happened; drill-in works.
3. Follow-up "add milk to that list" works (re-read + re-write).
4. Send a message, navigate to Settings mid-stream, return: the full reply
   is there (S1 bug #9 fixed).
5. The same DoD scenario run on qwen3:8b AND qwen3.8:27b, with rounds/
   latency/success recorded — the honest data point for the model slice.

## Tasks

### T1 — Nav-bug fix + seam-hygiene batch (S/M)
- Fix task #9: lift chat-stream ownership above the route (app-level
  store/provider) so SPA navigation never aborts a turn; ChatPage
  re-fetches messages on mount so persisted partials (interrupted marker)
  always render. E2E scenario: send → navigate away → return → full reply.
- Hygiene batch (all named by S1 reviews, see carries): memory service
  gets the {"error"} exception shape; INSTANCE_SECRET dropped from
  compose/.env (or commented reserved); web nginx explicit
  `location = /health/live`; install.sh chmod 600 .env + openssl in
  preflight; explicit N-1→N migration test; peers.client() sends
  Accept-Encoding: identity (mirror of the R26 fix); proxy timeout shapes
  pinned by constant assertions; a test for a backend that compresses
  despite identity (stripped-header defense stated); caller header keys
  normalized in the gateway outbound merge.

### T2 — Tool registry + ring-0 loop in core (L)
- Code-defined tool registry (name, JSON schema, executor) — no DB, no
  grants yet (S3 brings the policy kernel; S2's blast radius is contained
  by the toolset itself). [Footnote 2026-09-03: "S3 brings the policy
  kernel" → none, by owner ruling: every agent holds every tool, and "no
  DB, no grants" is permanently true — the blast radius is what the tools
  can reach and her judgment. See no-approvals.md.]
- Toolset (exactly): `workspace_write_file`, `workspace_read_file`,
  `workspace_list_files` — all inside a new dedicated volume
  (v4_workspace) mounted at /data/workspace, path-guarded like memory's
  store (realpath containment, no symlink escape); `memory_search`,
  `memory_save` (thin calls to the memory service with the owner scope);
  `get_time`; `fetch_url` (GET-only, SSRF-guarded: refuse non-global
  addresses, size cap, timeout, text-only extraction).
- Loop in the chat path: advertise tools via the gateway (OpenAI
  tool-calling, body passes through already); max rounds from settings
  (default 6); tool results appended per OpenAI convention; malformed
  args EXECUTE NOTHING and return a retryable Error: result; every
  executor failure is a stated Error: result, never an exception into the
  stream (the S1 SSE guard already backstops).
- Spans: every tool call = a turn_span (kind='tool', name, redacted args,
  result head ≤500 chars, duration, ok/error) written in the same atomic
  close; llm_call spans gain round numbers.
- Prompt: stable half gains the tool-use block; volatile unchanged; a
  turn with zero tool support in the serving model states it plainly
  (fail loud, never silently chat-only).
- The five S1 SSE frames stay; add `data: {"activity": {...}}` frames so
  the chat UI can show "using workspace_write_file…" live (shape:
  {tool, status: start|ok|error}).

### T3 — Activity page (M)
- Backend: GET /api/v1/activity?limit= (turns newest-first with span
  summaries), GET /api/v1/activity/{turn_id} (full spans). Session/bearer
  auth like everything else.
- Web: Activity nav item (v0.5.0-alpha AuditLog.tsx layout prior art);
  per-turn rows (kind, model, status, duration, tool-call count); drill-in
  panel showing the span tree with args/result heads and durations; the
  chat's live activity frames render as subtle in-bubble status lines.
- Empty states via the EmptyState primitive (no fake numbers, ever).

### T4 — E2E + DoD walks (M)
- New e2e scenarios: the groceries flow end-to-end (chat → file → Activity
  verification via API cross-check); the follow-up mutation; the nav-bug
  scenario; an honest-failure case (executor error → stated Error result
  → reply acknowledges failure, Activity shows the error span).
- The two-model measurement (DoD item 5): run the groceries scenario on
  qwen3:8b and qwen3.8:27b (tight fit), record rounds/latency/success to
  a small JSON the report cites. No conclusions baked in — data for the
  model slice.
- Full DoD walk performed and evidenced; stack left running and healthy.

## Out of scope (named so nobody drifts)
Policy kernel/consents (S3) [footnote 2026-09-03: built in S3, removed by
owner ruling — see no-approvals.md; it does not come back], any daemon
capability, model/wizard surface
changes (the model-and-engine slice carries those: SGLang onboarding, fit
warnings, change-model UI, re-run onboarding, curated diversification),
guard family beyond stated-error honesty (S3+), memory learning (S13).

## Rails in force (from the roadmap, same as S1)
Fail-closed schema defaults; no success unreported-unchecked; spans are
the ground truth; 127.0.0.1 binds; refuse-all tokens; path containment on
every filesystem tool; one migration philosophy (new migrations numbered
after S1's); pinned tests updated deliberately with stated reasons.

## Process
SDD per task (fresh implementer + task review + fix rounds + scoped
re-reviews), final whole-branch review for the slice, commits on
rebuild/v4, never pushed. DoD walked live before the slice is called done;
the operator gets the same hand-off report as S1.
