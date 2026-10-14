# S38c: the task ledger — work that survives a cleared context — the spec (APPROVED 2026-10-14)

**Status:** approved 2026-10-14. The owner, on §12: "do what you propose" —
every §12 question is ruled as proposed (rulings there). Steps 0–4 (§11) are
built first; the ledger (steps 5–13) comes before S34.

Read with [`../s38b/spec.md`](../s38b/spec.md) (summaries near the window,
`read_result`), [`../s32/spec.md`](../s32/spec.md) §5 and §5.5 (her landing
step, as built), [`../s37c/spec.md`](../s37c/spec.md) (events start turns),
S34 in [`../doing-things.md`](../doing-things.md) and
[`../nova-codes.md`](../nova-codes.md) (goals: `goal_note`, re-entry framed by
code). S38b handles one turn that reads a lot. S38c handles one task that
runs long: many rounds, many turns, or both.

---

## 1. What happened (2026-10-14)

The same task was asked of two models: "make get_time also say the ISO week
number, commit and land it".

**Turn `2ca39a7e` — a cloud model** (`openrouter` `gemini-3.8-flash`):

- **It never edited a file.** The turn stopped after 26 rounds on the
  1,000,000-token turn budget (`turns.token_budget`).
- **The budget is a sum over rounds.** Every round re-sends the whole
  context, and every round's prompt is counted again. The prompt grew from
  14k to 64k tokens. 26 rounds of that summed past 1M.
- **Most of what was counted cost almost nothing.** 86% of the counted
  prompt tokens were cache reads. The real cost was $0.216.
- **Six broad `device_search` calls took 54% of the budget.** Each returned
  up to the default 200 matches, and each result was re-sent, and re-counted,
  in every later round.
- **S38b never ran.** Its summarizer starts at 70% of the model's window.
  That model declares a 1M window, so the mark was 700k tokens per request.
  No request came near it. The per-request mark and the per-turn sum measure
  different things, and only the sum stopped her.

**Turn `cbe9db58` — a local model** (`qwen3.8:27b`, served at a 32k window):

- **She did the work.** She edited 3 files, ran the targeted tests in the
  change's box, and committed with `change_commit` (author Nova, with her
  `Nova-Turn` and `Nova-Coder` trailers).
- **Her first two landings could not measure.** `repo_land` returned
  `could_not_measure` twice: the box limit is 2, and both slots were taken —
  by her own idle change box and by a stale change's box. She closed the
  stale change herself and landed again.
- **The third landing was red, correctly.** Ruff flagged E501 in a test line.
- **She never saw the red.** She polled `landing_status` while it ran. Three
  identical "running" readings tripped the repeated-call guard, and the turn
  stopped at 24 rounds.

So the cloud model drowned in its own context and the local model was stopped
while waiting. Neither failure was about ability.

## 2. What the owner asked (2026-10-14, verbatim)

> "Can we implement caching of some theory? We need to improve how nova
> manages context because using local llms especially, she's going to have a
> lot of issues. Is there some new system that can help with memory, caching,
> context management? Or can we have her write to a file her status update on
> her current task after each turn, clear her context, read her goal and the
> status of the goal, and continue from where she left off or a combination?"

Then:

> "it all sounds good. we need this spec'd out."

And:

> "why can't she record progress or view a gitdiff? Also, she should include
> reasoning in the status file if she can, or a reasoning file along side
> each status file. and we need to consider improving both local llms and
> large cloud llms."

**The answer to "why can't she record progress or view a git diff":** she
can. `repo_diff` shows her change against `main`, file by file.
`change_commit` records her work as a commit. `landing_status` reads a
landing's verdict. `list_changes` lists her open changes. `read_result`
reads back a result S38b summarized. What she cannot get back is what was
only in her context: why she chose this file, what she already ruled out,
which searches she already ran. A reset loses that. The reasoning file (§5.2)
is for exactly that.

---

## 3. What binds this design

- **Mechanical over prompts.** "Write your status after each step" in her
  prompt is a request. The line of code that writes the ledger and resets
  the context is the control. Her status note is useful; it is never the
  record.
- **Derived, never hardcoded.** When to reset is read from the served link's
  window (served or declared), whether it is local, its measured prefill time
  and its spend. No list of models.
- **No approvals, ever** (2026-09-03, `../no-approvals.md`). A checkpoint
  never asks the owner and never stops work. `test_no_approvals` stays
  unchanged and green.
- **Never report success you did not check.** A ledger write is read back
  before the context is cleared. A failed write means no reset, stated on the
  trace — never a reset into an empty ledger.
- **No phrase matchers on his message** (2026-09-27). Nothing here reads his
  words to decide anything. A task opens from state: a change, a goal, a
  checkpoint.
- **No count of rounds stops a turn** (the no-ceiling ruling). Resets are
  triggered by size, time and spend, never by a round number.
- **Measurement frames outlive their code.** Changing what the token budget
  counts changes what stored `round_stop` rows mean. New rows name their
  basis; old rows are not compared with new ones.
- **One sample is not a measurement; never measure with ad-hoc turns.** The
  before/after numbers come from the eval runner, N≥3, with the commit rule
  fixed before looking (§9).
- **The repo is public.** No hostname, address, tailnet name or username in
  code, tests, fixtures or docs. This file names none.

---

## 4. What exists today (`main` at e511a5e5)

### 4.1 The token budget

- `chat.turn_tokens` (`chat.py:2595`) sums `prompt_tokens` and
  `completion_tokens` over every `llm_call` span of the turn, or core's
  estimate where a round reported none.
- It is checked between rounds, after the time budget (`chat.py:7072`).
  Default 1,000,000 (`settings_store.py:366`, range 10k–100M).
- Because each round re-sends everything, a turn of N rounds with a growing
  prompt counts roughly the area under that curve, not its height.

### 4.2 What `prompt_tokens` means depends on the adapter

- **Anthropic adapter** (`adapters/anthropic_messages.py:382`):
  `prompt_tokens` is Anthropic's *uncached remainder*. Cache reads and writes
  are separate fields.
- **OpenAI-shaped adapters** (OpenRouter, ollama `/v1`): `prompt_tokens` is
  the whole input. `prompt_tokens_details.cached_tokens` is a part of it
  (`usage.py:155` reads it into `cache_read_tokens`). OpenAI's own docs
  compute uncached as `input_tokens - cached_tokens - cache_write_tokens`, so
  cached is a subset.
- **So the same budget measures different things per provider.** On
  `2ca39a7e` it counted 86% cache reads as full tokens. On an Anthropic link
  the same turn would have counted far fewer.
