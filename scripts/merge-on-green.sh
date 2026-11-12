#!/usr/bin/env bash
# merge-on-green.sh PR [--wait-main]
# Merges a pull request when its exact head commit is green, and says what is still owed after the
# merge. The rules are in docs/PIPELINE.md (owner pipeline ruling, 2026-11-11):
#
#   1. Waits until no check on the PR is pending and the `gate` check exists for the PR's current
#      head commit. A gate on an older commit is not green.
#   2. Merge pause: refuses while an open issue labelled main-red exists, or the newest finished
#      push-to-main ci run's gate did not succeed, unless the PR body says "Fixes #N" (or
#      "Fixes main-red #N") for that open main-red issue: the fix forward.
#   3. Prints the PR type: UI (its gate included the UI gate and shots) or non-UI (the UI gate and
#      shots run on the push to main after the merge).
#   4. If the gate passed: merges with a merge commit (only if the head has not moved) and prints
#      `MERGED <sha>`. For a non-UI PR it then waits for main's run on the merge commit and prints
#      `MAIN-UI pass|fail <run url>`: that line is the evidence cited before the work is called done.
#      For a UI PR it prints main's result if there is one, or waits for it with --wait-main.
#   5. Otherwise prints NOT-GREEN and the failing checks.
#
# Exit: 0 merged (and, where waited for, main's UI run passed) · 1 not green · 2 usage or lookup
# error · 3 merges paused · 4 merged but main's UI run failed · 5 timed out waiting.
# Needs gh, logged in. Prints no tokens. Env: NOVA_REPO (default jeremyspofford/nova),
# POLL (seconds between looks, default 60), MAX_WAIT (seconds, default 10800).
set -uo pipefail

PR="${1:-}"
WAIT_MAIN=0
[ "${2:-}" = --wait-main ] && WAIT_MAIN=1
if ! [[ "$PR" =~ ^[0-9]+$ ]]; then
  echo "usage: scripts/merge-on-green.sh <PR number> [--wait-main]" >&2
  exit 2
fi
REPO="${NOVA_REPO:-jeremyspofford/nova}"
export GH_REPO="$REPO"
POLL="${POLL:-60}"
MAX_WAIT="${MAX_WAIT:-10800}"
START=$(date +%s)

waited_too_long() { [ $(( $(date +%s) - START )) -ge "$MAX_WAIT" ]; }

# The newest `gate` check run on a commit, as "status conclusion url" ("none" when there is none).
gate_on() {
  gh api "repos/$REPO/commits/$1/check-runs?check_name=gate&per_page=100" \
    --jq '[.check_runs[] | select(.app.slug == "github-actions")] | sort_by(.started_at) | last
          | if . == null then "none" else "\(.status) \(.conclusion // "-") \(.html_url)" end'
}

# The ci run on a commit pushed to main: its URL, or nothing yet.
main_run_url() {
  gh run list --workflow ci.yml --branch main --event push --commit "$1" --limit 1 --json url --jq '.[0].url // empty'
}

# On a main commit: "pass" when every UI gate shard and the shots job succeeded, "skipped" when all
# were skipped (a docs-only merge), else "fail".
main_ui_result() {
  gh api "repos/$REPO/commits/$1/check-runs?per_page=100" --paginate \
    --jq '.check_runs[] | select(.app.slug == "github-actions") | select(.name | startswith("UI gate") or startswith("shots")) | "\(.name)\t\(.conclusion)"' \
    | awk -F'\t' '{n++; if ($2 == "skipped") sk++; else if ($2 != "success") bad++} /^UI gate/ {ui++} /^shots/ {sh++}
                  END {if (n > 0 && sk == n) print "skipped"; else print (ui > 0 && sh > 0 && bad == 0 && sk == 0) ? "pass" : "fail"}'
}

# Waits for main's gate on a commit to finish, then prints MAIN-UI. Returns 0 pass, 4 fail, 5 timeout.
report_main() {
  local sha="$1" g status
  while :; do
    g=$(gate_on "$sha" 2>/dev/null) || g="none"
    status=${g%% *}
    if [ "$status" = completed ]; then break; fi
    if waited_too_long; then echo "MAIN-UI pending $(main_run_url "$sha") (timed out waiting)"; return 5; fi
    sleep "$POLL"
  done
  local url result
  url=$(main_run_url "$sha")
  result=$(main_ui_result "$sha")
  echo "MAIN-GATE $(echo "$g" | cut -d' ' -f2)"
  echo "MAIN-UI $result ${url:-(run url unavailable)}"
  # skipped: main's gate passed with every heavy job skipped, which only a docs-only change does.
  case "$result" in pass|skipped) return 0 ;; *) return 4 ;; esac
}

