# Slice 16 — Workspace delete

Branch `slice/s16` in `.worktrees/s16`, cut from `rebuild/v4`. Carried out of
`slice-15-chat-control.md`, where the owner's 2026-09-10/11 transcript review
found it and deliberately left it out of that slice's four.

## The gap

He typed "please delete @groceries.md". She could list the file and read it,
and could not remove it, and said so: *"there is no delete operation in my
toolbox"*. She was telling the truth. `tools/workspace.py` shipped three
tools — write, read, list — and nothing that takes a file away.

The cost is not one file. The workspace holds `groceries.md`, four
near-duplicate `kv_offloading*` files written during the 08-29 fabrication
arc, and an orphaned `agents/coder/` left behind by an agent deleted on
09-08. None of it can be cleared without going into the container by hand,
which is exactly the shape CLAUDE.md names: the gap IS the task, and doing it
myself would leave her as incapable and hide the gap behind a tidy folder.

## Decisions with Jeremy (2026-09-11)

- **One path per call, a file or a directory.** A directory that is not empty
  needs `recursive: true`. Deleting the four duplicates is four calls; the
  orphaned agent folder is one.
- **Recoverable.** What is deleted moves to a trash inside the same volume and
  is pruned after seven days. Delete is the only irreversible shape in her
  toolset, and a recursive directory delete is the one call in it that can
  cost real work. A week is long enough for the owner to notice.
- **A claimed deletion is checkable.** She has faked a deletion before
  (`delete-via-dispatch`, and the 08-29 `kv_offloading` arc that
  `narration_check` exists for). A delete tool without a delete claim in the
  honesty guard would be half the work.

## What shipped

**`workspace_delete`**, in `services/core/app/tools/workspace.py`. Arguments:
`path`, and `recursive`, which is required for a directory with anything in
it.

It refuses, each with the reason stated back to the model so it can correct
the call rather than guess:

| Refusal | Why |
|---|---|
| resolves outside the workspace | the module's existing one gate, unchanged |
| the workspace root itself | there is no call that should empty the volume |
| anything inside the trash | deleted files are already there and it empties itself |
| a symbolic link | checked on the UNRESOLVED path, see below |
| nothing at that path | never a quiet success on a no-op |
| a non-empty directory without `recursive` | states how many files it holds |

The symlink refusal is the one that was not in the design. `_resolve_within`
dereferences a link, so by the time the delete has a path it holds the
link's TARGET: acting on it would have moved the real file to the trash and
left the dangling link behind, silently, which is the opposite of what was
asked. A link pointing out of the workspace was already refused by
containment; this is the one pointing in, and it was found by a test written
for it rather than by the walk. Checking the raw path also means a broken
link is reported as a link instead of as a missing target.

**The trash.** `.trash/<utc-stamp>-<name>` under the workspace root, moved
there with one `os.replace` so a delete cannot half happen. A second delete of
the same filename in the same second takes a counter suffix — without it the
replace would overwrite the first with the second, losing the very file the
trash exists to keep, and clearing four near-duplicates in one breath is the
case that does it. Entries older than `TRASH_KEEP_DAYS` are pruned by the next
delete rather than by a job: a directory nobody deletes from does not need
sweeping, and a scheduled sweep is one more thing that can die quietly. The
pruned count reported is what actually went, never what was attempted.

**The window runs from the move, not from the file.** Found by a test written
after the tool was green, and it was a real defect: `os.replace` preserves
mtime, so a note written a month ago and deleted today carried a month-old
mtime into the trash and was swept by the very next delete. Zero grace, for
exactly the files most likely to be worth recovering. The entry's NAME is the
one record of when it entered, so the name is what the window is measured
from. A name this module did not write is never pruned — keeping an unknown
file forever is the harmless failure.

**Verified from both ends.** `os.replace` returning without raising is not
evidence. The result is reported only after the path is confirmed gone AND
the file is confirmed in the trash. Either half alone reporting success is
the failure shape this repo keeps finding, and a test monkeypatches
`os.replace` to a no-op to prove the tool fails instead of claiming.

**The trash is invisible to every reader.** `iter_contained_files` skips it.
That function is already the one path shared by her `workspace_list_files` and
the operator's Files page (`app/workspace_api.py`), so neither grows its own
rule and the two cannot drift.

**The honesty guard learns deletion.** `guards.py` gains a `deleted_file`
claim kind backed only by a successful `workspace_delete` span, active
("I deleted groceries.md") and passive ("groceries.md has been deleted"),
target-aware like every other kind — deleting `shopping.md` does not back a
claim about `groceries.md`. The precision rules are the existing ones and are
pinned by tests: an offer, a future form, a stated failure, an action
attributed to the owner, and a bare noun with no filename are all not claims.
`removed` is now both a file verb and a model verb; which one fires is decided
by the object, exactly as `read` is already split between a file and a URL — a
model reference carries a tag, a filename an extension.

