#!/usr/bin/env bash
# Pins apps/web's pre-auth token gate and its one exemption
# (nginx.conf.template + gate/, see apps/web/Dockerfile). Builds the real
# image, runs it against throwaway containers on random host ports, and
# curls the matrix the gate exists to satisfy: fail-closed on every path with
# no/wrong cookie, a working /gate login, byte-identical behaviour with the
# gate off, and no accidental corruption of nginx's own `$vars` by envsubst.
#
# Since S5b it also pins WHO is exempt: a request from the tailnet sidecar's
# fixed address (NOVA_TAILSCALE_ADDR) that carries serve's identity header.
# That is a claim about source addresses, so it is tested with real client
# containers on a private docker network with a declared subnet: one at the
# trusted address, one at another, plus the host's published-port path —
# against a web container whose upstream is a STUB aliased `core` that
# echoes the headers it received. The forwarding half (X-Forwarded-Proto
# passed through as the TLS hop sent it; identity headers dropped unless
# from the sidecar) is asserted on what ARRIVED, never on the conf alone.
#
# No stack needs to be running. Leaves nothing behind — every container,
# network and temp dir this script creates is removed on exit, success or
# failure. Names carry GATE_TEST_PREFIX (default nova-gate-test) so a run can
# be kept apart from a live stack's.
#
#     apps/web/gate_test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
PREFIX="${GATE_TEST_PREFIX:-nova-gate-test}"
IMAGE="${PREFIX}-image-$$"
ON="${PREFIX}-on-$$"
OFF="${PREFIX}-off-$$"
FWD="${PREFIX}-fwd-$$"
NOTRUST="${PREFIX}-notrust-$$"
STUB="${PREFIX}-core-$$"
NET="${PREFIX}-net-$$"
# A subnet of the test's own, so client containers can be placed at chosen
# addresses. Nothing else on the box should be using it; docker refuses to
# create the network if something is, which is a loud failure, not a wrong
# answer.
SUBNET="10.99.0.0/24"
SIDECAR_IP="10.99.0.50"
OTHER_IP="10.99.0.60"
STUB_DIR=""
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

cleanup() {
  docker rm -f "$ON" "$OFF" "$FWD" "$NOTRUST" "$STUB" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  docker rmi "$IMAGE" >/dev/null 2>&1 || true
  [ -n "$STUB_DIR" ] && rm -rf "$STUB_DIR"
}
trap cleanup EXIT

status_of() {
  # $1 base url, $2 path, $3... extra curl args (e.g. -b cookie)
  local base="$1" path="$2"; shift 2
  curl -s -o /dev/null -w '%{http_code}' "$@" "${base}${path}"
}

port_of() {
  docker port "$1" 80 2>/dev/null | tail -1 | sed 's/.*://'
}

# A throwaway client container at a chosen address on the test network. The
# web image itself is the client (busybox wget, no extra pull): --entrypoint
# swaps nginx out for wget. $1 source ip, $2 url, $3... extra wget args.
client_status() {
  # HTTP status as the client saw it; empty when no status line came back.
  local ip="$1" url="$2"; shift 2
  docker run --rm --network "$NET" --ip "$ip" --entrypoint wget "$IMAGE" \
    -S -T 5 -O /dev/null "$@" "$url" 2>&1 \
    | grep -oE 'HTTP/1\.[01] [0-9]{3}' | tail -1 | awk '{print $2}'
}

client_body() {
  local ip="$1" url="$2"; shift 2
  docker run --rm --network "$NET" --ip "$ip" --entrypoint wget "$IMAGE" \
    -q -T 5 -O - "$@" "$url" 2>/dev/null
}

client_headers() {
  local ip="$1" url="$2"; shift 2
  docker run --rm --network "$NET" --ip "$ip" --entrypoint wget "$IMAGE" \
    -S -T 5 -O /dev/null "$@" "$url" 2>&1
}

wait_for_nginx() {
  # $1 base url — polls / until nginx answers with ANY status (401 counts),
  # rather than a fixed sleep.
  local base="$1" tries=30
  while [ "$tries" -gt 0 ]; do
    local code
    code="$(status_of "$base" "/health/live" 2>/dev/null)"
    [ -n "$code" ] && [ "$code" != "000" ] && return 0
    tries=$((tries - 1))
    sleep 0.5
  done
  return 1
}

echo "building $IMAGE from $SCRIPT_DIR ..."
if ! docker build -q -t "$IMAGE" "$SCRIPT_DIR" >/dev/null; then
  echo "FAIL image build"
  exit 1
fi

