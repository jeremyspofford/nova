#!/usr/bin/env bash
# The agent's version: the first 12 hex characters of the git TREE of
# apps/novad at HEAD (hub D13, S42b P2). The same tree builds the same bytes,
# so the same version names the same sha256 on CI, on the hub (agent-dist) and
# on a laptop. `cut -c1-12`, never `--short=12`: git lengthens a short hash to
# keep it unambiguous, and core stores exactly 12.
#
# Refuses when apps/novad has uncommitted changes: a stamp of HEAD's tree on
# files that differ from it would be a version that lies.
#     deploy/agent_version.sh [<repo root>]
set -euo pipefail
ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)}"
if ! git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  echo "agent_version: cannot: $ROOT is not a git checkout, so the agent's version (its apps/novad tree) cannot be read" >&2
  exit 1
fi
if [ -n "$(git -C "$ROOT" status --porcelain -- apps/novad)" ]; then
  echo "agent_version: cannot: apps/novad has uncommitted changes — commit them first; the version names the committed tree" >&2
  exit 1
fi
git -C "$ROOT" rev-parse HEAD:apps/novad | cut -c1-12
