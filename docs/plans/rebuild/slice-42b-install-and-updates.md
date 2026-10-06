# S42b — install, service, downloads, the code card

## Status

Not yet closed out. Task 31 (docs) creates this file as a skeleton; Task 32
fills in every section below once the gates, the whole-branch review, the
walk and the eval have all run. Until then, `hub-topology.md` §S42b carries
the plan's P1–P31 decisions as they stand today, and `slice-42b-carries.md`
carries what is already known to wait past this slice.

## What shipped

(Task 32: the task-by-task list — each task, what it built, its fix rounds
if any, and its current commit SHAs — mirroring
[`slice-42a-agent-every-os.md`](slice-42a-agent-every-os.md)'s "What
shipped.")

## Decisions made where the spec was silent

(Task 32: the full P1–P31 table, one line each, as actually built — carry
forward the current version from `hub-topology.md` §S42b rather than the
plan's original wording, since the carries corrected several lines after
the plan was written.)

**Amendment carried from Task 31 (H11), to apply when this table is
filled in:** P25's plan wording ("its result names each command that will
end cancelled") is corrected. `machine_update` reports the **count** of
in-flight commands that will end cancelled, not each one's name (F15) — the
hub keeps futures, not capability names.

## Rulings made during the build

(Task 32: condensed from the SDD ledger's "Ruling:" lines
(`.superpowers/sdd/plan/progress.md`), the way
[`slice-42a-agent-every-os.md`](slice-42a-agent-every-os.md)'s "Rulings made
during the build" does — major ones first with what was decided, why, and
the cost if wrong; procedural and test-shape ones grouped at the end.)

## Review rounds

(Task 32: each task's review outcome, and the whole-branch review's.)

## Gates

(Task 32: the targeted and full-suite results at the HEAD this closes out,
core/gateway/memory/web/novad, with the known-red baseline named apart from
anything this slice caused.)

## CI

(Task 32: `rebuild-ci` run results for this branch — `novad` and
`novad-native` across its runners, and anything red outside `apps/novad`
named as pre-existing or not.)

## The walk

(Task 32: in chat, in her words, every turn read by turn id from
`turn_spans` — not a time-ordered guess. Topology, and which steps passed,
were skipped, or found something.)

## The eval

(Task 32: `agent_quality` suite results, the model used, and a read of any
S42b case that did not pass — not just the score.)

## For the owner

(Task 32: open questions, wording calls, and anything from the carries that
needs an owner decision rather than a default.)
