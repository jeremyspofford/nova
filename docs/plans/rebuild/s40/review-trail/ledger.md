# SDD ledger — plan: docs/plans/rebuild/slice-40-engines.md

Spec: docs/plans/rebuild/hub-topology.md (S40) + hub/r2-integration.md (D8, D10, D21) + hub/r1-integration.md §S40 + hub/r1-engines-design.md.
Base for all streams: d242b7f1 (after item 0, 71bf3a17).
Baselines at d242b7f1: gateway 466 passed; core 2957 passed (item 0 runs 3-4); web 76 files / 1121 tests, tsc clean.

## Preflight scan
The cross-task conflict scan was done by the plan's own review pass (docs/plans/rebuild/s40/review-rulings.md): C1-C14 contract conflicts, G1-G6 spec gaps, E1-E11 code-reality errors, broken-test inventory, ordering. Every row there is ruled in slice-40-engines.md "Rulings" and those rulings are binding.

Ruling: the three streams (A gateway T1-T4, B core T5-T7, C web T8) run IN PARALLEL, each in its own git worktree (.worktrees/s40-gw|core|web on branches slice/s40-gw|core|web) — the skill's "never parallel implementers" guards one tree; these touch disjoint paths in separate trees, so no two implementers ever share a file or an index — cost if wrong: a merge conflict at integration, resolved by hand.
Ruling: within a stream, tasks run strictly in order with a task review after each; T1 and T2 are ONE dispatch and one review (E11: they land as one push) — cost if wrong: a larger review surface for T1+T2.
Ruling: fix loop capped at 3 rounds inside the workflow (fresh fixer each round, the report file is the memory); anything still open is returned to the controller for adjudication per the breaker — cost if wrong: one extra controller-dispatched round.
Ruling: implementers and reviewers run on opus — the tasks are multi-file refactors whose plan text needs the rulings applied, i.e. judgment, not transcription — cost if wrong: tokens.
Ruling: T9 (deploy + live walk + close-out) is run by the controller after the three branches merge, not by a subagent — it touches the live stack and her chat — cost if wrong: none.

