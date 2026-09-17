#!/usr/bin/env bash
# Tests for the tailnet sidecar's wrapper (start.sh + serve_check.sh) and for
# the compose service that runs it — the CI stand-ins for the one thing this
# box cannot do: log a node in. A logged-in node (restart → mapping still
# there, a phone on the tailnet) is the owner's walk, slice-05b T3.
#
# Two halves:
#
#   1. The wrapper, run INSIDE the pinned image (its busybox sh, grep, sed,
#      tr — the real environment) against a FAKE `tailscale` and
#      `containerboot` placed first on PATH. The fakes answer `status --json`
#      and `serve status [--json]` from env vars in the exact shapes the real
#      CLI prints (the status shape measured against v1.102.3 logged out; the
#      serve config shape is ipn.ServeConfig's JSON) and record every call.
#        - never Running       → exits non-zero within the bound, says why
#                                (state, Health line, login URL), stops
#                                containerboot, never touches serve
#        - Running, no mapping → non-zero with the reason, serve's own error
#                                echoed, containerboot stopped
#        - Running, a STALE mapping (another target) → non-zero, the stale
#                                target shown
#        - Running after a few polls, mapping applied → serve invoked with
#                                http://<NOVA_WEB_ADDR>:80, the script stays
#                                up, SIGTERM reaches containerboot and its
#                                status becomes the script's
#        - containerboot dies first → exits with its status at once, not
#                                after the bound
#        - NOVA_WEB_ADDR blank → refuses before starting anything
#      serve_check.sh alone (the compose healthcheck) on the same fakes, and
#      once against the REAL tailscaled (userspace, memory state, logged
#      out) so the JSON parsing is proven on real output for the not-Running
#      path.
#
#   2. The compose service: `docker compose create` (created, never started)
#      under a throwaway project on its own subnet, then `docker inspect` for
#      the shape the plan pins — an ordinary container (no network_mode
#      container:), the state volume at /var/lib/tailscale, the wrapper's
#      DIRECTORY mounted read-only at /config, the fixed address, the pinned
#      image, TS_HOSTNAME from .env, no TS_SERVE_CONFIG — plus `compose
#      config` tripwires on the same facts.
#
# Needs docker with compose v2; the image is pulled if absent. Nothing it
# creates carries the live stack's name: compose project `s5b-t1` on
# 172.29.0.0/16 (refuses up front if that subnet is taken), containers
# `s5b-t1-wrap-*`, all removed on exit, success or failure.
#
#     deploy/tailscale/start_test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$DEPLOY_DIR/docker-compose.yml"
PROJECT="${S5B_T1_PROJECT:-s5b-t1}"
NET="${PROJECT}_default"
SUBNET="172.29.0.0/16"
IP_RANGE="172.29.0.0/17"
GATEWAY="172.29.0.1"
WEB_ADDR="172.29.128.10"
TS_ADDR="172.29.128.20"
NODE_NAME="s5b-t1-node"
# The wrapper's target in the fake runs: nothing is dialled, the fakes only
# echo it back, so any address will do — one that is obviously not real.
FAKE_WEB_ADDR="10.77.0.10"
FAKE_TARGET="http://${FAKE_WEB_ADDR}:80"
# Seconds the wrapper is allowed to wait for Running in the negative cases.
BOUND=4
TMP=""
PASS=0
FAIL=0

report() {
  if [ "$1" -eq 0 ]; then
    PASS=$((PASS + 1))
    printf 'ok   %s\n' "$2"
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL %s\n     %s\n' "$2" "${3:-}"
  fi
}

finish() {
  printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
  [ "$FAIL" -eq 0 ]
}

# A preflight failure is a FAIL with its reason, then the counts — never a
# silent exit 0 and never a skip that reads as success.
die() {
  report 1 "$1" "${2:-}"
  finish
  exit 1
}

cleanup() {
  local ids
  ids="$(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT" 2>/dev/null)"
  [ -n "$ids" ] && printf '%s\n' "$ids" | xargs docker rm -f >/dev/null 2>&1
  ids="$(docker ps -aq --filter "name=^${PROJECT}-wrap-" 2>/dev/null)"
  [ -n "$ids" ] && printf '%s\n' "$ids" | xargs docker rm -f >/dev/null 2>&1
  docker volume rm "${PROJECT}_v4_tailscale" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  [ -n "$TMP" ] && rm -rf "$TMP"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# `key=value` lines from a driver run.
field() {
  printf '%s\n' "$1" | sed -n "s/^$2=//p" | head -n 1
}

expect_eq() {
  local name="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then report 0 "$name"; else report 1 "$name" "got '$got', wanted '$want'"; fi
}

