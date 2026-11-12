#!/bin/bash
# Nova preview deploy watcher: redeploys the preview on every origin/main change.
# Installed by Muse 2026-11-08 after six merges landed without a redeploy.
#
# Canonical copy (owner pipeline ruling, 2026-11-11; docs/PIPELINE.md): it deploys the newest
# origin/main commit whose push-run `gate` check concluded success, never one whose main gate did
# not pass. If the newest main commit's gate is still running it waits; if it failed, the preview
# stays on the last green commit and the log says so once. A non-UI merge's UI gate runs only on
# main, so waiting for main's gate is what keeps an untested UI from reaching the preview.
# deploy/latest.json still records the newest origin/main commit (with its merge time) whenever it
# changes, deployed or not, as before: /api/v1/version (src/core/build.ts) compares it with the
# running commit, so while main's newest merge is pending or red the preview honestly says it is
# behind the latest merged build ("redeploy pending") instead of claiming to be it. Only the
# checkout and restart follow the green rule.
# The host runs its own copy (~/Nova-preview/deploy-watch.sh in tmux session deploy-watch);
# install this one there after it merges.
WT=/home/jeremy/workspace/nova-build/.claude/nova-preview
NOVA_HOME_DIR=/home/jeremy/Nova-preview
LOG=$NOVA_HOME_DIR/deploy-watch.log
NODE=/home/jeremy/.local/share/mise/installs/node/26.3.1/bin/node
REPO=jeremyspofford/nova
# How far back along main to look for the newest green commit.
LOOKBACK=20
cd "$WT" || exit 1
echo "[$(date -Is)] watcher started" >> "$LOG"

# Logs a line only when it differs from the last one logged this way (a pending or red main is
# looked at every 120 s; it is said once).
LAST_NOTE=""
note() { [ "$1" = "$LAST_NOTE" ] && return; LAST_NOTE=$1; echo "[$(date -Is)] $1" >> "$LOG"; }

# The newest gate check run on a main commit: success | failure | … | pending | unknown.
gate_of() {
  local out
  out=$(gh api "repos/$REPO/commits/$1/check-runs?check_name=gate&per_page=100" \
    --jq '[.check_runs[] | select(.app.slug == "github-actions")] | sort_by(.started_at) | last
          | if . == null then "pending" elif .status != "completed" then "pending" else (.conclusion // "unknown") end' 2>/dev/null) \
    || { echo unknown; return; }
  echo "${out:-unknown}"
}

# The newest origin/main commit last written to deploy/latest.json by this watcher.
RECORDED=""
while true; do
  git fetch origin --quiet 2>/dev/null
  REMOTE=$(git rev-parse origin/main 2>/dev/null)
  LOCAL=$(git rev-parse HEAD 2>/dev/null)
  # The latest merged build, whether or not it is deployed (merged is not served).
  if [ -n "$REMOTE" ] && [ "$REMOTE" != "$RECORDED" ]; then
    MT=$(git log -1 --format=%cI "$REMOTE")
    printf '{"commit":"%s","merged_at":"%s","source":"deploy-watcher"}\n' "$REMOTE" "$MT" > "$NOVA_HOME_DIR/deploy/latest.json"
    RECORDED=$REMOTE
  fi
  if [ -n "$REMOTE" ] && [ "$REMOTE" != "$LOCAL" ]; then
    TIP_GATE=$(gate_of "$REMOTE")
    TARGET=""
    if [ "$TIP_GATE" = success ]; then
      TARGET=$REMOTE
    elif [ "$TIP_GATE" = pending ] || [ "$TIP_GATE" = unknown ]; then
      note "main ${REMOTE:0:8}: gate $TIP_GATE, waiting; preview stays on ${LOCAL:0:8}"
    else
      # The tip is red: the newest green commit after the one deployed, if any (first parents only:
      # main's merge commits, each with its own push run).
      for c in $(git rev-list --first-parent --max-count="$LOOKBACK" "$REMOTE" 2>/dev/null); do
        [ "$c" = "$LOCAL" ] && break
        [ "$c" = "$REMOTE" ] && continue
        if [ "$(gate_of "$c")" = success ]; then TARGET=$c; break; fi
      done
      if [ -n "$TARGET" ]; then
        note "main ${REMOTE:0:8}: gate $TIP_GATE, not deployed; preview moves to the newest green, ${TARGET:0:8}"
      else
        note "main ${REMOTE:0:8}: gate $TIP_GATE, not deployed; preview stays on the last green, ${LOCAL:0:8}"
      fi
    fi
    if [ -n "$TARGET" ] && [ "$TARGET" != "$LOCAL" ]; then
      if git checkout --quiet "$TARGET" 2>>"$LOG"; then
        tmux kill-session -t nova-preview 2>/dev/null
        sleep 1
        tmux new-session -d -s nova-preview -c "$WT" "env NOVA_HOME='$NOVA_HOME_DIR' NOVA_PORT='4318' NOVA_INSTANCE=preview NOVA_MESH_URL='http://127.0.0.1:4320' NOVA_MESH_TRANSPORT='proxy' NOVA_MESH_PUBLIC_URL='https://dell-xps-8950-windows.tailba0abb.ts.net:9446' '$NODE' src/server.js 2>&1 | tee -a '$NOVA_HOME_DIR/preview.log'"
        echo "[$(date -Is)] redeployed $LOCAL -> $TARGET (main gate success)" >> "$LOG"
        LAST_NOTE=""
      else
        echo "[$(date -Is)] checkout to $TARGET FAILED, preview left on $LOCAL" >> "$LOG"
      fi
    fi
  fi
  sleep 120
done
