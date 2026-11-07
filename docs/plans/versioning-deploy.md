# Versioning and the deploy record: how the pieces fit (2026-11-06)

The non-UI half of the owner's versioning item (`docs/builder-packet/nova-versioning-changelog-2026-11-03.md`
and its delta `nova-about-deploy-visibility-delta-2026-11-06.md`). The About area, `/changelog`, the
pipeline dashboard and the footer stamp are the UI track's, against their approved designs; they read
what is described here.

## What the running Nova knows

`src/core/build.ts`, read at startup:

| Field | From |
|---|---|
| `version` | package.json `version`, the single source of truth (`0.1.0-alpha.1` now). |
| `commit`, `commit_short` | `NOVA_BUILD_COMMIT` (a full 40-hex commit) if set; else `git rev-parse HEAD` in the code root; else `null`. A value that isn't a full commit is ignored. Never throws. |
| `built_at` or `started_at` | `built_at` from `NOVA_BUILD_DATE` (ISO 8601 with its zone) if set; otherwise `started_at`, the process's start. Exactly one is present, so a start time is never passed off as a build date. |
| `latest` | The deploy record (below), read on every ask, or `null`. |
| `behind` | `latest.commit !== commit`; `null` when either is unknown. |
| `words` | "Running <short>, latest merged <short> — redeploy pending." / "Running <short>, the latest merged build." / "Running <short>; Nova doesn't know the latest merged build." |

`GET /api/v1/version` returns exactly that, read-only, at person access like the rest of the API. The
chat briefing (`src/core/self.ts`) and `nova_instance` carry a `Version:` line with the same words, so
Nova states its version from core state. Nova never calls GitHub or any network for any of it.

## The deploy record (merge queue contract)

After every merge to main, **before** the redeploy, the merge queue runs:

```sh
sh scripts/deploy-record.sh "<home>" "<merge commit, 40 hex>" "<merged_at, ISO 8601>"
# e.g. from the pull request:
#   gh pr view <n> --json mergeCommit,mergedAt -q '.mergeCommit.oid + " " + .mergedAt'
```

It writes `<home>/deploy/latest.json` as `{"commit","merged_at"}`, mode 600, atomically (a temporary
file in the same folder, then a rename), and refuses anything that isn't a full commit and an ISO date
with its zone (exit 2, nothing written). `<home>` is the instance's Nova home (the preview's
`NOVA_HOME`). A Nova whose record lives elsewhere is started with `NOVA_LATEST_FILE=<path>`. Nova
checks the file again when it reads it: a plain file (not a link), at most 4 KiB, JSON with those two
fields valid; anything else counts as not known.

Order matters: record, then redeploy. Between the two the running Nova says "redeploy pending", which
is the truth; after the redeploy the new process runs the recorded commit and says it is the latest.

## What the preview launcher passes

The preview runs straight from its worktree, so the launcher sets, for the Nova process it starts:

```sh
NOVA_BUILD_COMMIT="$(git -C "$PREVIEW_WORKTREE" rev-parse HEAD)"
NOVA_BUILD_DATE="$(git -C "$PREVIEW_WORKTREE" log -1 --format=%cI HEAD)"   # the commit's date: the build is that commit
```

Both are optional: without them Nova asks git itself and says `started_at`. Passing them makes the
answer independent of git being readable from the process (a release slot, a container). The owner's
preview helper under `.claude/` is the owner's to change; this pull request leaves it alone.

## Versions, the changelog and tags

- Each pull request that changes what Nova ships adds `docs/changelog/<date>-<branch>.md` and
  `docs/ledger/<date>-<branch>.md`; CI's checks job refuses it otherwise unless it is labelled
  `no-changelog` (`scripts/check-changelog.sh`; re-run the job after labelling).
- The version bump is the lead's, from the merge queue, on main: bump package.json's `version` (and
  package-lock.json's two top-level copies), run `npm run changelog -- --release` (moves the waiting
  fragments into `docs/changelog/<version>/` and regenerates CHANGELOG.md), commit, then tag that
  commit `v<version>` and push the tag. Alpha counter on each merge that changes shipped behaviour;
  the minor at a milestone's close (0.2.0-alpha.1 at M10's).
- For this pull request: package.json is already `0.1.0-alpha.1`, CHANGELOG.md holds the one opening
  entry, and this pull request's own fragment waits at the top of docs/changelog/. Right after it
  merges, `npm run changelog -- --release` puts it into 0.1.0-alpha.1 beside the opening entry, and
  main is tagged `v0.1.0-alpha.1`.

### Why fragments, not one file (a reversible choice)

A single CHANGELOG.md that every pull request edits collides the same way docs/LEDGER.md did, which
is why the ledger moved to one file per pull request. Fragments keep each pull request's entry in its
own file; only the lead's version bump on main touches CHANGELOG.md, one at a time. To go back to a
hand-edited file: run `npm run changelog -- --release` one last time, then delete `scripts/changelog.js`,
`tests/changelog.test.js` and the fragments, and point the CI rule at CHANGELOG.md.

## Left for the UI track

- About (Health) and the footer stamp: `GET /api/v1/version`, showing `words`, the version, the short
  commit and `built_at` or (labelled as a start time) `started_at`.
- `/changelog`: render CHANGELOG.md (or the version folders), with the running version and commit
  pinned on top; merged-but-not-yet-versioned changes are the fragments at the top of docs/changelog/.
- The pipeline dashboard: generated from docs/ledger/ and the roadmap documents at view time.
