#!/bin/sh
# Runs the test suite with a temporary folder of its own, removed when the run ends, so test homes,
# sandboxes and backups never pile up in /tmp (they once filled it: tens of thousands of folders).
# It runs under the no-Kubernetes tripwire (scripts/tripwire.sh): any call to kubectl, helm, flux or
# k3s fails the run.
# Usage: scripts/test.sh <test file globs…>   (npm test passes the suite's globs)
set -eu
dir=$(mktemp -d "${TMPDIR:-/tmp}/nova-test-XXXXXX")
trap 'rm -rf "$dir"' EXIT INT TERM
TMPDIR="$dir" sh "$(dirname "$0")/tripwire.sh" node --test "$@"