expect_contains() {
  local name="$1" hay="$2" needle="$3"
  case "$hay" in
    *"$needle"*) report 0 "$name" ;;
    *) report 1 "$name" "did not contain '$needle' — got: $(printf '%s' "$hay" | tr '\n' ' ' | cut -c1-600)" ;;
  esac
}

expect_lacks() {
  local name="$1" hay="$2" needle="$3"
  case "$hay" in
    *"$needle"*) report 1 "$name" "contained '$needle' — got: $(printf '%s' "$hay" | tr '\n' ' ' | cut -c1-600)" ;;
    *) report 0 "$name" ;;
  esac
}

expect_le() {
  local name="$1" got="$2" max="$3"
  if [ -n "$got" ] && [ "$got" -le "$max" ] 2>/dev/null; then report 0 "$name"; else report 1 "$name" "got '$got', wanted <= $max"; fi
}

# ── preflight ───────────────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || die "preflight: docker on PATH" "docker not found"
if ! err="$(docker info 2>&1 >/dev/null)"; then
  die "preflight: docker daemon reachable" "$err"
fi
if ! ver="$(docker compose version --short 2>&1)"; then
  die "preflight: docker compose v2 available" "$ver"
fi

# The image under test is the one the compose file pins — one source.
IMAGE="$(sed -n 's/^ *image: *\(tailscale\/tailscale:[^ ]*\).*/\1/p' "$COMPOSE_FILE" | head -n 1)"
[ -n "$IMAGE" ] || die "preflight: tailscale image named in $COMPOSE_FILE" "no 'image: tailscale/tailscale:...' line"
case "$IMAGE" in
  *:latest | tailscale/tailscale) die "tripwire: the tailscale image is pinned" "$IMAGE" ;;
  *) report 0 "tripwire: the tailscale image is pinned ($IMAGE)" ;;
esac
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  if ! err="$(docker pull "$IMAGE" 2>&1)"; then
    die "preflight: $IMAGE present" "$err"
  fi
fi

cleanup
TMP="$(mktemp -d)"
mkdir -p "$TMP/fakes"

# ── the fakes ───────────────────────────────────────────────────────────────
cat > "$TMP/fakes/tailscale" <<'FAKE'
#!/bin/sh
# Fake `tailscale` CLI. Records every call; answers from FAKE_* env vars.
#   FAKE_STATE          BackendState to report (NeedsLogin, Running, ...)
#   FAKE_RUNNING_AFTER  report NeedsLogin until the Nth `status --json` call
#   FAKE_AUTH_URL       AuthURL to report
#   FAKE_HEALTH         one Health line to report
#   FAKE_SERVE_APPLIES  "no" makes `serve --bg` fail like a tailnet without
#                       HTTPS certificates (and change nothing)
#   FAKE_SERVE_HANGS    "yes" makes `serve --bg` block forever (the real CLI
#                       when control answers "wait")
#   FAKE_SERVE_TARGET   a mapping `serve status` reports regardless of what
#                       was applied (a stale one)
printf '%s\n' "$*" >> "$FAKE_DIR/tailscale.calls"
case "${1:-}" in
  status)
    state="${FAKE_STATE:-NeedsLogin}"
    if [ -n "${FAKE_RUNNING_AFTER:-}" ]; then
      n="$(grep -c '^status --json$' "$FAKE_DIR/tailscale.calls")"
      if [ "$n" -ge "$FAKE_RUNNING_AFTER" ]; then state=Running; else state=NeedsLogin; fi
    fi
    printf '{\n  "Version": "fake",\n  "BackendState": "%s",\n  "AuthURL": "%s",\n  "Self": {\n    "HostName": "nova",\n    "DNSName": "nova.fake-tailnet.ts.net."\n  },\n  "CertDomains": [\n    "nova.fake-tailnet.ts.net"\n  ],\n  "Health": [\n    "%s"\n  ]\n}\n' \
      "$state" "${FAKE_AUTH_URL:-}" "${FAKE_HEALTH:-Tailscale is stopped.}"
    ;;
  serve)
    case "${2:-}" in
      --bg)
        # $3 = --https=443, $4 = target
        if [ "${FAKE_SERVE_APPLIES:-yes}" = "no" ]; then
          echo "error: Tailscale Serve requires HTTPS certificates to be enabled (fake)" >&2
          exit 1
        fi
        # The real CLI on a tailnet without the HTTPS cap: blocks forever.
        if [ "${FAKE_SERVE_HANGS:-}" = "yes" ]; then
          exec sleep 300
        fi
        printf '%s' "${4:-}" > "$FAKE_DIR/serve.applied"
        printf 'Available within your tailnet:\n\nhttps://nova.fake-tailnet.ts.net/\n|-- proxy %s\n' "${4:-}"
        ;;
      status)
        target=""
        [ -f "$FAKE_DIR/serve.applied" ] && target="$(cat "$FAKE_DIR/serve.applied")"
        [ -n "${FAKE_SERVE_TARGET:-}" ] && target="$FAKE_SERVE_TARGET"
        if [ -z "$target" ]; then
          if [ "${3:-}" = "--json" ]; then echo '{}'; else echo "No serve config"; fi
        elif [ "${3:-}" = "--json" ]; then
          printf '{\n  "TCP": {\n    "443": {\n      "HTTPS": true\n    }\n  },\n  "Web": {\n    "nova.fake-tailnet.ts.net:443": {\n      "Handlers": {\n        "/": {\n          "Proxy": "%s"\n        }\n      }\n    }\n  }\n}\n' "$target"
        else
          printf 'https://nova.fake-tailnet.ts.net (tailnet only)\n|-- / proxy %s\n' "$target"
        fi
        ;;
    esac
    ;;
