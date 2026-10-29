#!/usr/bin/env bash
# Runs the latest merged main as a local preview, by default at http://localhost:4317 with its own
# data home (~/Nova-preview), so it never touches anyone's real Nova data. Safe to re-run after
# every merge: it fetches origin/main into a dedicated worktree of this clone (the clone's own
# checkout is left alone), installs, restarts the tmux session, and checks that it answers.
set -euo pipefail

CLONE="$(cd "$(git -C "$(dirname "$0")" rev-parse --path-format=absolute --git-common-dir)/.." && pwd)"
DIR="${NOVA_PREVIEW_DIR:-$CLONE/.claude/nova-preview}"
DATA="${NOVA_PREVIEW_HOME:-$HOME/Nova-preview}"
PORT="${NOVA_PREVIEW_PORT:-4317}"
SESSION="${NOVA_PREVIEW_SESSION:-nova-preview}"

git -C "$CLONE" fetch -q origin main
if [ -d "$DIR" ]; then
  git -C "$DIR" checkout -q --detach origin/main
else
  git -C "$CLONE" worktree add -q --detach "$DIR" origin/main
fi
cd "$DIR"
command -v mise >/dev/null && mise trust -q mise.toml >/dev/null 2>&1 && mise install -q >/dev/null 2>&1 || true
NODE="$( (command -v mise >/dev/null && mise which node 2>/dev/null) || command -v node)"
npm ci --omit=dev --no-audit --no-fund -q >/dev/null

tmux kill-session -t "$SESSION" 2>/dev/null || true
# Something else on the port is not ours to stop.
if ss -ltn 2>/dev/null | grep -qE "[:.]$PORT\b"; then
  echo "Port $PORT is in use by another process; not starting. (ss -ltnp | grep :$PORT)" >&2
  exit 1
fi
mkdir -p "$DATA"
tmux new-session -d -s "$SESSION" -c "$DIR" \
  "env NOVA_HOME='$DATA' NOVA_PORT='$PORT' '$NODE' src/server.js 2>&1 | tee -a '$DATA/preview.log'"

for _ in $(seq 1 60); do
  if health="$(curl -sf "http://localhost:$PORT/api/v1/health")"; then
    echo "Preview of main $(git rev-parse --short HEAD) is up: http://localhost:$PORT"
    echo "$health"
    exit 0
  fi
  sleep 0.5
done
echo "The preview didn't answer on port $PORT. Last log lines:" >&2
tail -20 "$DATA/preview.log" >&2
exit 1
