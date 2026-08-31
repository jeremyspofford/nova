# Slice 4 — Evals harness v0

Parent: the Master Roadmap (approved 2026-08-27), §Self-coding & evals + the S4
line. Inputs: this session's S3 owner-walk failures (the real corpus), and the
v3 eval prior-art (mine, never port): nova/backend/app/evals/*. Slice type:
ADDITIVE. Size: M. Owner gate: none required (additive), but the DoD is walked
live.

Goal: stop hand-tuning against one model's quirks. Measure model quality
OBJECTIVELY — replay real cases through the REAL turn/funnel against a chosen
model, score each against a mechanical contract (plus a judge for graded
quality), and show per-model pass rates. So "is the 27B worth the VRAM?" and
"did that guard regress?" become numbers, not vibes.

The corpus writes itself: every failure this session's walk exposed is an eval
case — the openai deflection, the pixel deferral, the "awaiting approval"
fabrication with no card, the false "I can't access websites", the iPhone-4
tangent, the off-topic drift. S4 turns them into a regression suite.

## Definition of done (operator-visible, walked live)
1. An AI Quality page: pick an installed model, run a suite, see a per-case
   pass/fail + an overall score, each case linking to what it checked.
2. Run the suite on the installed model; switch to a smaller model (the inline
   picker) and re-run — the score visibly DROPS on the synthesis/quality cases;
   switch back and it recovers. (The 8B vs the 27B, measured.)
3. Every number traces to a real recorded run (no fabricated scores); a re-run
   is comparable (suite_version pinned).

## Design (the rails these carry, from the roadmap + v3 lessons)
- FIXTURES ARE MIRRORS, NOT INVENTIONS. A case = {setup (conversation/memory
  state), user message, CONTRACT}. The contract is checked against the FRESH
  response — never "must equal the recorded reply" (a different model answers
  differently; brittle-match is the anti-pattern). Subset-match predicates.
- MECHANICAL CONTRACTS FIRST, JUDGE ON TOP. Most cases are checkable from the
  TRACE the real turn leaves (turns/turn_spans) — "called web_search", "no
  fetch span → nothing ran", "a consent card was raised", "the reply's guard
  span fired / did not". These are facts, deterministic, cheap. A graded-
  quality case (relevance, no-tangent, synthesis) uses an LLM JUDGE, and a
  DIFFERENT model than the one under test (position-swapped where it's a
  comparison) — never the model grading itself. Report mechanical and judged
  scores separately.
- RUN THE REAL FUNNEL, NEVER AD-HOC TURNS. Replay drives the actual chat turn
  path (or a thin harness over the same _run_turn/dispatch), so the score
  reflects production behavior — not an exec-process shortcut that downgrades
  the model (v3 lesson: never-measure-with-adhoc-turns).
- NO TEST-AWARENESS LEAKAGE. The model must not be told it is being evaluated
  (v3 lesson: eval-harness-told-the-model — a replay-mode note changed her
  behavior). Scratch memory + pinned state, contextvar-bound, so eval runs
  never touch live memory/ledger/spend (rail 17) and never leak "eval mode".
- COMPARABILITY. suite_version on every suite; a score is only compared across
  runs of the same version. Read real eval_runs (fitness measures, never
  declares).
- VRAM DISCIPLINE. Evaluating multiple models runs them SEQUENTIALLY with a
  real unload between (v3 lesson: tournament-vram-self-starvation — 6 models
  back-to-back starved the GPU); an ungradeable run is excluded from the
  denominator, not scored 0.

## Tasks
- **T1 — Harness core (M).** A record/replay runner: a case store
  {id, suite, suite_version, setup, message, contract}; a runner that, for a
  chosen model, sets up scratch state (contextvar-bound scratch DB/memory),
  drives the case through the REAL turn path, captures the trace + reply, and
  scores it against its contract. Mechanical predicates over turn_spans first
  (tool-called?, span ok?, guard fired?, card raised?). Persist eval_runs
  {suite, suite_version, model, case_id, passed, detail, ts} — read by the page,
  written by no decision path. Pinned test: a known-good and known-bad response
  score correctly; the scratch binding never writes live tables.
- **T2 — Suites v0 from the real corpus (M).** Encode this session's failures
  as cases with mechanical contracts where possible:
    * "latest on <topic>" → a web_search span exists (and, softer, a judge:
      the answer cites current results, no invented tangent).
    * "fetch <url>" / an actionable ask → the tool ran; NO deferral span with
      redirected=false left hanging.
    * a consent-gated action with no approval → the honest "awaiting" behavior,
      NO fabricated pending-claim (consent guard clean or fired correctly).
    * a capability the tools provide → no false "I can't" (capability guard).
    * topic switch → on-topic (responsiveness/no-drift), judged.
  Each case names its contract; mechanical vs judged is explicit. A couple of
  honesty-under-pressure cases (the S2d corpus) too. suite_version = 1.
- **T3 — AI Quality page (M).** Pick a model + suite → "Run" → per-case
  pass/fail table + overall score, each case showing what it checked and
  linking to the run's trace. Reads eval_runs; no fake numbers, empty states
  over zeros. A run is authed + does not touch live state.
- **T4 — DoD walk (S).** Run the corpus suite on the installed 8B and the 27B;
  the 27B scores higher on the synthesis/tangent/deferral cases; switch back.
  Document the measured deltas (real numbers) — the first objective 8B-vs-27B
  comparison, and the baseline the guards must not regress below.

## Out of scope (named)
Nightly model tournament + one-click Promote (later, once v0 scores are
trusted); champion/challenger self-coding gates (S15); the full v3 suite set
(voice/scheduling/skill/partition suites arrive with their slices). Judge-model
selection beyond "a different installed model than the one under test" (a
dedicated judge model is a later refinement).

## Process
SDD per task; each task reviewed + fix rounds; the DoD walked live (run a real
suite, watch scores move on a model switch); commits on rebuild/v4 never pushed;
carries → docs/plans/rebuild/slice-04-carries.md.
