# The pipeline

How a change gets from a pull request to main to the preview, and what blocks what. Set by the
owner's pipeline ruling of 2026-11-11 (more shards, the gate split by PR type, auto-cancel; the
self-hosted runner next). The workflow is `.github/workflows/ci.yml`; the scripts it and the
merge use are named below. If this page and the workflow disagree, the workflow is what runs: fix
this page in the same pull request.

No test was deleted, skipped or loosened by this. Every test still runs on every merge to main.
What changed is when and where the UI tests run.

## The jobs

| Job | What it is | Time (2026-11-11) |
|-----|-----------|-------------------|
| `changes` | Sorts the changed files (`scripts/ci-changes.sh`): heavy or docs only, UI surface or not | under 1 min |
| `lint · typecheck · themes · tests` | Token lint, typecheck, syntax, themes, `npm test`, `npm audit` | 12.4–13.7 min |
| `UI gate (Chromium and WebKit) 1/8`…`8/8` | `tests/ui/**` in a real browser, in eight shards side by side | about 9 min of tests per shard, plus setup |
| `shots (Era-2 walkthrough)` | `scripts/shots.js`: the walkthrough flows and golden screens | 5.5–7.0 min |
| `gate` | The one required check. Decides from the others (`scripts/ci-gate.sh`) | seconds |
| `main red → issue` | On main only, when the gate failed: files the `main-red` issue | seconds |

## What blocks what

There are three kinds of change, decided by `scripts/ci-changes.sh` from the diff:

- **Docs only**: every file is under `docs/` or `handoffs/`, or is markdown outside the folders
  Nova runs from. No heavy job runs, on the pull request or on main. The gate passes when all three
  heavy jobs were skipped. This rule is unchanged.
- **UI**: the change touches a UI surface (the list below). On the pull request, checks, the UI
  gate and shots all run and must all pass before it can merge. That is the gate as it was before.
- **Non-UI**: heavy, but no UI surface. On the pull request only checks run, and the gate passes
  when checks passed and the UI gate and shots were skipped. The UI gate and shots then run on the
  push to main after the merge, and their result is required before the work is called done or
  deployed (see "Merged is not done" below).

On the push to main, every heavy merge runs checks, the UI gate and shots, whatever it touched, and
main's gate passes only when all three passed.

The gate's full rule (`scripts/ci-gate.sh`, every combination tested in `tests/ci-gate.test.js`):

| Event | Change | Gate passes when |
|-------|--------|------------------|
| any | docs only | checks, UI gate and shots all skipped |
| pull request | UI | checks, UI gate and shots all succeeded |
| pull request | non-UI | checks succeeded, and the UI gate and shots were skipped |
| push to main | heavy | checks, UI gate and shots all succeeded |

Anything else fails: a failed, cancelled or unexpectedly skipped job, or a value it doesn't know.

### The UI surfaces

A change is UI when any file matches one of these (derived from what `tests/ui/**` and
`scripts/shots.js` load, and from what the server sends to a browser):

- `ui/**`: every file served to the browser (pages, `ui/js`, styles, icons, the service worker, the manifest)
- `design-systems/**`: the design systems, compiled to `/design-system.css`
- `src/core/design.ts`: builds `/design-system.css` and the status-bar tag in the app page
- `src/core/extensions.ts`: validates an installed design system's manifest for `design.ts`
- `src/core/csp.ts`: the Content-Security-Policy on every HTML page
- `src/sw-version.js`: the service worker's cache name, filled into `/sw.js`
- `src/server.js`: serves `ui/` and rewrites its HTML (status bar, CSP, `sw.js`)
- `tests/ui/**`: the UI gate itself, its support files and screenshot baselines
- `scripts/shots.js`: the shots walkthrough
- `scripts/ui-shard.js`, `scripts/ui-timings.js`, `scripts/ui-timings.json`, `scripts/ui-test.sh`,
  `scripts/tripwire.sh`: how the UI gate is split, measured and run
- `scripts/fake-*.js`, `scripts/form-site.js`, `scripts/make-zip.js`, `scripts/stand-ins/**`:
  stand-in services the UI tests and shots start
- `tests/support/**`, `tests/acceptance/*support*.ts`, `tests/core/mesh-support.ts`: shared test
  helpers that `tests/ui/**` imports
- `package.json`, `package-lock.json`, `mise.toml`: the Playwright pin (`playwright-core`, matched
  by the container tag), axe-core, and the Node version the UI jobs run
- `.github/**`: a workflow change always runs everything
- any file that is in none of the known folders (fail safe: an unforeseen file is UI)

Not UI: docs, and the rest of `src/**`, `tests/**`, `scripts/**`, `charts/**`, `system/**`,
`templates/**`, `skills/**`, `schedules/**` and `connectors/**`.

