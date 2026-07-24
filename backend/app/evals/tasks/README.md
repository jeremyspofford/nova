# Eval suites — task specs and frozen fixture corpora

Data, not code. Nothing here imports anything and nothing here is executed;
`backend/app/evals.py` (the harness, model-eval-pipeline.md phase 1) is the
only consumer. Authored for `docs/plans/model-eval-pipeline.md` →
"Eval suites — ALL roles".

Scores are **only comparable within a suite version**. Any edit to a task's
prompt, fixtures, seed corpus, or contract that could change a contestant's
score must bump `suite_version` in that suite's `suite.json`; stored results
carry the version they were produced under.

## Layout

```
tasks/
  README.md          this file — the format contract
  schema.json        JSON Schema (draft 2020-12) for suite.json + task files
  validate.py        stdlib-only checker; run it after editing any spec
  <suite>/
    suite.json       suite metadata, run pins, task list
    probes.json      golden/bad samples proving the text checks work
    tasks/*.json     one task spec per file
    prompts/*.md     long task prompts (referenced by prompt_file)
    corpus/          OKF markdown pre-seeded into the SCRATCH memory dir
      topics/*.md
      sources/*.md
    fixtures/<task-id>/<tool>.json   canned tool results for that task
    fixtures/<task-id>/pages/*.txt   long tool results (referenced by result_file)
```

```
$ python backend/app/evals/tasks/validate.py
3 suites, 18 tasks, 17 fixture refs, 64 regexes, 18 probe pairs checked
0 error(s), 0 warning(s)
```

`validate.py` checks what the schema cannot: referenced files exist, regexes
compile, task ids match filenames and their suite's task list, fixture entries
have exactly one result source and none is shadowed by an earlier subset
match, no result exceeds the runner's 8000-char cap, contracts only name tools
the agent is actually granted, `rounds_max` fits the suite's pinned
`max_tool_rounds`, and every probe behaves. Corpus files are separately
verified against the real `OkfStore`: each one parses, and each filename is
the slug its own title would produce.

All paths inside a spec are **relative to the suite directory** and must stay
inside it.

## Suites in this directory

| suite | agent (`agents.name`) | class | tasks |
|-------|----------------------|-------|-------|
| `ingestion` | `ingestion` | live-tool | 6 |
| `model-manager` | `model-manager` | live-tool | 6 |
| `news-summarizer` | `news-summarizer` | live-tool (memory-only toolset) | 6 |

## Execution model these specs assume

1. Harness creates a scratch memory dir, copies every file listed in the
   task's `seed_corpus` into it preserving its relative path under
   `corpus/`, then calls `startup()` on the scratch `OkfMemory` so soul.md is
   seeded and the BM25 index covers the seeded corpus. Write-time
   `_link_pass` is deterministic because the corpus is frozen.
2. Harness pins `agents.max_tool_rounds` to the suite's `run.max_tool_rounds`
   (it is a global setting, not a per-agent column —
   `settings_store.py:42-45`, read live at `runner.py:490`).
3. Harness loads the task's fixture files into the replay contextvar, then
   runs champion and challenger back-to-back on the same fixtures.
4. Contract checks run over the event/tool transcript + the scratch memory
   dir. Judge sees task prompt, fixture sources, and the two outputs — never
   raw system prompts.

## Fixture files

A fixture file is one tool's canned results for one task.

```json
{
  "tool": "fetch_url",
  "notes": "why this corpus looks the way it does",
  "entries": [
    { "match": {"url": "https://example.com/a"}, "result_file": "pages/a.txt" },
    { "match": {"url": "https://example.com/b"}, "result": "inline string" }
  ],
  "default": { "result": "Error: ..." }
}
```

- A tool result is **always a plain string** — every builtin returns `str`
  (`tools/builtin.py:23-24`); structured results are `json.dumps(...,
  default=str)`. Fixtures therefore hold the exact string the tool would have
  returned, including `Error: ` prefixes and the `[source: …]` header that
  `fetch_url` prepends (`tools/web_fetch.py:147-148`).
- `match` is a **subset predicate** on the call's args: the entry matches when
  every listed key is present with an equal value. Entries are evaluated in
  order; first match wins; `default` serves everything else.
  This is the refinement the plan anticipates between "exact sha256 of
  canonical args" (which *will* miss — each contestant writes its own query
  strings) and "one default per tool per task". An entry whose `match` names
  the full arg set is equivalent to the hash form and lane 2 may index it that
  way; `default` is the fairness mechanism that keeps both contestants
  researching the same frozen mini-web.
- `result_file` is a path under the task's fixture dir; its contents are
  served **verbatim, byte for byte**, as the tool result string. Use it for
  anything multi-paragraph.
