# About Nova, deploy-on-merge, pipeline dashboard — delta spec, 2026-11-06

Owner idea, Jeremy, 2026-11-06. This is a DELTA on the existing
versioning/changelog spec — read that first:
`docs/builder-packet/nova-versioning-changelog-2026-11-03.md`
(SemVer alpha line, package.json as version source, CHANGELOG.md
with same-PR entries, version + short commit + build date in footer
and Health › About, /changelog surface, running-vs-latest honesty).

Verified state when this delta was written (Muse, 2026-11-06):
that spec is NOT built. package.json still says plain `0.1.0`
(not `0.1.0-alpha.1`), there is no CHANGELOG.md on main, and no
About surface exists. Do not re-spec it — implement it, plus:

## 1. Deploy on merge, enforced and visible

- Completion already means: merged + preview redeployed on the
  merge commit + verified. Make it mechanical, not remembered:
  scripted redeploy step the builder runs on every merge, and the
  running instance records the commit it is serving.
- If the running build is behind the latest merged commit, Nova
  SAYS so in the About area (and footer stamp): "Running <sha>,
  latest merged <sha> — redeploy pending." Stale must be visible,
  never silent. Owner should never have to wonder which build he
  is looking at.

## 2. Pipeline dashboard (new beyond the Nov 3 spec)

- An owner-facing view of where Nova stands: milestones/tracks
  with states taken from records that already exist — the per-PR
  ledger files in `docs/ledger/` (post-#352 structure) and the
  roadmap/queue documents.
- GENERATED, never hand-maintained: the dashboard renders from
  those sources at view time. A second hand-kept progress list is
  prohibited — it will drift and lie.
- Each item shows: name, state (merged / in progress / designed /
  not started), and the evidence link (PR or ledger entry) behind
  the state. States without evidence render as "designed" at best.

## 3. Rules that still apply

- Design-first: About, /changelog, and the dashboard get a
  styleguide entry and owner screenshot reaction before app code,
  consistent with the UI rebuild track — build them WITH that
  track, against the filed ui-references, not as a side UI.
- Plain language everywhere: the changelog and dashboard are for
  the owner, in the LEDGER's "What changed (plain language)"
  voice. No internal jargon, no PR numbers without a sentence
  saying what the change does for him.