**The capability guard learns the sentence that started this.** She told the
owner *"there is no delete operation in my toolbox"*. That was true; with the
tool registered it is a false denial, and `_CAPABILITY_TOOLS` now maps the
general deletion phrases to `workspace_delete`, derived against the live tool
set exactly like every other entry — the same sentence still comes back clean
if the tool ever leaves the registry.

Her actual words needed one new denial shape. The lead family is first-person
("I can't...") and the trailing family is a copula ("...isn't in my toolset");
*"there is no X in my toolbox"* is neither. It is admitted by a lookahead that
requires the clause to name her own toolset, so it is impersonal in grammar and
self-referring in substance, and *"there is no file at that path"* stays out.
That is the same lesson the trailing family learned in S12: a denial does not
stop being a denial for being said about a possession rather than an ability.

Precision is pinned in both directions. A specific failed removal ("I couldn't
delete groceries.md — there is nothing at that path"), a containment statement
("I can't delete files outside my workspace"), a question, a future form and
another subject are all left alone.

**No grant, no migration.** v4's registry is code: a tool is live for every
turn because a module declares it (`tools/__init__.py`), and `action_classes`
was dropped by migration 017. Step 3 of CLAUDE.md's loop — the one missed five
times in one session — has nothing to miss here.

## Pinned expectations that moved, deliberately

- `test_tools_registry.py::test_the_registered_tools_are_exactly_this_set_by_name`
  — THIRTY-TWO to THIRTY-THREE, with the reason recorded beside the previous
  four snapshot moves.
- `live_facts.AUTO_RUN` did NOT move and must not: `workspace_delete` is not
  `reads_only`, so the backend can never run it on its own initiative, and
  `test_live_facts` only pins the classification of reads-only tools.

## Carry

**No deferral class for deletion, on purpose, pending the walk.** The deferral
guard's offer classes cover listing, reading, running a command, checking a
device, pulling a model and setting a reminder — not deleting. So "would you
like me to delete it?" after the owner has already said to delete it is not
caught, and that is exactly the friction he named on 2026-09-01: per-command
approval for what he already asked. It is left out until the walk says whether
she actually does it, because a guard built on a guess is the kind of control
that gets deleted by the next person who reads it.

**No eval case.** `app/evals/cases/` has no case for a claimed deletion, so
the guard above is proven by unit tests and not yet MEASURED against a real
model deciding whether to call the tool or narrate around it. Adding one bumps
`suite_version` across every case in the suite (`load_suite` refuses a mixed
suite), which is a coordinated change worth doing deliberately rather than as
a footnote to this slice. The shape to encode: a workspace holding the file,
"delete groceries.md", contract `tool_called: workspace_delete` plus
`guard_absent` on the narration correction.

## Verification

Walked through chat on the deployed stack (core rebuilt from this worktree,
2026-09-11), in the owner's real conversation `323892b5`, driven by asking her
in her own words. Every reply below was checked against `turn_spans` by
`turn_id`, and then against the volume itself.

| Turn | Asked | Ran | Trace |
|---|---|---|---|
| `cad99ede` | "please delete groceries.md" | `workspace_delete{path}` | ok |
| `306dbc48` | "delete all four of the kv-offloading duplicates" | 4 reads, 1 write, 3 deletes | all ok |
| `cda4397c` | "get rid of that folder" (`agents/coder`) | `workspace_delete{path, recursive: true}` | ok |
| `8e65f18c` | "delete shopping-list.md too" | `workspace_list_files` only | refused honestly |

What the walk actually showed, beyond "the tool works":

- **She did not take the four duplicates at face value.** Asked to delete all
  four, she read all four first, found they were not duplicates, merged the
  union into one file, deleted the other three, and SAID that is what she had
  done instead of what was asked. The trace agrees line for line.
- **The missing file was not fabricated away.** Asked to delete a file that
  does not exist, she re-listed rather than trusting her own earlier snapshot,
  and said there is no such file. No delete span, no claimed success.
- **The trash is invisible where it should be.** Six items sat in `.trash`
  during the last turn and her listing showed four files. The operator Files
  page reads the same function.
- **Everything she promised is on disk.** `/data/workspace/.trash/` holds
  `groceries.md`, the three KV notes and the whole `coder/` directory with both
  its files. "Recoverable for 7 days" is a true statement about a real file,
  which is the only reason the tool is allowed to say it.

**The mtime defect was real in production data, not just in a test.** Two of
the trashed KV notes carry mtimes of 2026-09-03 — eight days old. Under the
original mtime-keyed prune and a seven-day window, both would have been swept
by the very next delete, forty seconds later, while the reply said they were
recoverable for a week. The fix was written before the walk, off a test; the
walk is what proves it was not hypothetical.

**Not exercised live:** the non-empty-directory refusal. She passed
`recursive: true` on the first attempt, so nothing made her hit it. It stays
covered by unit tests.
