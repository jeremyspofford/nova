#!/bin/sh
# The tailnet sidecar's entrypoint (deploy/docker-compose.yml, service
# `tailscale`): run containerboot, then apply the ONE serve mapping this node
# exists for and refuse to call the container up until tailscaled says the
# mapping is there.
#
# Why a wrapper and not TS_SERVE_CONFIG: containerboot's own serve path
# clears the node's serve config on EVERY start and re-applies it
# asynchronously from an fsnotify watch on the config file's parent
# directory — a racy path with an open upstream bug (tailscale/tailscale
# #19693, #14559) that reproduced here on 2026-09-03 as "No serve config"
# after a restart. With the CLI the config persists in the state store, and
# two writers (containerboot's watcher and us) would race each other, so
# there is exactly one writer: this script, on every start, after the
# backend is Running. `tailscale serve --bg` with the same mapping is
# idempotent, so a restart of an already-configured node is a no-op that is
# still verified. (One consequence, v1.102.3: `serve --bg` also turns
# funnel OFF for the port — "Removing Funnel" — so funnel does not survive a
# restart; keeping it needs a wrapper flag, a carry.)
#
# The target is web's FIXED address (NOVA_WEB_ADDR), never a name: a
# recreated web keeps its address, so nothing here goes stale.
#
# Sequence, each step checked:
#   1. containerboot in the background (it runs tailscaled, logs in with
#      TS_AUTHKEY when the state on the volume is not already logged in —
#      TS_AUTH_ONCE — and keeps the node up). SIGTERM/SIGINT are forwarded
#      to it so `docker stop` reaches tailscaled, and its exit status becomes
#      the container's.
#   2. Wait — bounded by NOVA_TAILSCALE_READY_TIMEOUT seconds (default 120)
#      — for `tailscale status --json` to report BackendState "Running". On
#      timeout, or if containerboot dies first, print WHY (the last state,
#      tailscaled's Health lines, the login URL if it is waiting for one),
#      stop containerboot, and exit non-zero. NeedsLogin with a login URL and
#      NO TS_AUTHKEY never resolves on its own (nobody can click through a
#      restarting container), so that exits at once with the URL printed.
#   3. `timeout` + `tailscale serve --bg --https=443 http://$NOVA_WEB_ADDR:80`.
#      Bounded (NOVA_TAILSCALE_SERVE_TIMEOUT, default 60s) because on a
#      tailnet WITHOUT HTTPS certificates enabled the CLI blocks forever
#      waiting on the IPN bus — a red healthcheck and no exit, no reason.
#   4. READ `tailscale serve status --json` (serve_check.sh, the same code
#      the compose healthcheck runs) and exit non-zero if the mapping is not
#      there. Never reports success it did not check.
#   5. `wait` on containerboot.
#
# POSIX sh (the image is Alpine/busybox). Mounted from the DIRECTORY
# deploy/tailscale — never a single-file bind, which resolves to a host
# inode at create time and dies with exit 127 when the mount is recycled.
set -u

CONFIG_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=serve_check.sh
. "$CONFIG_DIR/serve_check.sh"

READY_TIMEOUT="${NOVA_TAILSCALE_READY_TIMEOUT:-120}"
SERVE_TIMEOUT="${NOVA_TAILSCALE_SERVE_TIMEOUT:-60}"
POLL_INTERVAL=2
# How long containerboot gets after TERM before it is killed, when THIS
# script is the one stopping it (a failure path, not `docker stop`).
STOP_GRACE=15

log() { printf 'nova-tailscale: %s\n' "$*" >&2; }

TARGET="$(serve_target)" || {
  log "refusing to start: NOVA_WEB_ADDR is not set (deploy/docker-compose.yml passes it)"
  exit 1
}

# ---- 1. containerboot, with signals forwarded --------------------------------

containerboot &
CB=$!

forward() {
  kill -"$1" "$CB" 2>/dev/null || true
}
trap 'forward TERM' TERM
trap 'forward INT' INT