# 1. Wait for the PR's current head to have a finished gate and nothing pending.
while :; do
  HEAD=$(gh pr view "$PR" --json headRefOid --jq .headRefOid) || { echo "Can't read PR #$PR." >&2; exit 2; }
  STATE=$(gh pr view "$PR" --json state --jq .state)
  [ "$STATE" = OPEN ] || { echo "PR #$PR is $STATE, not open."; exit 2; }
  pending=$(gh pr checks "$PR" --json bucket --jq '[.[] | select(.bucket == "pending")] | length' 2>/dev/null || echo 1)
  gate=$(gate_on "$HEAD" 2>/dev/null) || gate="none"
  if [ "$pending" = 0 ] && [ "${gate%% *}" = completed ]; then break; fi
  if waited_too_long; then echo "Timed out waiting for PR #$PR's checks on ${HEAD:0:8}."; exit 5; fi
  sleep "$POLL"
done
GATE_CONCLUSION=$(echo "$gate" | cut -d' ' -f2)
echo "PR #$PR head ${HEAD:0:8}: gate $GATE_CONCLUSION ($(echo "$gate" | cut -d' ' -f3))"

# 2. Merge pause.
red_issue=$(gh issue list --label main-red --state open --json number --jq '.[0].number // empty')
last_main=$(gh run list --workflow ci.yml --branch main --event push --status completed --limit 1 --json headSha,url --jq '.[0] | "\(.headSha) \(.url)"')
last_main_sha=${last_main%% *}
last_main_gate=$(gate_on "$last_main_sha" 2>/dev/null | cut -d' ' -f2)
paused=""
[ -n "$red_issue" ] && paused="open main-red issue #$red_issue"
if [ -n "$last_main_sha" ] && [ "$last_main_gate" != success ]; then
  paused="${paused:+$paused; }newest finished main run at ${last_main_sha:0:8} has gate ${last_main_gate:-unknown} (${last_main#* })"
fi
if [ -n "$paused" ]; then
  body=$(gh pr view "$PR" --json body --jq .body)
  if [ -n "$red_issue" ] && printf '%s\n' "$body" | grep -Eiq "fixes (main-red )?#${red_issue}([^0-9]|$)"; then
    echo "Merges are paused ($paused), but this PR fixes main-red #$red_issue forward: going ahead."
  else
    echo "PAUSED: merges are paused until main is fixed forward: $paused."
    if [ -n "$red_issue" ]; then
      echo "Only a PR whose body says \"Fixes #$red_issue\" merges now."
    else
      echo "No main-red issue is open yet (the main-red job files it); wait for it, or for main to go green."
    fi
    exit 3
  fi
fi

# 3. PR type, from what its gate ran on this head: the UI gate ran (UI), the checks ran but the UI
# gate didn't (non-UI), or nothing heavy ran (docs only, unchanged by the 2026-11-11 ruling).
ran() {
  gh api "repos/$REPO/commits/$HEAD/check-runs?per_page=100" --paginate \
    --jq "[.check_runs[] | select(.app.slug == \"github-actions\") | select(.name | startswith(\"$1\")) | select(.conclusion != \"skipped\")] | length" \
    | awk '{s += $1} END {print s + 0}'
}
if [ "$(ran 'UI gate')" -gt 0 ]; then TYPE=UI
elif [ "$(ran 'lint')" -gt 0 ]; then TYPE=non-UI
else TYPE=docs-only
fi
case "$TYPE" in
  UI) echo "TYPE UI: its gate included the UI gate and shots." ;;
  non-UI) echo "TYPE non-UI: the UI gate and shots run on the push to main after the merge; their result is owed before this is done or deployed." ;;
  docs-only) echo "TYPE docs-only: no heavy job ran, here or on main." ;;
esac

# 5. Not green.
if [ "$GATE_CONCLUSION" != success ]; then
  echo NOT-GREEN
  gh pr checks "$PR" --json name,bucket,link --jq '.[] | select(.bucket == "fail" or .bucket == "cancel") | "\(.name)\t\(.bucket)\t\(.link)"'
  exit 1
fi

# 4. Merge, exactly this head.
if ! gh pr merge "$PR" --merge --match-head-commit "$HEAD" >/dev/null; then
  echo "Merge refused (the head may have moved past ${HEAD:0:8}); run again."
  exit 1
fi
MERGE_SHA=$(gh pr view "$PR" --json mergeCommit --jq .mergeCommit.oid)
echo "MERGED $MERGE_SHA"

if [ "$TYPE" = non-UI ] || [ "$WAIT_MAIN" = 1 ]; then
  report_main "$MERGE_SHA"
  exit $?
fi
# A UI PR: main's run has only just started. Its result, if there is one already.
g=$(gate_on "$MERGE_SHA" 2>/dev/null) || g="none"
if [ "${g%% *}" = completed ]; then
  echo "MAIN-UI $(main_ui_result "$MERGE_SHA") $(main_run_url "$MERGE_SHA")"
else
  echo "MAIN-UI pending $(main_run_url "$MERGE_SHA") (run again with --wait-main to wait for it)"
fi
exit 0
