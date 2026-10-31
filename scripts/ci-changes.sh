#!/bin/sh
# Sorts a change's files for CI (.github/workflows/ci.yml): reads one path per line on stdin and
# prints `heavy=…`, `computer=…` and `kind=…` lines for $GITHUB_OUTPUT.
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
set -eu

docs=0 code=0 workflows=0 computer=0 any=0
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
done

# No files at all (an empty or unreadable diff) is never taken as docs-only.
if [ "$any" = 0 ]; then code=1; fi

if [ "$code" = 1 ] || [ "$workflows" = 1 ]; then heavy=true; else heavy=false; fi
kind=""
[ "$code" = 1 ] && kind="${kind}code "
[ "$workflows" = 1 ] && kind="${kind}workflows "
[ "$docs" = 1 ] && kind="${kind}docs "
echo "heavy=$heavy"
echo "computer=$([ "$computer" = 1 ] && echo true || echo false)"
echo "kind=${kind% }"