esac
FAKE

cat > "$TMP/fakes/containerboot" <<'FAKE'
#!/bin/sh
# Fake containerboot: records its pid and any TERM it receives, then idles.
# It exits 37 on TERM — deliberately NOT 143, which is also what busybox
# `wait` returns when a trapped signal interrupts it, so a wrapper that
# dropped the child's real status could not be told apart.
# FAKE_CB_EXIT=<n> makes it die with that status after a second instead.
echo $$ > "$FAKE_DIR/cb.pid"
trap 'echo TERM >> "$FAKE_DIR/cb.signals"; exit 37' TERM
if [ -n "${FAKE_CB_EXIT:-}" ]; then
  sleep 1
  exit "$FAKE_CB_EXIT"
fi
while :; do sleep 1; done
FAKE

cat > "$TMP/fakes/driver.sh" <<'FAKE'
#!/bin/sh
# Runs inside the image. CASE picks the shape; everything measured is printed
# as key=value lines, then the wrapper's own output.
FAKE_DIR=/tmp/fake
export FAKE_DIR
mkdir -p "$FAKE_DIR"
start="$(date +%s)"
case "$CASE" in
  stays-up)
    sh /config/start.sh > "$FAKE_DIR/out" 2>&1 &
    W=$!
    i=0
    while [ ! -f "$FAKE_DIR/serve.applied" ] && [ "$i" -lt 60 ]; do sleep 0.5; i=$((i + 1)); done
    sleep 2
    if kill -0 "$W" 2>/dev/null; then echo "wrapper_alive=yes"; else echo "wrapper_alive=no"; fi
    kill -TERM "$W"
    wait "$W"
    rc=$?
    sleep 1
    cb="$(cat "$FAKE_DIR/cb.pid" 2>/dev/null)"
    if [ -n "$cb" ] && kill -0 "$cb" 2>/dev/null; then echo "cb_alive=yes"; else echo "cb_alive=no"; fi
    ;;
  term-while-waiting)
    sh /config/start.sh > "$FAKE_DIR/out" 2>&1 &
    W=$!
    sleep 3
    kill -TERM "$W"
    wait "$W"
    rc=$?
    ;;
  check-*)
    sh /config/serve_check.sh > "$FAKE_DIR/out" 2>&1
    rc=$?
    ;;
  real-containerboot)
    # No fakes on PATH: the real containerboot + tailscaled, userspace, no
    # network at all, no key — NeedsLogin for as long as the bound allows.
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
    export PATH
    mkdir -p "${TS_STATE_DIR:-/tmp/ts-state}"
    sh /config/start.sh > "$FAKE_DIR/out" 2>&1
    rc=$?
    echo "health_lines=$(grep -c '^  health:' "$FAKE_DIR/out")"
    echo "peer_in_health=$(grep '^  health:' "$FAKE_DIR/out" | grep -c '"Peer"')"
    ;;
  real-logged-out)
    # No fakes on PATH: the real tailscaled, userspace networking, memory
    # state, never logged in.
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
    export PATH
    mkdir -p /var/run/tailscale
    tailscaled --tun=userspace-networking --state=mem: > "$FAKE_DIR/tailscaled.log" 2>&1 &
    i=0
    while ! tailscale status --json > /dev/null 2>&1 && [ "$i" -lt 40 ]; do sleep 0.5; i=$((i + 1)); done
    sh /config/serve_check.sh > "$FAKE_DIR/out" 2>&1
    rc=$?
    echo "real_state=$(tailscale status --json 2>/dev/null | grep -o '"BackendState": *"[^"]*"' | head -n 1)"
    echo "real_serve=$(tailscale serve status --json 2>/dev/null | tr -d ' \n')"
    ;;
  *)
    sh /config/start.sh > "$FAKE_DIR/out" 2>&1
    rc=$?
    ;;
