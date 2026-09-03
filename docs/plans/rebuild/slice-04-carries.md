# Slice 4 — Evals harness v0: close-out + carries

Written at S4 close (2026-08-31). S4 shipped on rebuild/v4 (never pushed):
T1 harness core (7e2d82fb + eval_runs migration 010 e999a24c), T2 the
`agent_quality` corpus v1 (192b01e8), T3 the AI Quality page + evals API
(dca4559e, 23566751). Backend 679 / web 358 at T3.

## The DoD, MET + MEASURED (the first objective 8B-vs-27B comparison)
Ran the live `agent_quality` suite (v1, 7 cases from this session's real
owner-walk failures) through the REAL funnel against both installed models:

  * qwen3:8b   — 5/7 passed (71%), 0 ungradeable
  * qwen3.8:27b — 7/7 passed (100%), 0 ungradeable

The 8B's two failures were the hardest agentic cases: asked to summarize "to a
FILE" it web-searched instead of calling workspace_write_file; and for
bigblueview it web-searched instead of fetch_url'ing the named URL. The 27B did
both (e.g. "Wrote and confirmed kv-offloading.md (2.4 KB)"). This is the
measured answer to "is the 27B worth the VRAM": a 29-point gap on Nova's own
failure corpus, and the baseline the guards must not regress below.

Scratch isolation HELD LIVE (rail 17): 14 eval turns recorded kind='eval' under
a `__eval_scratch__` guest person, 0 leaked into the owner's chat/memory; the
owner's 57 chat turns were untouched. eval_runs persisted per (suite, version,
model) — the AI Quality page shows both scores without a re-run.

## Carries
- **Case strictness (corpus tuning):** `no-false-capability-denial-bigblueview`
  requires tool_called(fetch_url), but for "the latest from bigblueview.com" a
  web_search is arguably a valid answer too — so the 8B "failed" partly on the
  contract's strictness, not only capability. The case still discriminates (the
  27B passed it), but a v2 corpus should split "did it use SOME real source" from
  "did it hit the exact URL". Cheap fixture edit.
- **Judged predicates deferred:** T1/T2 shipped MECHANICAL predicates only. The
  graded-quality cases (relevance, no-tangent — the iPhone-4 case) are PROXIES
  today (keyword regex). A different-model LLM judge (position-swapped) is the
  clean next add, once v0 mechanical scores are trusted. Until then, the corpus
  measures structural behavior (search/defer/fabricate/deny), not synthesis.
- **Trace link is inline, not clickable (T3):** an eval turn's evidence is its
  copyable turn_id + reply excerpt + per-predicate outcomes (from
  eval_runs.detail); eval turns are filtered out of Activity and there is no
  per-turn route, so a dead link was avoided. `GET /api/v1/activity/{id}`
  already resolves eval turns — a single-eval-turn view is the clean add.
- **Cross-case memory within the scratch person — CLOSED 2026-09-03:** this
  carry stopped being theoretical: the owner's live v2 run had qwen3.8:27b
  fail `bare-intent-no-action` with zero tool calls yet produce a workspace
  listing with file sizes, narrated from memory — the reused scratch person's
  per-person memory had accumulated an earlier case's turn, and recall
  surfaced it as if it were current. Fixed in runner.py: `scratch_person`
  now creates a FRESH, single-use person every call (name is
  `__eval_scratch__` plus a uuid4 hex, never reused), and a new
  `_cleanup_scratch_person` tears it down after each case is scored —
  deletes the `people` row (cascades its conversation + message; turns/
  turn_spans/eval_runs survive, matching activity.py's existing NULL-
  conversation_id handling) and best-effort /forgets the one journal file a
  fresh single-use identity could have ingested into. The memory service has
  no bulk delete-person endpoint (only per-file /forget and /export), so an
  empty `people/<id>/` directory can still be left on disk after that one
  file is forgotten — a tiny, harmless remainder with no endpoint to close
  it. Pinned in test_eval_runner.py: two cases run in sequence never share a
  person_id, neither collides with the owner, and cleanup runs (row deleted,
  forget attempted) on both the ok and the ungradeable path.
- **Nightly tournament + one-click Promote, champion/challenger self-coding
  gates, the full v3 suite set (voice/scheduling/skill/partition)** — later, per
  the slice plan's out-of-scope.

## Process
SDD per task (T1 opus, T2 sonnet, T3 opus); each verified by the controller
(reads + tests + the live run); DoD walked live (the measurement above); commits
on rebuild/v4 never pushed.