TOKEN="$(openssl rand -hex 24)"
WRONG="0000000000000000000000000000000000000000000000"

# ── gate ON ──────────────────────────────────────────────────────────────
docker run -d --name "$ON" -p "127.0.0.1::80" -e NOVA_PUBLIC_GATE_TOKEN="$TOKEN" "$IMAGE" >/dev/null
if ! wait_for_nginx "http://127.0.0.1:$(port_of "$ON")"; then
  # Even "gate on" answers /health/live with 401, so a non-empty non-000
  # status means nginx came up; getting here means it never did.
  report 1 "gate-on container starts and answers" "$(docker logs "$ON" 2>&1 | tail -5)"
else
  ON_BASE="http://127.0.0.1:$(port_of "$ON")"

  code="$(docker exec "$ON" nginx -t 2>&1)"; rc=$?
  [ "$rc" -eq 0 ] && report 0 "gate on: nginx -t" || report 1 "gate on: nginx -t" "$code"

  for path in "/" "/api/v1/auth/state" "/assets/x.js" "/health/live"; do
    code="$(status_of "$ON_BASE" "$path")"
    [ "$code" = "401" ] && report 0 "gate on, no cookie: $path -> 401" \
      || report 1 "gate on, no cookie: $path -> 401" "got $code"
  done

  # /api/v1/devices/ws is the OTHER deliberate carve-out (see the nginx
  # template's own comment on that location): a paired device sends no
  # cookie, and the socket authenticates itself by ed25519 challenge, so
  # gating it would only take real daemons offline. With no cookie at all it
  # must NOT be blocked by the gate (not 401) — core is never started in
  # this throwaway container, so "the gate let it through" shows up as a 502
  # (nginx reached the proxy_pass and got nothing behind it), exactly like
  # the other no-cookie-but-ungated proof used for /api/v1/auth/state below.
  code="$(status_of "$ON_BASE" "/api/v1/devices/ws")"
  [ "$code" != "401" ] && report 0 "gate on, no cookie: /api/v1/devices/ws is NOT gated (got $code, not 401)" \
    || report 1 "gate on, no cookie: /api/v1/devices/ws is NOT gated (got $code, not 401)" "got 401, expected the gate to let this through"

  code="$(status_of "$ON_BASE" "/gate?token=$WRONG")"
  [ "$code" = "401" ] && report 0 "gate on: /gate?token=wrong -> 401" \
    || report 1 "gate on: /gate?token=wrong -> 401" "got $code"

  # /healthz is the ONE ungated location — must answer 200 with no cookie at
  # all, even while every other path 401s above. This is what Docker's
  # compose healthcheck for `web` actually polls (deploy/docker-compose.yml).
  code="$(status_of "$ON_BASE" "/healthz")"
  [ "$code" = "200" ] && report 0 "gate on, no cookie: /healthz -> 200 (ungated liveness)" \
    || report 1 "gate on, no cookie: /healthz -> 200 (ungated liveness)" "got $code"

  body="$(curl -s "$ON_BASE/healthz")"
  [ "$body" = "ok" ] && report 0 "gate on: /healthz body is 'ok'" \
    || report 1 "gate on: /healthz body is 'ok'" "$(printf '%s' "$body" | head -c 80)"

  HEALTHZ_HEADERS_ON="$(curl -s -D - -o /dev/null "$ON_BASE/healthz")"
  case "$HEALTHZ_HEADERS_ON" in
    *"Set-Cookie"*) report 1 "gate on: /healthz never sets a cookie" "$HEALTHZ_HEADERS_ON" ;;
    *) report 0 "gate on: /healthz never sets a cookie" ;;
  esac

  LOGIN_HEADERS="$(curl -s -D - -o /dev/null "$ON_BASE/gate?token=$TOKEN")"
  case "$LOGIN_HEADERS" in
    *"302"*) report 0 "gate on: /gate?token=<real> -> 302" ;;
    *) report 1 "gate on: /gate?token=<real> -> 302" "$LOGIN_HEADERS" ;;
  esac
  case "$LOGIN_HEADERS" in
    *"Set-Cookie: nova_gate=$TOKEN;"*) report 0 "gate on: login sets nova_gate=<token>" ;;
    *) report 1 "gate on: login sets nova_gate=<token>" "$LOGIN_HEADERS" ;;
  esac
  case "$LOGIN_HEADERS" in
    *"HttpOnly"*) report 0 "gate on: cookie is HttpOnly" ;;
    *) report 1 "gate on: cookie is HttpOnly" "$LOGIN_HEADERS" ;;
  esac
  # Secure is DERIVED from the forwarded scheme (the same $fwd_proto core
  # reads), not hardcoded: a Secure cookie minted over plain http would be
  # dropped by the browser and the login would silently not stick.
  case "$LOGIN_HEADERS" in
    *"Secure"*) report 1 "gate on: cookie is NOT Secure on plain http (no X-Forwarded-Proto)" "$LOGIN_HEADERS" ;;
    *) report 0 "gate on: cookie is NOT Secure on plain http (no X-Forwarded-Proto)" ;;
  esac
  LOGIN_HEADERS_TLS="$(curl -s -D - -o /dev/null -H "X-Forwarded-Proto: https" "$ON_BASE/gate?token=$TOKEN")"
  case "$LOGIN_HEADERS_TLS" in
    *"HttpOnly; Secure; SameSite=Lax"*) report 0 "gate on: cookie IS Secure behind TLS (X-Forwarded-Proto: https)" ;;
    *) report 1 "gate on: cookie IS Secure behind TLS (X-Forwarded-Proto: https)" "$LOGIN_HEADERS_TLS" ;;
  esac
  case "$LOGIN_HEADERS" in
    *"SameSite=Lax"*) report 0 "gate on: cookie is SameSite=Lax" ;;
    *) report 1 "gate on: cookie is SameSite=Lax" "$LOGIN_HEADERS" ;;
  esac

  code="$(status_of "$ON_BASE" "/" -b "nova_gate=$TOKEN")"
  [ "$code" = "200" ] && report 0 "gate on, correct cookie: / -> 200" \
    || report 1 "gate on, correct cookie: / -> 200" "got $code"

  # core is never started here — a 502 (nginx reached the proxy_pass and got
  # nothing behind it) still proves the gate let the request through, which
  # is everything this line of the matrix is checking.
  code="$(status_of "$ON_BASE" "/api/v1/auth/state" -b "nova_gate=$TOKEN")"
  [ "$code" = "502" ] && report 0 "gate on, correct cookie: /api/v1/auth/state reaches the proxy (502, core absent)" \
    || report 1 "gate on, correct cookie: /api/v1/auth/state reaches the proxy (502, core absent)" "got $code"

  code="$(status_of "$ON_BASE" "/" -b "nova_gate=$WRONG")"
  [ "$code" = "401" ] && report 0 "gate on, wrong cookie: / -> 401" \
    || report 1 "gate on, wrong cookie: / -> 401" "got $code"

  code="$(status_of "$ON_BASE" "/gate-page.html")"
  [ "$code" = "404" ] && report 0 "gate on: /gate-page.html not directly reachable (internal)" \
    || report 1 "gate on: /gate-page.html not directly reachable (internal)" "got $code"

  body="$(curl -s "$ON_BASE/")"
  case "$body" in
    *"<title>Access</title>"*) report 0 "gate on: 401 body is the neutral gate page" ;;
    *) report 1 "gate on: 401 body is the neutral gate page" "$(printf '%s' "$body" | head -c 200)" ;;
  esac
  case "$body" in
    *[Nn]ova*) report 1 "gate on: gate page reveals nothing Nova-specific" "$(printf '%s' "$body" | head -c 200)" ;;
    *) report 0 "gate on: gate page reveals nothing Nova-specific" ;;
  esac

  # A forged identity header on the PUBLISHED port (no trusted address
  # configured on this container at all): the gate does not care.
  code="$(status_of "$ON_BASE" "/" -H "Tailscale-User-Login: forged@example.com")"
  [ "$code" = "401" ] && report 0 "gate on, published port, forged Tailscale-User-Login, no cookie: / -> 401" \
    || report 1 "gate on, published port, forged Tailscale-User-Login, no cookie: / -> 401" "got $code"