- **Unverified, checked in T3:** `cost_from_price` (`usage.py:296`) adds
  `prompt_tokens × price` and then `cache_read_tokens × price × multiplier`.
  For an OpenAI-shaped provider that reports no cost of its own, that would
  bill cached tokens twice. OpenRouter reports its own cost, so `2ca39a7e`'s
  $0.216 is not affected.

### 4.3 Caching

- **The prefix is already split.** `base_messages` (`chat.py:1495`) sends
  the stable system prompt first, then the volatile one (recall, rosters),
  then history, then the decision hint, then his message. Tool names are
  sorted (`tools.tool_names`), so the tools array is deterministic.
- **The Anthropic adapter marks two breakpoints:** the first system block
  and the last tool (`anthropic_messages.py:325`, `:347`). No breakpoint
  sits on the messages. So within a turn, every round's growing message list
  is sent to Anthropic at full input price.
- **The OpenAI-shaped adapter sends no cache markers and no session id.**
  Gemini and OpenAI cache implicitly, which is why `2ca39a7e` hit 86%. An
  Anthropic model reached through OpenRouter would cache nothing past what
  OpenRouter does without `cache_control`.
- **Within a turn, context is append-only — until S38b or fitting acts.** A
  summary replaces a result in the middle; a trim cuts one. Either changes
  the bytes from that point on, so every cache (local KV or provider) misses
  from there.

### 4.4 S38b as built (#173)

- Every tool result is kept in full (`tool_results`, migration 049) and
  readable with `read_result(ref, part | query)`.
- Before a round, at 70% of the window's budget the oldest results are
  summarized by the serving link until under 50% (`_summarize_for_window`,
  `chat.py:5068`). The window is served (ollama `/api/ps`) or declared (the
  provider listing, `provider_windows`), marked by `context_window_source`.
- Results are kept per turn and deleted with the turn. `read_result` reads
  only the current turn's results.

### 4.5 Reasoning

- Core reads a reasoning model's thinking from `reasoning` (ollama `/v1`,
  OpenRouter) or `reasoning_content` (vLLM, DeepSeek) (`chat.py:1957`).
- It is streamed to the client as `think` frames and **never kept**
  (`_stream_reasoning`, `chat.py:6889`). The span keeps only
  `reasoning_chars`.
- The direct Anthropic adapter neither asks for thinking nor translates
  thinking blocks, so no reasoning reaches core from it.

### 4.6 Between turns

- A turn's history is user and assistant rows only, capped at 8,000
  characters (`HISTORY_CHAR_BUDGET`, `chat.py:146`). Tool results are not
  carried.
- **So "carry on" in a new turn is already a cleared context** — an
  unplanned one, holding only her prose. Nothing carries the request, the
  facts, or why she did what she did.

### 4.7 The tools that hurt on 2026-10-14

- **`device_search`** (`tools/devices.py:1508`): default 200 matches, max
  2,000, no path filter. The agent's `fs.search` honours `.gitignore` and has
  no include or glob argument (`apps/novad/internal/caps/fs_search.go`).
- **`landing_status`** is `ephemeral` and `reads_only`, so it is a live
  reading: a changed reading restarts its repeat count. A landing that sits
  at the same stage reads the same text, and the third identical reading is
  `repeated_call` (`SAME_CALL_LIMIT = 3`, `RoundProgress`, `chat.py:2946`).
- **The box limit** (`box.max_running`, default 2): a landing's judge box is
  one more box. S32 §5.5 names this trap; `cbe9db58` walked into it twice.

### 4.8 Goals and jobs

- **S34 (goals) is not built.** No `goals` table exists. Its design has
  `goal_note` writing to `goals/<id>/` on the workspace volume and every
  re-entry "framed by CODE from the goal's own record". The ledger here is
  that record, built first and general.
- **S30c jobs** exist (`device_jobs`, migration 048). **S37c events** exist
  (`events`, migration 051). The next free core migration is **052**.

### 4.9 Local models

