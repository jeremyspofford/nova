#!/bin/sh
# Records the latest merged build for a Nova home, so the running Nova can say whether it is behind
# (src/core/build.ts reads it; GET /api/v1/version). The merge queue runs this after every merge,
# before it redeploys (docs/plans/versioning-deploy.md). Nova itself never asks GitHub.
#
# Usage: sh scripts/deploy-record.sh <home> <commit> <merged_at>
#   home       Nova's data home (an existing folder), e.g. ~/Nova
#   commit     the merge commit, all 40 hex characters
#   merged_at  when it merged, ISO 8601 with its zone, e.g. 2026-11-06T18:22:01Z
#
# Writes <home>/deploy/latest.json as {"commit","merged_at"}, mode 600, atomically: a temporary file
# in the same folder, then a rename, so Nova never reads half a file.
set -eu

[ "$#" -eq 3 ] || { echo "usage: sh scripts/deploy-record.sh <home> <commit> <merged_at>" >&2; exit 2; }
home="$1"
commit="$(printf '%s' "$2" | tr 'A-F' 'a-f')"
merged_at="$3"

[ -d "$home" ] || { echo "No such Nova home: $home" >&2; exit 2; }
printf '%s' "$commit" | grep -Eqx '[0-9a-f]{40}' || { echo "Not a full commit (40 hex characters): $2" >&2; exit 2; }
printf '%s' "$merged_at" | grep -Eqx '[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]{1,9})?)?(Z|[+-][0-9]{2}:[0-9]{2})' || { echo "Not an ISO 8601 date with its zone: $merged_at" >&2; exit 2; }

umask 077
dir="$home/deploy"
mkdir -p "$dir"
tmp="$(mktemp "$dir/.latest.json.XXXXXX")"
trap 'rm -f "$tmp"' EXIT INT TERM
printf '{"commit":"%s","merged_at":"%s"}\n' "$commit" "$merged_at" > "$tmp"
chmod 600 "$tmp"
mv -f "$tmp" "$dir/latest.json"
trap - EXIT INT TERM
echo "Recorded $dir/latest.json: $commit merged $merged_at"