- Exactly one of `result` / `result_file` per entry.
- A result may contain `{{args.<key>}}` placeholders, substituted with
  `str(...)` of that key from the **actual** call args (missing key → empty
  string). This exists so the frozen search corpus can echo back whatever
  query the contestant actually wrote — `web_search` really does print
  `Search results for: {query}` (`tools/web_search.py:117`), and a fixed echo
  that disagreed with the call would be an incoherence one contestant might
  notice and another might not. `{{` with anything else after it is literal.
- Keep every result under **8000 characters** — that is the cap the runner
  applies before the model ever sees it (`runner.py:629-630`). Fixtures here
  are well under it.
- A `default` is required unless the task's contract makes an unmatched call a
  failure anyway; a missing `default` on an unmatched call should hard-error
  the eval rather than fall through to the live tool.

## suite.json

```json
{
  "suite": "ingestion",
  "suite_version": 1,
  "agent": "ingestion",
  "execution_class": "live-tool",
  "description": "...",
  "notes": "...",
  "run": {
    "max_tool_rounds": 10,
    "budget_seconds": 300,
    "exclude_tools": ["..."],
    "replay_only_tools": ["..."]
  },
  "tasks": ["task-id", "..."]
}
```

- `execution_class`: `live-tool` (read-mostly toolset; record/replay as
  designed) or `replay-only` (toolset mutates Postgres — fixtures are
  AUTHORED, never recorded, and nothing executes). All three suites here are
  `live-tool`.
- `exclude_tools`: removed from the agent's toolset for the whole suite.
  These are the real-side-effect tools the plan bans from eval toolsets
  (`pull_model`, `notify_operator`, `request_operator_confirmation`,
  `remember_speaker`) plus `delete_memory_item` (reaches into the real
  `media_ingests` ledger, `memory.py:360-361`).
- `replay_only_tools`: stay in the toolset but must **never** execute, not
  even in record mode — the harness serves a fixture. These are tools whose
  "read" still costs real work or real rows (`ingest_media` runs
  yt-dlp/whisper and writes the media ledger; `follow_source` /
  `poll_sources` / `unfollow_source` write `source_subscriptions` and enqueue
  ingest jobs; `get_weather` calls a live external API and is
  non-deterministic).
- `replay_only_default`: served when a replay-only tool is called and no
  fixture matches. A stray call then costs a graded `tool_error` instead of
  aborting the run — and still cannot reach the real world.

## Task spec

```json
{
  "id": "research-and-write-topic",
  "suite": "ingestion",
  "title": "short human label",
  "intent": "what this task measures, in one or two sentences",
  "prompt": "the user message",           // or "prompt_file": "prompts/x.md"
  "seed_corpus": ["corpus/topics/x.md"],
  "fixtures": ["fixtures/<id>/web_search.json"],
  "budget_seconds": 240,
  "contract": { ... },
  "judge": { ... }
}
```

`prompt` and `prompt_file` are mutually exclusive. The prompt is delivered as
a single user message (`run_agent(..., [{"role":"user","content": prompt}])`)
— the same shape the scheduler uses for an automation instruction.

### contract — the deterministic checks

Closed vocabulary. Every key is optional; an absent key is not checked.
`≥`/`≤` bounds are inclusive.

**`tools`**

| key | meaning |
|-----|---------|
| `must_call` | list of `{"name", "min", "max"}` — call count bounds for that tool (`max` optional) |
| `must_not_call` | tool names that must not be called at all |
| `must_call_with` | list of `{"name", "args"}` — at least one call to `name` whose args are a superset of `args` |
| `must_not_call_with` | list of `{"name", "args"}` — no call to `name` may have args matching that subset |
| `max_total_calls` | integer cap on all tool calls |

**`memory`** — evaluated against the scratch memory dir after the run, plus
the `write_memory` call args from the transcript.

| key | meaning |
|-----|---------|
| `no_writes` | `true` → the run must not write memory at all |
| `topics_created` | `{"min","max"}` — topics that did not exist in the seed corpus |
| `no_new_topics` | `true` → shorthand for `topics_created.max = 0` |
| `updates` | list of `{"item_id","mode","count"}` — `mode` ∈ `replace`/`append`/`prepend`; the item must have been written in place with that mode exactly `count` times |
| `title_matches` | regex the created topic's `title` frontmatter must match |
| `frontmatter_required` | keys that must be present on every created topic |
| `frontmatter_equals` | key→value the created topics must carry |
| `source_url_in` | the created topic's `source_url` must be one of these |
| `tags` | `{"min","max","no_generic","must_include_any","must_not_include"}` — see below |
| `body_must_contain_any` | list of alternative-groups; each group needs ≥1 hit in the created/updated body |
| `body_must_not_contain` | substrings that must not appear in the body |
| `body_must_not_match` | regexes that must not match the body — use this whenever the forbidden value is a SUBSTRING of the correct one |
| `write_content` | `{"must_match","must_not_match","must_contain","must_not_contain","max_chars"}` — applied to the `content` **argument** of the write, which is the only way to grade delta-only writes (append/prepend send just the delta); on a create it is the whole body |