fi

# ── gate ON, trusted sidecar address, upstream stub: who is exempt ────────
# A private network with a declared subnet, a stub that answers as `core`
# (the name the template's proxy_pass resolves through docker's embedded
# DNS, which only a user-defined network provides) and echoes the four
# headers this split cares about, and a web container told the sidecar
# lives at $SIDECAR_IP. Clients are then placed AT that address and at
# another one — the source address is the claim under test, so it is made
# for real, not simulated with a header.
STUB_DIR="$(mktemp -d)"
cat > "$STUB_DIR/default.conf" <<'STUB'
server {
    listen 8000;
    location / {
        default_type text/plain;
        return 200 "proto=$http_x_forwarded_proto\nlogin=$http_tailscale_user_login\nname=$http_tailscale_user_name\npic=$http_tailscale_user_profile_pic\n";
    }
}
STUB
if ! docker network create --subnet "$SUBNET" "$NET" >/dev/null; then
  report 1 "test network $NET on $SUBNET can be created" "docker network create failed (subnet in use on this box?)"
else
docker run -d --name "$STUB" --network "$NET" --network-alias core \
  -v "$STUB_DIR:/etc/nginx/conf.d:ro" nginx:alpine >/dev/null
docker run -d --name "$FWD" --network "$NET" -p "127.0.0.1::80" \
  -e NOVA_PUBLIC_GATE_TOKEN="$TOKEN" -e NOVA_TAILSCALE_ADDR="$SIDECAR_IP" "$IMAGE" >/dev/null