esac
echo "rc=$rc"
echo "elapsed=$(( $(date +%s) - start ))"
echo "cb_signals=$(tr '\n' ',' < "$FAKE_DIR/cb.signals" 2>/dev/null)"
echo "serve_applied=$(cat "$FAKE_DIR/serve.applied" 2>/dev/null)"
echo "status_calls=$(grep -c '^status --json$' "$FAKE_DIR/tailscale.calls" 2>/dev/null)"
echo "serve_calls=$(grep '^serve --bg' "$FAKE_DIR/tailscale.calls" 2>/dev/null | tr '\n' ';')"
echo "--- output"
cat "$FAKE_DIR/out"
FAKE
chmod +x "$TMP/fakes/tailscale" "$TMP/fakes/containerboot" "$TMP/fakes/driver.sh"

# $1 = CASE; the rest are extra `docker run` args (-e FAKE_...=...).
# CASE_BOUND=<s> in the environment overrides the wrapper's ready bound.
run_wrapper() {
  local name="$1"
  shift
  timeout 150 docker run --rm --name "${PROJECT}-wrap-$name" \
    -e CASE="$name" -e NOVA_WEB_ADDR="$FAKE_WEB_ADDR" -e NOVA_TAILSCALE_READY_TIMEOUT="${CASE_BOUND:-$BOUND}" \
    -e PATH=/fakes:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    "$@" \
    -v "$TMP/fakes:/fakes:ro" -v "$SCRIPT_DIR:/config:ro" \
    --entrypoint sh "$IMAGE" /fakes/driver.sh 2>&1
}

# ── 1a. never Running: bounded, explained, containerboot stopped ─────────────
OUT="$(run_wrapper never-running -e FAKE_STATE=NeedsLogin)"
expect_eq "never Running: exits non-zero" "$(field "$OUT" rc)" 1
expect_le "never Running: within the bound (${BOUND}s + slack)" "$(field "$OUT" elapsed)" $((BOUND + 8))
expect_contains "never Running: names the bound" "$OUT" "did not reach BackendState Running within ${BOUND}s"
expect_contains "never Running: names the last state" "$OUT" "last state: NeedsLogin"
expect_contains "never Running: prints tailscaled's Health line" "$OUT" "health: \"Tailscale is stopped.\""
expect_contains "never Running: containerboot was sent TERM" "$(field "$OUT" cb_signals)" "TERM"
expect_eq "never Running: serve was never invoked" "$(field "$OUT" serve_calls)" ""
expect_contains "never Running: says what would fix it" "$OUT" "TS_AUTHKEY"

# ── 1a'. NeedsLogin with a login URL and no key: never resolves, exit NOW ───
OUT="$(CASE_BOUND=30 run_wrapper needs-login-url -e FAKE_STATE=NeedsLogin -e FAKE_AUTH_URL=https://login.tailscale.com/a/fake123)"
expect_eq "login URL, no key: exits non-zero" "$(field "$OUT" rc)" 1
expect_le "login URL, no key: at once, not after the 30s bound" "$(field "$OUT" elapsed)" 8
expect_contains "login URL, no key: prints the URL" "$OUT" "login URL: https://login.tailscale.com/a/fake123"
expect_contains "login URL, no key: says why it will not wait" "$OUT" "never resolves on its own"
expect_contains "login URL, no key: names the fix" "$OUT" "set TS_AUTHKEY in deploy/.env"
expect_contains "login URL, no key: containerboot was sent TERM" "$(field "$OUT" cb_signals)" "TERM"
expect_eq "login URL, no key: serve was never invoked" "$(field "$OUT" serve_calls)" ""
# With a key set the login is containerboot's to finish: wait the bound.
OUT="$(run_wrapper key-set-url -e FAKE_STATE=NeedsLogin -e FAKE_AUTH_URL=https://login.tailscale.com/a/fake123 -e TS_AUTHKEY=tskey-auth-fake)"
expect_eq "login URL with a key: exits non-zero at the bound" "$(field "$OUT" rc)" 1
if [ "$(field "$OUT" elapsed)" -ge "$BOUND" ] 2>/dev/null; then
  report 0 "login URL with a key: waited the bound ($(field "$OUT" elapsed)s >= ${BOUND}s)"
else
  report 1 "login URL with a key: waited the bound" "elapsed=$(field "$OUT" elapsed)"
fi
expect_contains "login URL with a key: names the bound" "$OUT" "within ${BOUND}s"

