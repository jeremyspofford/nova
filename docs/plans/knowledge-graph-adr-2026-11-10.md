# The knowledge graph (ADR, F-057 ≡ A-060, 2026-11-10)

**Sources:** the owner's graph record, `docs/plans/owner-graph-engineering-addendum-2026-11-03.md`
(a queued requirements record, "not an ADR", `:3`; "ADR FIRST: a docs-only PR, with the second-model
review pattern, before any code", `:5`; the three settled decisions, `:9-13`; G1 storage and retrieval,
`:17-19`; G4 invalidate, tombstone, purge, and its canary, `:33-35`; out of scope, `:49-56`; nothing
authorised ahead of its gates, `:58`). The consolidation board of the two audits
(`docs/builder-packet/consolidation-2026-11-10/BOARD.md`: §3, "no graph layer A-060≡F-057" among the
highest-confidence findings; §4 "Later": knowledge slice 1 inside Memory, F-062 with Astra's "explain
one memory", behind this record; §5 D4, ruled: local-only is absolute) and its merge map, theme 14.
Fable's audit: `KNOWLEDGE-EXPERIENCE.md` (§2 today, §4 things and links, §5 provenance, §7 privacy and
forgetting, §12 slices, §13.1 decisions, §13.2 "what the decision record must settle"), `REPORT.md` §6,
and `BACKLOG.md` F-057, F-058, F-062. Astra's audit (branch `audit/astra-2026-11-09`):
`audit-astra/KNOWLEDGE-PLAN.md` (the reference model, privacy and deletion, slice 1 "Explain one
memory") and its graph-baseline entry, A-060. The capture-screening consumers plan,
`docs/plans/capture-screening-consumers.md`. Format follows `docs/plans/provider-plurality-adr-2026-11-09.md`
and `docs/plans/mcp-host-adr-2026-11-09.md`. The board, the merge map, the owner's rulings on it
(`consolidation-decisions-2026-11-10.md`) and both audit packages are in the owner's builder packet and
the audit worktrees, not in this repository; they are cited by section, not by line.

**Status:** Accepted 2026-11-10 (owner). Docs only: nothing in Nova changes in this step. The owner's
answers to every open question are recorded under "Owner ruling" at the end. The second-model review
the owner's record requires (`:5`) is a fresh Gemini chat over the whole record, run by the owner
(question 10).

**Gate before slice 1b:** slice 1b (the projection module and its route) waits until the fresh-Gemini
review's findings have come back and each is answered in this record or in a short amendment to it. PR 1
(the graph-table guard) and slice 1a may proceed now.

Every claim about today's code was read at `4be7973b2` (main after PR
#474) and carries a `file:line`. The audits read `d948aa0a`; where Batch 2 has changed the code since,
this record says so.

**Hard limits kept:** no model is called, no account, key or plugin is touched, and no table is added
by this step or by slice 1. The privacy gate (`src/core/models/index.ts:696`, the order is local only
under local-only), the receipt's refusal (`src/core/receipts.ts:111`), and the owner's three settled
graph decisions (no server graph database; the graph lives in Nova's existing SQLite; any second
engine is a throwaway read-only side copy) are not reopened.

## What exists today

**There is no graph layer.** Both audits found it independently, and it still holds at `4be7973b2`:
the 28 migrations (`src/core/migrations/0001_core.sql` to `0028_task_failed_amber.sql`) create no node,
edge, entity or relationship table, and no full-text or vector index. Memory search scores shared words
over active rows (`src/core/memory.ts:307`). What does exist is a set of recorded pointers, which are
the raw material for everything below.

| Piece | Where | What it records now |
|---|---|---|
| Memory rows | `0003_memory.sql:6-20`; `memory.ts:116-161` | Words, free-text `source`, `observed_at`, `recorded_by`, `confidence`, `supersedes`/`superseded_by`, `user_state`. A correction is a new row with a new random id (`memory.ts:136-152`) |
| A memory's history | `memory.ts:282-289` | Walks `supersedes` back to the first row and forward to the newest. No route exposes it (`src/core/index.ts:1366-1382`) |
| Memory events | `0003_memory.sql:24-30`; `memory.ts:390` | Content-free: when, what kind, which id, by whom. A forgotten id is never imported again (`memory.ts:128`) |
| Made from captured items | `0009_capture.sql:66-81` | `capture_promotion`: the one real link table. Memory id, event id, when and on which device and source it was captured. It outlives the captured item when retention sweeps it |
| Where a memory came from in capture | `src/core/capture/routes.ts:52` | `GET /capture/memory/{id}` already returns the promotions, by whom and when, and whether each item is still kept |
| Capture provenance in words | `capture.ts:1127` | A promoted memory's `source` is `capture:<ids>`; the runner reads that prefix to find capture-derived memory (`src/runner.js:1108-1114`) |
| Came from a conversation | `ui/js/view.js:485-497` | A text convention in `source`: conversation id, a slash, a turn. When no title matches, the row says "from a conversation" (`:497`), which is false for capture and device memory (F-038 ≡ A-086, still open) |
| Send records | `src/core/receipts.ts`; `0003_memory.sql:34-47` | References and hashes, never content. A chat lists the whole Memory file as one "standing" item, never one memory |
| Forget a memory | `memory.ts:177-193` | Deletes the whole chain in one transaction, writes a "forgotten" event per id, truncates the write-ahead log, then cleans backups (`:188`, wired at `:411` to `backups.forget`), exports (`:189`), capture (`src/core/index.ts:739` → `capture.ts:769-780`, which deletes the promotion rows and tombstones the captured items) and the sync log (`index.ts:610`) |
| Forget a day note (Batch 2, new since the audits) | `memory.ts:236-257`; `src/core/forgotten-notes.ts:1-12` | A day note has no row. Its forget leaves a content-free event, `note:<id>:<mac>`, the mac an HMAC of the words under the hub's note key, never the words or a plain hash. Its words go from every backup, encrypted copy, checkpoint, staged restore and the sync log |
| Copies of the database | `src/core/db.ts:130` (upgrade backup); `src/core/resilience/backup.ts:96-138` (nightly, with `SKIP_FILE`); `archive.ts:1-7` (the encrypted copy); `checkpoints.ts:192-253` (a snapshot of `nova.db`) | Whole database files. Every forget cleans each one table by table by id (`src/core/backups.ts:50-75`, `cleanDbFile` at `:87-132`; nightly via `resilience/index.ts:75`; checkpoints at `checkpoints.ts:390-395`). A table the cleaner is not told about is not cleaned |
| Restore | `src/core/resilience/restore.ts:127-199`; `restore-backup.ts:180-203` | Re-applies every forget made since: memories by their "forgotten" events, capture by its tombstones, day notes by id or keyed hash. The drill (`drill.ts`) checks the same |
| Copy between machines | `src/core/mesh/sync.ts:17-40` | A fixed list of replicated tables. `memory`, `memory_event`, `capture_promotion` and `receipt` are on it. Anything not on it stays on its own node |
| Use-time screening of capture-derived memory (A-005, new since the audits) | `src/runner.js:1116-1140`; `src/context.js:122-135` | Before a model call, each memory made from capture is screened as outside content. A block keeps it out of the prompt; anything else goes in as the screen's extract, in its own marked block |
| The bundled SQLite | probed for this record on Node 26.3.1, the version `package.json` requires (`engines`, `>=26`) | SQLite 3.53.1. FTS5, R-tree, JSON functions and a recursive query work. Loading an extension is refused ("extension loading is not allowed"), so sqlite-vec cannot be loaded |

### What is missing

1. **No address that lasts.** A memory's id changes on every correction and on Undo (F-058). Anything
   keyed by a row id breaks on the next correction.
2. **No way to see provenance.** The pointers exist but no screen joins them. The one line that tries
   is false in a common case (F-038).
3. **No rule for derived data.** Nothing says where derived rows may live, which copy paths must
   exclude them, or how a forget reaches them. Today there are none, so the gap is latent. The first
   stored graph row would open it.
4. **One line of the owner's record does not match the code.** "FTS5 plus sqlite-vec remains the
   default retrieval path" (`addendum:19`): there is no vector index and the extension cannot be loaded.

## Decision

1. **The graph is a derived projection over records Nova already keeps. It is never a store of truth.**
   A node points at one authoritative record. An edge points at the recorded pointer that proves it.
   Neither holds words. Delete the graph and rebuild it, and nothing is lost.
2. **Version 1 derives edges by deterministic rules from recorded pointers only.** No inferred edge, no
   model, no text matching. A text match is a search result, never an edge.
3. **It is built in two stages.** Stage 1, which serves slice 1, computes the projection when a screen
   asks for it, from the authoritative tables, and stores nothing. Stage 2 stores it in `graph_node`
   and `graph_edge` tables inside `nova.db`, and is gated (see "Where it lives").
4. **Every forget removes derived rows in the same transaction as the record, and no copy of the
   database ever carries derived rows.** Restore never trusts them: it drops and rebuilds them from
   live authoritative rows after forgets are re-applied.
5. **Every edge cites exactly one source pointer, a method and a basis.** "Explain one memory" is a
   walk of those edges, each step openable to the record that proves it.
6. **Slice 1 is one change inside the Memory view:** Fable's filter and true source line (F-062) and
   Astra's "explain one memory", as a list. No new page, no new place, no diagram, no stored table.
7. **Any later model step is local in every privacy mode,** reads only screened input, and writes only
   edges marked as guesses. None is authorised by this record.

## 1. What the graph is

**Options.**

| Option | For | Against |
|---|---|---|
| A. A derived projection over memory, capture, tasks and send records (chosen) | One source of truth per thing. Rebuildable. A forget has one place to happen, and the projection follows it. Matches the owner's "the graph never duplicates content" (`addendum:17`) and "replacing the ledger with the graph" being out of scope (`:55`) | Edges are only as rich as the pointers Nova records. Many questions stay unanswerable until producers record more (G2) |
| B. A separate store of entities and relations, written by its own producers | Can hold people, topics and links nobody recorded elsewhere | A second truth that drifts. Every forget needs a second, independent purge. People and topics need extraction, which is out of scope (`addendum:51`; F-060). Rejected |
| C. A mix: a projection plus person-written edges | Lets a person tie two things together | A person's edge is authoritative data, so it needs its own table that forgetting, backups and sync all reach. No ranked question needs it yet (Fable §12). Deferred, not rejected: open question 6 |

**Things (nodes) in version 1.** Closed list. A node's key is `<kind>:<authoritative id>`.

| Kind | Points at | Key | Notes |
|---|---|---|---|
| `memory` | the newest row of a chain | `memory:<thread id>` once F-058 ships; until then stage 1 uses the row id and never persists it | The page-level thing |
| `memory_version` | one `memory` row | `memory_version:<row id>` | Changes on correction; that is its meaning |
| `capture_item` | `capture_event` | `capture_item:<event id>` | May be swept; the promotion row still says when and where (`0009_capture.sql:66-67`) |
| `capture_source` | `capture_source` | `capture_source:<id>` | |
| `device` | `device` | `device:<id>` | Never merged by display name |
| `turn` | a conversation file line | `turn:<conversation id>/<turn>` | From the text convention in `source`; weakest pointer |
| `task` | `task` | `task:<id>` | Stage 2 only |
| `send_record` | `receipt` | `send_record:<id>` | Stage 2 only. Never linked to a single memory: the record does not name one |

**Not nodes in version 1:** day notes (an entry without a marker has an id made from a hash of its
words, `forgotten-notes.ts:35`, so keying a node by it would store an unkeyed hash of forgotten words);
people, organisations, places and topics (Nova holds none, F-060); held items (`memory_candidate` is
per-machine and deleted on decision, `0027_memory_gate.sql:11`); skills, schedules and files (no stable
identity yet, F-059).

## 2. Where it lives

**Stage 1 (slice 1): nowhere.** A read-time projection in one module, `src/core/graph/`, that reads the
authoritative tables through the same queries the existing routes use, and returns one DTO: nodes,
edges, and a coverage note. No migration, no table, no cache that outlives the request. A forget is
correct by construction, because the projection only ever reads rows a forget already deletes. Astra's
plan allows exactly this for its slice 1 ("a query-time projection over existing relationships",
`KNOWLEDGE-PLAN.md`, slice 1, Data), provided it uses the agreed DTO and identity contract, which this
record sets.

**Stage 2: tables in `nova.db`.** Starts only when all three hold: F-058 has given memories a thread id;
a measurement on the three test homes shows the read-time projection misses its budget (p95 under
200 ms for one memory's one-hop neighbourhood is the proposed budget, a hypothesis until measured); and
the owner has accepted this record.

**Options for stage 2.**

| Option | For | Against |
|---|---|---|
| A. Tables in `nova.db` (chosen) | The owner settled it (`addendum:10`). A forget deletes the record and its derived rows in **one transaction**. One file to back up, vacuum and secure-delete | Every whole-file copy (upgrade backup, nightly, encrypted copy, checkpoint) would carry the tables unless each copy path strips them. That is a real obligation, met below with one test per path |
| B. A separate `graph.db` beside it | Out of every backup by leaving it off the copy lists | SQLite does not make a transaction across attached databases atomic in WAL mode, and Nova runs WAL (`src/core/db.ts:50`). A crash between the two commits leaves a derived row for a forgotten record. Checkpoints copy the home, so it needs its own exclusion anyway. Rejected |
| C. A read-only side engine | Fast analytics | Settled as throwaway only (`addendum:11`); not needed at this size |

**Schema sketch (stage 2, not a migration).**

```sql
-- Derived, rebuildable, never replicated, never in a copy. Holds pointers only: no words, no hashes of words.
CREATE TABLE graph_node (
  id         TEXT PRIMARY KEY,               -- '<kind>:<authoritative id>'
  kind       TEXT NOT NULL CHECK (kind IN ('memory','memory_version','capture_item','capture_source','device','turn','task','send_record')),
  ref_table  TEXT,                           -- the authoritative row, or
  ref_id     TEXT,
  ref_path   TEXT,                           -- a file reference (a conversation turn)
  built_rev  INTEGER NOT NULL                -- the projection revision that wrote it
);
CREATE TABLE graph_edge (
  id           INTEGER PRIMARY KEY,
  src          TEXT NOT NULL REFERENCES graph_node(id) ON DELETE CASCADE,
  rel          TEXT NOT NULL,                -- closed list, below
  dst          TEXT NOT NULL REFERENCES graph_node(id) ON DELETE CASCADE,
  basis        TEXT NOT NULL CHECK (basis IN ('observed','stated','inferred')),
  method       TEXT NOT NULL,                -- 'link-row:capture_promotion', 'column:memory.supersedes', ...
  source_table TEXT NOT NULL,                -- exactly one pointer to the evidence (the owner's source_id)
  source_id    TEXT NOT NULL,
  confidence   REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  valid_at     TEXT, invalid_at TEXT,        -- world time; NULL is unknown, never "now"
  created_at   TEXT NOT NULL, expired_at TEXT, -- when Nova held it
  CHECK (basis <> 'inferred' OR confidence IS NOT NULL),
  UNIQUE (src, rel, dst, source_table, source_id)
);
CREATE INDEX graph_edge_src ON graph_edge (src, rel);
CREATE INDEX graph_edge_dst ON graph_edge (dst, rel);
CREATE INDEX graph_edge_source ON graph_edge (source_table, source_id);
CREATE INDEX graph_node_ref ON graph_node (ref_table, ref_id);
CREATE TABLE graph_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); -- projection version, built_at, built_on
```

Three departures from the owner's G1 text, each ruled yes by the owner (question 3) and made as an
amendment to G1 (see "Owner ruling"): the tables are named in the singular
like every other Nova table (`graph_node`, not `graph_nodes`; question 3); there is **no `deleted_at`
column**, because a forget deletes the row and a row that says "something was here" is itself a leak
(question 3); and the evidence pointer is two columns, `source_table` and `source_id`, so it can be
indexed and purged by table.

**Rebuild.** One function, `rebuild()`, empties the tables and re-derives them in one transaction from
live authoritative rows only. It runs: when `graph_meta.version` does not match the code; after every
restore, after the restore has re-applied forgets (`restore.ts:127-199`, `restore-backup.ts:182-203`);
after an import; after a standby applies a sync batch that deleted rows; and on request from
Diagnostics. Between those, the projection is kept current by the same writers that change the
authoritative rows, inside their transactions. The screen that shows graph data says when it was built
("Built on <hub> at <time>") whenever a rebuild is running.

**Never replicated.** The graph tables are never added to `REPLICATED` (`sync.ts:18`). Each machine builds
its own from the authoritative rows it receives. A test fails if a `graph_` table appears in that list
(the owner's "graph as sync transport" is out of scope, `addendum:54`).

**Traversal.** Application code, with a visited set, a cap on steps and a cap on neighbours per step
(`addendum:19`). A recursive query only for a lookup of at most three steps. Slice 1 walks one step out
from a memory, plus its version chain.

## 3. How it is derived

**Version 1 edges, closed list.** Each names the pointer that proves it. All are `basis = observed`
(or `stated` where a person wrote the row), `confidence = NULL`.

| Edge | From → to | Proved by (`source_table` / method) | Stage |
|---|---|---|---|
| `SUPERSEDES` | memory_version → memory_version | `memory.supersedes` (`0003_memory.sql:15-16`) / `column` | 1 |
| `DERIVED_FROM` | memory_version → capture_item | `capture_promotion` row (`0009_capture.sql:68-79`) / `link-row` | 1 |
| `CAPTURED_ON` | capture_item → device, capture_source | `capture_promotion.device_id`, `.source_id` / `column` | 1 |
| `CAME_FROM` | memory_version → turn | `memory.source` of the form `<conversation>/<turn>` / `text-convention` | 1 |
| `RECORDED_BY` | memory_version → device or the person | `memory.recorded_by` / `column` | 1 |
| `PROPOSED_AS` | capture_item → memory_version | `capture_proposal.memory_id` / `column` | 2 |
| `FOR_TASK` | send_record → task | `receipt` task column / `column` | 2 |

`capture_promotion` is the authority for "made from captured items". The `capture:<ids>` prefix in
`source` is a convenience copy of it, cut at 2,000 characters (`capture.ts:1127`); where the two disagree
the promotion rows win and the panel says the source line is incomplete.

**Deterministic rules first, models never in version 1.** A rule reads ids and columns. It never reads
a memory's or a captured item's words, so derivation itself sends nothing anywhere and needs no screen.

**The one existing inference stays out of the graph.** The rule that deletes day-note entries that "say
the same" as a forgotten memory (`src/memory.js:442-449`) is a forget-time guess. It is not an edge and
is not stored. Its future belongs to the forget work, not to this record.

**When a model step is ever proposed** (suggested links, people or topics, summaries), it needs an
amendment to this record, and it inherits these rules now so they cannot be skipped later:

- **Local in every privacy mode.** D4 makes local-only absolute, and the code now says so: "There is no
  exception" (`receipts.ts:3-6`). This record goes one step further for derivation: it asks for local-only on every call whatever
  the person's mode, through the one path that checks it (`models/index.ts:696`) and the receipt's
  refusal (`receipts.ts:111`). No local model means no derivation, said on screen, never queued for a
  cloud. Turning cloud use on later never sends the past (question 5).
- **Screened input.** Text that came from capture is outside content (A-005). A derivation step reads
  it only after the same screen the runner applies at use time (`runner.js:1116-1140`), and never reads
  an item the screen blocked or a captured item still in quarantine.
- **Output is a guess.** `basis = inferred`, a method naming the model step, a measured confidence or
  none at all. A guess is never shown as "Recorded", never promoted by repetition, and never counted in
  a forget's closure as authority.
- **The graph is never a side door into a prompt.** Anything graph-derived that enters a model call goes
  through the same context assembly, screening and send record as everything else.

## 4. Forgetting

Non-negotiable, after Batch 2: **every forget, of a memory, a day note or a captured item, removes the
derived nodes and edges that point at it, everywhere Nova keeps a copy, and a restore can never bring
them back.**

**Stage 1 meets this by storing nothing.** The projection reads `memory`, `capture_promotion`,
`capture_event` and `receipt` at request time. A forget already deletes the chain (`memory.ts:180-184`),
the promotion rows and captured items (`capture.ts:773-778`), and day-note words. The canary below
proves it rather than assuming it.

**Stage 2 obligations, each with its own test.**

1. **Same transaction.** `Memory.forget` deletes graph rows inside its existing transaction
   (`memory.ts:180-184`): every node whose `ref` is in the chain, and every edge whose `source_table`
   / `source_id` is any deleted row. `ON DELETE CASCADE` removes edges to a deleted node. The capture
   forget does the same inside its own transaction (`capture.ts:776-778`, `:792`), keyed by promotion,
   event and proposal ids.
2. **An edge goes when its evidence goes,** even if both ends remain.
3. **Orphans go.** After the purge, any edge with a missing end is deleted, and a check queries the
   graph tables for every forgotten id. A hit is a red problem that stops Nova.
4. **Day notes.** They are not nodes (section 1), so a note's forget has nothing to purge from the graph.
   If notes ever become nodes, the key is the note's marker id, never the hand id made from its words,
   and the note forget (`memory.ts:243-257`) purges them like a record.
5. **Standbys.** Sync deletes the replicated rows; `forgottenElsewhere` (`memory.ts:227-234`;
   `capture.ts:784-787`) then runs the same graph purge, and a rebuild follows the batch.
6. **No copy carries derived rows.** Each whole-file copy path empties the graph tables in the copy
   before it is closed: the upgrade backup (`db.ts:130`), the nightly backup and its encrypted copy
   (`backup.ts`, `archive.ts`), checkpoints (`checkpoints.ts:222`), and a staged restore. The cleaner
   (`backups.ts:87-132`) also deletes graph rows by `ref_id` and `source_id` for every forget, as a second
   line for any copy that predates a strip. One test per path fails if a `graph_` row is in the copy.
   Export writes records only (`memory.ts:332`) and stays that way.
7. **Restore rebuilds, never restores.** A restored database's graph tables are dropped and rebuilt
   after forgets made since are re-applied. A rebuild reads live rows only, so it cannot be the way a
   forgotten thing returns.
8. **No tombstone row in the graph.** The marks that a thing was forgotten already exist and are
   content-free: the "forgotten" event (`memory.ts:183`), the note's keyed-hash event
   (`forgotten-notes.ts:5-12`), `capture_tombstone`. The graph relies on them. This reads the owner's G4
   "tombstone propagates to all spokes before purge" (`addendum:33`) as met by those marks, with one
   limit stated: the hub deletes at once and the mark reaches a machine that is switched off when it
   next connects. Question 3.
9. **The owner's canary** (`addendum:35`), extended: plant a memory with a made-up phrase and a captured
   source, build the graph, forget it, then search every table, every graph table, every backup, the
   encrypted copy, every checkpoint and a staged restore for the phrase **and** the ids. Expected: no
   graph row anywhere. The phrase is found nowhere Batch 2 already cleans. Run it for a memory, a day
   note and a captured item.

## 5. Provenance

- **Every edge cites exactly one source pointer** (`source_table`, `source_id`), the method that read it
  and its basis. Never a copy of words. If the evidence is gone, the edge is gone.
- **Two words on screen:** "Recorded" for observed or stated, "Nova's guess" for inferred (Fable §5.2).
  Version 1 shows only the first. Colour never carries the difference.
- **Confidence is empty unless measured.** A memory's stored `confidence` is the caller's claim
  (`memory.ts:401`); the panel says "Nova was unsure when it wrote this" only below the mark the model is
  already told about, and shows no number.
- **"Explain one memory" shows the path.** From a memory, in this order, each step a line that opens its
  evidence where it lives:
  1. the version chain, newest first, with who wrote each and when (`SUPERSEDES`, `RECORDED_BY`);
  2. what it was made from: each captured item, when and on which device and source it was captured,
     and whether Nova still keeps it (`DERIVED_FROM`, `CAPTURED_ON`; the data `GET /capture/memory/{id}`
     already returns, `capture/routes.ts:52`);
  3. the conversation turn, when the source names one and the conversation still exists (`CAME_FROM`);
  4. when nothing recorded points anywhere: "Nova has no record of where this came from." Never a likely
     answer.
- **What it never claims:** that a single memory was or was not sent to a model. Send records name the
  whole Memory file (Fable §2.5). That line belongs to a later slice and to F-028.

## 6. Slice 1: inside Memory

Both audits converge on starting inside the Memory view (BOARD §4). Fable's F-062 is a one-day page
change: a filter and a true source line. Astra's slice 1 is "explain one memory": sources and history,
openable, 5 to 8 days, with a small diagram beside the list. They fit together: F-062 makes the list
findable and honest, and the explain panel answers the next question about one row. The reconciled slice
drops Astra's diagram (open question 7) and Fable's later per-memory page (F-063, which needs F-058), and
ships in three small test-first PRs.

**1a. Filter and true source line (F-062, as written).** A filter box over the loaded rows, with the
palette's match rule and a polite count ("14 of 37 shown."). Held items are never hidden or counted. The
false fallback at `ui/js/view.js:497` becomes "Nova cannot show where this came from yet."

**1b. The projection and one read route.** `src/core/graph/` (stage 1) and `GET /memory/{id}/sources`:
the DTO of section 2 for one memory, one step out plus its version chain. Same access as `GET /memory`
(`src/core/index.ts:1366`). Answers for any id in a chain. An unknown or forgotten id answers exactly
like one that never existed.

**1c. "Where this came from" on a memory row.** One disclosure on each row of the existing Memory view
opens the path of section 5 as a list. No new page, no new address, no new top-level place. Each
captured item and turn opens its canonical surface; the panel performs no action of its own. Edit and
Forget stay where they are.

**Acceptance criteria (slice 1 is done when all hold):**

- Fixtures cover: a memory written by hand; one from a matched conversation turn; one from captured
  items still kept; one whose captured items were swept; one corrected twice; one by a device; one with
  no recorded source. Each shows the path of section 5, and the last says "Nova has no record of where
  this came from."
- No row anywhere reads "from a conversation" unless a conversation was matched.
- Every line in the panel opens the record that proves it. A test asserts each line's link target.
- Forget a memory with its panel open: the row and panel leave at once, and the route answers for its
  old id as for an id that never existed. Then the canary of section 4, stage 1 form: no route, page or
  response carries the phrase or the ids.
- Forget a captured item a memory was made from: the panel no longer lists it, and says nothing about
  its having been there.
- No model call and no send record, asserted by a test. The same test runs under each privacy mode.
- No migration. A test fails if a migration in this slice creates a table.
- Typing in the filter makes no request, does not change the address and writes nothing to browser
  storage. The new route sits under `/api/memory`, which the offline cache never stores (`ui/sw.js:35`);
  a test asserts it.
- Keyboard only: box, then list, then each row's disclosure; Escape closes the panel and returns focus to
  its row. The panel is a list a screen reader reads in order. At 320 px and 200 percent zoom nothing
  scrolls sideways; new controls have a 44 by 44 px press area.
- A screen-reader pass is recorded with date and versions before slice 1 is called done; until then it
  is reported "not checked with a screen reader".
- With 2,000 fixture memories, the route answers one memory under 200 ms on the machine it was measured
  on, recorded with that machine. A record, not yet a gate.

**Effort.** 1a about a day (Fable's estimate). 1b and 1c together about 4 to 6 days, inside Astra's
range once its diagram and user trials are taken out. A hypothesis until built.

## 7. Out of scope

- Stored graph tables, until stage 2's three conditions hold.
- Any model in derivation, browsing or search. Suggested links, people, organisations, places and
  topics (F-060). Whole-corpus extraction and cluster summaries (`addendum:51-52`).
- Links a person writes by hand.
- Full-text search (FTS5 is available; adopt it on a measured need, as its own change) and vectors
  (not loadable today; question 4).
- A diagram, a map of everything, 2D or 3D views, the "Stellar Map" draft (PR #207, left untouched).
- A page per memory and a lasting address (F-063, after F-058). The conversation view of what was kept
  and sent (F-064), and "What was sent" (F-028).
- Day notes, skills, schedules and files as nodes.
- Prospective decision traces (G2), skill compilation (G3), distillation (G5), traces and replay (G6),
  and the compilation pilot. Each keeps its own gate in the owner's record.
- The graph as sync transport, or as an enforcer of approvals (`addendum:53-54`).
- Changing the day-note "say the same" rule in a forget.

## Migration: small test-first PRs

| # | PR | Test first |
|---|---|---|
| 0 | This record | ledger-files, check-changelog |
| 1 | A guard: a migration that creates a `graph_` table fails unless this record's status reads Accepted (F-057's acceptance criterion) | The guard fails on a stand-in migration |
| 2 | Slice 1a: filter and true source line (F-062) | The F-062 table-driven tests |
| 3 | Slice 1b: `src/core/graph/` projection and `GET /memory/{id}/sources` | Fixtures and the forget canary, stage 1 form |
| 4 | Slice 1c: the panel in the Memory view | View tests, keyboard, no-request, no-model |
| 5 | F-058, the thread id (its own decision note) | One test per writer |
| 6 | Stage 2, only after its three conditions: tables, same-transaction purge, copy strips, rebuild | One test per copy path; the full canary |

## Golden cases

1. A memory made from two captured items, one since swept: the panel lists both, the swept one as "no
   longer kept", with when and on which device.
2. A memory corrected twice: three versions newest first; the route answers for any of the three ids.
3. A memory with a `source` that matches no conversation and no promotion row: "Nova has no record of
   where this came from."
4. Forget that memory: the panel closes, the route answers as for an unknown id, no response holds the
   phrase or id.
5. Forget only a captured item it was made from: the panel loses that line and says nothing of it.
6. Local-only, local model off: slice 1 works in full and no send record is written.
7. A capture-derived memory whose screen blocked it at use time: the panel still shows its sources to the
   person, and nothing about the panel puts it into a prompt.
8. Stage 2: a backup, a checkpoint, the encrypted copy and a staged restore each contain no `graph_` row.
9. Stage 2: restore an old backup after a forget: the rebuilt graph has no node or edge for the
   forgotten record.
10. Stage 2: a standby that was off during a forget connects, applies the deletes, purges and rebuilds;
    its graph holds no row for the forgotten record.

## Security

- **Relationship leakage.** An edge is returned only when the viewer may read both ends and the
  evidence, checked on the hub per request through the same read path as the list. A hidden or
  forgotten neighbour leaves no placeholder, count, degree or hint.
- **No content in derived rows,** and no hash of content. Labels are resolved at read time from the
  authoritative row and escaped, as the Memory view escapes them today.
- **Access.** The new route declares its access explicitly, matching `GET /memory`. It must not rely on
  the route default that the audits found too broad (F-079); if F-079's flip lands first, the route
  follows it.
- **Outside content.** Captured text shown in the panel is shown to the person as data, escaped, never
  rendered as markup. The graph adds no path into a prompt.
- **No new egress.** Slice 1 sends nothing, and loads no font, library or worker from outside.

## Rejected alternatives

- **A separate graph store of entities and relations.** A second truth, a second forget. Section 1.
- **A separate `graph.db` file.** Loses the atomic forget under WAL. Section 2.
- **Building stage 2 tables first.** Nothing in slice 1 needs them, and they open every copy path to a
  new kind of leak before any screen uses them.
- **A diagram in slice 1.** One memory's sources are a short list; a picture adds no answer the list
  lacks, and costs the accessibility work twice.
- **A `deleted_at` tombstone in graph rows.** A leak that outlives the forget it records.

## Consequences

- Slice 1 can start as soon as this record is accepted, without F-058 and without a migration.
- Stage 2 has a written contract, so the first table cannot arrive without its forget, copy and restore
  obligations.
- Questions that need richer pointers (what a task used, what a run touched, why a decision was made)
  stay unanswerable until producers record them prospectively. Nothing will be back-filled by inference.
- The owner's G1 text carries the amendments ruled under questions 3 and 4.

## Owner ruling, 2026-11-10

"The record is accepted." Each answer below is the owner's wording, against the question it answers.

| # | Question | Owner's answer |
|---|---|---|
| 1 | Derived projection, recorded-pointer edges only | "Q1 yes." |
| 2 | Two stages, read-time first | "Q2 yes — read-time projection first; stage 2 only on its three conditions." |
| 3 | Amend G1 | "Q3 yes — amend G1 (singular names, no deleted_at, existing content-free forget marks are G4's tombstone, with the switched-off limit stated)." |
| 4 | The retrieval line | "Q4 yes — amend the retrieval line as proposed (FTS5 on measured need; vectors not planned while the bundled SQLite refuses extensions)." |
| 5 | Model derivation | "Q5 yes — any future model derivation is local in every privacy mode, and the past is never sent." |
| 6 | Hand-written links | "Q6 not in v1." |
| 7 | Slice 1 shape | "Q7 yes — slice 1 is a list inside Memory; the diagram stays behind the picture gate." |
| 8 | F-038 placement | "Q8 F-038 straight after slice 1a." F-038 is its own PR, next after slice 1a. |
| 9 | Where stage 2 lives | "Q9 nova.db." |
| 10 | Second-model review | "Q10: the second-model review is a FRESH Gemini chat, the whole record, with §4 (Forgetting) and the Security section called out — the owner will run it and bring back anything it raises." |
| 11 | People, organisations, topics | "Q11 yes." |
| 12 | PR #207 | "Q12 leave PR #207 untouched." |

"Merge the ADR once its own checks pass. Then: PR 1 (the graph-table guard) and slice 1a may proceed.
Slice 1b (the projection module and route) waits until the Gemini review has come back and any findings
it raises are answered in this record or a short amendment."

### The G1 amendments, as ruled

These replace the matching words of G1 in `docs/plans/owner-graph-engineering-addendum-2026-11-03.md`,
which carries a note pointing here. The rest of G1 stands.

- **Names (Q3).** The tables are `graph_node` and `graph_edge`, singular like every other Nova table.
- **No `deleted_at` (Q3).** Graph rows carry no tombstone column. A forget deletes the derived rows.
- **The tombstone (Q3).** G4's tombstone is the existing content-free forget marks: the "forgotten"
  memory event, the day note's keyed-hash "note-forgotten" event, and `capture_tombstone`. **Limit,
  stated:** the hub deletes at once, and a machine that is switched off learns of the forget when it
  next connects.
- **Retrieval (Q4).** The line "FTS5 plus sqlite-vec remains the default retrieval path" is replaced by:
  "Retrieval today is a shared-word scan. FTS5 is available in the bundled SQLite and is adopted on a
  measured need. Vectors are not planned while the bundled SQLite refuses extensions."

## Open questions for the owner (answered above)

Each has the answer this record recommended. **[Security]** marks a question that changes what can leak.

1. **The graph is a derived projection, never a store of truth, with version 1 edges from recorded
   pointers only?** *Recommended: yes.*
2. **Two stages, with slice 1 on a read-time projection and stored tables only after F-058 and a measured
   miss?** *Recommended: yes.* Fable asked whether read-only links computed on open count as "graph
   code" (its decision 3); accepting this record answers it.
3. **[Security] Amend G1: singular table names, no `deleted_at` column in graph rows, and the existing
   content-free forget marks read as G4's tombstone,** with the stated limit that a switched-off machine
   learns of a forget when it next connects? *Recommended: yes.*
4. **Amend G1's retrieval line.** sqlite-vec cannot be loaded (extension loading is refused in the
   bundled SQLite 3.53.1). *Recommended:* "Retrieval today is a shared-word scan. FTS5 is available and
   is adopted on a measured need. Vectors are not planned."
5. **[Security] Any future model step in derivation is local in every privacy mode, never cloud, and
   never processes the past when cloud use is later turned on?** *Recommended: yes.*
6. **Links a person writes by hand:** not in version 1? *Recommended: not in version 1.* Look again when
   people are seen wanting them, with an authoritative table that forgetting and backups reach.
7. **Slice 1 as a list only, inside the Memory view, with no diagram, page or new address?**
   *Recommended: yes.* Astra's small one-hop diagram goes behind the picture gate in Fable §10.2.
8. **Where F-038 (review state, "Not yet checked", device in the source line) sits.** *Recommended:*
   straight after slice 1a, as its own PR; both change the same rows.
9. **Stage 2 tables in `nova.db`, stripped from every copy, rather than a separate file?**
   *Recommended: `nova.db`,* as already settled, for the atomic forget.
10. **The second-model review the owner's record requires (`addendum:5`):** which model, and its scope?
    *Recommended: the whole record, with sections 4 and the Security section called out.*
11. **No people, organisations or topics in version 1 (F-060)?** *Recommended: yes.*
12. **PR #207:** keep open as a visual reference or close it. *Recommended:* leave it untouched as a
    reference; nothing in it is carried over by this record.
