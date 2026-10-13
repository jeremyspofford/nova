# S38b: reading past the context — the spec

**Status:** approved 2026-10-13. The owner took every proposal in §8 ("go
with your proposed").

The owner's idea (2026-09-30): "read what it can, then compress/summarize it
when the context is almost full, then continue reading". He ordered it on
2026-10-13: S38b next, then S37c.

From [`../doing-things.md`](../doing-things.md): when a turn's gathered tool
results near the model's context, the older ones are replaced by written
summaries so the turn can go on; the full text stays on the record, and a
summary is marked as one. It is general — logs, files and command output as
well as pages.

---

## 1. What exists today (`main` at b33570d9)

- **Fitting, not summarizing.** `context_fit.fit`
  (`services/core/app/context_fit.py`) runs before every round
  (`chat._fit_to_window`, `chat.py:4621`). Over budget, it cuts the oldest
  tool results from their tail down to a note (`[trimmed N chars to fit a
  W-token context window]`), then drops the oldest whole rounds. What it cut
  is gone for the rest of the turn: she cannot get it back, and nothing says
  what it held. The span says `context_trimmed`.
- **Fitting runs only where a window is stated.** The gateway states a link's
  window in `X-Nova-Context-Window` from ollama's `/api/ps`
  (`data_plane.py:653`), so only local links are fitted. A cloud link sends
  whatever the turn holds and fails at the provider when it is too big. The
  gateway's catalog already holds a declared `context_length` for cloud
  models (`catalog.py:276`).
- **A tool result's full text is kept nowhere.** The span keeps the first
  500 characters (`traces.SPAN_RESULT_HEAD_CHARS`). `messages` holds only
  user and assistant rows. The full result lives in the turn's memory and
  dies with it.
- **The browser already reads in parts.** `browser_read` serves a page in
  24,000-character parts or by search (`browser/reader.py`). This is where
  S38b compresses first (S38 spec, "Interplay").
- **Measured 2026-10-09:** the 8B and 27B on the Dell run at a 32k window.
  Turn `13c6717e` trimmed one tool result and still answered correctly. A
  longer read (a log, a 100 KB file, three browser parts) is where she loses
  what she read first.

## 2. What changes

1. **Every tool result she is sent is kept in full** for the life of its
   turn's trace: a new table `tool_results` (turn id, tool call id, tool name,
   content, chars). It is deleted with its turn. Migration: the next free
   number when S38b lands (049 is S32.3's).
2. **When a round's request nears the window, the oldest results are
   summarized**, oldest first, until the request is back under a mark. A
   summary replaces the result in what is SENT, never in what is kept. Each
   result is summarized at most once per turn; the next round reuses it.
3. **A summary is marked as one, by code:**

   ```
   [summary of browser_read result r3 (48,120 chars) — the full text is kept;
   read it with read_result("r3", part=… or query=…)]
   <the summary>
   ```

4. **She can read the full text back:** a new tool `read_result(ref, part |
   query)`, served in parts or by search the same way `browser_read` serves a
   page (the reader's paging is reused, not copied). "Continue reading" means
   this: what she summarized is one call away, never lost.
5. **The summary is written for the question.** The summarizer is given his
   latest message and told to keep what bears on it verbatim: numbers, names,
   paths, error lines, quotes. That instruction is a request, so it is not
   the control. The control is item 4: the full text is always readable again.
6. **Fitting stays as the last line.** If summarizing fails (the call errors,
   times out, or returns nothing), the round falls back to today's trimming,
   and the span says `summary_failed` with the reason. A result is never
   marked as a summary unless a summary was written.
7. **Cloud links are fitted too** (§8, Q3): when the gateway's catalog
   declares a model's `context_length`, the gateway states it in the same
   header, marked as declared, not served. Without one, a cloud turn is sent as
   it is today.

## 3. When it runs

Before each round, after the existing estimate:

- Under **70% of the budget**: nothing happens.
- Over it: the oldest results not yet summarized, skipping the latest round's
  own results, are summarized one at a time until the estimate is under 50%,
  or until none are left. Then `fit` runs as it does today.

The 70/50 gap means a long read summarizes in batches, not one result every
round. Both numbers are fractions of the window, never a table of models.

## 4. Who writes the summary

The link that is serving the turn (§8, Q1). It is the model already chosen
for this work, it is the one whose window is being managed, and on a local
machine it is already loaded. One extra call per summarized result goes
through the gateway like any other, with its own `llm_call` span
(`purpose: summary`), so its cost and time are on the trace.

## 5. What the trace says

- The round's span: `context_summarized: [{ref, tool, chars, summary_chars}]`,
  and `summary_failed` when one failed.
- The summary call's own span: tokens, cost, link, duration.
- `read_result` calls are spans like any tool.

So "she read all of it" is checkable: every part she was sent is a span, and
every summary names the result it replaced.

## 6. Honesty

- **The marker is written by code**, so it cannot be left off.
- **No new guard.** A guard that matches what she says she read against what
  was summarized would be a phrase matcher (owner ruling 2026-09-27). The
  facts are on the trace instead, and the eval below measures whether her
  answers stay right.

## 7. Evals and measurement

- **Two corpus cases** (bumps `suite_version`):
  1. *A long log:* a ~150 KB file in the eval workspace, with one fact near
     the start and one near the end. The question needs both. Pass: the answer
     names both facts, the turn closed ok, and its trace shows
     `context_summarized`.
  2. *Read back:* the question needs a detail the summary is unlikely to keep
     (a line number in the middle). Pass: she calls `read_result` and answers
     correctly.
- **Measured before and after** on `dell:qwen3:8b` (32k) and the 27B, N=3
  each, through the eval runner, with the commit rule fixed before looking:
  S38b ships if case 1 passes at least 2 of 3 on the 27B where `main` passes
  fewer, and nothing in the existing corpus drops.
- **Live walk:** he asks, in chat, for something that needs a long read (his
  pick; for example "read the last 2,000 lines of core's log and tell me what
  failed first"). Pass: the turn closes ok, the trace shows a summary and the
  answer is right.

## 8. Questions for the owner (all ruled as proposed, 2026-10-13)

1. **Who writes summaries?** **The link serving the turn.** The alternative is
   a new routing role, `summary`, with its own chain, which would let a cheap
   cloud model summarize for a local one. It costs a settings row and a role.
2. **When?** **Start at 70% of the window and stop at 50%.**
3. **Fit cloud links too, from the catalog's declared window?** **Yes.**
   Today a too-big cloud request fails at the provider. This changes what
   cloud turns send, but only when they would otherwise fail.
4. **How long are full results kept?** **As long as the turn's trace**,
   deleted with it. The alternative is only the results that were summarized,
   which saves disk but makes `read_result` work only on those.

## 9. Size and order

M. About 6–8 hours, in this order: the table and keeping results (1), the
summarizer and its marker (2–3, 6), `read_result` (4), cloud windows (7, in
the gateway), then the eval cases and the measurement. One migration; a
registry pin (`read_result`) and a corpus pin move, on purpose.

## 10. Interplay

- **S32.3 (another session):** it takes migration 049; whichever lands second
  renumbers once.
- **S34 goals:** long attempts use these summaries (`nova-codes.md`).
- **S37c (next):** event payloads are tool-result-shaped and get the same
  treatment for free.