# ── 1b. Running, but the mapping does not appear ────────────────────────────
OUT="$(run_wrapper no-mapping -e FAKE_STATE=Running -e FAKE_SERVE_APPLIES=no)"
expect_eq "no mapping: exits non-zero" "$(field "$OUT" rc)" 1
expect_contains "no mapping: serve was invoked with the target" "$(field "$OUT" serve_calls)" "serve --bg --https=443 $FAKE_TARGET"
expect_contains "no mapping: serve's own error is echoed" "$OUT" "HTTPS certificates to be enabled"
expect_contains "no mapping: says the mapping is absent" "$OUT" "serve mapping HTTPS 443 -> $FAKE_TARGET is NOT present"
expect_contains "no mapping: shows what serve status said" "$OUT" "No serve config"
expect_contains "no mapping: refuses to be up" "$OUT" "this container is not up"
expect_contains "no mapping: containerboot was sent TERM" "$(field "$OUT" cb_signals)" "TERM"

# ── 1c. Running, a stale mapping to another target ──────────────────────────
OUT="$(run_wrapper stale-mapping -e FAKE_STATE=Running -e FAKE_SERVE_TARGET=http://172.18.0.5:80)"
expect_eq "stale mapping: exits non-zero" "$(field "$OUT" rc)" 1
expect_contains "stale mapping: says the wanted mapping is absent" "$OUT" "-> $FAKE_TARGET is NOT present"
expect_contains "stale mapping: shows the stale target" "$OUT" "proxy http://172.18.0.5:80"

# ── 1d. the good path: polls, applies, verifies, stays up, forwards TERM ────
OUT="$(run_wrapper stays-up -e FAKE_RUNNING_AFTER=3)"
expect_eq "good path: the wrapper was still up after the mapping was applied" "$(field "$OUT" wrapper_alive)" yes
expect_eq "good path: serve applied to http://<NOVA_WEB_ADDR>:80" "$(field "$OUT" serve_applied)" "$FAKE_TARGET"
if [ "$(field "$OUT" status_calls)" -ge 3 ] 2>/dev/null; then
  report 0 "good path: waited through NeedsLogin polls ($(field "$OUT" status_calls) status calls)"
else
  report 1 "good path: waited through NeedsLogin polls" "status_calls=$(field "$OUT" status_calls)"
fi
expect_contains "good path: logs the verified mapping" "$OUT" "serving https://nova.fake-tailnet.ts.net/ -> $FAKE_TARGET"
expect_contains "good path: TERM reached containerboot" "$(field "$OUT" cb_signals)" "TERM"
expect_eq "good path: containerboot is gone after TERM" "$(field "$OUT" cb_alive)" no
expect_eq "good path: containerboot's status (37) became the wrapper's, not wait's 143" "$(field "$OUT" rc)" 37

# ── 1d'. TERM during the ready loop: forwarded, and the child's status kept ──
OUT="$(CASE_BOUND=60 run_wrapper term-while-waiting -e FAKE_STATE=NeedsLogin)"
expect_eq "TERM while waiting: containerboot's status (37) is the wrapper's" "$(field "$OUT" rc)" 37
expect_le "TERM while waiting: exited promptly, not after the 60s bound" "$(field "$OUT" elapsed)" 10
expect_contains "TERM while waiting: TERM reached containerboot" "$(field "$OUT" cb_signals)" "TERM"
expect_contains "TERM while waiting: says containerboot exited" "$OUT" "containerboot exited (status 37) before tailscaled reported Running"

# ── 1e. containerboot dies before Running ───────────────────────────────────
OUT="$(CASE_BOUND=60 run_wrapper cb-dies -e FAKE_STATE=NeedsLogin -e FAKE_CB_EXIT=3)"
expect_eq "containerboot dies: its status is the wrapper's" "$(field "$OUT" rc)" 3
expect_le "containerboot dies: exits at once, not after the bound" "$(field "$OUT" elapsed)" 10
expect_contains "containerboot dies: says so" "$OUT" "containerboot exited (status 3) before tailscaled reported Running"

# ── 1e'. `serve --bg` hangs (no HTTPS cap on the tailnet): bounded, explained ─
OUT="$(run_wrapper serve-hangs -e FAKE_STATE=Running -e FAKE_SERVE_HANGS=yes -e NOVA_TAILSCALE_SERVE_TIMEOUT=3)"
expect_eq "serve hangs: exits non-zero" "$(field "$OUT" rc)" 1
expect_le "serve hangs: within the serve bound (3s + slack)" "$(field "$OUT" elapsed)" 15
expect_contains "serve hangs: names the bound" "$OUT" "tailscale serve did not return within 3s"
expect_contains "serve hangs: says why and what to enable" "$OUT" "HTTPS Certificates enabled"
expect_contains "serve hangs: containerboot was sent TERM" "$(field "$OUT" cb_signals)" "TERM"

