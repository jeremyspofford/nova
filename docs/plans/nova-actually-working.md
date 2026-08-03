# Nova actually working

Started 2026-08-03, from one conversation. Jeremy: *"We need to get to a
point where Nova is actually working. It can't just quit on tasks without
notifying us of issues. It must be able to search the internet. It must be
able to code and come up with improvements. it's supposed to be autonomous
and smart."*

Phases 1 and 2 are shipped (`8340318`, `c20dcd1`). This is the rest.

---

## The evidence this plan is built on

The whole brief is one arc, 2026-08-03 14:09–14:16:

```
14:09:31  USER   "The Chinese came out with a new human memory storage
                  database system for AI… Can you find that"
14:09:51  TOOL   web_search -> all providers failed
14:09:57  NOVA   "Web search is currently unavailable… I can't pull up that
                  article for you."
14:10:42  NOVA   "I can't directly fix DNS/networking issues"     ← no tool
14:11:14  NOVA   "Let me dig deeper into what's actually running:" ← turn ENDS
14:12:11  USER   "Did you stop?"
14:12:20  NOVA   "You're right — I stopped mid-investigation. Let me keep
                  digging:"                                        ← ENDS again
14:13:12  USER   "I don't believe you'll keep digging."
14:15:15  USER   "Actually, you already ingested my original request…
                  It's tencent db."
14:16:31  NOVA   reports calling read_memory_item — trace 94b21447 shows
                  tool_calls_requested = 0. The call never happened.
```

She had ingested that exact video **18 hours earlier**
(`media_ingests` row `youtube:5AkurBDSYwo`, status ok) and written two notes.
Web search being down was never the real blocker: she already owned the
answer and could not see it.

**Measured facts that shape every decision below.** Do not re-litigate these
without re-measuring:

| Fact | Value |
|---|---|
| searxng downtime before anyone noticed | 43 hours (exit 127, stale single-file bind mount) |
| memory items that are third-party | 221 of 247 |
| …therefore excluded from automatic recall when the agent holds an actor tool | all 221 |
| `main`'s model | `ollama:ornith:9b` — the only local model of 12 agents; `fallback_model` NULL |
| narrate-and-stop, replayed on the real prompt + real 24 tools | ornith:9b **6/8**, glm-5.2 **0/5** |
| rounds left when a turn ended on a promise | 9 of 10 |
| narration slips that morning caught by the detector | 1 of 10 |
| assistant rows carrying `tool_calls` | 0 of 549 |
| tool rows carrying `tool_call_id` | 0 of 1651 |

---

## Done

- **A turn does not end on a promise.** The detector fires *inside* the round
  loop; one correction is injected and the loop runs again, capped at one
  retry. Verified live: `"I'll reach for it directly:"` with no call became a
  real `diagnose` run and a real answer.
- **The detector judges the round that ended the turn**, not the turn total
  (a round-1 call used to blind it), and gained a structural arm needing no
  vocabulary: zero calls + a reply whose last line ends in `:` or `—`.
- **A failed turn leaves a record** — the reason is appended to the
  transcript and persisted, so it survives a reload.
- **All three tool-result paths go through `_cap_result`.** Two still sliced
  raw at 8000 chars, in defiance of that function's own docstring.
- **A core service being down is an alert**, routed through the existing
  `notify` path. Raise and clear both verified.
- **searxng can recover on its own** — directory mount instead of a single
  file, plus the healthcheck every comparable service already had.
- **She can see what she already ran** — one derived line per past turn,
  read from the rows the runner wrote at execution time.
- **A dead search falls back to memory inside the tool**, rather than hoping
  the model calls `search_memory`.

---

## Next, in order

### 1. `service_status` — she has no instrument (S, mechanical)

**Why first.** The retry fix made her call a tool, and she then reported
*"SearXNG is not healthy — completely unreachable"* while it was healthy.
`diagnose` covers Context, Agents, Inference, Backups, Attachments, Models,
Appearance and **no service health at all**. Fixing the silence without
giving her an instrument just moves the failure from "says nothing" to "says
something wrong", which is worse.

- Read-only tool: compose service state (running/exited, exit code,
  `State.Error`, healthcheck) for the `nova-*` project.
- `diagnose` gains a Services area surfacing exited containers with
  `State.Error` **verbatim** — "mount failed" is the sentence that would
  have ended the 43-hour outage in one turn.
- Grant to `main`. Read-only, so no consent gate.
- Risk: the backend must not hold the docker socket. `inference-control` is
  the only socket holder by design — go through it, fixed-verb, or read
  `/proc`-level signals. **Do not mount the socket into the backend.**

### 2. The goal gate creates its own card (S, mechanical)

Today a refusal returns a string telling the model to call `propose_goal` —
a prompt, not a control — and she demonstrably does not. `registry.py:546`
already knows the verb, the agent, the conversation and the refused call's
args.

- On refusal, write the pending capability-request row itself.
- Change the refusal text to *"a goal card is waiting for the operator"*.
- Leaves **an operator-visible artifact** where today a refusal leaves none.

