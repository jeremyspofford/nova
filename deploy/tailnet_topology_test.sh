#!/usr/bin/env bash
# The tailnet-free topology test — S5b's pin for DoD 2 ("web recreated by
# ANY shape the operator actually uses and the tailnet URL keeps working with
# NO manual step"), see docs/plans/rebuild/slice-05b-tailnet.md, Architecture
# revision 2.
#
# What it measures: a reverse proxy that targets an app by a FIXED ADDRESS
# keeps working across every restart shape the operator uses, with no
# start-order coupling. A throwaway compose project (written to a temp dir)
# declares its IPAM with the dynamic pool in the lower half of the subnet,
# puts `web` (nginx serving one page) and `sc` (nginx reverse-proxying `/`
# to web's address — the stand-in for `tailscale serve`) at fixed addresses
# in the upper half, and then after EACH restart shape asserts that
# `docker exec sc wget -qO- http://127.0.0.1/` returns web's page and that
# both containers still hold their addresses:
#
#   1. up -d                                       (baseline)
#   2. up -d --no-deps --force-recreate web        (the habitual recreate)
#   3. docker compose restart                      (the whole project)
#   4. docker restart <web>                        (a crash-restart of the app)
#   5. docker restart <sc>                         (a crash-restart of the proxy)
#   6. up -d --force-recreate                      (both)
#   7. a container with NO static address lands in the lower half, so the
#      allocator cannot collide with the fixed addresses — and from there it
#      reaches sc at its fixed address and gets web's page.
#
# Each recreate/restart is also checked to have actually happened (container
# id or StartedAt changed) so a step that silently no-ops cannot pass.
#
# Negative control, so the test cannot be vacuous: the pod shape revision 1
# used (a `netns` pause container that web and sc join via
# `network_mode: service:netns`) is brought up in its own project and the
# namespace owner is crash-restarted (`docker restart <netns>`). That must
# strand the pod — web keeps running, its loopback healthcheck stays green,
# and nothing on the network can reach it any more. If the pod is still
# reachable, the test FAILS with "negative control passed; the topology test
# is not measuring anything". The plan's other measured pod failure —
# `docker compose restart` killing web with Exited(128) — did NOT reproduce
# on compose v5.3.0 when this test was written (14/14 survived); it is run
# and reported as an uncounted `info` line so the fact stays visible either
# way, never as a pass.
#
# Needs docker with compose v2 and the nginx:alpine image (pulled if absent).
# No stack needs to be running. Everything it creates lives under the compose
# projects `s5b-topo` / `s5b-topo-neg` on subnets 10.98.0.0/24 / 10.98.1.0/24
# (docker refuses to create a network over a subnet already in use, and this
# script refuses up front) and is removed on exit, success or failure.
# Idempotent: a previous run's leftovers are removed before starting.
#
#     deploy/tailnet_topology_test.sh
set -uo pipefail

PROJECT="${TOPO_TEST_PROJECT:-s5b-topo}"
NEG_PROJECT="${PROJECT}-neg"
NET="${PROJECT}_default"
NEG_NET="${NEG_PROJECT}_default"
SUBNET="10.98.0.0/24"
IP_RANGE="10.98.0.0/25"
GATEWAY="10.98.0.1"
WEB_ADDR="10.98.0.130"
SC_ADDR="10.98.0.140"
NEG_SUBNET="10.98.1.0/24"
NEG_GATEWAY="10.98.1.1"
NEG_POD_ADDR="10.98.1.130"
DYN="${PROJECT}-dyn"
NEG_CLIENT="${NEG_PROJECT}-client"
IMAGE="nginx:alpine"
ANSWER_DEADLINE=10
MARK="${PROJECT}-page-$(date +%s)-$$"
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

info() { printf 'info %s\n' "$1"; }

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

# Remove everything a run (this one or a previous killed one) can leave
# behind, by compose label rather than by name so a half-created project is
# found too. Never touches anything outside the two project names.
remove_project() {
  local ids
  ids="$(docker ps -aq --filter "label=com.docker.compose.project=$1" 2>/dev/null)"
  [ -n "$ids" ] && printf '%s\n' "$ids" | xargs docker rm -f >/dev/null 2>&1
  docker network rm "${1}_default" >/dev/null 2>&1 || true
}

