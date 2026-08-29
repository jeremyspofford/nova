# Slice 2 — Carries to later slices

Written at S2 close-out (2026-08-29). Review-triaged items that ride
forward, each named to its owning slice. Discharges ruling S2-R8: the
rulings/carries the slice ruled must survive workspace deletion.

## The headline finding — MANDATE for Slice 3

**The small model narrates actions it never performed.** In the S2 e2e
walks, qwen3:1.7b claimed "groceries.md updated successfully" with ZERO
tool calls and an unchanged file, and invented an invoice (amount, date,
customer) for a path that does not exist. Only the mechanical e2e checks
(file bytes on disk + tool spans in the ledger) caught it. Nothing in the
running system currently refuses a reply that claims a file operation no
span records — the system prompt asks for honesty, and a prompt is a
request, not a control ([[mechanical-over-prompts]]).

**S3's guard family (capability-claim / narration verifier) is MANDATED,
not optional.** Acceptance evidence already exists: the three concrete
fabrications quoted in tests/e2e/README.md are its test corpus. The cheap
signal is already shipped — every Activity row carries tool_call_count, so
a zero-call turn that claims an action is visible to the operator today;
the in-loop refusal is S3's to build (reading prose against spans is
exactly the capability-claim-verifier shape, not a rushed regex).

## Security carries

- **DNS rebinding (S3 / security pass)**: fetch_url's SSRF guard
  resolves-then-checks, but httpx re-resolves to connect — a rebinding
  window remains. Stated in services/core/app/tools/web.py's docstring.
  Close with a transport pinned to the validated address.
- **fetch_url allows any port on a global address** (e.g. :22) — S3's
  policy kernel should decide port policy.
- **Prompt-injection surface**: fetch_url content and file contents flow
  into the transcript. The STRUCTURAL non-reparse property holds (tool
  results are never re-parsed as tool calls — verified across T2's fix
  rounds); semantic policy is S3's.

## Model-slice carries (S2/S4 model work)

- **The 27B loads and performs well at 24 GB**: measured 16594 MB VRAM /
  32K ctx / 3 rounds / 28.6s on the groceries task — FASTER than qwen3:8b
  (9508 MB / 2 rounds / 45.5s). Data in
  tests/e2e/measurements/s2-two-model.json (data-only, no conclusions).
  This supersedes S1's tentative "27B is a tight fit" worry: it is tight
  on headroom but performant.
- **ANOMALY to resolve before trusting the JSON**: the 27B's nvidia_smi
  delta (23670−13671 ≈ 10.0 GB) sits beside vram_mb:16594 +
  size_vram_equals_size:true with no explanation (likely the 8B still
  resident at first sample + compute buffers outside size_vram). Annotate
  or re-measure before the model slice consumes it.
- **Curated pool still single-family qwen and a generation behind**
  (carried from S1) — diversify + probe-inform in the model slice.
- **Scenario-vs-model gating (e2e)**: qwen3:1.7b is not a reliable gate
  for the tool scenarios (it narrates); the suite should gate scenarios
  on model capability, or the model slice should pin a floor model.

## Owner QA findings (2026-08-29, live walk of the rebuilt S2 stack)

- **VERIFIED WORKING**: the tool loop end to end — Nova wrote
  /data/workspace/groceries.md (real 57-byte file, correct content) and
  the turn's tool spans appear in Activity. The nav-survival bug is
  confirmed fixed.
- **GAP (high value, near-term)**: the workspace is INVISIBLE in the app —
  no way to view the files Nova creates or their locations. She can be
  seen to have written a file (the span) but the file itself can't be
  opened or browsed. Needs a Files/Workspace viewer (v1 had a Files
  explorer; the roadmap's Library concept can hold it). This defeats half
  the value of the tool loop — schedule it near-term (proposed as its own
  small slice before/alongside S3, or S3's UI task).
- **TESTING POLICY CHANGED**: no more isolated `nova-e2e` stacks; test
  against the real stack, rebuild/reset freely (see memory
  nova-v4-testing-policy). S2-R9's isolation apparatus is retired for S3+.

## UI / Activity carries

- **Live activity line never commits to the DOM for fast filesystem
  tools** (React batches start+ok ~1ms apart) — frames verified on the
  wire, DOM polish deferred. A slow-tool (fetch_url) run would convert the
  batching explanation from inference to fact.
- **Activity drill-in caches a live-errored fetch with no retry
  affordance** (Activity polish, later).
- **Role-hierarchy mismatch (S8)**: minRole:'admin' nav items clear only
  for the owner role today; the Activity API has no route-level role
  guard (matches Settings' pre-existing pattern) — S8's household roles
  work must give the Activity ledger proper per-person scoping (an adult
  should not read another person's turns).

## Test-suite carries (minor, e2e)

- Three S2-T4 items are untested-until-the-next-live-walk (verified
  offline only): the new /teal/i scenario-3 needle, the dragon-fruit
  scenario-9 item, and the in-container branch of the project
  discriminator. The next walk that runs the suite live discharges them.
- dc logs -f is over-refused by the project-flag guard (fails safe;
  carve-out only if needed). nginx `location = /health/live` is
  inspection-only until a walk curls it.

## S2 rulings appendix (provenance; full text was in the SDD ledger)

- S2-R1: tool span shape (kind='tool', meta{args_redacted, result_head≤500,
  ok, error?}, duration in column; llm_call meta gains round).
- S2-R2: tool registry is code-defined in S2; S3's policy kernel wraps it.
- S2-R3/R6: SSE parser ignores well-formed unknown-key frames
  (forward-compat for {"activity"}); malformed still errors. Amended S1's
  R20 deliberately.
- S2-R4: T1 left the server chat path unchanged; T2 owns the loop edits.
- S2-R5: two-model measurement is data-only, no conclusions/tier changes.
- S2-R7: memory gained POST /save (verified-before-return, collision
  suffix, containment, reindex).
- S2-R8: committed code justifies itself inline; ruling IDs are
  breadcrumbs; this file is the slice-close appendix R8 promised.
- S2-R9: e2e runs as an isolated `nova-e2e` project (no host ports,
  disjoint volumes, in-network playwright); the owner's stack gets only
  read-only /health/live + ollama /api/ps probes, proven untouched at the
  end.
