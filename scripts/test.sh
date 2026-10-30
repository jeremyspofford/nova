#!/bin/sh
# Runs the test suite with a temporary folder of its own, removed when the run ends, so test homes,
# sandboxes and backups never pile up in /tmp (they once filled it: tens of thousands of folders).
# Usage: scripts/test.sh <test file globs…>   (npm test passes the suite's globs)
set -eu
dir=$(mktemp -d "${TMPDIR:-/tmp}/nova-test-XXXXXX")
trap 'rm -rf "$dir"' EXIT INT TERM
TMPDIR="$dir" node --test "$@"