cleanup() {
  docker rm -f "$DYN" "$NEG_CLIENT" >/dev/null 2>&1 || true
  remove_project "$PROJECT"
  remove_project "$NEG_PROJECT"
  [ -n "$TMP" ] && rm -rf "$TMP"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# ── preflight ───────────────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || die "preflight: docker on PATH" "docker not found"
if ! err="$(docker info 2>&1 >/dev/null)"; then
  die "preflight: docker daemon reachable" "$err"
fi
if ! ver="$(docker compose version --short 2>&1)"; then
  die "preflight: docker compose v2 available" "$ver"
fi
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  if ! err="$(docker pull "$IMAGE" 2>&1)"; then
    die "preflight: $IMAGE present" "$err"
  fi
fi

remove_project "$PROJECT"
remove_project "$NEG_PROJECT"

# The subnets must be ours alone. Docker would refuse the overlap anyway, but
# naming the holder beats "Pool overlaps with other one on this address space".
holder=""
for n in $(docker network ls -q); do
  line="$(docker network inspect -f '{{.Name}} {{range .IPAM.Config}}{{.Subnet}} {{end}}' "$n" 2>/dev/null)" || continue
  case "$line" in
    *" $SUBNET"*|*" $NEG_SUBNET"*) holder="$holder ${line%% *}" ;;
  esac
done
[ -z "$holder" ] || die "preflight: $SUBNET and $NEG_SUBNET are free" "in use by:$holder"

report 0 "preflight: docker $(docker version -f '{{.Server.Version}}' 2>/dev/null), compose $ver, $IMAGE present, subnets free"

# ── the throwaway projects ──────────────────────────────────────────────────
TMP="$(mktemp -d)"
mkdir -p "$TMP/web" "$TMP/sc" "$TMP/sc-pod"
printf '%s\n' "$MARK" > "$TMP/web/index.html"

# The proxy targets an ADDRESS, not a name: nginx resolves a literal
# proxy_pass once at config time and never again — the same contract as
# `tailscale serve ... http://<addr>:80`.
cat > "$TMP/sc/default.conf" <<EOF
server {
  listen 80;
  location / {
    proxy_pass http://$WEB_ADDR:80;
  }
}
EOF

# No depends_on anywhere: the whole claim is that nothing here couples start
# order. `--no-deps` in step 2 is kept because it is the operator's habitual
# command shape (the real web does have dependencies).
cat > "$TMP/compose.yml" <<EOF
services:
  web:
    image: $IMAGE
    volumes:
      - ./web:/usr/share/nginx/html:ro
    networks:
      default:
        ipv4_address: $WEB_ADDR
  sc:
    image: $IMAGE
    volumes:
      - ./sc:/etc/nginx/conf.d:ro
    networks:
      default:
        ipv4_address: $SC_ADDR
networks:
  default:
    ipam:
      config:
        - subnet: $SUBNET
          ip_range: $IP_RANGE
          gateway: $GATEWAY
EOF

# The pod shape (revision 1). web and sc share netns's network namespace, so
# the proxy listens on 8080 and targets loopback — exactly how serve did.
cat > "$TMP/sc-pod/default.conf" <<'EOF'
server {
  listen 8080;
  location / {
    proxy_pass http://127.0.0.1:80;
  }
}
EOF
cat > "$TMP/pod.yml" <<EOF
services:
  netns:
    image: $IMAGE
    command: ["sleep", "infinity"]
    networks:
      default:
        ipv4_address: $NEG_POD_ADDR
  web:
    image: $IMAGE
    network_mode: service:netns
    volumes:
      - ./web:/usr/share/nginx/html:ro
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1/"]
      interval: 1s
      timeout: 1s
      retries: 2
  sc:
    image: $IMAGE
    network_mode: service:netns
    volumes:
      - ./sc-pod:/etc/nginx/conf.d:ro
networks:
  default:
    ipam:
      config:
        - subnet: $NEG_SUBNET
          gateway: $NEG_GATEWAY
EOF

C=(docker compose -p "$PROJECT" -f "$TMP/compose.yml")
N=(docker compose -p "$NEG_PROJECT" -f "$TMP/pod.yml")

