#!/usr/bin/env bash
# Pins apps/web's pre-auth token gate (nginx.conf.template + gate/, see
# apps/web/Dockerfile). Builds the real image, runs it twice (token set,
# token absent) against throwaway containers on random host ports, and
# curls the matrix the gate exists to satisfy: fail-closed on every path
# with no/wrong cookie, a working /gate login, byte-identical behaviour
# with the gate off, and no accidental corruption of nginx's own `$vars` by
# envsubst.
#
# No stack needs to be running. Leaves nothing behind — every container this
# script starts is removed on exit, success or failure.
#
#     apps/web/gate_test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
IMAGE="nova-web-gate-test-$$"
ON="nova-gate-test-on-$$"
OFF="nova-gate-test-off-$$"
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
  docker rm -f "$ON" "$OFF" >/dev/null 2>&1 || true
  docker rmi "$IMAGE" >/dev/null 2>&1 || true
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

  for path in "/" "/api/v1/auth/state" "/assets/x.js" "/api/v1/devices/ws" "/health/live"; do
    code="$(status_of "$ON_BASE" "$path")"
    [ "$code" = "401" ] && report 0 "gate on, no cookie: $path -> 401" \
      || report 1 "gate on, no cookie: $path -> 401" "got $code"
  done

  code="$(status_of "$ON_BASE" "/gate?token=$WRONG")"
  [ "$code" = "401" ] && report 0 "gate on: /gate?token=wrong -> 401" \
    || report 1 "gate on: /gate?token=wrong -> 401" "got $code"

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
  case "$LOGIN_HEADERS" in
    *"Secure"*) report 0 "gate on: cookie is Secure" ;;
    *) report 1 "gate on: cookie is Secure" "$LOGIN_HEADERS" ;;
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
fi

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

  # ── envsubst-filter proof ────────────────────────────────────────────
  # NGINX_ENVSUBST_FILTER=^NOVA_ must leave every nginx-native `$var` alone
  # and substitute only NOVA_PUBLIC_GATE_TOKEN. Derived from the checked-in
  # template itself (not a pinned historical commit — a hardcoded SHA would
  # be exactly the "derived, never hardcoded" mistake this repo's own rule
  # warns about, and would also make this check outlive a rebase). Every
  # nginx `$var` the template actually uses must appear verbatim, un-mangled,
  # in the rendered output; envsubst would have blanked or dropped any of
  # these had the filter let it touch them.
  rendered="$(docker exec "$OFF" cat /etc/nginx/conf.d/default.conf)"
  template="$SCRIPT_DIR/nginx.conf.template"
  # Every nginx variable the template references, in either $name or
  # ${name} form, EXCLUDING the one that's actually meant to substitute
  # (NOVA_PUBLIC_GATE_TOKEN) and nginx's map-derived $gate_* outputs (those
  # legitimately don't exist until nginx evaluates the maps, so grepping for
  # their literal presence proves nothing extra beyond the maps themselves).
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
  # And the one var that SHOULD have been substituted must be gone —
  # otherwise NGINX_ENVSUBST_FILTER's pattern silently stopped matching it.
  case "$rendered" in
    *'${NOVA_PUBLIC_GATE_TOKEN}'*|*'$NOVA_PUBLIC_GATE_TOKEN'*)
      report 1 "envsubst filter: NOVA_PUBLIC_GATE_TOKEN itself IS substituted" "literal placeholder still present" ;;
    *)
      report 0 "envsubst filter: NOVA_PUBLIC_GATE_TOKEN itself IS substituted" ;;
  esac
fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