if ! wait_for_nginx "http://127.0.0.1:$(port_of "$FWD")"; then
  report 1 "gate-on+trusted-address container starts and answers" "$(docker logs "$FWD" 2>&1 | tail -5)"
else
  FWD_BASE="http://127.0.0.1:$(port_of "$FWD")"
  # The stub must actually be behind the proxy, or every check below would
  # be a 502 that proves nothing.
  tries=20
  while [ "$tries" -gt 0 ]; do
    code="$(status_of "$FWD_BASE" "/api/v1/auth/state" -b "nova_gate=$TOKEN")"
    [ "$code" = "200" ] && break
    tries=$((tries - 1)); sleep 0.5
  done
  [ "$code" = "200" ] && report 0 "stub: /api/v1/auth/state through the proxy -> 200 (upstream stub reachable as core)" \
    || report 1 "stub: /api/v1/auth/state through the proxy -> 200 (upstream stub reachable as core)" "got $code"

  # From the SIDECAR address with the header: exempt, on the app and the API.
  code="$(client_status "$SIDECAR_IP" "http://$FWD/" --header "Tailscale-User-Login: a@b")"
  [ "$code" = "200" ] && report 0 "from $SIDECAR_IP (sidecar) + Tailscale-User-Login, no cookie: / -> 200 (tailnet peer exempt)" \
    || report 1 "from $SIDECAR_IP (sidecar) + Tailscale-User-Login, no cookie: / -> 200 (tailnet peer exempt)" "got '$code'"
  body="$(client_body "$SIDECAR_IP" "http://$FWD/api/v1/auth/state" --header "Tailscale-User-Login: a@b" \
    --header "Tailscale-User-Name: A B" --header "Tailscale-User-Profile-Pic: http://x/a.png")"
  if printf '%s' "$body" | grep -qx 'login=a@b' && printf '%s' "$body" | grep -qx 'name=A B' && printf '%s' "$body" | grep -qx 'pic=http://x/a.png'; then
    report 0 "from $SIDECAR_IP + Tailscale-User-*, no cookie: /api/v1/auth/state reaches core with all three headers intact"
  else
    report 1 "from $SIDECAR_IP + Tailscale-User-*, no cookie: /api/v1/auth/state reaches core with all three headers intact" "$body"
  fi
  # ...and the forwarded scheme rides along (serve sends https).
  body="$(client_body "$SIDECAR_IP" "http://$FWD/api/v1/auth/state" --header "Tailscale-User-Login: a@b" --header "X-Forwarded-Proto: https")"
  case "$body" in
    *"proto=https"*) report 0 "from $SIDECAR_IP + X-Forwarded-Proto: https -> core sees proto=https" ;;
    *) report 1 "from $SIDECAR_IP + X-Forwarded-Proto: https -> core sees proto=https" "$body" ;;
  esac
  # The exemption mints nothing.
  hdrs="$(client_headers "$SIDECAR_IP" "http://$FWD/" --header "Tailscale-User-Login: a@b")"
  case "$hdrs" in
    *"Set-Cookie"*) report 1 "from $SIDECAR_IP, tailnet peer: no Set-Cookie" "$hdrs" ;;
    *) report 0 "from $SIDECAR_IP, tailnet peer: no Set-Cookie" ;;
  esac

  # From the sidecar address WITHOUT the header — a funnel visitor, or a
  # tagged node: gated.
  code="$(client_status "$SIDECAR_IP" "http://$FWD/")"
  [ "$code" = "401" ] && report 0 "from $SIDECAR_IP, no header, no cookie: / -> 401 (funnel visitor / tagged node is gated)" \
    || report 1 "from $SIDECAR_IP, no header, no cookie: / -> 401 (funnel visitor / tagged node is gated)" "got '$code'"
  code="$(client_status "$SIDECAR_IP" "http://$FWD/" --header "Tailscale-User-Login:")"
  [ "$code" = "401" ] && report 0 "from $SIDECAR_IP, EMPTY Tailscale-User-Login: / -> 401" \
    || report 1 "from $SIDECAR_IP, EMPTY Tailscale-User-Login: / -> 401" "got '$code'"
  # The WS carve-out still holds from there (a funnel novad: no header, no
  # cookie) — the stub answers 200 to a plain GET; 401 would mean the gate.
  code="$(client_status "$SIDECAR_IP" "http://$FWD/api/v1/devices/ws")"
  [ "$code" = "200" ] && report 0 "from $SIDECAR_IP, no header, no cookie: /api/v1/devices/ws is NOT gated (200 from core)" \
    || report 1 "from $SIDECAR_IP, no header, no cookie: /api/v1/devices/ws is NOT gated (200 from core)" "got '$code'"

  # From ANOTHER address with the header: the header is worth nothing, and
  # even with a valid cookie core sees none of the identity headers.
  code="$(client_status "$OTHER_IP" "http://$FWD/" --header "Tailscale-User-Login: forged@example.com")"
  [ "$code" = "401" ] && report 0 "from $OTHER_IP (not the sidecar) + Tailscale-User-Login, no cookie: / -> 401" \
    || report 1 "from $OTHER_IP (not the sidecar) + Tailscale-User-Login, no cookie: / -> 401" "got '$code'"
  body="$(client_body "$OTHER_IP" "http://$FWD/api/v1/auth/state" --header "Cookie: nova_gate=$TOKEN" \
    --header "Tailscale-User-Login: forged@example.com" --header "Tailscale-User-Name: Forged" --header "Tailscale-User-Profile-Pic: http://x/p.png")"
  if printf '%s' "$body" | grep -qx 'login=' && printf '%s' "$body" | grep -qx 'name=' && printf '%s' "$body" | grep -qx 'pic='; then
    report 0 "from $OTHER_IP + cookie + forged Tailscale-User-{Login,Name,Profile-Pic}: core sees NONE of them"
  else
    report 1 "from $OTHER_IP + cookie + forged Tailscale-User-{Login,Name,Profile-Pic}: core sees NONE of them" "$body"
  fi

  # From the HOST via the published port (arrives from docker's gateway):
  # same as any other address.
  code="$(status_of "$FWD_BASE" "/" -H "Tailscale-User-Login: forged@example.com")"
  [ "$code" = "401" ] && report 0 "published port + forged Tailscale-User-Login, no cookie: / -> 401" \
    || report 1 "published port + forged Tailscale-User-Login, no cookie: / -> 401" "got $code"
  body="$(curl -s -b "nova_gate=$TOKEN" -H "Tailscale-User-Login: forged@example.com" \
    -H "Tailscale-User-Name: Forged" -H "Tailscale-User-Profile-Pic: http://x/p.png" "$FWD_BASE/api/v1/auth/state")"
  if printf '%s' "$body" | grep -qx 'login=' && printf '%s' "$body" | grep -qx 'name=' && printf '%s' "$body" | grep -qx 'pic='; then
    report 0 "published port + cookie + forged Tailscale-User-{Login,Name,Profile-Pic}: core sees NONE of them"
  else
    report 1 "published port + cookie + forged Tailscale-User-{Login,Name,Profile-Pic}: core sees NONE of them" "$body"
  fi
  # ...on the streaming and WS locations too (each has its own header set).
  for path in "/api/v1/chat/stream" "/api/v1/models/pull" "/api/v1/devices/ws"; do
    body="$(curl -s -b "nova_gate=$TOKEN" -H "Tailscale-User-Login: forged@example.com" "$FWD_BASE$path")"
    if printf '%s' "$body" | grep -qx 'login='; then
      report 0 "published port + forged Tailscale-User-Login on $path: core sees no login"
    else
      report 1 "published port + forged Tailscale-User-Login on $path: core sees no login" "$body"
    fi
  done

  # X-Forwarded-Proto: what the TLS-terminating hop sent survives, in any
  # case; absent means nginx's own scheme (http); anything else stays http.
  body="$(curl -s -b "nova_gate=$TOKEN" -H "X-Forwarded-Proto: https" "$FWD_BASE/api/v1/auth/state")"
  case "$body" in
    *"proto=https"*) report 0 "X-Forwarded-Proto: https -> core sees proto=https (not erased by \$scheme)" ;;
    *) report 1 "X-Forwarded-Proto: https -> core sees proto=https (not erased by \$scheme)" "$body" ;;
  esac
  body="$(curl -s -b "nova_gate=$TOKEN" -H "X-Forwarded-Proto: HTTPS" "$FWD_BASE/api/v1/auth/state")"
  case "$body" in
    *"proto=https"*) report 0 "X-Forwarded-Proto: HTTPS (upper case) -> core sees proto=https" ;;
    *) report 1 "X-Forwarded-Proto: HTTPS (upper case) -> core sees proto=https" "$body" ;;
  esac
  body="$(curl -s -b "nova_gate=$TOKEN" "$FWD_BASE/api/v1/auth/state")"
  case "$body" in
    *"proto=http"$'\n'*) report 0 "no X-Forwarded-Proto -> core sees proto=http (nginx's own scheme)" ;;
    *) report 1 "no X-Forwarded-Proto -> core sees proto=http (nginx's own scheme)" "$body" ;;
  esac
  body="$(curl -s -b "nova_gate=$TOKEN" -H "X-Forwarded-Proto: http" "$FWD_BASE/api/v1/auth/state")"
  case "$body" in
    *"proto=http"$'\n'*) report 0 "X-Forwarded-Proto: http -> core sees proto=http" ;;
    *) report 1 "X-Forwarded-Proto: http -> core sees proto=http" "$body" ;;
  esac
  body="$(curl -s -b "nova_gate=$TOKEN" -H "X-Forwarded-Proto: gopher" "$FWD_BASE/api/v1/auth/state")"
  case "$body" in
    *"proto=http"$'\n'*) report 0 "X-Forwarded-Proto: gopher -> core sees proto=http (only https is kept)" ;;
    *) report 1 "X-Forwarded-Proto: gopher -> core sees proto=http (only https is kept)" "$body" ;;
  esac

  # ── Rendered-conf tripwires ────────────────────────────────────────────
  # Behaviour is proven above; these catch the edit that quietly drops a
  # line from ONE location (a sixth proxied location added without the
  # identity-header rule, say) before it ships.
  rendered_fwd="$(docker exec "$FWD" cat /etc/nginx/conf.d/default.conf)"
  n_listen="$(printf '%s\n' "$rendered_fwd" | grep -cE '^\s*listen ')"
  if [ "$n_listen" -eq 1 ] && printf '%s\n' "$rendered_fwd" | grep -qE '^\s*listen 80;'; then
    report 0 "rendered conf: exactly one listener, :80"
  else
    report 1 "rendered conf: exactly one listener, :80" "$(printf '%s\n' "$rendered_fwd" | grep -E '^\s*listen')"
  fi
  block="$(printf '%s\n' "$rendered_fwd" | sed -n '/map \$remote_addr \$from_sidecar {/,/}/p')"
  if printf '%s' "$block" | grep -qE "^\s*\"$SIDECAR_IP\" 1;"; then
    report 0 "rendered conf: \$from_sidecar map carries NOVA_TAILSCALE_ADDR ($SIDECAR_IP) as its one trusted key"
  else
    report 1 "rendered conf: \$from_sidecar map carries NOVA_TAILSCALE_ADDR ($SIDECAR_IP) as its one trusted key" "$block"
  fi
  n_pass="$(printf '%s\n' "$rendered_fwd" | grep -cE '^\s*proxy_pass ')"
  n_fwd="$(printf '%s\n' "$rendered_fwd" | grep -cE '^\s*proxy_set_header X-Forwarded-Proto \$fwd_proto;')"
  n_login="$(printf '%s\n' "$rendered_fwd" | grep -cE '^\s*proxy_set_header Tailscale-User-Login \$ts_user_login_upstream;')"
  n_name="$(printf '%s\n' "$rendered_fwd" | grep -cE '^\s*proxy_set_header Tailscale-User-Name \$ts_user_name_upstream;')"
  n_pic="$(printf '%s\n' "$rendered_fwd" | grep -cE '^\s*proxy_set_header Tailscale-User-Profile-Pic \$ts_user_pic_upstream;')"
  n_scheme="$(printf '%s\n' "$rendered_fwd" | grep -cE '^\s*proxy_set_header X-Forwarded-Proto \$scheme;')"
  if [ "$n_pass" -gt 0 ] && [ "$n_fwd" -eq "$n_pass" ] && [ "$n_scheme" -eq 0 ]; then
    report 0 "rendered conf: every proxied location ($n_pass) forwards X-Forwarded-Proto \$fwd_proto, none forwards bare \$scheme"
  else
    report 1 "rendered conf: every proxied location ($n_pass) forwards X-Forwarded-Proto \$fwd_proto, none forwards bare \$scheme" "proxy_pass=$n_pass fwd_proto=$n_fwd scheme=$n_scheme"
  fi
  if [ "$n_pass" -gt 0 ] && [ "$n_login" -eq "$n_pass" ] && [ "$n_name" -eq "$n_pass" ] && [ "$n_pic" -eq "$n_pass" ]; then
    report 0 "rendered conf: every proxied location ($n_pass) sets all three Tailscale-User-* headers from the \$from_sidecar-keyed maps"
  else
    report 1 "rendered conf: every proxied location ($n_pass) sets all three Tailscale-User-* headers from the \$from_sidecar-keyed maps" "proxy_pass=$n_pass login=$n_login name=$n_name pic=$n_pic"
  fi
  # The maps themselves: anything not from the sidecar must map to EMPTY
  # (nginx then drops the header) — a `default` that is anything else
  # forwards a forgery.
  for var in ts_user_login_upstream ts_user_name_upstream ts_user_pic_upstream; do
    block="$(printf '%s\n' "$rendered_fwd" | sed -n "/map \$from_sidecar \$$var {/,/}/p")"
    if printf '%s' "$block" | grep -qE '^\s*default "";' && printf '%s' "$block" | grep -qE '^\s*1 \$http_tailscale_user_'; then
      report 0 "rendered conf: map \$$var is empty by default and pass-through only when \$from_sidecar"
    else
      report 1 "rendered conf: map \$$var is empty by default and pass-through only when \$from_sidecar" "$block"
    fi
  done