# ── helpers ─────────────────────────────────────────────────────────────────
cid() { "${C[@]}" ps -aq "$1" 2>/dev/null | head -1; }
started_at() { docker inspect -f '{{.State.StartedAt}}' "$1" 2>/dev/null; }
state_of() { docker inspect -f '{{.State.Status}}' "$1" 2>/dev/null; }
addr_on() { # $1 container, $2 network
  docker inspect -f "{{with index .NetworkSettings.Networks \"$2\"}}{{.IPAddress}}{{end}}" "$1" 2>/dev/null
}
health_of() {
  docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$1" 2>/dev/null
}

now_ms() { echo $(( $(date +%s%N) / 1000000 )); }
secs() { printf '%d.%d' $(( $1 / 1000 )) $(( $1 % 1000 / 100 )); }   # ms -> "1.2"
DEADLINE_MS=$(( ANSWER_DEADLINE * 1000 ))

# What sc answers on its own loopback listener — the request `tailscale
# serve` would forward. Prints the body (empty when nothing answered).
proxied_page() { docker exec "$1" wget -qO- -T 2 http://127.0.0.1/ 2>/dev/null; }

# Poll until sc returns web's page or the deadline passes. Prints the seconds
# it took; returns 1 with the last body on stdout after the deadline. A
# restart legitimately takes a moment, so a bounded wait is honest — an
# unbounded one, or none, would not be.
wait_for_page() { # $1 sc container id
  local t0 body
  t0="$(now_ms)"
  while :; do
    body="$(proxied_page "$1")"
    if [ "$body" = "$MARK" ]; then
      secs $(( $(now_ms) - t0 ))
      return 0
    fi
    if [ $(( $(now_ms) - t0 )) -ge "$DEADLINE_MS" ]; then
      printf 'no page in %ss; last body: %s' "$ANSWER_DEADLINE" "${body:-<empty>}"
      return 1
    fi
    sleep 0.25
  done
}

# The assertions every step must satisfy.
assert_shape() { # $1 step label
  local step="$1" web sc took wa sa
  web="$(cid web)"; sc="$(cid sc)"
  if [ -z "$web" ] || [ -z "$sc" ]; then
    report 1 "$step: both containers exist" "web='$web' sc='$sc'"
    return
  fi
  if took="$(wait_for_page "$sc")"; then
    report 0 "$step: proxy answers through $WEB_ADDR (${took}s; web $(state_of "$web"), sc $(state_of "$sc"))"
  else
    report 1 "$step: proxy answers through $WEB_ADDR" "$took; web $(state_of "$web"), sc $(state_of "$sc")"
  fi
  wa="$(addr_on "$web" "$NET")"; sa="$(addr_on "$sc" "$NET")"
  if [ "$wa" = "$WEB_ADDR" ] && [ "$sa" = "$SC_ADDR" ]; then
    report 0 "$step: fixed addresses held (web $WEB_ADDR, sc $SC_ADDR)"
  else
    report 1 "$step: fixed addresses held (web $WEB_ADDR, sc $SC_ADDR)" "web='$wa' sc='$sa'"
  fi
}

# The step must have DONE something: a recreate changes the container id, a
# restart changes StartedAt. Without this a no-op step would pass for free.
assert_changed() { # $1 step label, $2 what, $3 before, $4 after
  if [ -n "$4" ] && [ "$3" != "$4" ]; then
    report 0 "$1: $2"
  else
    report 1 "$1: $2" "before='$3' after='$4' — the step did not happen"
  fi
}

run_compose() { # $1 label, $2... compose args; a failing compose command is a FAIL, not noise
  local label="$1" out; shift
  if ! out="$("$@" 2>&1)"; then
    report 1 "$label" "$(printf '%s' "$out" | tail -3 | tr '\n' ' ')"
    return 1
  fi
}

# ── 1. baseline ─────────────────────────────────────────────────────────────
STEP="step 1: up -d"
run_compose "$STEP" "${C[@]}" up -d || die "$STEP" "cannot bring the project up"
assert_shape "$STEP"

# ── 2. the habitual recreate ────────────────────────────────────────────────
STEP="step 2: up -d --no-deps --force-recreate web"
before="$(cid web)"
run_compose "$STEP" "${C[@]}" up -d --no-deps --force-recreate web
assert_changed "$STEP" "web recreated (new container id)" "$before" "$(cid web)"
assert_shape "$STEP"

# ── 3. the whole project ────────────────────────────────────────────────────
STEP="step 3: docker compose restart"
wb="$(started_at "$(cid web)")"; sb="$(started_at "$(cid sc)")"
run_compose "$STEP" "${C[@]}" restart
assert_changed "$STEP" "web restarted (StartedAt changed)" "$wb" "$(started_at "$(cid web)")"
assert_changed "$STEP" "sc restarted (StartedAt changed)" "$sb" "$(started_at "$(cid sc)")"
assert_shape "$STEP"

# ── 4. crash-restart of the app ─────────────────────────────────────────────
STEP="step 4: docker restart <web>"
wb="$(started_at "$(cid web)")"
run_compose "$STEP" docker restart "$(cid web)"
assert_changed "$STEP" "web restarted (StartedAt changed)" "$wb" "$(started_at "$(cid web)")"
assert_shape "$STEP"

# ── 5. crash-restart of the proxy ───────────────────────────────────────────
STEP="step 5: docker restart <sc>"
sb="$(started_at "$(cid sc)")"
run_compose "$STEP" docker restart "$(cid sc)"
assert_changed "$STEP" "sc restarted (StartedAt changed)" "$sb" "$(started_at "$(cid sc)")"
assert_shape "$STEP"

# ── 6. recreate both ────────────────────────────────────────────────────────
STEP="step 6: up -d --force-recreate"
wb="$(cid web)"; sb="$(cid sc)"
run_compose "$STEP" "${C[@]}" up -d --force-recreate
assert_changed "$STEP" "web recreated (new container id)" "$wb" "$(cid web)"
assert_changed "$STEP" "sc recreated (new container id)" "$sb" "$(cid sc)"
assert_shape "$STEP"

# ── 7. the dynamic pool cannot reach the fixed addresses ────────────────────
# A container with no static address on the project network: its address must
# land in ip_range (the lower half), and from there it must get web's page
# through sc's fixed address — the in-network path a tailnet peer's request
# takes once serve hands it on.
STEP="step 7: dynamic allocation"
if run_compose "$STEP" docker run -d --name "$DYN" --network "$NET" "$IMAGE" sleep 300; then
  dyn_ip="$(addr_on "$DYN" "$NET")"
  last="${dyn_ip##*.}"
  if [ "${dyn_ip%.*}" = "10.98.0" ] && [ "$last" -ge 2 ] && [ "$last" -le 126 ] 2>/dev/null; then
    report 0 "$STEP: unpinned container got $dyn_ip — inside $IP_RANGE, below the fixed addresses"
  else
    report 1 "$STEP: unpinned container lands inside $IP_RANGE" "got '$dyn_ip'"
  fi
  body="$(docker exec "$DYN" wget -qO- -T 2 "http://$SC_ADDR/" 2>/dev/null)"
  if [ "$body" = "$MARK" ]; then
    report 0 "$STEP: from $dyn_ip, sc at $SC_ADDR serves web's page"
  else
    report 1 "$STEP: from $dyn_ip, sc at $SC_ADDR serves web's page" "got '${body:-<empty>}'"
  fi
  docker rm -f "$DYN" >/dev/null 2>&1
fi

# The positive project is done; take it down before the control so the
# control's measurements cannot be confused with it.
"${C[@]}" down -v --remove-orphans -t 1 >/dev/null 2>&1

# ── negative control: the pod shape must break ──────────────────────────────
NEG="negative control (pod shape)"
pod_reachable() { # the pod's proxy as seen from ANOTHER container on the network
  docker exec "$NEG_CLIENT" wget -qO- -T 1 "http://$NEG_POD_ADDR:8080/" 2>/dev/null
}
if ! err="$("${N[@]}" config -q 2>&1)"; then
  printf 'skip %s: this compose cannot express network_mode: service:<name> — %s\n' "$NEG" \
    "$(printf '%s' "$err" | tail -1)"
elif ! run_compose "$NEG: up -d" "${N[@]}" up -d; then
  : # already reported
elif ! run_compose "$NEG: client on the network" docker run -d --name "$NEG_CLIENT" --network "$NEG_NET" "$IMAGE" sleep 300; then
  : # already reported
else
  netns="$("${N[@]}" ps -aq netns | head -1)"
  podweb="$("${N[@]}" ps -aq web | head -1)"
  podsc="$("${N[@]}" ps -aq sc | head -1)"
  # The control has to WORK first, or its failure would prove nothing.
  t0="$(now_ms)"; base=""
  while [ $(( $(now_ms) - t0 )) -lt "$DEADLINE_MS" ]; do
    base="$(pod_reachable)"; [ "$base" = "$MARK" ] && break; sleep 0.25
  done
  if [ "$base" != "$MARK" ]; then
    report 1 "$NEG: pod reachable at $NEG_POD_ADDR:8080 before the restart" "got '${base:-<empty>}' — the control is broken, nothing was measured"
  else
    report 0 "$NEG: pod reachable at $NEG_POD_ADDR:8080 before the restart"

    # The counted control: crash-restart the namespace owner. The measured
    # trap is that web keeps running (its loopback healthcheck green) while
    # the pod's address answers nobody, and `up -d` afterwards is a no-op.
    run_compose "$NEG: docker restart <netns>" docker restart "$netns"
    t0="$(now_ms)"; still=""
    while [ $(( $(now_ms) - t0 )) -lt "$DEADLINE_MS" ]; do
      if [ "$(pod_reachable)" = "$MARK" ]; then still="yes"; break; fi
      sleep 0.5
    done
    detail="web $(state_of "$podweb")/health=$(health_of "$podweb"), sc $(state_of "$podsc"), loopback from sc: $(docker exec "$podsc" wget -qO- -T 1 http://127.0.0.1:8080/ 2>/dev/null || printf '<no answer>')"
    if [ -n "$still" ]; then
      report 1 "$NEG: docker restart <netns> strands the pod" \
        "negative control passed; the topology test is not measuring anything — pod still reachable at $NEG_POD_ADDR:8080 after the namespace owner restarted ($detail)"
    else
      report 0 "$NEG: docker restart <netns> strands the pod — unreachable at $NEG_POD_ADDR:8080 for ${ANSWER_DEADLINE}s while $detail"
      # `up -d` sees nothing to do and leaves it stranded — the part that
      # made the trap invisible in operation. Reported, not counted twice.
      "${N[@]}" up -d >/dev/null 2>&1
      sleep 1
      if [ "$(pod_reachable)" = "$MARK" ]; then
        info "$NEG: a following up -d DID recover the pod on this compose"
      else
        info "$NEG: a following up -d is a no-op — pod still unreachable (web $(state_of "$podweb")/health=$(health_of "$podweb"))"
      fi
    fi

    # The plan's other measured pod failure, run fresh and reported as a fact
    # either way. Uncounted: it did not reproduce when this test was written,
    # and a control that is known to pass must not be counted as a control.
    "${N[@]}" down -v --remove-orphans -t 1 >/dev/null 2>&1
    docker rm -f "$NEG_CLIENT" >/dev/null 2>&1
    if "${N[@]}" up -d >/dev/null 2>&1 \
       && docker run -d --name "$NEG_CLIENT" --network "$NEG_NET" "$IMAGE" sleep 300 >/dev/null 2>&1; then
      podweb="$("${N[@]}" ps -aq web | head -1)"
      t0="$(now_ms)"
      while [ $(( $(now_ms) - t0 )) -lt "$DEADLINE_MS" ]; do
        [ "$(pod_reachable)" = "$MARK" ] && break; sleep 0.25
      done
      if [ "$(pod_reachable)" = "$MARK" ]; then
        "${N[@]}" restart >/dev/null 2>&1
        t0="$(now_ms)"; back=""
        while [ $(( $(now_ms) - t0 )) -lt "$DEADLINE_MS" ]; do
          if [ "$(pod_reachable)" = "$MARK" ]; then back="$(secs $(( $(now_ms) - t0 )))"; break; fi
          sleep 0.25
        done
        if [ -n "$back" ]; then
          info "$NEG: docker compose restart — pod reachable again after ${back}s (plan rev 2 measured web Exited(128); not reproduced here; uncounted)"
        else
          info "$NEG: docker compose restart — pod NOT reachable within ${ANSWER_DEADLINE}s; web $(state_of "$podweb") exit=$(docker inspect -f '{{.State.ExitCode}} {{.State.Error}}' "$podweb" 2>/dev/null) (matches plan rev 2; uncounted)"
        fi
      else
        info "$NEG: docker compose restart — could not establish a reachable pod to restart; nothing measured"
      fi
    else
      info "$NEG: docker compose restart — could not bring the pod up a second time; nothing measured"
    fi
  fi
fi

finish