- The 8B and 27B are served at a 32k window, measured 2026-10-09. A prompt
  at the window was cut from the *front* by ollama: the system prompt and his
  ask were gone. Core now fits to the served window (local-context, #140).
- Chat rides ollama's `/v1`, which ignores `think` and `num_ctx`. The gateway
  reads the window; it cannot set it.
- **Current Ollama reports cached prompt tokens.** Ollama's
  "Report cached prompt tokens" (#17943, merged 2026-09-02) fills
  `prompt_eval_cached_count`, and `/v1` maps it to
  `usage.prompt_tokens_details.cached_tokens`. The gateway already reads that
  field. **Unverified:** whether the GPU machine's installed Ollama is that
  new. T0 reads it.

---

## 5. The proposal

### 5.1 The shape, in one paragraph

Every long piece of work is a **task** with a **ledger**: the owner's
request, verbatim; a status she writes; her reasoning; and facts that code
writes from the trace. When a turn's context grows past a mark derived from
the serving link, the **turn loop** — not her — writes the ledger, reads it
back, and starts a fresh context: the same stable prefix, byte for byte,
then the ledger, then the last result. The turn goes on from there as a new
**segment**. A new turn on the same open task starts from the ledger too.
Everything that left the context stays readable by reference. Caching is
kept intact on both sides of a reset: local engines reuse the unchanged
prefix, and cloud providers get the markers they need.

### 5.2 The ledger

| Part | Written by | When | What the next segment sees |
|---|---|---|---|
| **The request** | code | when the task opens; each later message of his in that task is appended, dated | verbatim, in full, every segment |
| **Status** | her, through `task_status` | whenever she calls it; asked for once at a checkpoint | the latest version, marked as her note |
| **Reasoning** | her rationale (through `task_status`), plus the raw stream kept by code where the provider exposes it | her part when she writes it; the raw part every round | her rationale in full; the raw stream as references only |
| **Facts** | code, from spans | at every checkpoint and at the turn's end | in full, marked as the record |

**The request is pinned and never summarized.** Code copies his message
that opened the task, and appends any later message of his in that task,
each with its time. It never goes to S38b's summarizer or any other. The
evidence that a summary drops what matters is consistent:

- Anthropic's own harness for long-running agents keeps a progress file and
  a feature list beside git because "compaction isn't sufficient": it
  "doesn't always pass perfectly clear instructions to the next agent".
- Anthropic's context-engineering guide: "overly aggressive compaction can
  result in the loss of subtle but critical context."
- The ACE paper names *context collapse*: an LLM rewriting its own context
  each time drifts into shorter, less informative summaries, with sharp drops
  in performance.
- Laban et al. measured a 39% average drop when one instruction arrives over
  several turns instead of one; models "get lost and do not recover".
- S38b's own summarizer is told to keep paths and numbers verbatim. That
  instruction is a request; S38b's control is that the original stays
  readable. The request gets a stronger control: it is never rewritten.

**Status** is structured, not free text: `done`, `next`, `open_questions`
(lists of short lines). Anthropic's harness found a model less likely to
mangle JSON than Markdown. Each call writes a new version; old versions are
kept.

**Reasoning** has two halves:

1. **Her written rationale** — `task_status(rationale=…, ruled_out=…)`:
   why she chose what she chose, and what she ruled out and why. This is the
   part a reset loses today, and the part every provider allows.
2. **The model's raw reasoning stream**, kept by code per round, where the
   provider sends one. It is stored by reference, like a tool result
   (`reasoning` rows, `ref` `k7`), and **never inlined** into the next
   context. A ledger line names the refs; `read_result("k7", query=…)` reads
   one back. It is not inlined because it is large (a qwen3 "hello" once
   streamed 3,016 characters of thinking), because it is not what she said,
   and because it would undo the reset.

What each provider exposes (the reasoning file is only her rationale where
nothing comes back):

| Path | Raw reasoning reaches core? |
|---|---|
| Ollama `/v1` (qwen3) | yes, in `reasoning`, full text |
| vLLM, DeepSeek | yes, in `reasoning_content` |
| OpenRouter | in `reasoning` when the upstream exposes it; OpenRouter's docs name the OpenAI o-series as not exposing it |
| OpenAI direct | no raw chain of thought; a summary only when `reasoning.summary` is asked, or opaque `encrypted_content` |
| Anthropic direct | current models return *summarized* thinking; some blocks come back encrypted. Through our adapter today: nothing, because it does not ask for thinking (§4.5) |
| Gemini | thought summaries only (unverified through our path; T0 reads it) |

**Facts** are written by code from the task's spans, never by her:

- files touched (edit and write facts, with the change id);
- `repo_diff`'s per-file stat at the checkpoint, read live from the repo
  machine;
- test runs: argv, exit code, `ran_in`, counts;
- commits: SHA, files, message's first line;
- landings: id, verdict, the failing suite and its first error line;
- jobs: id, state, exit code;
- searches: pattern, path, matches, capped or not, and the result's ref — so
  a reset does not lead to the same search again;
- tool errors: the tool and the `Error:` line.

Each line carries its turn id and span, so it can be checked.

**Where it lives (§12, Q1):** tables `tasks` and `task_entries`
(migration 052), rendered by code to a read-only file in her workspace,
`tasks/<id>/ledger.md`, with `reasoning/` beside it. The owner can open it.
She can read it with `workspace_read_file`. She writes only through
`task_status`, so nothing she writes can land in the facts.

### 5.3 What a task is

- **A change.** `start_change` opens a task keyed to the change id. One task
  per change. `list_changes` shows it.
- **A goal**, when S34 lands. A goal owns its task. `goal_note` becomes a
  `task_status` write. S34's "re-entry framed by code" is a segment start.
- **A long request.** A turn that reaches its first checkpoint with no
  change or goal open gets a task opened by code, keyed to that turn and its
  conversation.

**A task closes by code:** a green landing with a merged SHA, `close_change`,
a goal met or stopped, or `task_status(close=true, why=…)`. He can close any
task from its page.

**Later turns (§12, Q6):** while a conversation has an open task, each new
turn in it starts with that task's ledger framed after the stable prefix.
That is how "carry on" works without reading his words. Downside: an
unrelated question in the same conversation carries the ledger too — a few
thousand tokens — until the task closes.

### 5.4 Checkpoints and resets, enforced by the backend

**When.** Before each round, after S38b's estimate, a checkpoint is due when
any of these holds:

1. **Size:** the next request is estimated at or above the **reset mark**:
   the lower of `R × window` (`R` is `turns.segment_ratio`) and
   `turns.segment_tokens`. The window is the
   served one (local) or the declared one (cloud). `R` and
   `turns.segment_tokens` are settings, proposed 0.5 and 64,000, fixed after
   measurement M-4 (§12, Q2). The second number is there because a declared
   1M window does not mean the model attends well over 1M: Chroma measured
   18 models getting less reliable as input grows, even on simple tasks, and
   Anthropic's guide calls context a finite "attention budget".
2. **Prefill time, local links only:** the last round's prefill — time to
   the first token of any kind, which `_note_throughput` already measures —
   was at or above `turns.segment_prefill_s` (proposed 60 s). This reads the
   machine as it is: a model swap, a cold cache, a busy card.
3. **Spend, metered links only:** the segment's real cost (span `cost_usd`)
   passed `turns.segment_usd` (proposed $0.25). This is a reset point, never
   a stop; the turn goes on.

Whether a link is local, its window and its price are read from the span the
gateway stamped. Nothing names a model.

**What a reset does, in order:**

1. **Ask once for her status.** One round with only `task_status` offered,
   and a code-written line saying a checkpoint is due. If she writes nothing
   or the call fails, the reset goes on and the ledger says "status not
   written at this checkpoint". Her note helps; the facts do not depend on it.
2. **Write the facts** from the spans, and the reasoning refs.
3. **Read the ledger back.** If the write cannot be read back, no reset: the
   round goes on through S38b and fitting as today, and the span says
   `checkpoint_failed` with the reason.
4. **Start the new segment's context:**
   - the stable system prompt and the tools array, **byte-identical** to the
     segment before;
   - the volatile system prompt, the same bytes for the whole turn;
   - the ledger block, which opens with the code-written line
     `[resumed: segment 3 of task t-…, after a checkpoint at <time>; the
     earlier rounds are on record — read_result reads any ref below]`;
   - the last tool result, or its S38b summary with its ref if it is large.
5. **File a `checkpoint` span**: why (size, prefill or spend), the estimate,
   the window and its source, the link, local or not, the segment number,
   the ledger's size.

**How it composes with S38b.** Within a segment, nothing changes: S38b
summarizes at 70% of the window and fitting is the last line. Across
segments, the reset is the coarse step and S38b the fine one. On a 32k local
window with `R = 0.5`, a reset comes before S38b's 70% mark, so S38b mostly
handles one huge result inside a segment (a 150 KB log). On a 1M cloud
window, the 64,000-token mark resets long before S38b would have run.
**`read_result` widens to the task:** a ref from an earlier segment or an
earlier turn of the same task reads back, and results of a task's turns are
kept until the task closes, then deleted with their turns as today.

**The budget (§12, Q3).** Two choices, and they can be combined:

- **(a) Count uncached tokens.** Normalize first (T3): every adapter states
  total input, cached reads and writes the same way. Then the budget counts
  `prompt − cache_read + completion`. `2ca39a7e` would have counted about
  14% of its prompt tokens. *Downside:* it changes what the number means.
  Every new `round_stop token_budget` row carries `budget_basis:
  "uncached"`; rows before it are in the old frame and are never compared
  with new ones. And a link that reports no cache field counts everything,
  as today.
- **(b) The budget per segment.** Each segment gets the full
  `turns.token_budget`. *Downside:* tokens no longer bound the turn; only the
  time budget (900 s default) does, plus spend resets.

**Proposed: (a), per turn.** Segments already bound each request's size; the
budget should bound the work, and the work is what was not cached.

### 5.5 Local models

- **Keep the prefix stable, so the engine reuses its KV cache.** What the
  engines do:
  - **Ollama**, current source, runs the upstream `llama-server` and sends
    `cache_prompt: true`. Prefix reuse is per slot: a request that shares a
    prefix with the slot's last prompt skips prefill for the shared part.
    Since #17943 it reports how many tokens were cached. A model unloads
    after its keep-alive (5 minutes by default), and its cache with it.
  - **llama.cpp server:** `cache_prompt` defaults to true;
    `--cache-reuse` (KV shifting when an earlier part changed) is off by
    default; `--cache-ram` (default 8,192 MiB) keeps idle slots' prompts in
    RAM.
  - **vLLM:** automatic prefix caching hashes each full block with its
    prefix; per vLLM's V1 announcement it is on by default in V1. *The
    current docs page reads as opt-in; unverified for any installed
    version.*
- **What breaks reuse here:** any change before the tail. A reset keeps the
  stable prefix, so the prefix still hits; only the ledger and what follows
  are new. An S38b summary in the middle of a segment breaks reuse from that
  point. **A summary call on a one-slot server is a different prompt in the
  same slot** — the next round may re-prefill everything unless the
  server's RAM prompt cache restores it. *Unverified;* M-2 measures it. If it
  does re-prefill, a reset is cheaper than a mid-segment summary on local
  links, and the reset mark should sit below S38b's.
- **Smaller effective windows.** The measured window is 32k. Thinking spends
  output tokens before any answer (measured 2026-09-10: 3,997 characters of
  reasoning and no content at `max_tokens` 1,200). So a local segment resets
  at half the window, leaving room to think and answer.
- **Measure prefill.** Every round's span gets `prefill_s` (time to first
  token of any kind) and `cache_read_tokens` when the engine reports it. The
  prefill trigger (§5.4) reads it.
- **Reasoning is kept** (§5.2): qwen3 sends the full stream, so on local
  links the reasoning file is the real thing.

### 5.6 Cloud models

- **Prompt caching, per provider** (as documented, October 2026):

  | Provider | How | Read price | Notes |
  |---|---|---|---|
  | Anthropic | explicit `cache_control`, or one top-level field that moves the breakpoint forward | 0.1× input on most models (0.05× and 0.025× on the newest) | writes 1.25× (5 min) or 2× (1 h); 512–4,096-token minimum by model; at most 4 breakpoints |
  | OpenAI | automatic at 1,024+ tokens | by model | `prompt_cache_key` routes related requests together on older models; advice: static first, append rather than rewrite |
  | Gemini | implicit on 2.5 and newer | discounted | 4,096-token minimum on the 3.x Flash models; `2ca39a7e`'s 86% came from this |
  | OpenRouter | passes through; Anthropic needs `cache_control`; Gemini 2.5 implicit | the provider's | sticky routing to one provider for 10 minutes; `session_id` sets the routing key explicitly |

- **What changes in the gateway:**
  - **Anthropic:** add the top-level automatic `cache_control` (or a moving
    breakpoint on the last message), so each round reads the earlier rounds
    from cache. Keep the two existing breakpoints.
  - **OpenRouter:** send `session_id` = the task id, so a task's rounds stay
    on one provider's cache. Send `cache_control` when the upstream is
    Anthropic.
  - **OpenAI direct (if added):** `prompt_cache_key` = the task id.
- **Provider-native compaction exists, and is not the control here.**
  - Anthropic: server-side compaction (on demand, beta
    `compact-2026-09-04`, or at a token threshold), context editing that
    clears old tool results or thinking (`clear_tool_uses_20250919`,
    `clear_thinking_20251015`), and a memory tool (`memory_20250818`).
  - OpenAI: Responses compaction (`context_management` with
    `compact_threshold`), which returns an *encrypted* compaction item.
  - Gemini: none found. OpenRouter: passes through what the upstream offers.

  *Proposed: do not use them as the mechanism.* Downside first: we write and
  keep our own, and lose summaries the provider tuned for its model. Why
  anyway: they differ per provider and do not exist on local links; one is
  encrypted, so the trace cannot show what she was told; and a provider's
  summary may rewrite the request, which §5.2 forbids. Anthropic's tool-result
  clearing could be a later optimization inside a segment. Not now (§12, Q5).
- **Context rot even with huge windows.** Anthropic's own guide warns that
  recall falls as context grows; Chroma measured it across 18 models. The
  segment mark (64,000 proposed) applies to cloud links for that reason, not
  for money.

### 5.7 The small mechanical fixes found today (early tasks)

Each stands alone and ships before the ledger.

1. **`device_search`:** default `max_matches` 50 (§12, Q7), and a new
   `glob` argument (`services/**/*.py`) the agent applies before reading a
   file. The head line states when the result was capped and how many more
   matched: "50 of 412 matches shown; narrow it with path or glob". An agent
   older than the `glob` argument is stated as such, with `machine_update`,
   the way `max_matches` already is (`_old_agent_refused_max_matches`).
2. **A landing's judge box must not wait on the change's own idle box.**
   When `repo_land` needs a box slot and the change being landed holds one,
   it stops that box first (its work is committed, or the commit check would
   have refused), and says so on the row: "stopped this change's box to
   judge it; it starts again on your next command". Other changes' boxes are
   not touched; when they hold every slot, the landing reads
   `could_not_measure` naming them, as today. This is an S32.3 follow-up,
   listed here because it cost two landings on `cbe9db58`.
3. **Waiting for a verdict without tripping the repeated-call guard:**
   `landing_status(id, wait_s)`, up to 90 s, returns as soon as the verdict
   or the stage changes, or at the deadline with "still running at stage
   *X*, waited *N* s, *M* min since it started". The elapsed time makes each
   reading new, so the live-reading rule counts it as progress; the time
   budget still bounds the turn. Later, with S34: a verdict written after the
   turn ended becomes an S37c event that resumes the task, so she never has
   to poll at all.
4. **Repeated identical searches:** a search whose pattern, path and glob
   match one already run in this task gets a code-written line on its
   result: "you ran this search in segment 1 (ref r12); it is kept —
   read_result reads it". It still runs, because the tree may have changed.
   A warning on the result, never a block (the verifier-loop pattern).
5. **One meaning for `prompt_tokens`** across adapters (§4.2), with the
   price check, before any budget change.
6. **The cache markers** in §5.6.

### 5.8 Honesty controls

| Claim in a reply | Backed only by | Otherwise |
|---|---|---|
| "I edited *file*" / "I committed it" / "the tests pass" / "it landed" | the facts on this turn's spans **or** the task's ledger facts from an earlier segment or turn, each with its time | corrected to what the record shows, as the S29/S32 guards do now |
| "I resumed from where I left off" / "carrying on from…" | a `checkpoint` span this turn, or a ledger framed at this turn's start | corrected: "this turn started without the task's ledger" |
| anything in her status note | nothing — a status note is never a backing fact | the guards ignore it as evidence |

- **The guards read the ledger's facts.** After a reset, the facts of
  segment 1 are no longer on segment 2's context, but they are still true. A
  guard that reads only this segment's spans would correct an honest "I
  committed it earlier" — and a guard that corrects an honest reply is the
  liar. The guards read the task's facts by turn id and span.
- **The ledger marks who wrote what.** The block she is sent has two
  headings, written by code: "The record (written from the trace)" and "Your
  notes (written by you; not evidence)".
- **A resumed segment says it resumed** — in her context (the first ledger
  line, §5.4) and on the trace (`checkpoint` span). Her reply in a turn that
  reset ends with one code-written line: "This ran in 3 segments; the
  earlier rounds are on record."
- **No new phrase matcher.** The ledger never parses his message. Claims are
  checked by the existing claim kinds, now with more facts to read.
- **The guards pass the timing sweep.** They run in core's event loop.

### 5.9 What the trace says

- `checkpoint` span: reason, estimate, window and its source, link, local,
  segment, ledger size, `status_written`, `checkpoint_failed`.
- Every `llm_call` span: `segment`, `prefill_s`, `cache_read_tokens`.
- `round_stop token_budget`: `budget_basis`.
- `reasoning` rows: turn, round, ref, chars, provider, `kind: raw | summary`.
- The ledger's own rows: task id, kind, written by (`code` or `nova`), turn,
  span.

---

## 6. Alternatives, downside first

**A. Her own files, by prompt** (the owner's first framing, taken
literally): she writes `status.md` with `workspace_write_file` and the prompt
tells her to read it after a reset. *Downside:* both steps are requests; a
model under pressure skips them, and a file she writes can say "tests pass"
with nothing behind it. *Upside:* no new tables.

**B. Provider-native compaction.** *Downside:* per provider, none on local
links, one is encrypted, and a summary can rewrite the request. *Upside:*
almost no code on Anthropic and OpenAI.

**C. S38b only, with lower marks.** *Downside:* summaries in the middle break
every cache from that point, nothing carries across turns, and the request is
not pinned. *Upside:* built already.

**D. Sub-agents in clean contexts** (Anthropic's guide): the lead delegates
searching to an agent that returns 1,000–2,000 tokens. *Downside:* each is a
turn of its own, with its own budget and failure modes; a local machine
serves one model at a time. *Upside:* the lead's context stays small. It
fits S12's agents later; it does not replace a ledger.

**E. Raise the budget.** *Downside:* cost, context rot, and nothing survives
a turn. *Upside:* one setting.

**Proposed: §5.** A combination, as the owner asked: the ledger is his file
idea made mechanical, and the caching work keeps resets cheap.

---

## 7. Measurements first

Each one is taken before the build step it gates, through her tools or the
eval runner, read back by turn id, sampled at least three times. Probes that
hold machine identifiers stay outside the repo.

| ID | Measure | Branch it selects | Gates |
|---|---|---|---|
| M-1 | Per link, a fixed 10-round replay: `cache_read_tokens` per round. Local (does the installed Ollama report cached tokens?), OpenRouter Gemini, Anthropic direct. | Local reports → prefill and cache both on the span. Not reported → `prefill_s` only, stated. Anthropic misses on messages → T4 is worth it, by how much. | T4, §5.5 |
| M-2 | On the local 27B: the prefill of the round after an S38b summary call, against the round before. | Re-prefills everything → reset mark below S38b's on local links. Restored from the RAM cache → no change. | §5.4 trigger 1 |
| M-3 | Local prefill after 6 minutes idle (keep-alive). | Cold → a resumed task's first round is a full prefill; stated, not hidden. | §5.5 |
| M-4 | S38b's long-log case at 25%, 50%, 75% and 100% of the 32k window on the 8B and 27B; the same case at 32k, 64k and 128k on the cloud link. | Sets `R` and `turns.segment_tokens` from where answers start to fail. | §12 Q2 |
| M-5 | Per link, what comes back as reasoning: raw, summary, encrypted, or nothing. | Fills §5.2's table with readings instead of docs. | T5 |
| M-6 | Per adapter, `prompt_tokens` with and without cached tokens; and the bill `cost_from_price` writes for a cached round on a priced, non-reporting provider. | Confirms or clears §4.2's double count. | T3 |

### Measurements (T1)

Taken 2026-10-14 for steps 0–4, read-only: `turn_spans` read by turn id
(core database), `usage_events` and `provider_prices` (gateway database),
and the Ollama image pin in `deploy/docker-compose.yml`. No chat turn, no
paid call, no write to the stack. These are readings of turns that already
ran, so each is one sample, not the N = 3 replay §9 asks for.

**M-1, OpenRouter Gemini (turn `2ca39a7e`, the "before" baseline).** 27
`llm_call` spans: rounds 1–26, plus the closing call after the stop
(`round` 0).

- `prompt_tokens` grew from 14,228 (round 1) to 63,958 (round 26).
  `cache_read_tokens` went from 0 to 61,625.
- Over all 27 calls: 1,072,248 prompt tokens, of which 880,595 were cache
  reads (82.1%). Leaving out the closing call: 1,020,526 and 86.3%, the
  figure §1 cites. Reported cost: $0.216445.
- Gemini's implicit cache missed whole rounds twice: round 1 read 0 (the
  first call) and round 3 read 0 after round 2 read 9,958.
- The closing call read 0 of its 51,722 prompt tokens. It is sent with no
  tools (`chat.py`'s stop path, `round_number=0`), so its prefix differs
  from every round before it.

**M-1, local (turn `cbe9db58`, the GPU machine's link, `qwen3.8:27b` at a
32k window).** 26 `llm_call` spans: rounds 1–24, one S38b summary call, and
the closing call.

- That machine's Ollama reports cached tokens. `cache_read_tokens` rose with
  the turn, 18,054 at round 2 to 28,130 at round 19, and prefill sat near
  1 s a round (764–1,680 ms) from round 4 to round 19.
- Rounds 20–24 each carry `context_trimmed` (fitting to the 32k window).
  Cache reads fell back to 18,054 and prefill rose to 11.2–11.4 s a round.
  This is §4.3's last point, measured once: a trim changes the bytes and
  every cache misses from there.
- Over all 26 calls: 628,813 prompt tokens, 523,907 cache reads (83.3%).
- The closing call read 0 of 15,061, the same no-tools prefix as above.
- In the gateway ledger the same link reports a cache count on 145 of 250
  local rows (109 of them above 0).

**M-1, the hub (the stack's own Ollama container).** `usage_events` holds
420 hub rows and 1,460 earlier `ollama` rows. None carries a cache count.
Nothing in either database records the installed version (searched: columns
named for versions, engines or runtimes, and the gateway's JSON columns).
The gateway calls `/api/version` only to verify the provider and stores
nothing; the engine facts hold the CPU and accelerators. The compose file pins `ollama/ollama:0.33.1`,
pinned 2026-08-28, before #17943 merged on 2026-09-02. So the hub's Ollama
almost certainly predates the cached-token report. *Could-not-measure,
directly:* the version string inside the running container, which would
need a call into the stack.

**M-1, Anthropic direct and Anthropic through OpenRouter.**
*Could-not-measure:* both need paid live calls, and the 10-round replay
needs the eval-fixture repository (§9, §12 Q10), which does not exist yet.
The ledger holds 4 Anthropic rows (2026-09-08, `claude-haiku-4-5`): one
cache write of 4,863 tokens and one read of 4,863, both of the system/tools
prefix. Steps 3–4 do not depend on this reading; §12 Q5 ruled the markers.

**M-6, per adapter.**

- **Anthropic: `prompt_tokens` is the uncached remainder.** On the cache-read
  row, `prompt_tokens` is 3,686 and `cache_read_tokens` is 4,863. A part
  cannot exceed its whole, so the read is not inside the prompt count. Its
  bill, $0.004222, equals 3,686 × $1/M + 10 × $5/M + 4,863 × $1/M × 0.1.
  The write row's $0.009806 likewise uses 1.25 × on 4,863. So today's
  Anthropic bills are right, and step 3 must keep these dollars.
- **OpenAI-shaped (OpenRouter, the GPU machine's link): `prompt_tokens` is the
  whole input.** Across 506 OpenRouter rows and 191 GPU-machine rows with a
  cache read above 0, the read never exceeds `prompt_tokens`.
- **The double count, confirmed.** We priced `2ca39a7e`'s 27 calls at
  OpenRouter's listing for `google/gemini-3.8-flash` ($0.75/M prompt,
  $3.75/M completion, default cache-read multiplier 0.1). Treating the cache
  read as a part reproduces OpenRouter's own reported cost on all 27 calls,
  within $0.000001: $0.216446 against $0.216445. `cost_from_price` as written
  would bill $0.876890, 4.05 × the real cost. Round 25 alone: $0.052706
  against $0.006474.
- **No stored bill is wrong yet.** No OpenRouter row was priced from the
  listing with a cache read: all 1,641 rows with a cost are
  provider-reported, and the 23 without one read 0. The only other
  OpenAI-shaped cloud provider (`cerebras`) has no price and 0 rows. The
  double count fires the first time OpenRouter omits its cost on a cached
  round.

**Not taken in step 0:** M-2 through M-5. They gate the ledger steps (5–13),
not steps 1–4. One unreplicated reading bears on M-2. In `cbe9db58`, the
round after the S38b summary call (round 3) read 18,054 cached tokens, the
same as round 2. Its prefill was 21.4 s, against 4.3 s for round 2. One
sample is not a measurement; M-2 is still owed.

---

## 8. Not in this spec

- Memory notes across conversations (S13, S14). The ledger is per task.
- The goal runner itself (S34). This spec gives it its record.
- Sub-agents for search (alternative D).
- The 8,000-character history budget between unrelated turns.
- Provider-native compaction or context editing (§5.6).

---

## 9. Measurement plan: before and after

**Through the eval runner only, never ad-hoc turns.** Links: the local 8B
(`qwen3:8b`), the local 27B (`qwen3.8:27b`), and one cloud model
(`gemini-3.8-flash` through OpenRouter, the `2ca39a7e` link). N = 3 per link
per arm. `main` before T1 is the "before" arm.

**The case needs a world the replay does not have yet.** Today a declared
device replays `run` only (argv to output). A coding task needs search, read,
edit, run, commit and land. *Proposed (§12, Q10):* a declared repository in
the eval fixture — an in-memory tree that `device_search`,
`device_read_file` and `device_edit_file` act on, test commands answered by
a rule over the tree (the test passes when the file holds the edit), and
`change_commit` / `repo_land` replayed against it. The tree is large enough
that a broad search returns hundreds of matches. *Otherwise:* a live eval on
her real repo with a throwaway change, closed after. *Downside:* it uses the
repo machine, the box slots and the CPU lock, takes minutes per sample, and
reaches the hub, which the replay rule forbids.

**Cases** (`suite_version` +1):

1. `finishes-a-long-coding-task` — the ISO-week task, verbatim. Pass: an
   edit fact on the right file, a run fact exit 0, a commit fact, a green
   landing replayed, the turn closed ok.
2. `resumes-after-a-checkpoint` — a setup that forces a checkpoint at round
   6. Pass: the task finishes; no search repeated with the same pattern and
   path; a `checkpoint` span; the ledger's request byte-equal to the
   message.
3. `reads-a-red-landing` — the replayed landing goes red after two
   "running" readings. Pass: she names the failing check; no
   `repeated_call` stop.
4. `claims-earlier-work-honestly` — a second turn on an open task asks
   "did the tests pass?" with the run fact in segment 1. Pass: the guard is
   silent on "yes"; a variant with no run fact gets the correction.

**Measured per sample:** task success; rounds; tokens counted on the old
basis and on the new one; real cost (sum of `cost_usd`); prefill seconds per
round (local); cache reads per round; checkpoints; wall time.

**The commit rule, fixed before looking:** S38c ships if, on the 27B and the
cloud link, case 1 passes at least 2 of 3 where `main` passes fewer; the
cloud link's tokens on the new basis drop by at least half against the old
basis on the same runs; mean prefill per round on the 27B does not rise; and
nothing in the existing corpus drops.

---

## 10. Interplay

- **S38b:** the fine step inside a segment; `read_result` widens to the
  task (§5.4).
- **S32:** `start_change` opens the task; the judge-box fix (§5.7, 2) is an
  S32.3 follow-up; S32.4's Changes page can link each change's ledger.
- **S34:** the ledger is the goal's record; `goal_note` becomes
  `task_status`; a goal attempt starts as a segment. S34 gets smaller.
- **S37c:** a landing verdict written after the turn ended can resume the
  task as an event (§5.7, 3).
- **S35 and S26:** the measurement cases here are coding-capability cases.

---

## 11. Build order and estimate

Estimates are for the build and its tests. The walk is on top.

0. **Measurements M-1 to M-6** (§7). About 3 h.
1. **`device_search`:** default 50, `glob` in core and in the agent's
   `fs.search`, the capped head line, the old-agent statement. About 2 h.
2. **Landing fixes:** the judge box stops the change's own box; the bounded
   wait in `landing_status`. About 3 h.
3. **One meaning for token counts** across adapters, and the price check
   (M-6). About 2 h.
4. **Cache markers:** Anthropic's moving breakpoint; OpenRouter
   `session_id` and `cache_control` for Anthropic upstreams. About 1.5 h.
5. **Reasoning kept by reference:** the `reasoning` rows, captured in
   `_stream_reasoning`, read with `read_result`. About 3 h.
6. **The ledger:** migration 052 (`tasks`, `task_entries`), the facts
   writer from spans, the read-back, the rendered file. About 5 h.
7. **`task_status`** and the framing of the ledger block. About 3 h.
8. **Checkpoints and resets in the turn loop:** the three triggers, the
   status round, the new segment's context, the spans. About 6 h.
9. **The budget basis** (§5.4, Q3) and its stamp on `round_stop`. About 2 h.
10. **Guards read the ledger's facts**, the resumed claim, the timing
    sweep. About 3 h.
11. **Tasks across turns:** open on `start_change` and at a first
    checkpoint, frame in later turns, close by code. About 2 h.
12. **The eval fixture** (the declared repository) and the four cases.
    About 6 h.
13. **The measurement runs and the docs** (`docs/` for the ledger page,
    the settings). About 3 h.

**About 44 h** (range 38 to 52). **Steps 1–4 are about 8.5 h and ship on
their own**, before the ledger; they fix both of today's failures without
it.

**Pins that move, deliberately, with the reason in the commit:**

- the tool registry, +1 (`task_status`);
- the eval corpus, +4 cases, `suite_version` +1;
- the settings snapshot: `turns.segment_tokens`, `turns.segment_ratio`,
  `turns.segment_prefill_s`, `turns.segment_usd`;
- `test_no_approvals` stays **unchanged and green**.

### As built (steps 0–4), 2026-10-14

Built on `slice/s38c-fixes`. What shipped is in `deploy/README.md`
("Searching a machine", "Her landing step", "Token counts and prompt
caching") and `apps/novad/README.md`. Where the build differs from the text
above, the build is right, and this is why.

**What was measured (step 0).** The readings are in §7, "Measurements
(T1)". M-6 was confirmed twice: by the code, and by repricing one turn's
calls by hand (the double count would have billed it about four times
over). No stored bill was wrong: every affected row carried the provider's
own cost. M-1 was read from two turns that already ran.

**What could not be measured.**

- Anthropic's per-round cache miss, direct and through OpenRouter. It needs
  paid calls, and the §9 fixture repository is not built. The markers were
  built without it (§12, Q5 ruled them).
- Which Ollama version the bundled engine runs. No database records it. The
  compose pin predates the Ollama change that reports cached tokens
  (#17943), which would explain why it reports no cache reads. That is a
  reading of the pin, not of the engine.
- Whether OpenRouter honours a marker on a tool-result message. Its guide
  says nothing either way, and checking it costs a paid call.
- M-2 to M-5. They gate the ledger (steps 5–13), not these steps.

**Design calls that differ from the spec text.**

1. **`device_search` (step 1).**
   - novad's own default dropped to 50 as well, and core sends 50 whenever
     she gives no number. So an older agent also returns 50.
   - `glob` is matched by novad's own code (no new Go dependency). With no
     `/`, it matches the file name at any depth. With `/`, it matches the
     path from the directory searched.
   - Core never assumes an agent applied the glob. novad ignores an argument
     it does not know, and still answers ok. Only the glob echoed back in the
     result proves the filter ran; without it, nothing is shown.
   - The total comes from novad counting past the cap. That count has its
     own 5 s budget. When the budget or the deadline cuts it, the total is a
     lower bound and the head line says "of at least N". An agent that sends
     no total gets "more exist — narrow it with path or glob", with no
     number.
2. **The judge's box (step 2).**
   - It is stopped by a new novad capability, `box.stop`. The spec named no
     mechanism. `box.remove` would have thrown away her box's database and
     dependency cache.
   - `box.stop` refuses a box that runs a live job. The landing then says why
     her box was not stopped, and judges as before.
   - It stops her box only when the running boxes, not counting the judge's,
     fill every slot and hers is one of them. The limit is read live.
   - A note on the landing row now survives the verdict. Before, writing the
     verdict replaced the row's reason, so a note written earlier was lost.
3. **The bounded wait (step 2).** The deadline line is "Still running at
   stage X, waited N s, M min S s since it started." It counts the age to
   the second, not in whole minutes as the spec wrote. In whole minutes, two
   readings less than a minute apart could match and trip the repeated-call
   stop. It reads the landing every 2 s, and the owner's stop ends the wait.
4. **One meaning for token counts (step 3).**
   - The plan was to leave the old Anthropic usage rows as they were and say
     so. Instead, gateway migration 016 moves them into the new meaning. It
     adds their cache reads and writes to their prompt count. Their cost and
     cache columns are untouched, and each still prices to what it was
     billed.
   - Core's past `llm_call` spans are not rewritten. An Anthropic span from
     before this step still carries the uncached remainder.
   - When reads and writes add up to more than the prompt, the call gets no
     cost rather than a wrong one, and the gateway logs a warning.
5. **Cache markers (step 4).**
   - Anthropic: an explicit marker on the last block of the last message, not
     the top-level automatic field. With the system and tools markers, when
     the request has a system prompt and tools, that is at most 3 of
     Anthropic's 4. A caller's own markers are never passed on.
   - OpenRouter: `session_id` is the turn id, not the task id. Tasks do not
     exist until step 6. It is sent for every model, but only to
     `openrouter.ai` and only on a call made for a turn (core's checks and
     beat passes send no turn id, so they carry none); a caller's own is
     kept.
   - OpenRouter, `anthropic/` models only: up to 2 markers, on the first
     system message (when there is one) and the latest message with content. The vendor is read from the
     model id as sent, never from a list. Any other model gets no marker.
   - A limit, not fixed: Anthropic looks back 20 blocks for an earlier cache
     entry. A round that adds more than 20 (about 10 parallel tool calls)
     misses it once and writes the cache again. Nothing fails.
6. **Not built here:** §5.7 item 4, the note on a repeated search. It needs a
   task to belong to, so it waits for the ledger.
7. **Estimate.** The build took about 9.5 h against 8.5 h: the glob matcher
   and `box.stop` were not counted. The measurements took about 0.5 h
   against 3 h, because the paid readings were not taken.

**What the owner needs to do after the merge.**

- **Update every machine's agent.** novad changed (`fs.search`'s glob and
  totals, the new `box.stop`). Ask her to run `machine_update` on each one.
- **Until then, an old agent says so.** A search with a glob fails with "this
  agent predates the glob filter", and shows nothing. A search without one
  still returns 50 hits, with no total. A landing notes "the agent predates
  box.stop — update it with machine_update" and judges as it did before.
- **The gateway migrates on start.** Migration 016 runs once. Anthropic
  usage rows show larger prompt counts afterwards. Their dollars do not
  change.
- **Anthropic turns count more against the token budget.** Their prompt
  tokens now include cache reads, as every other link's already did.

---

## 12. Questions for the owner — ruled 2026-10-14

The owner: "do what you propose". Every answer below is ruled as proposed.
Question 11 left one placement to him; with "do what you propose" the
orchestrator placed it (below), and he can move it.

1. **Where does the ledger live?** *Proposed:* database rows, rendered by
   code to a read-only `tasks/<id>/ledger.md` in her workspace; she writes
   only through `task_status`. *Otherwise:* plain files she writes. Downside:
   her file can claim facts nothing backs.
2. **When does a reset happen?** *Proposed:* at the lower of half the window
   and 64,000 tokens, or a local prefill of 60 s or more, or $0.25 spent in
   the segment — all settings, fixed after M-4.
3. **What does the token budget count?** *Proposed:* uncached input plus
   output, per turn, with `budget_basis` on every new stop row; old rows are
   not compared. *Otherwise:* the full budget per segment, which leaves only
   time bounding a turn.
4. **Keep the raw reasoning stream?** *Proposed:* yes, by reference, never
   inlined, deleted with the task. *Otherwise:* her written rationale only.
   Downside: the stream is the only record of why a local model did what it
   did.
5. **Provider-native compaction?** *Proposed:* not used; add Anthropic's
   moving cache breakpoint and OpenRouter's `session_id` instead.
6. **Does an open task's ledger follow later turns of the conversation?**
   *Proposed:* yes, until code closes the task. *Otherwise:* only when she
   resumes it with a tool, which is a request she can forget.
7. **`device_search`'s default?** *Proposed:* 50 matches, plus `glob`.
8. **The judge box:** *Proposed:* stop the landing change's own idle box
   while judging, as an S32.3 follow-up.
9. **Waiting for a verdict:** *Proposed:* a bounded wait in
   `landing_status`, up to 90 s, now; the verdict as an S37c event that
   resumes the task, with S34.
10. **The eval world for a coding task:** *Proposed:* a declared repository
    in the replay. *Otherwise:* a live eval on her real repo.
11. **Order.** *Proposed:* steps 1–4 now (they unblock the self-coding walk);
    the ledger before S34, which then builds on it. Where it sits against
    S32.4, S32.5 and S46a's boot agent is his call.
    *Placed 2026-10-14:* steps 0–4 now; then the S32.3 walk to green, S32.4,
    S32.5, and S46a's boot agent (ruled earlier the same day: after S32.5);
    then the ledger (steps 5–13), before S34.

---

## 13. Done when

Walked on the real stack, built from the nova directory at the merge commit,
each turn read back by turn id. Each number sampled three times.

1. **"Make get_time also say the ISO week number, commit and land it"** on
   the local 27B. She starts a change, edits, runs the targeted tests in the
   box, commits and lands. When a landing is red she reads why within the
   turn — no `repeated_call` stop — fixes it and lands green, merged. The
   trace shows any checkpoint with its reason.
2. **The same ask on the cloud link.** It finishes within the budget. The
   trace shows checkpoints, `budget_basis: uncached`, cache reads per round
   and the real cost. The ledger's request is byte-equal to his message.
3. **Mid-task, the turn ends** (stopped, or its time budget). **"Carry on"**
   in the next turn: the ledger is framed, she says she resumed, and no
   search from the first turn is repeated with the same pattern and path.
4. **"Did the tests pass?"** after a reset: answered from an earlier
   segment's run fact, the guard silent. A status note saying "tests pass"
   with no run fact behind it is corrected.
5. **Reasoning:** on the 27B, the ledger lists reasoning refs and one reads
   back as qwen3's own stream. On the cloud link, the ledger says what the
   provider exposed (§5.2), and the rationale is hers.
6. **§9's numbers are recorded** in the close-out, before and after, with
   the commit rule's verdict.

---

## Sources

- Anthropic, compaction overview: https://platform.claude.com/docs/en/build-with-claude/compaction
- Anthropic, context editing: https://platform.claude.com/docs/en/build-with-claude/context-editing
- Anthropic, prompt caching: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- Anthropic, extended thinking (summarized thinking, caching): https://platform.claude.com/docs/en/build-with-claude/extended-thinking
- Anthropic engineering, "Effective harnesses for long-running agents" (2025-11-26): https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents
- Anthropic engineering, "Effective context engineering for AI agents" (2025-09-29): https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- OpenAI, compaction: https://developers.openai.com/api/docs/guides/compaction
- OpenAI, prompt caching: https://developers.openai.com/docs/guides/prompt-caching
- OpenAI, Responses API reasoning items (`encrypted_content`, summaries): https://developers.openai.com/api/reference/resources/beta/subresources/responses
- Google, Gemini context caching: https://ai.google.dev/gemini-api/docs/caching
- OpenRouter, prompt caching: https://openrouter.ai/docs/guides/best-practices/prompt-caching
- OpenRouter, reasoning tokens: https://openrouter.ai/docs/guides/best-practices/reasoning-tokens
- Ollama source, `llm/llama_server.go` (llama-server slots, `cache_prompt`, cached counts): https://github.com/ollama/ollama/blob/main/llm/llama_server.go
- Ollama, "Report cached prompt tokens" (#17943): https://github.com/ollama/ollama/pull/17943
- llama.cpp server README (`cache_prompt`, `--cache-reuse`, `--cache-ram`): https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md
- vLLM, prefix caching design: https://docs.vllm.ai/en/latest/design/prefix_caching.html
- vLLM, V1 announcement (prefix caching on by default): https://vllm.ai/blog/v1-alpha-release
- Manus, "Context Engineering for AI Agents" (2025-07-18): https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus
- Chroma, "Context Rot": https://research.trychroma.com/context-rot
- Zhang et al., "Agentic Context Engineering" (context collapse): https://arxiv.org/abs/2510.04618
- Laban et al., "LLMs Get Lost in Multi-Turn Conversation": https://arxiv.org/abs/2505.06120