# ── 1f. no target configured ────────────────────────────────────────────────
OUT="$(run_wrapper no-target -e NOVA_WEB_ADDR=)"
expect_eq "blank NOVA_WEB_ADDR: refuses" "$(field "$OUT" rc)" 1
expect_contains "blank NOVA_WEB_ADDR: says why" "$OUT" "NOVA_WEB_ADDR is not set"
expect_eq "blank NOVA_WEB_ADDR: containerboot was never started" "$(field "$OUT" cb_signals)" ""

# ── 1g. serve_check.sh alone — what the compose healthcheck runs ────────────
OUT="$(run_wrapper check-ok -e FAKE_STATE=Running -e FAKE_SERVE_TARGET="$FAKE_TARGET")"
expect_eq "healthcheck: Running + mapping present → 0" "$(field "$OUT" rc)" 0
expect_contains "healthcheck: reports the mapping it read" "$OUT" "serving https://nova.fake-tailnet.ts.net/ -> $FAKE_TARGET"
OUT="$(run_wrapper check-no-mapping -e FAKE_STATE=Running)"
expect_eq "healthcheck: Running without the mapping → 1" "$(field "$OUT" rc)" 1
expect_contains "healthcheck: says the mapping is absent" "$OUT" "is NOT present"
OUT="$(run_wrapper check-stopped -e FAKE_STATE=Stopped -e FAKE_SERVE_TARGET="$FAKE_TARGET")"
expect_eq "healthcheck: mapping present but not Running → 1" "$(field "$OUT" rc)" 1
expect_contains "healthcheck: names the state" "$OUT" "not Running (BackendState: Stopped)"

# ── 1h. the real tailscaled, logged out: parsing proven on real output ──────
OUT="$(run_wrapper real-logged-out)"
expect_contains "real tailscaled: reported NeedsLogin" "$(field "$OUT" real_state)" "NeedsLogin"
expect_eq "real tailscaled: serve_check.sh exits 1 when logged out" "$(field "$OUT" rc)" 1
expect_contains "real tailscaled: the state was parsed from real JSON" "$OUT" "not Running (BackendState: NeedsLogin)"
expect_contains "real tailscaled: the Health line was parsed from real JSON" "$OUT" "health: \"Tailscale is stopped.\""
expect_eq "real tailscaled: empty serve config is {} as assumed" "$(field "$OUT" real_serve)" "{}"

# ── 1i. the REAL containerboot, no network, no key: NeedsLogin to the bound ──
# Pins the awk Health read: after containerboot runs `tailscale up`, Health
# is `[]` on one line, and the old sed range dumped the peer list.
OUT="$(CASE_BOUND=20 run_wrapper real-containerboot --network none -e TS_USERSPACE=true -e TS_STATE_DIR=/tmp/ts-state -e TS_AUTHKEY=)"
expect_eq "real containerboot: exits 1" "$(field "$OUT" rc)" 1
expect_contains "real containerboot: last state NeedsLogin" "$OUT" "last state: NeedsLogin"
expect_contains "real containerboot: names the bound" "$OUT" "within 20s"
expect_eq "real containerboot: no health line carries the peer list" "$(field "$OUT" peer_in_health)" 0
expect_le "real containerboot: exited within bound + TERM grace" "$(field "$OUT" elapsed)" 45
printf 'info real containerboot: rc=%s elapsed=%ss health_lines=%s\n' "$(field "$OUT" rc)" "$(field "$OUT" elapsed)" "$(field "$OUT" health_lines)"
printf '%s\n' "$OUT" | sed -n '/^--- output/,$p' | sed 's/^/info   /'

# ── 2. the compose service, created and inspected, never started ────────────
holder=""
for n in $(docker network ls -q); do
  line="$(docker network inspect -f '{{.Name}} {{range .IPAM.Config}}{{.Subnet}} {{end}}' "$n" 2>/dev/null)" || continue
  case "$line" in
    "$NET "*) ;;
    *" $SUBNET "*) holder="${line%% *}" ;;
  esac
done
[ -z "$holder" ] || die "preflight: subnet $SUBNET free" "held by network '$holder'"

ENVF="$TMP/env"
cat > "$ENVF" <<EOT
POSTGRES_PASSWORD=x
CORE_TOKEN=x
CORE_GATEWAY_TOKEN=x
CORE_MEMORY_TOKEN=x
TS_AUTHKEY=tskey-auth-dummy-not-a-real-key
TAILNET_HOSTNAME=$NODE_NAME
NOVA_WEB_ADDR=$WEB_ADDR
NOVA_TAILSCALE_ADDR=$TS_ADDR
EOT
OVERLAY="$TMP/overlay.yml"
cat > "$OVERLAY" <<EOT
# Throwaway subnet so this project can exist beside the live one (docker
# refuses overlapping subnets). !override replaces the base ipam wholesale.
networks:
  default:
    ipam: !override
      config:
        - subnet: $SUBNET
          ip_range: $IP_RANGE
          gateway: $GATEWAY
