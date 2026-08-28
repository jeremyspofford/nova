#!/usr/bin/env bash
# Tests for deploy/install.sh's inference decision.
#
# install.sh guards its own entry point (`if [ "${BASH_SOURCE[0]}" = "$0" ]`),
# so this file sources it to get the real functions and then stubs only the
# two that touch the outside world — what holds the port, and whether an
# ollama answers on it. Everything under test is the shipped code path.
#
# No docker, no network, no writes outside a temp dir:
#     deploy/install_test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
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

# Run one case in a subshell so a `die` (exit 1) cannot take the harness with
# it, and so each case gets clean globals. Prints "<exit>|<stderr>".
#
#   $1 port_holder output ("" = free)
#   $2 ollama_answers_on_host exit code (0 answers, 1 does not, 2 cannot tell)
#   $3 value of NOVA_SKIP_INFERENCE
#   $4 bundled_ollama_running exit code (0 = it is ours; default 1)
run_decide() {
  (
    # shellcheck source=/dev/null
    . "$SCRIPT_DIR/install.sh"
    # install.sh sets -e for its own run; here a non-zero result IS the
    # thing being measured, so errexit must not eat it before we read it.
    set +e
    port_holder() { printf '%s' "$1x" >/dev/null; printf '%s' "$HOLDER"; }
    ollama_answers_on_host() { return "$ANSWERS"; }
    bundled_ollama_running() { return "$OURS"; }
    HOLDER="$1"
    ANSWERS="$2"
    OURS="${4:-1}"
    if [ -n "$3" ]; then export NOVA_SKIP_INFERENCE="$3"; else unset NOVA_SKIP_INFERENCE; fi

    err="$(decide_inference 2>&1)" ; code=$?
    printf '%s|%s' "$code" "$(printf '%s' "$err" | tr '\n' ' ')"
  )
}

expect_case() {
  local name="$1" out="$2" want_code="$3" want_text="$4"
  local code="${out%%|*}" text="${out#*|}"
  if [ "$code" != "$want_code" ]; then
    report 1 "$name" "exit $code, wanted $want_code — output: $text"
    return
  fi
  case "$text" in
    *"$want_text"*) report 0 "$name" ;;
    *) report 1 "$name" "output did not mention '$want_text' — output: $text" ;;
  esac
}

# ── a free port is the ordinary case ────────────────────────────────────────
expect_case "free port: the bundled engine is used" \
  "$(run_decide "" 1 "")" 0 "free (bundled ollama will publish it)"

# ── the regression this file exists for ─────────────────────────────────────
# A host ollama used to produce "WARNING: port 11434 is already in use",
# followed seconds later by a raw docker "port is already allocated". It must
# now refuse up front, say an ollama is there, and give both remedies.
HOST_OLLAMA="$(run_decide "ollama(4242)" 0 "")"
expect_case "host ollama: refuses instead of warning" "$HOST_OLLAMA" 1 \
  "an ollama is already serving on 127.0.0.1:11434"
expect_case "host ollama: names what holds the port" "$HOST_OLLAMA" 1 "ollama(4242)"
expect_case "host ollama: offers freeing the port" "$HOST_OLLAMA" 1 "Free the port"
expect_case "host ollama: offers the skip flag" "$HOST_OLLAMA" 1 \
  "NOVA_SKIP_INFERENCE=1 ./install"
expect_case "host ollama: points at the wizard's remote option" "$HOST_OLLAMA" 1 \
  "Remote endpoint"

# ── re-install: the port is busy because WE are on it ───────────────────────
# install.sh is documented idempotent. Refusing to re-run because the last
# run's own container is still up would be a worse bug than the one above.
expect_case "our own ollama: re-install proceeds instead of refusing" \
  "$(run_decide "docker-proxy(1)" 0 "" 0)" 0 "held by this stack's own ollama"

# ── something else on the port is a different sentence ──────────────────────
expect_case "foreign listener: says it did not answer as an ollama" \
  "$(run_decide "nc(99)" 1 "")" 1 "did not answer as an ollama"

# ── no HTTP client: say so rather than guess ────────────────────────────────
expect_case "no curl or wget: does not claim to know what is there" \
  "$(run_decide "something(7)" 2 "")" 1 "could not be checked"

# ── the documented escape hatch ─────────────────────────────────────────────
expect_case "NOVA_SKIP_INFERENCE=1: skips even with the port busy" \
  "$(run_decide "ollama(4242)" 0 "1")" 0 "bundled ollama skipped"

# ── the flag has to reach compose and the health table ──────────────────────
# detect_hardware is the one place that appends the profile, so this exercises
# it for real with its output redirected into a temp dir.
run_wiring() {
  (
    # shellcheck source=/dev/null
    . "$SCRIPT_DIR/install.sh"
    set +e
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    # Read by the sourced install.sh, not by anything in this file — which is
    # exactly what shellcheck cannot see across a `.` it was not given.
    # shellcheck disable=SC2034
    DATA_DIR="$tmp"
    # shellcheck disable=SC2034
    HARDWARE_JSON="$tmp/hardware.json"
    # shellcheck disable=SC2034
    BUNDLED_INFERENCE="$1"
    detect_hardware >/dev/null 2>&1
    printf '%s|%s' "${COMPOSE_ARGS[*]}" "$HEALTH_CHECKED_SERVICES"
  )
}

WIRED_ON="$(run_wiring 1)"
case "$WIRED_ON" in
  *"--profile inference"*) report 0 "bundled on: compose gets --profile inference" ;;
  *) report 1 "bundled on: compose gets --profile inference" "$WIRED_ON" ;;
esac
case "${WIRED_ON#*|}" in
  *ollama*) report 0 "bundled on: ollama is health-checked" ;;
  *) report 1 "bundled on: ollama is health-checked" "$WIRED_ON" ;;
esac

WIRED_OFF="$(run_wiring 0)"
case "$WIRED_OFF" in
  *"--profile inference"*) report 1 "bundled off: no inference profile" "$WIRED_OFF" ;;
  *) report 0 "bundled off: no inference profile" ;;
esac
case "${WIRED_OFF#*|}" in
  *ollama*) report 1 "bundled off: ollama is not health-checked" "$WIRED_OFF" ;;
  *) report 0 "bundled off: ollama is not health-checked" ;;
esac

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
