#!/bin/sh
# The `gate` job's decision (.github/workflows/ci.yml): the one required check. Reads the event, what
# the change touches (scripts/ci-changes.sh) and the other jobs' results from the environment, prints
# why, and exits 0 (pass) or 1 (fail). Tested in tests/ci-gate.test.js. docs/PIPELINE.md says it in words.
#
#   EVENT       pull_request | push (push runs only for main)
#   CHANGES     the changes job's result          HEAVY, UI_SURFACE  its heavy= and ui= outputs
#   CHECKS      lint · typecheck · themes · tests UI  the UI gate (all shards)   SHOTS  the walkthrough
#
# Passes only on:
#   docs only (heavy=false), any event      checks, UI gate and shots all skipped
#   pull request, heavy, UI surface         checks, UI gate and shots all success
#   pull request, heavy, no UI surface      checks success; UI gate and shots skipped (they run on
#                                           the push to main after the merge)
#   push to main, heavy                     checks, UI gate and shots all success
# Anything else fails: a failed, cancelled or unexpectedly skipped job, an unknown event or value.
set -u

CHANGES="${CHANGES:-}" HEAVY="${HEAVY:-}" UI_SURFACE="${UI_SURFACE:-}" EVENT="${EVENT:-}"
CHECKS="${CHECKS:-}" UI="${UI:-}" SHOTS="${SHOTS:-}"
echo "event: $EVENT · changes: $CHANGES · heavy: $HEAVY · UI surface: $UI_SURFACE · checks: $CHECKS · UI gate: $UI · shots: $SHOTS"

pass() { echo "PASS: $1"; exit 0; }
fail() { echo "FAIL: $1"; exit 1; }

[ "$CHANGES" = success ] || fail "The change couldn't be sorted."

case "$HEAVY" in
  false)
    [ "$CHECKS" = skipped ] && [ "$UI" = skipped ] && [ "$SHOTS" = skipped ] \
      || fail "Docs only, but the heavy jobs weren't skipped."
    pass "Docs only: the heavy jobs were skipped." ;;
  true) ;;
  *) fail "Unknown heavy value '$HEAVY'." ;;
esac

case "$EVENT" in
  push)
    [ "$CHECKS" = success ] && [ "$UI" = success ] && [ "$SHOTS" = success ] \
      || fail "Main: checks, the UI gate and shots must all pass."
    pass "Main: checks, the UI gate and shots passed." ;;
  pull_request) ;;
  *) fail "Unknown event '$EVENT'." ;;
esac

case "$UI_SURFACE" in
  true)
    [ "$CHECKS" = success ] && [ "$UI" = success ] && [ "$SHOTS" = success ] \
      || fail "UI pull request: checks, the UI gate and shots must all pass."
    pass "UI pull request: checks, the UI gate and shots passed." ;;
  false)
    [ "$CHECKS" = success ] || fail "Non-UI pull request: checks must pass."
    [ "$UI" = skipped ] && [ "$SHOTS" = skipped ] \
      || fail "Non-UI pull request, but the UI gate or shots weren't skipped."
    pass "Non-UI pull request: checks passed. The UI gate and shots run on the push to main after the merge, and their result is required before this work is done or deployed." ;;
  *) fail "Unknown UI surface value '$UI_SURFACE'." ;;
esac