EOT
COMPOSE=(docker compose -p "$PROJECT" --env-file "$ENVF" -f "$COMPOSE_FILE" -f "$OVERLAY" --profile tailnet)

if err="$("${COMPOSE[@]}" config -q 2>&1)"; then
  report 0 "compose config: validates with the tailnet profile"
else
  die "compose config: validates with the tailnet profile" "$err"
fi
CFG="$("${COMPOSE[@]}" config 2>/dev/null)"
TS_BLOCK="$(printf '%s\n' "$CFG" | awk '/^  tailscale:/{f=1; print; next} f && /^  [a-z]/{f=0} f')"
[ -n "$TS_BLOCK" ] || die "compose config: has a tailscale service" "no '  tailscale:' block in config output"
expect_contains "config: the pinned image" "$TS_BLOCK" "image: $IMAGE"
expect_contains "config: under the tailnet profile" "$TS_BLOCK" "- tailnet"
expect_contains "config: the named state volume" "$TS_BLOCK" "source: v4_tailscale"
expect_contains "config: ...mounted at TS_STATE_DIR" "$TS_BLOCK" "target: /var/lib/tailscale"
expect_contains "config: the wrapper's DIRECTORY is what is mounted" "$TS_BLOCK" "source: $SCRIPT_DIR"
expect_contains "config: ...at /config" "$TS_BLOCK" "target: /config"
expect_contains "config: ...read-only" "$TS_BLOCK" "read_only: true"
expect_contains "config: TS_HOSTNAME from TAILNET_HOSTNAME" "$TS_BLOCK" "TS_HOSTNAME: $NODE_NAME"
expect_contains "config: TS_AUTH_ONCE" "$TS_BLOCK" 'TS_AUTH_ONCE: "true"'
expect_contains "config: TS_USERSPACE" "$TS_BLOCK" 'TS_USERSPACE: "true"'
expect_contains "config: the wrapper gets NOVA_WEB_ADDR" "$TS_BLOCK" "NOVA_WEB_ADDR: $WEB_ADDR"
expect_lacks "config: NO TS_SERVE_CONFIG (one writer: the wrapper)" "$TS_BLOCK" "TS_SERVE_CONFIG"
expect_contains "config: the fixed address from NOVA_TAILSCALE_ADDR" "$TS_BLOCK" "ipv4_address: $TS_ADDR"
expect_lacks "config: no network_mode (an ordinary container)" "$TS_BLOCK" "network_mode"
expect_lacks "config: no capabilities" "$TS_BLOCK" "cap_add"
expect_lacks "config: no devices (no tun)" "$TS_BLOCK" "devices"
expect_contains "config: the healthcheck runs serve_check.sh" "$TS_BLOCK" "/config/serve_check.sh"
expect_contains "config: the command runs start.sh via sh" "$TS_BLOCK" "/config/start.sh"
expect_contains "config: restart unless-stopped" "$TS_BLOCK" "restart: unless-stopped"
expect_contains "config: web's fixed address moves with NOVA_WEB_ADDR" "$CFG" "ipv4_address: $WEB_ADDR"
expect_contains "config: the volume is project-prefixed" "$CFG" "name: ${PROJECT}_v4_tailscale"
expect_eq "config: !override left exactly one subnet" "$(printf '%s\n' "$CFG" | grep -c 'subnet:')" 1
expect_contains "config: ...ours" "$CFG" "subnet: $SUBNET"
if [ -f "$SCRIPT_DIR/serve_check.sh" ] && [ -f "$SCRIPT_DIR/start.sh" ]; then
  report 0 "config: both mounted scripts exist in the mounted directory"
else
  report 1 "config: both mounted scripts exist in the mounted directory" "$(ls "$SCRIPT_DIR")"
fi

if err="$("${COMPOSE[@]}" create tailscale 2>&1)"; then
  report 0 "compose create: the tailscale container was created"
else
  die "compose create: the tailscale container was created" "$err"
fi
CID="$("${COMPOSE[@]}" ps -aq tailscale 2>/dev/null)"
[ -n "$CID" ] || die "compose create: container id known" "ps -aq returned nothing"
expect_eq "create: only the one container (no deps dragged in)" \
  "$(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT" | wc -l | tr -d ' ')" 1