# containerboot's exit status becomes ours. A trapped signal returns from
# `wait` early (status > 128) while the child may still be running, so wait
# again until it is actually gone; never `wait` twice on a reaped pid (that
# reads as 127 in busybox/dash).
wait_for_containerboot() {
  wait "$CB"
  rc=$?
  while kill -0 "$CB" 2>/dev/null; do
    wait "$CB"
    rc=$?
  done
  return "$rc"
}

fail() {
  log "$1"
  forward TERM
  i=0
  while kill -0 "$CB" 2>/dev/null && [ "$i" -lt "$STOP_GRACE" ]; do
    sleep 1
    i=$((i + 1))
  done
  if kill -0 "$CB" 2>/dev/null; then
    log "containerboot did not exit within ${STOP_GRACE}s of TERM — killing it"
    forward KILL
  fi
  wait_for_containerboot || true
  exit "${2:-1}"
}

# ---- 2. wait for BackendState Running, bounded -------------------------------

started="$(date +%s)"
state=""
while :; do
  if ! kill -0 "$CB" 2>/dev/null; then
    wait_for_containerboot
    rc=$?
    [ "$rc" -eq 0 ] && rc=1
    log "containerboot exited (status $rc) before tailscaled reported Running (last state: ${state:-unknown})"
    explain_not_running
    exit "$rc"
  fi
  status="$(tailscale status --json 2>/dev/null)"
  state="$(printf '%s\n' "$status" | json_string BackendState)"
  if [ "$state" = "Running" ]; then
    break
  fi
  if [ "$state" = "NeedsLogin" ] && [ -z "${TS_AUTHKEY:-}" ]; then
    url="$(printf '%s\n' "$status" | json_string AuthURL)"
    if [ -n "$url" ]; then
      log "tailscaled is waiting for an interactive login and no TS_AUTHKEY is set — this never resolves on its own"
      log "  login URL: $url"
      fail "set TS_AUTHKEY in deploy/.env (https://login.tailscale.com/admin/settings/keys), or migrate a logged-in node's state onto the volume, then restart the service"
    fi
  fi
  now="$(date +%s)"
  if [ $((now - started)) -ge "$READY_TIMEOUT" ]; then
    log "tailscaled did not reach BackendState Running within ${READY_TIMEOUT}s (last state: ${state:-unknown})"
    explain_not_running
    fail "giving up — fix the login (TS_AUTHKEY in deploy/.env, or the node state on the volume) and restart the service"
  fi
  sleep "$POLL_INTERVAL"
done
log "tailscaled is Running as $(dns_name)"

# ---- 3. apply the mapping, bounded -------------------------------------------

log "applying: tailscale serve --bg --https=443 $TARGET (timeout ${SERVE_TIMEOUT}s)"
serve_started="$(date +%s)"
serve_out="$(timeout "$SERVE_TIMEOUT" tailscale serve --bg --https=443 "$TARGET" 2>&1)" && serve_rc=0 || serve_rc=$?
serve_took=$(( $(date +%s) - serve_started ))
if [ "$serve_rc" -eq 0 ]; then
  printf '%s\n' "$serve_out" | sed 's/^/  serve: /' >&2
else
  # busybox `timeout` reports the killed child's status (143 = TERM); GNU
  # reports 124. Either one after the full bound is the hang.
  if { [ "$serve_rc" -eq 143 ] || [ "$serve_rc" -eq 124 ]; } && [ "$serve_took" -ge "$SERVE_TIMEOUT" ]; then
    log "tailscale serve did not return within ${SERVE_TIMEOUT}s. It blocks like this when the tailnet has no"
    log "  HTTPS Certificates enabled (the control plane answers 'wait'): enable them in the"
    log "  admin console (DNS -> HTTPS Certificates), then restart this service."
    printf '%s\n' "$serve_out" | sed 's/^/  serve: /' >&2
    fail "the serve mapping could not be applied; this container is not up"
  fi
  log "tailscale serve exited non-zero ($serve_rc):"
  printf '%s\n' "$serve_out" | sed 's/^/  serve: /' >&2
fi

# ---- 4. verify it is there, or refuse to be up --------------------------------

if ! verdict="$(serve_ok)"; then
  fail "the serve mapping is not in place; this container is not up"
fi
log "$verdict"

# ---- 5. containerboot's exit is ours ----------------------------------------

wait_for_containerboot
exit $?