fi

# ── gate ON, NO trusted address: nobody is exempt ─────────────────────────
# The compose file always passes NOVA_TAILSCALE_ADDR, but a bare `docker
# run` (or a blank value) must fail closed: the map key renders empty and no
# source address ever equals the empty string.
docker run -d --name "$NOTRUST" --network "$NET" -p "127.0.0.1::80" -e NOVA_PUBLIC_GATE_TOKEN="$TOKEN" "$IMAGE" >/dev/null
if ! wait_for_nginx "http://127.0.0.1:$(port_of "$NOTRUST")"; then
  report 1 "gate-on, no NOVA_TAILSCALE_ADDR container starts and answers" "$(docker logs "$NOTRUST" 2>&1 | tail -5)"
else
  code="$(client_status "$SIDECAR_IP" "http://$NOTRUST/" --header "Tailscale-User-Login: a@b")"
  [ "$code" = "401" ] && report 0 "no NOVA_TAILSCALE_ADDR: from $SIDECAR_IP + Tailscale-User-Login: / -> 401 (nobody is trusted)" \
    || report 1 "no NOVA_TAILSCALE_ADDR: from $SIDECAR_IP + Tailscale-User-Login: / -> 401 (nobody is trusted)" "got '$code'"
  body="$(client_body "$SIDECAR_IP" "http://$NOTRUST/api/v1/auth/state" --header "Cookie: nova_gate=$TOKEN" --header "Tailscale-User-Login: a@b")"
  if printf '%s' "$body" | grep -qx 'login='; then
    report 0 "no NOVA_TAILSCALE_ADDR: from $SIDECAR_IP + cookie + Tailscale-User-Login: core sees no login"
  else
    report 1 "no NOVA_TAILSCALE_ADDR: from $SIDECAR_IP + cookie + Tailscale-User-Login: core sees no login" "$body"
  fi
  rendered_nt="$(docker exec "$NOTRUST" cat /etc/nginx/conf.d/default.conf)"
  block="$(printf '%s\n' "$rendered_nt" | sed -n '/map \$remote_addr \$from_sidecar {/,/}/p')"
  if printf '%s' "$block" | grep -qE '^\s*"" 1;' && ! printf '%s' "$block" | grep -q 'NOVA_TAILSCALE_ADDR'; then
    report 0 "no NOVA_TAILSCALE_ADDR: rendered \$from_sidecar key is the empty string, not a leftover placeholder"
  else
    report 1 "no NOVA_TAILSCALE_ADDR: rendered \$from_sidecar key is the empty string, not a leftover placeholder" "$block"
  fi