expect_eq "create: created, never started" "$(docker inspect -f '{{.State.Status}}' "$CID")" created
expect_eq "create: NetworkMode is the project network, not container:" \
  "$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$CID")" "$NET"
expect_eq "create: fixed address on the project network" \
  "$(docker inspect -f "{{(index .NetworkSettings.Networks \"$NET\").IPAMConfig.IPv4Address}}" "$CID")" "$TS_ADDR"
MOUNTS="$(docker inspect -f '{{range .Mounts}}{{.Type}} {{.Name}} {{.Source}} {{.Destination}} rw={{.RW}}{{"\n"}}{{end}}' "$CID")"
expect_contains "create: the state volume is mounted rw at /var/lib/tailscale" "$MOUNTS" "volume ${PROJECT}_v4_tailscale "
expect_contains "create: ...at the state dir" "$MOUNTS" " /var/lib/tailscale rw=true"
# Under Docker Desktop (WSL) the inspected source of a bind — in Mounts AND
# in HostConfig.Binds — is a translated /run/desktop/... path, so the HOST
# path is pinned by the `config:` assertions above (compose's resolved
# `source:` is the wrapper directory); here the mount is asserted on its
# type, destination and mode.
if printf '%s\n' "$MOUNTS" | grep -q '^bind .* /config rw=false$'; then
  report 0 "create: a bind mount, read-only, at /config"
else
  report 1 "create: a bind mount, read-only, at /config" "$MOUNTS"
fi
expect_contains "create: the bind spec ends :/config:ro" \
  "$(docker inspect -f '{{json .HostConfig.Binds}}' "$CID")" ':/config:ro"'

expect_eq "create: exactly two mounts" "$(printf '%s\n' "$MOUNTS" | grep -c .)" 2
ENV="$(docker inspect -f '{{range .Config.Env}}{{.}}{{"\n"}}{{end}}' "$CID")"
expect_contains "create: TS_HOSTNAME reaches the container" "$ENV" "TS_HOSTNAME=$NODE_NAME"
expect_contains "create: TS_AUTHKEY reaches the container" "$ENV" "TS_AUTHKEY=tskey-auth-dummy-not-a-real-key"
expect_contains "create: TS_STATE_DIR" "$ENV" "TS_STATE_DIR=/var/lib/tailscale"
expect_contains "create: TS_AUTH_ONCE" "$ENV" "TS_AUTH_ONCE=true"
expect_contains "create: TS_USERSPACE" "$ENV" "TS_USERSPACE=true"
expect_contains "create: NOVA_WEB_ADDR" "$ENV" "NOVA_WEB_ADDR=$WEB_ADDR"
expect_lacks "create: no TS_SERVE_CONFIG in the container's env" "$ENV" "TS_SERVE_CONFIG"
expect_eq "create: hostname" "$(docker inspect -f '{{.Config.Hostname}}' "$CID")" "$NODE_NAME"
expect_eq "create: command" "$(docker inspect -f '{{json .Config.Cmd}}' "$CID")" '["sh","/config/start.sh"]'
expect_contains "create: healthcheck" "$(docker inspect -f '{{json .Config.Healthcheck.Test}}' "$CID")" '"/config/serve_check.sh"'
expect_eq "create: init (tini) as PID 1" "$(docker inspect -f '{{.HostConfig.Init}}' "$CID")" true
expect_eq "create: restart policy" "$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$CID")" unless-stopped
expect_eq "create: no added capabilities" "$(docker inspect -f '{{json .HostConfig.CapAdd}}' "$CID")" null
DEVICES="$(docker inspect -f '{{json .HostConfig.Devices}}' "$CID")"
case "$DEVICES" in
  null | "[]") report 0 "create: no devices (no tun)" ;;
  *) report 1 "create: no devices (no tun)" "$DEVICES" ;;
esac
if docker volume inspect "${PROJECT}_v4_tailscale" >/dev/null 2>&1; then
  report 0 "create: the state volume exists under the project prefix"
else
  report 1 "create: the state volume exists under the project prefix" "docker volume inspect failed"
fi

if err="$("${COMPOSE[@]}" down -v --remove-orphans 2>&1)"; then
  report 0 "down -v: removed"
else
  report 1 "down -v: removed" "$err"
fi
if docker inspect "$CID" >/dev/null 2>&1; then
  report 1 "down -v: container gone" "still there"
else
  report 0 "down -v: container gone"
fi
if docker volume inspect "${PROJECT}_v4_tailscale" >/dev/null 2>&1; then
  report 1 "down -v: volume gone" "still there"
else
  report 0 "down -v: volume gone"
fi
if docker network inspect "$NET" >/dev/null 2>&1; then
  report 1 "down -v: network gone" "still there"
else
  report 0 "down -v: network gone"
fi

finish
