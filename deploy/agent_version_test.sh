#!/usr/bin/env bash
# Tests for deploy/agent_version.sh — the agent's version is the git TREE of
# apps/novad (S42b P2): the same tree builds the same bytes, so the same
# version names the same binary on CI, the hub and any laptop.
#     deploy/agent_version_test.sh
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
PASS=0
FAIL=0
report() {
  if [ "$1" -eq 0 ]; then PASS=$((PASS + 1)); printf 'ok   %s\n' "$2"
  else FAIL=$((FAIL + 1)); printf 'FAIL %s\n     %s\n' "$2" "${3:-}"; fi
}
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
git -C "$T" init -q
git -C "$T" config user.email test@example.com
git -C "$T" config user.name test
mkdir -p "$T/apps/novad" "$T/docs"
echo 'package main' > "$T/apps/novad/main.go"
echo one > "$T/docs/x.md"
git -C "$T" add apps docs && git -C "$T" commit -qm one

want="$(git -C "$T" rev-parse HEAD:apps/novad | cut -c1-12)"
got="$(bash "$SCRIPT_DIR/agent_version.sh" "$T")"; rc=$?
if [ "$rc" -eq 0 ] && [ "$got" = "$want" ] && [ "${#got}" -eq 12 ]; then
  report 0 "the version is exactly 12 hex of the apps/novad tree"
else
  report 1 "the version is exactly 12 hex of the apps/novad tree" "rc=$rc got='$got' want='$want'"
fi

echo two > "$T/docs/x.md" && git -C "$T" commit -qam two
got2="$(bash "$SCRIPT_DIR/agent_version.sh" "$T")"
[ "$got2" = "$got" ] && report 0 "a commit outside apps/novad keeps the version" \
  || report 1 "a commit outside apps/novad keeps the version" "$got2 != $got"

echo '// changed' >> "$T/apps/novad/main.go"
out="$(bash "$SCRIPT_DIR/agent_version.sh" "$T" 2>&1)"; rc=$?
if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q 'uncommitted'; then
  report 0 "uncommitted changes in apps/novad refuse (a stamp would lie)"
else
  report 1 "uncommitted changes in apps/novad refuse (a stamp would lie)" "rc=$rc out=$out"
fi

git -C "$T" commit -qam three
got3="$(bash "$SCRIPT_DIR/agent_version.sh" "$T")"
[ "$got3" != "$got" ] && report 0 "a commit inside apps/novad moves the version" \
  || report 1 "a commit inside apps/novad moves the version" "still $got3"

N="$(mktemp -d)"
out="$(bash "$SCRIPT_DIR/agent_version.sh" "$N" 2>&1)"; rc=$?
rm -rf "$N"
if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q 'not a git checkout'; then
  report 0 "outside a git checkout it says cannot"
else
  report 1 "outside a git checkout it says cannot" "rc=$rc out=$out"
fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