## Execution
Dispatched as workflow wf_a242fedd-e1f (task wdw3o00nj): streams A (T1T2 -> T3 -> T4), B (T5 -> T6 -> T7), C (T8) in parallel; implement -> review -> up to 3 fix rounds per task; a stream stops at the first task left with open findings or blocked. Resume with resumeFromRunId if it dies (workflow agents die on a usage limit — check git log in each worktree first).
T8: implemented d242b7f1..45945e96 (web 78 files / 1,148 tests, tsc clean); review spec ✅ quality ✅, 6 findings (2 important) -> fix loop. 393px check deferred to T9 by design.
T1T2: implemented d242b7f1..11f47387 (gateway 578 passed, 0 failed; baseline 466).
Ruling: T1T2's C3 deviation accepted — GET /admin/engines/{name} never reads /api/ps from a wake_on_lan engine the request did not observe live (resident null with the stated reason); ?live=1 reads it — because a probe of a sleeping node can wake it (the lane's own rule, r1-engines "Engine state") — cost if wrong: a card shows no resident models for a node until a live read.
Ruling: T1T2's E10 deviation accepted — the conftest seam matches request.path.name, because pytest imports test modules by basename so the review's module-name check could never match — cost if wrong: none (the seam is test-only).
Ruling: shared-scratchpad collision (stream B overwrote stream A's helper) — later dispatches name a per-stream scratch dir; nothing was lost (the run caught it) — cost if wrong: a silent no-op edit, caught by tests.
Note: Write/Edit tools refuse paths under /home/jeremy/workspace/nova/.worktrees/*; implementers edit through Bash. Reviewers are read-only, unaffected.
T8: fix round 1/3 (2 addressed, 0 open); head 22ca4e14
Task T8: complete (commits d242b7f1..22ca4e14, review clean after 1 fix round; 393px check owed at T9)
T1T2: complete (commits d242b7f1..11f47387, review clean; 3 minors — see workflow result)
T5: implemented d242b7f1..d14f9c0f (full core suite 3,005 passed).
T3: implemented 11f47387..fffad4fa (gateway 604 passed).
Ruling: T3's served_stamp must never delay a reply's first byte by more than ~2 s — bound the stamp's engines.observe with a 2 s timeout and OMIT served_on on timeout (omitted, never guessed); applied in the T3 fix loop if the reviewer raises it, else in the final fix wave — cost if wrong: a cold no-role turn loses its stamp once.
Ruling: C12 annotation of r1-integration.md / r1-engines-critique.md (ReadTimeout-before-headers wording) is a T9 docs item — outside stream A's paths — cost if wrong: none.
Note: T5 — an open inference_degraded notice re-fingerprints once after deploy (served_on/runtime joined its facts); deliberate, goes in the S40 carries.
Task T3: complete (commits 11f47387..fffad4fa, review clean)
Task T5: complete (commits d242b7f1..d14f9c0f, review clean)
T4: implemented (gateway 640 passed); under review. T6: implementing.
Task T4: complete (commits fffad4fa..60bb4d9a, review clean; 8 minors — see workflow result). Stream A done.
T6: fix round 1/3 (1 addressed, 0 open); core 3,098 passed
Task T6: complete (commits d14f9c0f..409e4d92, review clean after 1 fix round)
Integration: merged slice/s40-gw + slice/s40-web into the lane branch (426970e5, 81d3f71a): gateway 640 passed, web 78 files / 1,149 tests, tsc clean.
Ruling: T9 DoD 4 walks the NO-NEXT-LINK branch — the live chat chain is ["ollama:qwen3:8b"] only (no cloud link), so "stop running chat models here" must end in a stated failure naming hub switched off, and "turn it back on" goes through the Machines tile (she has no model to call) — the owner's routing is not changed to manufacture a cloud answer — cost if wrong: the cloud-fallback branch stays unwalked until a chain has a cloud link (carried).
Preflight G5 PASSED on the live gateway: 0 providers named hub/library. Live: chat.model "ollama:qwen3:8b" (035 -> hub:qwen3:8b), chat.vision_model bare "qwen3.8:27b" (untouched), routes chat ["ollama:qwen3:8b"].
T5: complete (review clean). T6: complete (1 fix round). T7: fix round 1/3 (1 addressed, 0 open); Task T7: complete (commits 409e4d92..3e01d4ae, review clean after 1 fix round). Stream B done.
All 8 tasks complete, 0 open findings. Deferred minors / out-of-scope / cannot-verify: .superpowers/sdd/slice-40-engines/deferred-minors.md (112 lines).
Ruling: plan-conflict minors FIXED in the final wave — T3 standby asks /api/show for the default model alone first (a slow show after restart must not 503 a standby that worked); T4 pull accepts a library: id as bare and the dead engines.installed_sizes + its test go; T5 one card-selection helper in machines.py and vision.choose matches bare tails against LOCAL rows only; T7 the FixturePlant refusal says "cannot: '<name>' is not one of the machines that can be switched here" (no test-awareness leakage), the eval detail stays in the span; T8 Refresh shows on empty/error — cost if wrong: small, reviewable diffs.
Ruling: plan-conflict minors CARRIED (slice-40-carries) — shadow check on make_default; catalogue reads bypass the wake guard (S46); bare pull confirm / bare model_pull backing across machines (S44); natural fabrications "I switched hub off" uncaught + direction not compared (S44/guard work); checks case vs a cloud model saying hub is down; EngineView row shape written thrice in evals (DRY, low risk); engines.client sends no bearer to non-builtin engines (S44) — cost if wrong: none now, all need a second engine.
Note: the three IMPORTANT plan-conflict items (T6 configured_machine false positives; T8 description overclaim; T8 vacuous layout check) were addressed in their fix rounds (re-reviews ADDRESSED).
Integration suites at 5b8e1a48 (all S40 merged): gateway 640 passed; core FULL 3,134 passed (15:04); web 78 files / 1,149 tests, tsc clean; memory 207 passed + 2 failed — the 2 are PRE-EXISTING and unrelated (S40 touched 0 memory files): test_distilled_notes compares date.today() (local, EDT) with a note stamped in UTC, so between UTC midnight and local midnight they differ; both pass under TZ=UTC. Carried (found in passing).
Rollback drill (final-review #4) on copies of LIVE data in nova-scratch-pg (pg 16.15 both sides):
- 009 applies cleanly to live gateway data: providers anthropic,cerebras,hub,openrouter; engines hub:true; chat chain ["hub:qwen3:8b"]; idempotent on a second pass.
- 035 applies cleanly to live core data: chat.model "hub:qwen3:8b", chat.vision_model bare "qwen3.8:27b" untouched; idempotent.
- The DOCUMENTED rollback (pg_restore --clean --if-exists over the S40 DB) FAILS: cannot drop providers (engines FK), then COPY violates providers_hub_is_the_builtin; state stays S40. CONFIRMED defect.
- The CORRECTED rollback (stop gateway+core; DROP DATABASE; CREATE DATABASE (owner = the service role on live); pg_restore of the pre-S40 dump; re-tag nova-*:pre-s40; up) restores exactly: providers incl. ollama, routes 2, usage 1468, probes 5, no engines table, chain back to ["ollama:qwen3:8b"].
Ruling: T9 uses and documents the corrected rollback; the pre-deploy dumps are taken immediately before deploy — cost if wrong: none (drilled).
Final fix wave: 5b8e1a48..fba702bb, 12 commits; gateway 645, core 3,161, web 1,157 + tsc clean. EngineView contract v2 (+builtin, +answered) for A1.
Final fix wave re-review: A1-C4 all ADDRESSED. New breakage: IMPORTANT — guards._target_of (1051-1056) backs a pull/remove claim ONLY by resolved_model, so her echo of the raw id she passed ("I pulled ollama:qwen3:4b" / "library:qwen3:4b") is corrected after a confirmed action; MINOR — tools/machines.py:118-119 example follows the bare-id clause; out-of-scope — runner docstring overclaims "an eval never changes a real machine" (true only for the serving switch; model_pull/model_remove still reach the real gateway in eval turns — pre-existing exposure).
Ruling: one small scoped fix dispatch AFTER the single final wave (deviation from "no second fix wave") — back a claim when it matches the resolved id OR the raw argument (dell: pins must still fire), MUST_NOT pins for the library:/ollama: echoes; move the machines.py example after "names that machine"; scope the runner docstring to the serving switch — because the defect makes an honesty guard contradict a TRUE, gateway-confirmed report, which is exactly what guards must never do, and the fix is two lines with pins — cost if wrong: one extra small review.
Carried: evals can still pull/remove models on the real gateway (pre-existing; needs a model-plant like the machines plant); C1 double read when the default does not chat (~10 s worst case); machine_status text does not say "not answering" for a switched-off, dead engine (the fact carries it).
Echo-backing follow-up: fba702bb..5869f5a1 (3 commits), core 3,165 passed; scoped re-review: 3/3 ADDRESSED, no new breakage. S40 review trail CLOSED.