**A non-UI change can still break the UI gate.** The UI gate starts the whole server and drives it
through the browser, so a change to, say, `src/core/memory.ts` can fail it. The list above is the
code that decides what the browser gets, not everything the UI gate touches. That is exactly what
the push-to-main run on every merge, and the merge pause below, are there to catch.

## The merge script's definition of green

`scripts/merge-on-green.sh <PR> [--wait-main]` is how pull requests are merged.

1. It waits until no check is pending and the `gate` check exists for the pull request's current
   head commit. A gate on an older commit is not green.
2. It refuses while merges are paused (below), and prints why.
3. It prints the pull request's type: `UI` (its gate included the UI gate and shots), `non-UI` (UI
   evidence pending on main) or `docs-only`.
4. If the gate passed it merges with a merge commit, only if the head is still the commit it
   checked, and prints `MERGED <sha>`.
   - Non-UI: it then waits for main's run on that merge commit and prints
     `MAIN-UI pass|fail <run url>`. That line is the evidence cited before the work is reported done.
   - UI: it prints main's result if there is one yet, or waits for it with `--wait-main`.
5. Otherwise it prints `NOT-GREEN` and the failing checks.

Green, by type:

| Type | Green to merge | Green to call done |
|------|----------------|--------------------|
| docs only | gate passed (heavy jobs skipped) | merged |
| UI | gate passed: checks, UI gate and shots on the exact head | merged, and main's run passes |
| non-UI | gate passed: checks on the exact head | merged, and `MAIN-UI pass` from main's run on the merge commit |

## Merged is not done; deployed waits for main

Merged and deployed are different things, as before. The preview's deploy watcher
(`scripts/deploy-watch.sh`, installed on the host) deploys the newest commit on main whose
push-run `gate` check passed. While the newest main commit's gate is running it waits; if it
failed, the preview stays on the last green commit and the watcher's log says so once. A commit
whose main gate did not pass is never deployed. Because main's gate includes the UI gate and shots
for every heavy merge, nothing reaches the preview without them.

## Main goes red: an issue, and merges pause

If main's gate fails after a merge, the `main red → issue` job opens an issue labelled `main-red`,
titled "Pipeline: main is red at <sha8>", with the run's link, the failing jobs and the merged pull
request (or comments on the one already open). It is the only job allowed to write issues.

While a `main-red` issue is open, or the newest finished main run's gate did not pass,
`scripts/merge-on-green.sh` merges nothing, except the fix: a pull request whose body says
`Fixes #N` (or `Fixes main-red #N`) for that open `main-red` issue. That is a fix forward: nothing
is reverted by the pipeline. When the fix merges, GitHub closes the issue, and merges resume once
main's run on the fix is green. If it is red again, a new issue opens and the pause holds.

## Runs that are cancelled, and runs that never are

- A pull request's runs share the group `ci-pr-<number>` with cancel-in-progress: a new push cancels
  the run for the push before it, which was moot anyway.
- Main's runs each get their own group, `ci-main-<sha>`, and are never cancelled: every merge
  commit's run is its record. Before this, main shared one group (`ci-refs/heads/main`). GitHub
  never cancelled a running main run, but it keeps only one pending run per group, so when a third
  merge arrived it cancelled the second one's queued run: 56 main runs ended "cancelled" that way,
  for example run 42872635055 on 2026-11-10.

## How the UI shards are balanced

`scripts/ui-shard.js` deals the UI test files into eight shards by measured time, slowest file
first into the least-loaded shard; every file runs in exactly one shard (`tests/ui-shard.test.js`).
Shard 1 also runs the accessibility advisory, so it gets that much less test time. The times are in
`scripts/ui-timings.json`, which records the main runs it was measured from.

To re-measure (after UI tests are added or get slower; the shard step warns when the file is over
30 days old or more than a few files are unmeasured):

```sh
GH_TOKEN=$(gh auth token) npm run ui:timings -- --runs 10
node scripts/ui-shard.js --plan 8      # projected seconds per shard
```

Commit the regenerated `scripts/ui-timings.json`. To change the shard count, change the matrix in
`ci.yml`, the advisory's `matrix.shard == '1/8'`, and the count in `tests/ui-shard.test.js`.

With eight shards the UI gate is no longer the long pole: `lint · typecheck · themes · tests`
(about 13 minutes) is. The full gate is bounded near that, not halved.

## Next step: a self-hosted runner

Not built yet; queued after this package lands. Run CI on a self-hosted runner on the Beelink
mini-PC, which is always on (the Dell can help when it is awake). The reason is GitHub's
concurrency ceiling: on GitHub's hosted runners a batch of pull requests queues behind the job
limit, eight UI shards each included, so batches wait instead of running in parallel. Our own
runner removes that ceiling.
