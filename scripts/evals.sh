#!/bin/sh
# Runs the eval harness (Amendment 2026-10-31-B Part 4) with a temporary folder of its own, removed
# when the run ends, as scripts/test.sh does for the tests. Arguments go to tests/evals/cli.ts:
#   sh scripts/evals.sh                              the regression suite, stand-ins (as CI)
#   sh scripts/evals.sh --suite all                  regression, capability and injection
#   sh scripts/evals.sh --model gemma4:12b --home ~/Nova
#                                                    a local model's scorecard, kept for Settings › Models
#   sh scripts/evals.sh --only capture.needs-key-diagnosis
# See docs/plans/evals.md.
set -eu
here=$(dirname "$0")
dir=$(mktemp -d "${TMPDIR:-/tmp}/nova-evals-XXXXXX")
trap 'rm -rf "$dir"' EXIT INT TERM
TMPDIR="$dir" node "$here/../tests/evals/cli.ts" "$@"
