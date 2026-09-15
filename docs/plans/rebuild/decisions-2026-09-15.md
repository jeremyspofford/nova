# Decisions — 2026-09-15

A pass through every open scope of work, one at a time, with the owner
deciding each. Recorded because two things today were nearly lost by living
only in a transcript: the quality-corpus TODO (agreed 09-14, recorded
nowhere, found by accident) and the S23 spec (written, then unfindable on an
unmerged branch).

Numbers are the order they were taken in.

---

## 1. S22 — live resources → **CLOSED as done**

Built, merged, deployed, pushed. The two walk steps stay deferred in
`slice-22-carries.md`: ask her about the GPU on a card that can answer, and
confirm the Inbox item when a second round walls. Both need a free card and
the owner's own session, so holding the slice open would not make them
happen sooner.

## 2. Icons → **CLOSED, with the web manifest as a follow-on**

Four icon choices, two independent settings, mark derived from the live
palette — done and deployed.

Two gaps found while closing. Taken: **the manifest.** `apps/web` has no
`manifest.webmanifest` and no `<link rel="manifest">`, so Add-to-Home-Screen
gets no app name, no standalone display, no maskable icon and no theme
colour — and `icon-512-maskable.png` is already in the repo, unreferenced.

NOT taken: a server-side instance default for the icons (the theme has one,
`appearance.default_preset`; the icons are per-browser only). One user,
three browsers, ten seconds each — not worth two settings rows.

## 3. S23 — serving runtime → **MERGED and listed**

Parked earlier the same day. Spec merged to `rebuild/v4` docs-only, branch
and worktree deleted, and listed in `slice-22-carries.md` so it is findable
where the other open work already is.

## 4. Repo cleanup → **PUSHED, then pruned**

The order mattered: `rebuild/v4` was **16 commits ahead of origin** — every
piece of today's work existed on one disk. Pushed first (`7910fe3c`),
verified, then pruned 22 branches and 11 worktrees. From 26 branches and 13
worktrees to 4 and 2.

## 5. v3 governance lane → **working copy discarded**

All 23 files re-verified byte-identical to `archive/v3-governance-wip` at
the moment of deletion, and that branch confirmed on origin. Nothing lost
but a dirty `git status`.

## 6. `identity-view` → **ARCHIVED**

Renamed `archive/v3-identity-view` and pushed. Both archives are now
described in `docs/archived-branches.md`, which exists because neither was
mentioned anywhere in the repository — the same invisibility as items 1 and
3 above.

## 7. The Inbox → **FULL SCOPE (S24)**

The owner's complaint: cards do not read like something a human wrote,
nothing is actionable, and there is no way to discuss an item. Reading the
code confirmed all three and found more. Everything is taken:

- **The defects.** Mute is per-fingerprint and forever, and is defeated by
  any check whose facts carry a moving number (`work_failing_timers` puts
  `consecutive_failures` in its facts, so the next failure is a fresh,
  unmuted card and the muted row is never cleared or pruned). A muted card
  still bumps `last_seen_at` on every fold, and the list sorts by it — so
  the thing he silenced is the first card he sees. "Mark seen" silently and
  permanently removes a notice from the daily digest while NOT silencing an
  urgent re-push, because the two paths read different columns.
- **Human prose per card**, and linked subjects — a `timer_id` in the facts
  should be a link to the timer, not monospace text.
- **A `notices` tool, so she can read her own Inbox.** Today she writes the
  daily digest into his conversation and then cannot answer a single
  question about it. This is the CLAUDE.md principle: give her the
  capability, not the page another button.
- **"Talk about this"** — open a conversation seeded with the notice.
- **Wire `POST /api/v1/skills {from_notice: …}`**, which is fully
  implemented and which no UI calls.

## 8. Quality corpus → **FULL SCOPE (S25)**, judge selectable, plus a
## recommendation

Today's ceiling: 23 cases, 20 of which never look at the reply text at all;
14 pin an honesty guard silent; exactly one grades answer quality and calls
itself a proxy. Reasoning, long-context, writing, factual correctness: zero
each. No judge, no rubric, no score beyond boolean-AND.

Taken: the full capability corpus — ground truth on cases, a fixture world,
argument- and sequence-aware predicates, multi-turn replay, a judge with a
non-boolean score.

**The judge is a toggle: local or cloud.** Local keeps everything on the
box and runs on the same contended card that measured 5 tok/s today; cloud
is consistent and touches no GPU but sends test prompts and model outputs
off-box. They are synthetic rather than his data, but it is his
privacy-first principle, so it is a setting rather than a choice made for
him.

**Plus a recommended-model hint, derived.** Nova should say which model
measured best. My reading of the ask, flagged here so it can be corrected:
a recommendation surfaced from measured results, per role — not an
auto-switch. v3's prior art is `model_fitness`, which READ eval_runs
("fitness measures, never declares"), and a one-click Promote. The v4
constraint is the 2026-09-03 ruling: she may state that a model measured
best; she may not switch to it on his behalf.

Stated plainly, and it did not change the decision: **a corpus is an
instrument, not a feature.** It makes improvement measurable; it does not
cause it. What it unblocks is decisions — "is the 27B actually better than
the 8B" (today's 21/23 vs 19/23 is almost certainly false about capability,
since the gap is honesty pins) and "did q8_0 hurt anything", which is the
question that stopped the one config change worth making today.

---

## Order of work

1. The web manifest (item 2) — small, agreed, finishes a closed scope.
2. **S24, the Inbox** — his daily surface, and the thing his assistant
   currently files unreadable reports into.
3. **S25, the quality corpus** — the instrument. Larger, mostly design.

Carries riding along, to be folded in where they fit: S16's claimed-deletion
eval case needs a workspace-file fixture (S25 builds exactly that fixture
world); `no-fabricated-agent-work` is unstable on both models; the 27B has
no matched three-run set under the warm-up code.
