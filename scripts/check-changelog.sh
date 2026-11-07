#!/bin/sh
# A pull request that changes what Nova ships must add its changelog fragment and its ledger entry
# (docs/changelog/README.md, docs/ledger/README.md). CI runs this on pull requests (.github/workflows/
# ci.yml, the checks job); run it yourself the same way.
#
# Usage: sh scripts/check-changelog.sh <base>     e.g. origin/main
#   It compares <base>...HEAD: what this branch changed since it left <base>.
#   NO_CHANGELOG=1 (the pull request has the no-changelog label) skips the check.
#
# "What Nova ships" is anything under src/, ui/, skills/, templates/ or system/. The fragment is a
# new docs/changelog/<file>.md and the entry a new docs/ledger/<file>.md (not README.md); changing an
# existing one doesn't count.
set -eu

base="${1:?usage: sh scripts/check-changelog.sh <base>, e.g. origin/main}"

if [ "${NO_CHANGELOG:-}" = 1 ]; then
  echo "Labelled no-changelog: no changelog fragment or ledger entry needed."
  exit 0
fi

changed="$(git diff --name-only "$base...HEAD")" || { echo "Couldn't compare with $base (is it fetched, with enough history?)."; exit 1; }
added="$(git diff --name-only --diff-filter=A "$base...HEAD")"

shipped="$(printf '%s\n' "$changed" | grep -E '^(src|ui|skills|templates|system)/' || true)"
if [ -z "$shipped" ]; then
  echo "Nothing Nova ships changed: no changelog fragment or ledger entry needed."
  exit 0
fi

fragment="$(printf '%s\n' "$added" | grep -E '^docs/changelog/[^/]+\.md$' | grep -v '/README\.md$' || true)"
ledger="$(printf '%s\n' "$added" | grep -E '^docs/ledger/[^/]+\.md$' | grep -v '/README\.md$' || true)"

echo "This change touches what Nova ships:"
printf '%s\n' "$shipped" | sed 's/^/  /'
missing=0
if [ -n "$fragment" ]; then echo "Changelog fragment: $fragment"; else echo "Missing: a new docs/changelog/<YYYY-MM-DD>-<branch>.md (docs/changelog/README.md)."; missing=1; fi
if [ -n "$ledger" ]; then echo "Ledger entry: $ledger"; else echo "Missing: a new docs/ledger/<YYYY-MM-DD>-<branch>.md (docs/ledger/README.md)."; missing=1; fi
if [ "$missing" = 1 ]; then
  echo "If nothing the owner would notice changed (a test fix, a refactor), add the no-changelog label and re-run the checks."
  exit 1
fi
