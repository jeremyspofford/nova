# Nova v4 — the master roadmap

The ordered backlog for v4, and the index to the 47 slice documents beside it.

**Created 2026-09-17.** Four slice documents have cited "the master roadmap" as
an authority since at least 2026-09-02 — `slice-02e-carries.md:87` ("Specified
as S10a in the master roadmap"), `slice-17-skills.md:19` ("The master roadmap
asks for markdown procedures with provenance…"), and `slice-27-feature-flags.md`
for the landing-step tripwire. **No such file has ever existed in this
repository** (`git log --all --diff-filter=A -- '*ROADMAP*'` returns only v3's).
This restores it. Where a slice cited it for something specific, that content is
carried below so the citation resolves.

Root `ROADMAP.md` was v3's, 2,436 lines, last touched 2026-08-08. It is
archived at `docs/archive/ROADMAP-v3.md` — untouched, and still the best mining
source for anything v4 has not rebuilt.

---

## Where things stand

v4 merged to `main` on 2026-09-17 (`0996a31`). Shipped slices: S01–S05b, S09,
S10/S10a/S10pre, S11–S19, S22, S24, S25, S28. Parked: S23. Unbuilt: S26, S27.

---

## The order of work

From `decisions-2026-09-15.md` ("Order of work"), revised 2026-09-15 and
amended 2026-09-16. S28 (attachments) was inserted and completed after S25.

| | Slice | State |
|---|---|---|
| 1 | The web manifest | done |
| 2 | **S24** threads | done |
| 3 | **S25** the Inbox | done |
| — | **S28** attachments | done (inserted) |
| 4 | **S26 — the quality corpus** | **NEXT. Nothing built, nothing spec'd.** |
| 5 | **S27** feature flags | **deliberately last** (owner, 2026-09-16: "Add it late") |

### 0. Before S26 — the suite hang

**Not a slice, and ahead of all of them.** The full core suite wedges at ~12%,
in the chat tests. It first appeared while S25 was being gated, so it belongs to
nobody's slice, and it means **no slice can show a full-suite green.** S28
merged on targeted suites and live walks instead.

S26 leans on the chat tests harder than anything else in the repo. Building a
measurement instrument on a runner that silently wedges is the wrong order.

Hypotheses, probes and file:line evidence:
`docs/incidents/2026-09-16-core-suite-wedge.md`. The strongest is that
`conftest.py:119`'s `asyncio.wait_for(chat.drain_background(), timeout=15)` can
raise inside a `finally`, skipping `db.close_pool()` on the next line and
leaving the module-global pool bound to a dead event loop. The cheapest first
move is `pytest-timeout`, which converts "the suite wedges" into "this test
wedges".

### 4. S26 — the quality corpus

**The instrument. Largest, mostly design. No spec document exists yet.**

Today's corpus is 23 cases (`services/core/app/evals/cases/`, pinned at
`services/core/tests/test_eval_corpus.py:376`, `suite_version` 13). Every one is an HONESTY or
CONTRACT pin: did she call the tool, did she avoid claiming something she did
not do, did the guard stay silent. It does that well and it is why she is
honest.

It says almost nothing about whether she is any **good** — whether she reasons,
writes well, holds a long context, or picks the right approach.

**Why that matters, in one number.** The 27B scores 21/23 and the 8B 19/23,
which reads as "nearly the same" and is almost certainly false about capability:
the two-case gap is honesty pins, not intelligence. Without a capability half,
the corpus cannot answer the question it is actually asked — *which model should
Nova run.*

Scope decided 2026-09-15 (`decisions-2026-09-15.md`, item 8): ground truth on
cases, a fixture world, argument- and sequence-aware predicates, multi-turn
replay, and a judge with a non-boolean score. **The judge is a toggle, local or
cloud** — local keeps everything on the box and runs on the same contended card;
cloud is consistent and touches no GPU but sends test prompts and model outputs
off-box. Synthetic rather than his data, but it is his privacy-first principle,
so it is a setting rather than a choice made for him.

**Plus a derived recommended-model hint.** Nova may state which model measured
best, per role. She may not switch to it — owner ruling 2026-09-03. v3's prior
art is `model_fitness` ("fitness measures, never declares").

Known hard part, stated so it is not re-discovered: mechanical predicates
(`tool_called`, `reply_matches`) cannot grade reasoning or prose. Grading those
means a judge model — position bias, its own taste, a second thing to trust — or
hand-written rubrics that go stale. A deliberate design decision, not a corpus
to start typing.

Carried items that fold in here:
- **S16's claimed-deletion case** needs a workspace-file fixture. Confirmed
  still blocked: `Case` declares `setup`, `agents` and `skills` and **no
  `files`** (`services/core/app/evals/cases.py:261-277`).
- **`no-fabricated-agent-work` is unstable on both models** (2/3).
- **The 27B has no matched three-run set** under the warm-up code.

Stated plainly, and it did not change the decision: **a corpus is an instrument,
not a feature.** It makes improvement measurable; it does not cause it.

### 5. S27 — feature flags

Spec: `slice-27-feature-flags.md`. **Nothing built** — confirmed 2026-09-17: no
`feature_flag` / `release_channel` / `kill_switch` identifier anywhere in
`services/` or `apps/`, and `SURFACE_PRESET` is still hardcoded to `'advanced'`
at `apps/web/src/components/layout/Sidebar.tsx:120` and `MobileNav.tsx:25`,
exactly as the spec describes.

Features declared in core with alpha / beta / released stages; a release channel
per instance (Released by default); an engineers' Feature flags page where
released features stay switchable as kill switches; a fix's deploy clearing its
kill; a generated changelog.

**It opens with a discussion, not code** — whether flag-first development can be
guaranteed without fail, for Nova and for Claude sessions
(`decisions-2026-09-15.md`, item 10). The answer may add a tripwire test to this
slice's scope. Two facts that discussion starts from: a written rule is not a
control, and **a test only refuses where it runs** — CI is disabled and git
hooks are off (owner, 2026-09-07), so today a tripwire fires only when someone
runs the suites by hand.

---

## Open items, audited 2026-09-17

Each verdict read from code on `main` at `0996a31`, not from the doc that
claimed it.

| Item | Verdict | Evidence |
|---|---|---|
| S23 serving runtime parked, nothing built | **STILL VALID** | no `LLAMA_ARG_*` in any compose file, service or script outside `docs/`. |
| S27 feature flags, nothing built | **STILL VALID** | see above. |
| The prefill / `tok_per_s` fix | **SHIPPED** | `prefill_ms`, `ttft_ms`, `thinking_ms` are three separate fields at `services/core/app/chat.py:2859-2863`; prefill ends at the first token of any kind. |
| Reasoning stream is read | **SHIPPED** | `_REASONING_FIELDS = ("reasoning", "reasoning_content")`, `chat.py:1418`. |
| Thinking cannot be disabled on `/v1` | **STILL VALID** | the gateway exposes only `POST /v1/chat/completions` (`services/gateway/app/data_plane.py:35`); no `/api/chat` path exists. |
| GPU contention: she can say it, nothing stops it | **STILL VALID, by design** | `services/core/app/checks/inference.py` states; routing around a contended card is S10's mode switch and a decision on his behalf (ruling 2026-09-03). Third occurrence 2026-09-15. |
| S16 eval case needs a file fixture | **STILL VALID** | `cases.py:261-277` — no `files` field. |
| `no-fabricated-agent-work` unstable | **STILL VALID** | case present; no stability work since. |
| Full core suite hang | **STILL VALID** | see item 0 and the incident doc. |

### Deferred, needing the owner's own session

Both S22 walk steps, deferred 2026-09-14. Neither needs code. Paste-ready kit
with queries and pass/fail: **`slice-22-walk-kit.md`**.

One finding from writing it, which changes the walk: `inference_health` is in
`live_facts.AUTO_RUN` (`live_facts.py:93`), so the BACKEND may run it when a
recalled note names a live source. The span it files is deliberately identical
to one she made, except for `meta.unasked` (`live_facts.py:236`, the only place
it is set). **The pass condition is therefore an `inference_health` span
WITHOUT `unasked`** — "the span exists", as the 2026-09-14 note put it, is no
longer sufficient.

### Standing, from earlier slices

- **Watching stops when the machine sleeps** (S11). WSL-on-Windows host; nine of
  twelve hours had no pass on the first night. The digest says so rather than
  implying cover. Where Nova runs is a bigger question than that slice.
- **`review_commitments` is the only check that spends money** (S11). On a cloud
  chain, a metered line item every six hours. v3's watchdog burned 6.3M tokens
  in one night while its ledger read $0.
- **Model flicker on review findings** (S11) — a pass that overlooks a
  commitment clears the notice; a later pass re-raises it as news.
- **The digest brief is unbounded** in standing notices (S11).
- **Three poisoned journal lines** left in place at the owner's call
  (2026-09-16): `/forget` deletes whole files, and removing them would cost a
  day of real conversation to delete three sentences.
- **Audio**, if ollama gains it (S28). The derivation is written; only the
  "nothing here can listen" branch has to go.
- **Her attaching a file back to him** (S28 question 5), deferred.

### Parked

**S23, the serving runtime** (`slice-23-serving-runtime.md`). Every number in it
was measured on this host, so it does not rot. First move on any pickup is one
cheap experiment, not a migration: does `LLAMA_ARG_CACHE_RAM` reach ollama's
llama-server child the way `LLAMA_ARG_KV_OFFLOAD` was proven to?

---

## The arcs — what Nova is becoming

**→ [`ARCS.md`](ARCS.md)**

Ten arcs, what each has already decided, where v4 is along it, and the next
move. Plus a browser of her own, and Jev.

This file answers *what is next*. That one answers *what is Nova becoming*.

*What was here before, and why it is gone:* a "Mined from v1–v3 — proposals"
section that diffed old shipped code against v4's and called every difference
a gap. It reported unbuilt plans as defects, and it retired three capabilities
the owner intends to have — the autonomous goal loop, IDE integration and the
friction log — which was never a call for this document to make. `ARCS.md`
replaces it, built from the intent corpus instead.


## Housekeeping this pass turned up

- **`README.md` on `main` describes v3**, not v4 — "Brain Home Screen +
  Multi-Agent Chat", `frontend/`, "Settings → Models → Providers". Last touched
  2026-08-07. `CLAUDE.md` tells every session to read it "for what works".
  **Rewriting it is real work and was deliberately left out of this pass.**
- **`main` carries both codebases.** v4 added `apps/`, `services/`, `deploy/`,
  `install`, `tests/`, `.github/` on top of v2.0.0-alpha's tree and removed
  nothing. `backend/`, `frontend/`, `coder/`, `git-landing/`, `media/`,
  `workloads/`, `inference-control/`, `mcp-runner/` are v3's. Good as a mining
  source, confusing as a working tree. A deliberate decision, not a cleanup to
  do by reflex.
- **CI does not cover `main`.** `.github/workflows/rebuild-ci.yml` triggers only
  on `rebuild/**`. A PR into `main` runs no checks at all.

---

## Index — `docs/plans/rebuild/`

**Rulings and cross-cutting:** `ARCS.md` (the product map — the ten arcs and
where v4 is along each), `no-approvals.md` (the 2026-09-03 owner ruling —
read before designing anything that gates), `decisions-2026-09-15.md` (eight
scopes and the order of work), `feature-flags.md` (a withdrawn parallel design,
kept for the record).

**Slices, in order.** `-carries.md` files hold what a slice did not finish.

| | Slice | Docs |
|---|---|---|
| S01 | spine | `slice-01-spine.md`, `-carries` |
| S02 | tool loop | `slice-02-toolloop.md`, `-carries` |
| S02b–f | files, durable turn, honesty guard, model surface, fit | `slice-02b-files.md`, `02c-durable-turn`, `02d-honesty-guard`, `02e-model-surface` + `-carries`, `02f-fit-correctness` |
| S03 | policy | `slice-03-policy.md`, `-carries` |
| S04 | evals | `slice-04-evals.md`, `-carries` |
| S05 | daemon | `slice-05-daemon.md`, `-carries` |
| S05b | tailnet | `slice-05b-tailnet.md`, `-carries` |
| S09 | scheduling | `slice-09-scheduling.md`, `-carries` |
| S10 | spend + routing | `slice-10-spend-routing.md` |
| S10a | live catalog + provenance | `slice-10a-catalog.md` |
| S10pre | providers | `slice-10pre-providers.md`, `-carries` |
| S11 | proactive | `slice-11-proactive.md`, `-carries` |
| S12 | agents | `slice-12-agents.md`, `-carries` |
| S13 | memory | `slice-13-memory.md` |
| S14 | distillation | `slice-14-distillation.md`, `-carries` |
| S15 | chat control | `slice-15-chat-control.md` |
| S16 | workspace delete | `slice-16-workspace-delete.md` |
| S17 | skills | `slice-17-skills.md` |
| S18 | scripted skills | `slice-18-scripted-skills.md` |
| S19 | stale failure | `slice-19-stale-failure.md` |
| S22 | live resources | `slice-22-live-resources.md`, `-carries`, **`-walk-kit`** |
| S23 | serving runtime | `slice-23-serving-runtime.md` — **parked** |
| S24 | threads | `slice-24-threads.md` |
| S25 | inbox | `slice-25-inbox.md` |
| S26 | quality corpus | **no document yet** |
| S27 | feature flags | `slice-27-feature-flags.md` — **last** |
| S28 | attachments | `slice-28-attachments.md` |

**What S10a was cited for** (`slice-02e-carries.md:87`): live catalog +
provenance. The owner's hand-pulled `muse-glimmer:latest` showed no metadata —
the curated file was the only source — and `:latest` drift is untracked. Ollama
`/api/tags` + `/api/show` already hold size, quant, context, license and digest
locally; the registry v2 manifest resolves tag→digest without pulling; the HF
Hub API covers direct-from-HuggingFace pulls. Spec:
`slice-10a-catalog.md`.

**What S17 was cited for** (`slice-17-skills.md:19`): markdown procedures with
provenance, an outcome ledger, a draft/active/flagged/retired lifecycle, steps
distilled from the trace, and a with-and-without replay that proves a skill
earned its place.

**Elsewhere:** `docs/history/releases.md` (the tagged releases),
`docs/incidents/` (root causes, including the suite wedge),
`docs/archive/ROADMAP-v3.md` and `docs/archive/NEXT-v3.md` (v3's backlog —
still the mining source), `docs/plans/*.md` (49 v3 plan documents; rows marked
"v3 only" in `docs/plans/README.md` hold approval designs the 2026-09-03 ruling
removed — **never mine those as prior art**).