fi
fi  # network created

# ── gate OFF (no -e at all — the real "unconfigured .env" case) ────────────
docker run -d --name "$OFF" -p "127.0.0.1::80" "$IMAGE" >/dev/null
if ! wait_for_nginx "http://127.0.0.1:$(port_of "$OFF")"; then
  report 1 "gate-off container starts and answers" "$(docker logs "$OFF" 2>&1 | tail -5)"
else
  OFF_BASE="http://127.0.0.1:$(port_of "$OFF")"

  code="$(docker exec "$OFF" nginx -t 2>&1)"; rc=$?
  [ "$rc" -eq 0 ] && report 0 "gate off: nginx -t" || report 1 "gate off: nginx -t" "$code"

  HEADERS="$(curl -s -D - -o /dev/null "$OFF_BASE/")"
  case "$HEADERS" in
    *"200"*) report 0 "gate off, no -e at all: / -> 200" ;;
    *) report 1 "gate off, no -e at all: / -> 200" "$HEADERS" ;;
  esac
  case "$HEADERS" in
    *"Set-Cookie"*) report 1 "gate off: no Set-Cookie on /" "$HEADERS" ;;
    *) report 0 "gate off: no Set-Cookie on /" ;;
  esac

  code="$(status_of "$OFF_BASE" "/gate?token=anything")"
  [ "$code" = "401" ] && report 0 "gate off: /gate login itself refuses (nothing to mint a cookie for)" \
    || report 1 "gate off: /gate login itself refuses (nothing to mint a cookie for)" "got $code"

  code="$(status_of "$OFF_BASE" "/healthz")"
  [ "$code" = "200" ] && report 0 "gate off: /healthz -> 200" \
    || report 1 "gate off: /healthz -> 200" "got $code"

  HEALTHZ_HEADERS_OFF="$(curl -s -D - -o /dev/null "$OFF_BASE/healthz")"
  case "$HEALTHZ_HEADERS_OFF" in
    *"Set-Cookie"*) report 1 "gate off: /healthz never sets a cookie" "$HEALTHZ_HEADERS_OFF" ;;
    *) report 0 "gate off: /healthz never sets a cookie" ;;
  esac

  # ── envsubst-filter proof ────────────────────────────────────────────
  # NGINX_ENVSUBST_FILTER=^NOVA_ must leave every nginx-native `$var` alone
  # and substitute only the NOVA_* vars. Derived from the checked-in
  # template itself (not a pinned historical commit — a hardcoded SHA would
  # be exactly the "derived, never hardcoded" mistake this repo's own rule
  # warns about, and would also make this check outlive a rebase). Every
  # nginx `$var` the template actually uses must appear verbatim, un-mangled,
  # in the rendered output; envsubst would have blanked or dropped any of
  # these had the filter let it touch them.
  rendered="$(docker exec "$OFF" cat /etc/nginx/conf.d/default.conf)"
  template="$SCRIPT_DIR/nginx.conf.template"
  # Every nginx variable the template references, in either $name or
  # ${name} form, EXCLUDING the ones that are actually meant to substitute
  # (NOVA_*, upper case, so the [a-z_] class never matches them) and nginx's
  # map-derived $gate_* outputs (those legitimately don't exist until nginx
  # evaluates the maps, so grepping for their literal presence proves
  # nothing extra beyond the maps themselves).
  native_vars="$(grep -oE '\$\{?[a-z_]+\}?' "$template" \
    | sed -E 's/[${}]//g' | sort -u \
    | grep -vE '^(gate_block|gate_cookie_ok|gate_enabled|gate_login_ok|gate_token_ok|cookie_nova_gate|arg_token)$')"
  missing=""
  for var in $native_vars; do
    case "$rendered" in
      *"\$$var"*) : ;;
      *) missing="$missing \$$var" ;;
    esac
  done
  if [ -z "$missing" ]; then
    report 0 "envsubst filter: every nginx-native \$var in the template survives un-mangled in the rendered conf"
  else
    report 1 "envsubst filter: every nginx-native \$var in the template survives un-mangled in the rendered conf" \
      "missing:$missing"
  fi
  # And the vars that SHOULD have been substituted must be gone —
  # otherwise NGINX_ENVSUBST_FILTER's pattern silently stopped matching.
  case "$rendered" in
    *'${NOVA_PUBLIC_GATE_TOKEN}'*|*'$NOVA_PUBLIC_GATE_TOKEN'*)
      report 1 "envsubst filter: NOVA_PUBLIC_GATE_TOKEN itself IS substituted" "literal placeholder still present" ;;
    *)
      report 0 "envsubst filter: NOVA_PUBLIC_GATE_TOKEN itself IS substituted" ;;
  esac
  case "$rendered" in
    *'${NOVA_TAILSCALE_ADDR}'*|*'$NOVA_TAILSCALE_ADDR'*)
      report 1 "envsubst filter: NOVA_TAILSCALE_ADDR itself IS substituted" "literal placeholder still present" ;;
    *)
      report 0 "envsubst filter: NOVA_TAILSCALE_ADDR itself IS substituted" ;;
  esac
fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
