# S38b: reading past the context — the close-out

**Status:** built on `slice/s38b`, not merged, not shipped. The measurement and
the LIVE walk have not run (sections below). The spec is
[`spec.md`](spec.md); the owner took every proposal in its §8 on 2026-10-13.

What it does: when a turn's gathered tool results near the served model's
window, the oldest are replaced in what is SENT by a summary the serving link
writes, under a marker written by code. Every result is kept in full and she
can read it back with `read_result`. Cloud links are fitted too, from the
window their provider's listing declares. Trimming stays the last line.

## Commits

On `slice/s38b`, off `origin/main` at `b33570d9`:

| Commit | What |
|---|---|
| `9bcbe8a5` | docs(s38b): the spec |
| `24730f4e` | docs(s38b): the owner took every §8 proposal |
| `3fe3f976` | T1 — keep every tool result in full |
| `30cc87d6` | T2 — which results to summarize, and the summary marker |
| `1c2a1865` | T3 — summarize the oldest results when a round nears the window |
| `4db7d817` | T4 — `read_result` reads a kept result back in parts or by search |
| `15f0d03f` | T5 — cloud links state the window their listing declares |
| `58ac9e01` | T6 — two eval cases that read past a 32k window |

These docs (T7) are not committed yet.

## What was built, per task

