#!/bin/sh
# Sorts a change's files for CI (.github/workflows/ci.yml): reads one path per line on stdin and
# prints `heavy=…`, `computer=…`, `ui=…` and `kind=…` lines for $GITHUB_OUTPUT.
#
#   docs      docs/**, handoffs/**, and markdown outside every folder Nova runs from
#   workflows .github/**
#   code      everything else: src/**, ui/**, tests/**, scripts/**, package*.json, mise.toml,
#             charts/**, and the folders whose markdown Nova loads at run time (system/,
#             templates/, skills/, schedules/, connectors/, design-systems/)
#
# Anything not known to be docs counts as code, so an unforeseen file runs the whole suite.
# `heavy` is false only when every file is docs. `computer` is true when Nova Computer's code or
# its tests changed (the image is pulled ahead only then; its tests pull it themselves otherwise).
#
# `ui` is true when the change touches a UI surface (the owner's pipeline ruling, 2026-11-11). On a
# pull request the UI gate and the shots walkthrough block the merge only then; on the push to main
# they always run (docs/PIPELINE.md). The UI surfaces, derived from what tests/ui/** and
# scripts/shots.js load and what the server sends to a browser:
#
#   ui/**                         every file the server serves to the browser (pages, ui/js, styles,
#                                 icons, the service worker, the manifest)
#   design-systems/**             the design systems, compiled to /design-system.css
#   src/core/design.ts            builds /design-system.css and the status-bar tag in the app page
#   src/core/extensions.ts        validates an installed design system's manifest for design.ts
#   src/core/csp.ts               the Content-Security-Policy on every HTML page
#   src/sw-version.js             the service worker's cache name, filled into /sw.js
#   src/server.js                 serves ui/ and rewrites its HTML (status bar, CSP, sw.js)
#   tests/ui/**                   the UI gate itself, its support files and screenshot baselines
#   scripts/shots.js              the shots walkthrough
#   scripts/ui-shard.js, scripts/ui-timings.js, scripts/ui-timings.json, scripts/ui-test.sh,
#   scripts/tripwire.sh           how the UI gate is split, measured and run
#   scripts/fake-*.js, scripts/form-site.js, scripts/make-zip.js, scripts/stand-ins/**
#                                 stand-in services the UI tests and shots start
#   tests/support/**, tests/acceptance/*support*.ts, tests/core/mesh-support.ts
#                                 shared test helpers tests/ui/** imports
#   package.json, package-lock.json, mise.toml
#                                 the Playwright pin (playwright-core, the container tag), axe-core
#                                 and the Node version the UI jobs run
#   .github/**                    a workflow change always runs everything
#   scripts/ci-changes.sh, scripts/ci-gate.sh, scripts/merge-on-green.sh, scripts/deploy-watch.sh
#                                 the pipeline's own decisions: like .github/**, always run everything
#   anything unknown             a file in none of the folders below counts as UI (fail safe)
#
# Not UI: docs (above), and the rest of src/**, tests/**, scripts/**, charts/**, system/**,
# templates/**, skills/**, schedules/**, connectors/**. The UI gate drives the whole server, so a
# change there can still break it: the push to main runs it on every merge and a red result pauses
# merges until fixed forward.
set -eu

docs=0 code=0 workflows=0 computer=0 ui=0 any=0
while IFS= read -r f; do
  [ -n "$f" ] || continue
  any=1
  case "$f" in
    src/core/computer/*|tests/core/computer-*|tests/acceptance/m10a-*) computer=1 ;;
  esac
  case "$f" in
    .github/*) workflows=1 ;;
    src/*|ui/*|tests/*|scripts/*|charts/*|system/*|templates/*|skills/*|schedules/*|connectors/*|design-systems/*) code=1 ;;
    docs/*|handoffs/*) docs=1 ;;
    *.md) docs=1 ;;
    *) code=1 ;;
  esac
  case "$f" in
    .github/*|ui/*|design-systems/*|tests/ui/*) ui=1 ;;
    scripts/ci-changes.sh|scripts/ci-gate.sh|scripts/merge-on-green.sh|scripts/deploy-watch.sh) ui=1 ;;
    src/core/design.ts|src/core/extensions.ts|src/core/csp.ts|src/sw-version.js|src/server.js) ui=1 ;;
    scripts/shots.js|scripts/ui-shard.js|scripts/ui-timings.js|scripts/ui-timings.json|scripts/ui-test.sh|scripts/tripwire.sh) ui=1 ;;
    scripts/fake-*.js|scripts/form-site.js|scripts/make-zip.js|scripts/stand-ins/*) ui=1 ;;
    tests/support/*|tests/acceptance/*support*.ts|tests/core/mesh-support.ts) ui=1 ;;
    package.json|package-lock.json|mise.toml) ui=1 ;;
    src/*|tests/*|scripts/*|charts/*|system/*|templates/*|skills/*|schedules/*|connectors/*) ;;
    docs/*|handoffs/*|*.md) ;;
    *) ui=1 ;;
  esac
done

# No files at all (an empty or unreadable diff) is never taken as docs-only, nor as non-UI.
if [ "$any" = 0 ]; then code=1; ui=1; fi

if [ "$code" = 1 ] || [ "$workflows" = 1 ]; then heavy=true; else heavy=false; fi
kind=""
[ "$code" = 1 ] && kind="${kind}code "
[ "$workflows" = 1 ] && kind="${kind}workflows "
[ "$docs" = 1 ] && kind="${kind}docs "
echo "heavy=$heavy"
echo "computer=$([ "$computer" = 1 ] && echo true || echo false)"
echo "ui=$([ "$ui" = 1 ] && echo true || echo false)"
echo "kind=${kind% }"