### 3. Degraded grants are visible (S, mechanical)

`maintainer`'s entire read surface is an MCP sidecar. When it is stopped,
seven granted tools vanish with **no signal anywhere** — main dispatches to
her, she has nothing, and the failure looks like incompetence.

- Compute per-agent DEGRADED grants where the index is built
  (`runner.py:718-740`): every entry in `allowed_tools` resolving to no
  callable def.
- Print them in the tool index line and in `diagnose`.

### 4. Nothing ever asks her to improve (M)

Every automation runs as `ingestion`. None touches `maintainer`,
`propose_patch` or `delegate_coding_task`. She never proposes an improvement
unless Jeremy is in the chat asking, and even then it is one-shot.

- A `self-review` agent (cloud model; grants = `nova-src` read tools +
  `propose_patch` + a failure-scan read).
- One weekly automation: read the last 7 days of failed turns, ingest
  failures and alerts, and propose improvements.
- Feeds #5.

### 5. The improvement loop dead-ends at a card (M)

`recommendations.decide()` flips a status column and writes receipts. There
is **no code path** that turns an accepted patch into an applied one.

- On `decide(rec_id, 'accept')` for `kind='patch'`, call `coder.start()`
  with the stored diff and record the branch on the card.
- Operator merge stays the gate.

### 6. A refused ACTOR call should route, not dead-end (M)

`delegate_coding_task` is an ACTOR tool; `web_search` taints the turn. So
"look it up, then fix it" is structurally impossible in one turn, and the
refusal dead-ends instead of naming the way forward — unlike the goal gate,
which names the exact call and is therefore used.

- Turn-scoped deferred-action queue: a refused ACTOR call under taint
  becomes a queued action the operator can approve, rather than a `no`.

### 7. Terminal-event guarantee inside `run_agent` (M)

Phase 1 fixed this at the consumer (`router_chat`), which covers chat. A
**dispatched sub-agent** that crashes still returns `"[X returned nothing]"`.

- Wrap `run_agent` so exactly one `final` leaves it on every non-cancelled
  path. Cancellation stays the consumer's job — a cancel cannot yield.

### 8. Search resilience (S)

- Retry each provider once with jittered backoff.
- Treat *200 with a non-trivial body but zero parseable results* as a
  provider anomaly, distinct from "no results" — that is what DDG returned
  on the one query that mattered.

---

## Open decisions — Jeremy's, not mine

1. **`main`'s model.** ornith:9b narrate-and-stops 6/8 where glm-5.2 does
   0/5, and it is operating near a hard ceiling (a 10,303-token prompt
   against an 8,192 window — refused rather than silently truncated, which
   is the right refusal but a real limit). Moving it to a cloud model fixes
   the most symptoms fastest and cuts against local-models-first. The
   mechanical fixes make *any* model behave better; the ceiling is a
   separate problem they do not touch. **Recommendation:** re-measure the
   6/8 now that phases 1–2 have landed, then decide with a number.
   Independently: `main.fallback_model` is NULL while the fallback machinery
   exists and is unused — that is worth setting regardless.

2. **The recall fence.** An agent holding actor tools gets recall narrowed
   to first-party, which hides 221 of 247 notes. They stay reachable via
   `search_memory`, which taints the turn — a coherent design whose last
   step depends on the model choosing to call a tool. Options: (a) leave it
   and rely on the web_search fallback plus the retry loop; (b) state
   mechanically what is hidden ("N notes matched and are not shown; call
   search_memory"); (c) pre-emptively taint and include when the safe recall
   is empty. **Recommendation:** (b) — it is derived, changes no security
   property, and makes the hidden set visible.

3. **Model fitness should MEASURE, not read a flag.** `model_fitness`
   passes any model whose `/api/show` declares `tools`, which ornith:9b
   does. A stored eval that sends a two-turn transcript ending in a
   resumption prompt and asserts a tool call would have caught this. `evals/`
   already wires `narration_slip_allowed` to `narration.detect` — this is a
   suite, not new machinery.

---

## Traps worth remembering

- **The BM25 index is in-process.** Any check run in a fresh
  `docker compose exec backend python` sees an EMPTY index and will answer
  confidently about nothing. This produced a wrong "0 results" while
  measuring memory visibility, and it is why the web_search memory fallback
  is code-verified but not hit-verified. Test recall through the live
  backend or not at all. It caught me three times in one day.
- **`is_leader()` is in-process too** — `maybe_evaluate_alerts()` returns
  early in an exec process. Verify alerting by waiting for the backend's own
  tick and reading the shared DB.
- **A single-FILE bind mount resolves to an inode at container-create time.**
  When the host mount is recycled the container dies permanently and
  `restart: unless-stopped` retries forever without ever repairing it. Mount
  the directory.
- **Sub-agent tool ids never reach Postgres**, so conversation history can
  never be replayed as real tool-call pairs. Derived summaries are the only
  honest option.