`tags.no_generic: true` fails the check if any tag is in
`OkfMemory._GENERIC_TAGS` (`memory.py:114-137`). `must_include_any` is a list
of groups; each group needs at least one of its tags present.

**top level**

| key | meaning |
|-----|---------|
| `rounds_max` | tool rounds used must be ≤ this |
| `malformed_args_max` | tool calls the runner rejected as malformed JSON args |
| `tool_errors_max` | results starting `Error: ` or `Blocked by rule ` |
| `final_text` | `{"must_match": [regex], "must_not_match": [regex]}` on the final assistant text |
| `narration_slip_allowed` | default `false`; fails when `narration.detect(final_text, tool_calls_made)` returns a match |

A forbidden value that is a substring of the RIGHT answer cannot be expressed
with `body_must_not_contain` — `"1.2 trillion"` contains `"2 trillion"`, so the
substring form fails a correct write. That is not hypothetical: it graded a
champion as wrong on 2026-07-24. Reach for `body_must_not_match` with an
anchored pattern (`(?<![\d.])2\s*(?:trillion|T\b)`) in that case.

Regexes are Python `re`, matched case-insensitively with `re.search` and
**without** `re.MULTILINE` — `^` means start of the string, not start of a
line. Patterns that need a line anchor mid-document write `(?:^|\n)`
explicitly. Substring checks (`must_contain`, `body_must_contain_any`,
`must_not_contain`) are also case-insensitive.

Every text check is probed. Each suite ships a `probes.json` holding a golden
and a bad sample per task; `validate.py` asserts the golden passes every check
and the bad sample fails at least one. This is not decoration — writing the
probes is what caught a `must_not_match` that fired on the correct answer
(a supersession task where naming the stale model is required) and a `^###`
anchor that could never match without `re.MULTILINE`. Add a probe with every
new check, and lane 2 gets a ready-made test corpus for the checker itself.

### judge — the pairwise rubric inputs

```json
"judge": {
  "dimensions": ["faithfulness", "completeness", "memory_write_quality"],
  "source_facts": ["ground truth statements the fixtures establish"],
  "traps": ["what a weak model is expected to get wrong here"],
  "guidance": "task-specific instruction appended to the shared rubric"
}
```

`source_facts` and `traps` are the fixture's ground truth written out so the
judge does not have to re-derive it (and so a human reviewer can check the
fixture against its own claims). They are shown to the judge; the contestants
never see them.

## Authoring rules used here

- **Every task is a real incident or a real rail.** Tag hygiene is the
  Bear Mountain / "Me at the zoo" bridging bug. Update-in-place is the
  "writing without item_id creates a second topic, which is a failure" line in
  the ingestion prompt. `already_ingested` honesty is the delete-faking class
  of failure. Delta-only prepend is the `tech-news-digest` automation's
  instruction. Regressions become tasks; that is how these suites grow.
- **Fixtures contain the ground truth, priors do not.** Where a fixture states
  a fact, that fact is authoritative even if it disagrees with what a model
  thinks it knows — that is the point of a frozen mini-web. Several fixtures
  deliberately plant a stale or wrong source next to the authoritative one.
- **Contract before judge.** Anything a regex or a file check can decide is a
  contract check; the judge is for prose quality only.
- **No destructive tool is reachable.** See `exclude_tools` /
  `replay_only_tools` above.

## Known gaps (deliberate, not oversights)

- **Pull discipline is untestable here.** `pull_model` is banned from eval
  toolsets, so "never pull without asking" cannot be graded as a
  `must_not_call` — with the tool absent the model cannot demonstrate the
  choice. The model-manager suite grades the adjacent behavior it *can*
  (recommend-with-reasons, supersession, inventory honesty) and leaves pull
  discipline to the live consent rails.
- **`news-summarizer` has no research task yet.** Its row was granted
  `read_memory_item`, `web_search` and `fetch_url` on 2026-07-24 (it had only
  the two memory tools before, which made whole-document dedup impossible).
  Its six tasks still deliver the raw articles in the prompt and mark the two
  web tools replay-only, so nothing here exercises research. A research-mode
  task with a real mini-web is the natural seventh, once phase 3 records
  fixtures. Note also that the digest work running in production is the
  `tech-news-digest` automation running as **`ingestion`** — see that suite's
  `notes`.
- **That grant lives only in the live DB.** `news-summarizer` is
  operator-created (`is_system=false`) and has never been defined in a
  migration, so neither the agent nor its toolset is reproducible from the
  repo. `validate.py`'s `GRANTED` map is a hand-maintained mirror; if the row
  changes, update it.
- **Digest topics carry generic tags on purpose.** `ai-news`, `tech-news`, and
  `digest` are all in `_GENERIC_TAGS`, and the production automation
  instruction asks for exactly those. The news-summarizer digest tasks
  therefore set `tags.no_generic: false`; a naive checker would flag correct
  behavior.
- **No `main`/orchestrator, guardian, memory-curator, or replay-only suites
  yet** — phase 4 of the plan.
