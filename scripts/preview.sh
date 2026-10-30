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
# Optional: the device door (M4's mesh listener), so phones can pair through a TLS proxy such as
# Tailscale Serve. It stays on this machine (loopback only); the proxy in front carries TLS:
#   NOVA_PREVIEW_MESH_URL=http://127.0.0.1:4320 \
#   NOVA_PREVIEW_MESH_PUBLIC_URL=https://<machine>.<tailnet>.ts.net:<port> scripts/preview.sh
# Never point a proxy at the console port itself: whoever reaches that controls Nova completely.
MESH_URL="${NOVA_PREVIEW_MESH_URL:-}"
MESH_PUBLIC="${NOVA_PREVIEW_MESH_PUBLIC_URL:-}"
MESH_ENV=""
if [ -n "$MESH_URL" ]; then
  case "$MESH_URL" in
    http://127.0.0.1:*|http://localhost:*) ;;
    *) echo "NOVA_PREVIEW_MESH_URL must be on this machine (http://127.0.0.1:<port>); the proxy in front carries TLS." >&2; exit 1 ;;
  esac
  case "$MESH_PUBLIC" in
    https://*) ;;
    *) echo "NOVA_PREVIEW_MESH_URL needs NOVA_PREVIEW_MESH_PUBLIC_URL: the https address devices use (the proxy's)." >&2; exit 1 ;;
  esac
  MESH_ENV="NOVA_MESH_URL='$MESH_URL' NOVA_MESH_TRANSPORT='proxy' NOVA_MESH_PUBLIC_URL='$MESH_PUBLIC'"
fi

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
# The old server needs a moment to let go of the port after its session ends.
for _ in $(seq 50); do ss -ltn 2>/dev/null | grep -qE "[:.]$PORT\b" || break; sleep 0.1; done
# Something else on the port is not ours to stop.
if ss -ltn 2>/dev/null | grep -qE "[:.]$PORT\b"; then
  echo "Port $PORT is in use by another process; not starting. (ss -ltnp | grep :$PORT)" >&2
  exit 1
fi
mkdir -p "$DATA"
tmux new-session -d -s "$SESSION" -c "$DIR" \
  "env NOVA_HOME='$DATA' NOVA_PORT='$PORT' $MESH_ENV '$NODE' src/server.js 2>&1 | tee -a '$DATA/preview.log'"

for _ in $(seq 1 60); do
  if health="$(curl -sf "http://localhost:$PORT/api/v1/health")"; then
    echo "Preview of main $(git rev-parse --short HEAD) is up: http://localhost:$PORT"
    [ -n "$MESH_URL" ] && echo "Devices pair at $MESH_PUBLIC (listening on $MESH_URL)"
    echo "$health"
    exit 0
  fi
  sleep 0.5
done
echo "The preview didn't answer on port $PORT. Last log lines:" >&2
tail -20 "$DATA/preview.log" >&2
exit 1
