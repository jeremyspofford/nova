# Slice 18 — Scripted skills: the model leaves the middle of the loop

Branch `slice/s18` in `.worktrees/s18`, cut from `rebuild/v4` at f89e2e34.
Carried out of S17, where it was deferred on purpose: the ledger built there
is what says which procedures fire often enough to be worth scripting.

## The gap

An S17 skill is procedure TEXT. She reads it and then makes every call
herself, which costs one model round per step, each carrying the whole
context, and leaves the order of the steps to a model that has just been told
the order. Jeremy's question when the slice closed: if a skill has repeatable
steps that can be scripted, should she not write a script?

Yes, and the objection that shaped this slice is the TRACE. Every honesty
control in v4 reads `turn_spans` — the narration guard, the capability
verifier, the presented-listing check, the S17 ledger — and a shell script
that moves files produces ONE span holding stdout, with the per-step record
gone. So a scripted skill here is not a shell script. It is a list of steps
that the runner dispatches through the SAME tool registry her own calls go
through, each step filing its own span.

## Decisions with Jeremy (2026-09-11)

All three taken as recommended, after the trade-offs were put to him.

- **One `run_skill(name, inputs)` tool**, not a tool per script. The registry
  stays static (so `test_tools_registry`'s pin keeps meaning what it says),
  her prompt gains one entry however many scripts exist, and the advertised
  tool list does not become per-turn derived state that prompt caching would
  have to track.
- **Sequence plus repeat-over-an-input.** Steps run in order; a step may
  repeat over a list she supplied as an input. No branching on what a step
  returned: `tools.dispatch` answers with PROSE (`tuple[str, bool]`), and a
  condition over prose is the guesswork this slice exists to remove. The run
  stops at the first failed step.
- **The page writes the script, from a derived draft.** The derivation is
  code over the spans of the skill's own source turns. Asking her to author
  it would put a model's judgement exactly where correctness lives.

## What gets built

### 1. The columns (migration 026)

`skills` gains two nullable columns:

- `script jsonb` — the step program. NULL means a prose-only S17 skill, and
  everything about it behaves exactly as it does today.
- `inputs jsonb` — a JSON Schema object describing what `run_skill` must be
  given. NULL only when `script` is NULL; a script with no inputs carries an
  empty-properties schema, because "takes nothing" and "nobody said" are
  different facts.

A CHECK pairs them: both NULL or both set.

### 2. `app/skill_scripts.py` — the program, its validator, its runner

Its own module rather than more of `app/skills.py` (already ~700 lines), with
one job: what a script IS, what makes one valid, and what running one does.

**The shape.**

```json
{
  "version": 1,
  "steps": [
    {"tool": "workspace_read_file", "args": {"path": "{{ path }}"},
     "for_each": "paths", "as": "path"},
    {"tool": "workspace_delete",    "args": {"path": "{{ path }}"},
     "for_each": "paths", "as": "path"}
  ]
}
```

**Templating, deliberately small.** A string that is exactly `{{ name }}`
becomes the VALUE of that name with its type intact (a number stays a number,
an array stays an array). A `{{ name }}` inside a longer string substitutes
its text. Nothing else: no expressions, no filters, no indexing. A name
resolves from the run's inputs, or from the enclosing step's loop variable.

**Validated when it is SAVED, and again when it RUNS.** Saved, because a
script that names a tool that does not exist should be refused where someone
is looking at it; again at run, because the registry is live and a tool can
leave. The checks, each refusing in words:

- every step names a tool in `tools.REGISTRY`;
- no step names `run_skill` (a script that runs a script is a loop nobody
  bounded);
- every `{{ name }}` resolves to a declared input or the step's own loop
  variable;
- `for_each` names a declared input whose schema type is `array`, and `as`
  is a name that does not collide with an input;
- the step's argument KEYS are checked against that tool's own JSON schema —
  an unknown property or a missing required one is refused at save. The
  VALUES cannot be checked until they exist, so they are checked at run by
  the same `tools.schema.validate` every call goes through.

**Running.** `run(script, inputs, ctx, step)`:

1. validate the inputs against the skill's schema — her arguments, checked
   mechanically, the same way every tool's arguments are;
2. expand each step (a `for_each` step becomes one dispatch per item);
3. refuse before running anything if the expansion exceeds `MAX_STEPS` (50),
   naming the number — a bounded runaway, never a slow one;
4. dispatch each in order through the `step` seam (below), stopping at the
   first `ok=False`;
5. answer with what RAN: each step, its tool, its loop item if any, ok or the
   tool's own error, and — when it stopped early — which step and how many
   were never attempted.

### 3. The seam: a nested call that is still a span

`tools.dispatch` does not write spans; `chat._run_tool` writes the span
around it. An executor therefore cannot file one, and a script whose steps
left no spans would be exactly the hole this slice refuses to dig.

So `ToolContext` gains `step`, the same shape as the `progress` callback it
already carries: a callable the turn binds per call, which opens a span, runs
`tools.dispatch`, records `ok` and the result head on it, and returns
`(text, ok)`. Span-writing stays in the turn loop where it lives today.

Each step's span is `kind="tool"`, `name=<the real tool's name>` — so every
existing reader keeps working without being told scripts exist — plus
`meta["via_skill"] = <skill name>` and `meta["step"] = <index>`. The S17
ledger counts a failed step as a failed call by that fact alone; the
narration guard backs a claim with a step's span exactly as with a direct
call; Activity shows the steps rather than one opaque entry.

A context with no `step` bound (an eval replay outside a turn, a test) runs
the steps through `tools.dispatch` directly, unspanned, and `run_skill` says
so in its result rather than pretending the trace has them.

### 4. `run_skill`, in `app/tools/skills.py` beside `load_skill`

Arguments: `name`, and `inputs` (an object, defaulting to `{}`). It refuses,
in the store's own words, when the skill does not exist, is not ACTIVE, or
has no script — the last one naming `load_skill` as what to call instead, so
a model that reached for the wrong verb is told the right one.

`reads_only` is FALSE: a script can write and delete. It joins
`NOT_AUTO_RUN` in `live_facts` for the same reason `load_skill` did, and more
so.

### 5. The derivation

`POST /api/v1/skills/{name}/script/draft` composes a candidate from the
skill's source turns and returns it WITHOUT saving — the owner edits and
saves deliberately.

It reads each source turn's tool spans with their recorded `args_redacted`,
collapses each walk to its shape the way `skills.shape` already does, and
then, per step position:

- an argument whose value was the same in every walk becomes a constant;
- an argument whose value differed becomes an input named after the argument
  (`path`, then `path_2` on a collision), typed from the values seen;
- a collapsed RUN of one tool becomes a `for_each` step over a new array
  input, because that is what a run is: the same call over a list.

With only one walk it cannot tell a constant from a variable, and the draft
says so in a `note` the page shows. Nothing here asks a model anything.

### 6. The page

The skill detail panel gains a Script section: the script and the inputs
schema as two JSON textareas, a "Derive from the trace" button that fills
them from the endpoint, and Save. Refusals are the server's sentences, shown
verbatim. A skill with a script shows a badge in the list so "which of these
run themselves" is answerable at a glance.

## What refuses when the model is wrong

- Her `inputs` are validated against the skill's schema before any step runs.
- Every step is dispatched through the one registry funnel, so a step's
  arguments are schema-checked and the executor's own refusals stand.
- Every step files a span, so a claim about what a script did is backed by
  the same evidence a direct call leaves — and a script cannot be a place
  where work happens unobserved.
- The first failed step stops the run, and the result says which step and
  what the tool said. A partial run is never reported as a completed one.
- The expansion is capped before anything runs.
- A script naming `run_skill` is refused at save and at run.

## Out of scope, on purpose

- **Branching on a step's result.** Needs structured tool results, which is
  its own change to every executor.
- **A script she wrote.** The owner authors; revisit when there is a reason.
- **Scripts that call an agent.** `delegate_to_agent` is a tool like any
  other and is not special-cased, but nothing here has been walked with one.

## Definition of done (walked)

1. Derive a script for a skill from its own trace, edit it, save it.
2. Ask her to do the thing. ONE `run_skill` call, N tool spans under it in
   Activity, and a reply that reports what ran.
3. Point a step at something that does not exist. The run stops there, the
   reply says which step failed and why, and claims nothing it did not do.
4. The S17 ledger records the use, with the failed step counted.

---

## Verification (walked 2026-09-12 on the deployed stack)

Core and web rebuilt from `.worktrees/s18`; migration 026 applied at startup.
The skill walked is S17's own `note-what-is-in-the-workspace`, whose script was
DERIVED from the two turns that made it.

**The derivation, on real spans.** "Derive from the trace" read the two walks
and proposed: `workspace_list_files` with no arguments (identical both times),
`workspace_write_file` with `{{ path }}` and `{{ content }}` (both differed),
and `workspace_read_file` with `{{ path }}` — the same input, because the read
passed the value the write had already used.

**One call, three spans.** Asked to run it, turn `0f6ee816`:

| Span | ok | via_skill | args |
|---|---|---|---|
| `run_skill` | yes | — | name + the inputs she filled |
| `workspace_list_files` | yes | step 1 | {} |
| `workspace_write_file` | yes | step 2 | walk-notes-6.md, "a scripted run" |
| `workspace_read_file` | yes | step 3 | walk-notes-6.md |

Three model rounds for four calls, and the file is on the volume with the
content she reported.

**The failure path.** Asked to run it with `../escaped.md`, turn `876edc87`:
step 1 ran, step 2 was refused by the workspace's containment gate, step 3 was
never attempted and left no span. `run_skill` came back ok=False carrying the
whole account, and she reported the refusal and offered the corrected path
rather than claiming a write.

### The defect the walk found

**The ledger never saw a scripted run.** Two runs had happened and the skill's
use count still read 2, from yesterday: `record_uses` counted `load_skill`
spans, and a script is `run_skill`. The ledger is the thing that flags a
procedure that stops helping, so scripts would have been the one kind of skill
it could never flag. A `run_skill` span now counts as a use whether or not the
run finished — unlike a refused LOAD, which handed her no procedure, a run that
stopped at step two used the procedure and it went badly, which is precisely
what the ledger is for — and the wrapper's own failure is kept out of
`failed_calls`, because it is a summary of the step's and the step is already
counted.

### What the walk could not measure, and why

The inference stack was in a bad way throughout: the GPU sat at 97-100% with
6.6 GB held by a process outside this stack even after ollama was restarted
with nothing loaded, the 27B timed out twice at the gateway's 300 s read limit,
and the gateway walled the model after two strikes. The walk was completed on
`qwen3:8b` and the setting put back afterwards. So this slice has NOT been
measured for the thing that motivated it — whether a scripted run is faster
than the same work call by call — and the eval corpus case measures the shape
(that she runs it) rather than the saving. The trial (S17) is where that
measurement belongs, and it needs a stack that is not contending with something
else for the card.

One thing the outage did show: after the failed turns she answered a later
question from her own poisoned history, reporting the stack as broken while the
model was answering her. Told the outage had passed, she ran the skill on the
next turn. Same shape as [[consent-loop-context-poisoning]].
