# Slice 14 — carries

Open items from S14 (distillation). Each is a fact about what is NOT built,
so a later slice starts from the truth rather than from a re-discovery.

## OPTIONAL / RESEARCH: a page to view her memory

Deferred by Jeremy, 2026-09-11, after the design below was agreed and
before any of it was built. Recorded whole so it can be picked up cold.

**Why it came up.** He asked "Is there a way to view her memory? I don't
see those distilled notes." The answer is no. Core exposes no route to the
memory volume and the web app has no page; the Files page reads the
WORKSPACE volume, which is a different thing. The only way to read a note
today is to ask her, or to go into the container by hand. For a feature
whose whole point is what she remembers about him, that is the wrong
answer.

**Decisions he made before it was deferred:**

1. **Read-only.** No delete, no edit. It matches the Files page, which is
   explicitly an operator's read-only window, and it finds out what he
   wants to act on before the acting is built.
2. **Notes first, journals behind a toggle.** The distilled facts are what
   she answers from and what he could not see; the journals are the bulk by
   size and would bury them.
3. **His memory, with a switcher for the agents'.** Agents keep their own
   partitions (S12). Cheap now, awkward to retrofit.

**The design as agreed.** Three pieces, and the first one is the reason
this is not a pure frontend task:

- **The memory service grows a small read API.** It has no way to list
  anything: `/export` hands back a tar.gz of one person's whole partition
  and that is the entire read surface. So it gains `GET /notes`
  (`person_id`, optional kind — path, title, kind, created, said_at,
  subject, source, live_source, superseded_by, size; NO bodies, because a
  list must not ship twelve journals of text) and `GET /note`
  (`person_id`, `path` — one file's meta and body, path-checked through
  the existing `_resolve_within` / `PathEscape`). Everything needed is
  already there in `store.iter_all()` and `store.read()`.

  IT BELONGS IN MEMORY, not in core, because memory owns that file format.
  Core already has one narrow reader of it — `distil._notes_state`, which
  unpacks the export to read two frontmatter keys — and that function's own
  docstring says "the honest fix, when memory may be edited, is a subjects
  endpoint there". Building this retires that hack rather than growing a
  second reader that can disagree with the first.

- **Core gets `app/memory_api.py`**: two passthroughs under
  `/api/v1/memory/`, behind the existing session gate, plus a route listing
  who has a partition — the owner and the agents — DERIVED from `identity`
  and the `agents` table so there is no roster to maintain.

- **The web app gets `/memory`** (`pages/memory/MemoryPage.tsx`), modelled
  on `FilesPage`: same DI `api` seam, same PageHeader / EmptyState /
  Skeleton, a sidebar entry beside Files. Notes by default — title,
  subject, when it was SAID, whether a live check is attached, superseded
  ones greyed with a link to what replaced them — a client-side filter box,
  a toggle for journals, and a click-through to the full note with its
  citation and role.

**Testing**: memory route tests (scoping, path escape, superseded visible
but marked); core passthrough tests including an unknown person refused; a
MemoryPage test against a fake api. The sidebar and MobileNav parity pins
move.

**Explicitly not in it**: delete, edit, semantic search (recall already
does that through her), pagination — 45 notes filter fine client-side.

## The excerpt loses the answer on a hit found by meaning

Measured, 2026-09-10, and worth two of the twenty recall questions.

`index._snippet` centres the excerpt on the best-matching run of QUERY
TERMS. A unit retrieved by the semantic half often shares no term with the
question at all — that is what semantic retrieval is for — and then `hits`
is empty and the excerpt falls back to the first `SNIPPET_RADIUS * 2`
characters of the unit. For a journal exchange that head is the user's
question, not the reply that answers it.

So Q02 and Q07 return a target document at RANK 1 with the answer outside
the snippet. It is recall's defect rather than distillation's, and it is
the largest concrete loss known in that path.

What was tried and is NOT in the code: preferring a distilled note over a
transcript chunk in `_fuse`. On one sample it bought those two and cost one
on the lexical number — inside the generator's noise (below) — for a magic
constant in a slice this one does not own.

An honest fix needs a semantic anchor: split the unit into windows and pick
the one nearest the query vector. That costs an embed call per long hit on
the recall path, so it needs measuring before it ships.

## The recall fixture is one sample of a noisy generator

`services/core/tests/recall_distilled.py` writes the distilled notes by
running the real distiller over the fixture transcript. The model samples,
so every regeneration gives a different corpus. Three runs from IDENTICAL
code scored 7/7/10 lexical and 12/12/14 hybrid — a three-point spread on
twenty questions.

Consequences already handled: the committed fixture is the MEDIAN by hybrid
score (the rule was fixed before the samples were read, because
regenerating until the number looks good is the obvious way to lie with
that file), the floors sit at the low end of the spread, and
`test_recall_quality.py` says a move smaller than the spread is the
generator and not your patch.

What is NOT handled: the suite still cannot RESOLVE an effect of one or two
questions. Twenty questions is too few. Fixing it means more questions, or
averaging across several committed samples (which multiplies the suite's
runtime), and it should be done before any later slice claims a recall win
— because this one did, twice, on single favourable draws, and both claims
had to be retracted.

## Deleting a live note leaves its predecessor dangling

`/forget` on a note that superseded an earlier one removes the live note
and leaves the older one marked `superseded_by:` a path that no longer
exists. Nothing reads that field on the recall path today, so it costs
nothing yet; a page that renders "replaced by …" would show a dead link.

## `memory_search` does not show a note's age or its live check

Her own search tool prints each hit's kind but not its `created` age, nor
whether it carries a `live_source`. Both are on the hit. `chat._snippets`
composes exactly those labels for the recall path, and reusing it needs the
shared module an import cycle currently prevents — `app.tools.memory_tools`
cannot import `app.chat`.