**T1 — every result kept in full.** Core migration `050_tool_results.sql`
(049 is S32.3's). One row per tool result she is sent: `turn_id`, `ref`
(`r1`, `r2`, … in call order, the turn's own handle), `tool_call_id`, `tool`,
`content`, `chars`. `chat._run_tool` appends the result to the turn in memory,
with no new await (`test_no_approvals` pins `_run_tool`'s awaits). The rows
are written by `traces.close_turn` in the same one transaction as the spans
and the status: a turn whose trace landed has its results, and one that never
closed has neither. The kept text is the span's own scrub of the result. A
NUL byte (postgres text refuses one) is stored as U+FFFD; `chars` is
unchanged. While the turn runs, `traces.results_of(turn_id)` holds the same
list; `_run_turn`'s `finally` clears it on every exit.

**T2 — which results, and the marker.** `services/core/app/context_summary.py`,
pure. Under 70% of the window's budget (`context_fit.budget_for`), nothing.
At or over it, the oldest tool results with a kept ref, not already
summarized and not in the latest tool round, are picked one at a time until
the estimate is under 50%, or none are left. A summary not yet written is
counted at its cap, 5% of the window (`summary_max_tokens`). All three are
fractions of the window; there is no table of models. The marker, exactly:

```
[summary of browser_read result r3 (48,120 chars) — the full text is kept;
read it with read_result("r3", part=… or query=…)]
<the summary>
```

`apply()` refuses a summary with no text, so a marker never goes without one.

**T3 — the summarizer, in chat.** Before a round's `llm_call` span opens,
`_summarize_for_window` looks up the window (`_window_for`, shared with
`_fit_to_window` so the two never disagree), takes T2's picks and asks the
link that served the turn to summarize each one. The call goes through the
gateway with the turn's own role, `purpose: summary`, `GATEWAY_TIMEOUT` and
`max_tokens` = the 5% cap. The summarizer sees his latest message (capped at
4,000 characters) and is told to keep numbers, names, paths, error lines and
quotes verbatim. That instruction is a request; the control is `read_result`.
A result bigger than the summarizer's room goes in window-sized pieces, one
call each, joined into one summary and cut to the cap. Each result is
summarized at most once per turn: later rounds send the cached summary
again. A summary that is refused, errors, times out or comes back empty is
stated as `summary_failed`, is not retried that turn, and the result goes as
it was, for `_fit_to_window` to trim as before. With no window known, or
under 70%, no summary call is made.

**T4 — `read_result(ref, part | query)`.** `services/core/app/tools/results.py`.
It reads this turn's kept results by the turn id its context carries, and
serves one in parts of 24,000 characters or by search, as `browser_read`
serves a page: `reader.read_text` builds the page through the reader's own
paging, and the search is the reader's. An unknown ref is an `Error:` naming
the refs that exist; a part past the end says how many there are. Outside a
chat turn it says it cannot, and it never reads another turn's results.
Registered, `reads_only`. The registry, `reads_only`, capability and
`live_facts` pins moved on purpose (`read_result` is not auto-run: no
recalled note can name a ref of the running turn).

**T5 — cloud windows.** Gateway migration `014_provider_windows.sql`: on
every listing fetch (`admin._listing_for`, the one path the catalogue and the
admin page use) the gateway stores each model's declared `context_length`
per (provider, model); the next fetch replaces that provider's set. A 200
from a link that is not an engine, whose origin states no `/api/ps` window,
for a model with a stored length, carries `X-Nova-Context-Window` and
`X-Nova-Context-Window-Source: declared`. An `/api/ps` window still wins and
says `served`. A model never listed with a length carries neither header, as
before. Core records the source and fits (and so summarizes) with a declared
window as with a served one, but never reads a declared window as a silent
cut: a cloud provider refuses, it does not drop the front.

**T6 — two eval cases and a predicate.** See "Evals" below.

## What the trace says

On the round's `llm_call` span:

| Key | When | Holds |
|---|---|---|
| `context_summarized` | this round sent new summaries | `[{ref, tool, chars, summary_chars}]` |
| `summaries_reused` | this round sent summaries written in an earlier round | `[ref, …]` |
| `summary_failed` | a summary call failed | `"rN: <reason>; …"` |
| `context_window_source` | the gateway stated a window | `served` (`/api/ps`) or `declared` (a listing's `context_length`) |

Each summary call is its own `llm_call` span with `purpose: summary`, filed
before the round's span, with its tokens, cost, link and duration. It has no
`round` key: a reader counting a turn's rounds must filter on `purpose`, as
it already does for judge and redirect calls. `read_result` calls are tool
spans like any other.

## Retention

A result is kept for the life of its turn: `tool_results.turn_id` references
`turns(id) ON DELETE CASCADE`, as `turn_spans` does. **Turns are never deleted
today** — no retention job touches them — so `tool_results` grows without
bound. That is the owner's choice in §8 Q4 (keep every result, so
`read_result` works on any of them), not an oversight.

## Evals

Predicate `context_summarized` (arg = a tool name): passes when an `llm_call`
span's `context_summarized` names that tool. A failed or reused summary is not
a written one. Ten predicates now.

Two cases, generated by `.epics/s38b-t6-gen_cases.py` (deterministic; edit
the generator, never the page text):

1. **`reads-a-long-log-past-the-window`** — a nightly log of 166,927
   characters in 7 parts. One fact is in part 1, one in the last part, each
   once. Contract: `browser_read` succeeded, the reply names both facts, a
   round summarized a `browser_read` result, no narration guard.
2. **`reads-back-a-summarized-result`** — a deploy log of 163,966 characters.
   The asked commit is at entry 1217, in a middle part, and again in the
   final note, which never names the entry. The page's entry list is far
   bigger than a summary may be, so a summary cannot keep it. Contract:
   `read_result` called, the reply names 1217, `browser_read` succeeded, no
   narration guard.

**The window-conditional ruling** (orchestrator, 2026-10-13): a case must
never fail an honest, right answer because the model's window was big enough.
The summary clause (case 1) and the `read_result` clause (case 2) declare
`page_chars`, and apply only when the smallest `context_window` stated on the
turn's `llm_call` spans cannot hold the page (its budget against
`page_chars` at the default chars per token — never a list of models). With a
bigger or unstated window the clause passes with `applicable: false` and a
detail that says `not applicable`, and the case is scored on the reply. A
64k window holds case 1's page by this arithmetic, so the clause does not
apply there even though the product would summarize at 70%.

**Deviation from spec §7.** The spec asked for "a ~150 KB file in the eval
workspace". The corpus has no workspace-file fixture, and
`workspace_read_file` returns only the first 32 KB with no paging, so such a
file cannot be read past 32 KB. Both cases use the existing browser fixture
(`eval_browser_engine`, as `reads-a-long-page-in-parts`) to serve the long
text as a page read in parts instead.

Corpus pins moved on purpose: 47 cases to 49, `suite_version` 25 to 26.

## Known limits

- **Fit can trim a summary.** `context_fit.fit` trims the oldest tool content
  first, from its tail, and a summary is now the oldest. When the latest
  round alone overflows the window, a summarized result can go as its marker
  and a cut summary, or as its marker and only a `[trimmed` note. A summary
  was written, so the marker is not a lie, but she may see no summary text
  for that round. A fit that skips summarized content is a follow-up, not
  done.
- **The first round after a core restart is not summarized or fitted.** The
  window is learned from the gateway's answer, so a link never served since
  the restart has none yet, as before S38b.
- **A cloud model never listed** has no declared window and is sent as before.
- **A stalled origin** past the gateway's stamp budget costs the declared
  window too: the whole stamp is omitted, as before.
- **A NUL byte in a result's first 500 characters still fails the close.**
  `tool_results` swaps it, but the span head (`turn_spans.meta`, jsonb) does
  not, and postgres refuses it there. This is older than S38b and out of its
  scope.
- **No test pins the summary timeout's value** (`GATEWAY_TIMEOUT`, not the
  judge's 30 s).

## Measurement

**NOT YET RUN.** Through the eval runner, N=3 each, on `dell:qwen3:8b` (32k)
and the 27B, before (main's behaviour) and after. The commit rule, fixed
before looking: S38b ships if case 1 passes at least 2 of 3 on the 27B where
`main` passes fewer, and no existing corpus case drops. The "before" method
is to be written down before the first run. Numbers and run ids go here.

## LIVE walk

**NOT YET RUN.** After merge and deploy from `~/workspace/nova` `main`: an
owner-style long read in chat (for example "read the last 2,000 lines of
core's log and tell me what failed first"), then read by turn id in
`turn_spans`: the turn closed ok, a round span carries `context_summarized`,
an `llm_call` span has `purpose: summary`, and the answer is right. The turn
id goes here.
