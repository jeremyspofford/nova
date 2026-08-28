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
#   $4 ollama_slot_config_files stdout (the compose config_files label)
#   $5 ollama_slot_config_files exit code (0 container, 1 none, 2 docker error)
#
# Note what is stubbed: the SEAM, not bundled_ollama_running. Every case below
# therefore runs the real ours/foreign judgement — the whole point of the
# defect being fixed here was that a stubbed identity check proved nothing.
run_decide() {
  (
    # shellcheck source=/dev/null
    . "$SCRIPT_DIR/install.sh"
    # install.sh sets -e for its own run; here a non-zero result IS the
    # thing being measured, so errexit must not eat it before we read it.
    set +e
    port_holder() { printf '%s' "$1x" >/dev/null; printf '%s' "$HOLDER"; }
    ollama_answers_on_host() { return "$ANSWERS"; }
    ollama_slot_config_files() { printf '%s' "$SLOT_LABEL"; return "$SLOT_RC"; }
    HOLDER="$1"
    ANSWERS="$2"
    SLOT_LABEL="${4:-}"
    SLOT_RC="${5:-1}"
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
expect_case "host ollama: offers stopping the host daemon" "$HOST_OLLAMA" 1 \
  "systemctl --user stop ollama"
expect_case "host ollama: offers the skip flag" "$HOST_OLLAMA" 1 \
  "NOVA_SKIP_INFERENCE=1 ./install"
expect_case "host ollama: points at the wizard's remote option" "$HOST_OLLAMA" 1 \
  "Remote endpoint"

# ── re-install: the port is busy because WE are on it ───────────────────────
# install.sh is documented idempotent. Refusing to re-run because the last
# run's own container is still up would be a worse bug than the one above.
OURS_LABEL="$SCRIPT_DIR/docker-compose.yml,$SCRIPT_DIR/docker-compose.gpu.yml"
V3_LABEL="/home/jeremy/workspace/nova/docker-compose.yml,/home/jeremy/workspace/nova/docker-compose.gpu.yml"

expect_case "our own ollama: re-install proceeds instead of refusing" \
  "$(run_decide "docker-proxy(1)" 0 "" "$OURS_LABEL" 0)" 0 "held by this stack's own ollama"

# ── the defect this round exists for ────────────────────────────────────────
# v3 and v4 both declare `name: nova` and both define a service called
# `ollama` behind profiles:["inference"], so a project+service match cannot
# tell them apart — and `docker compose down` does not reach a profiled
# service, so a surviving v3 ollama on :11434 is the documented normal case.
# It must classify as FOREIGN and refuse.
V3_LEFTOVER="$(run_decide "docker-proxy(1)" 0 "" "$V3_LABEL" 0)"
expect_case "leftover v3 ollama: refuses instead of adopting it" "$V3_LEFTOVER" 1 \
  "an ollama is already serving"
expect_case "leftover v3 ollama: says the container is not ours" "$V3_LEFTOVER" 1 \
  "is not this stack's"
expect_case "leftover v3 ollama: quotes the foreign config files" "$V3_LEFTOVER" 1 \
  "/home/jeremy/workspace/nova/docker-compose.yml"
expect_case "leftover v3 ollama: names the v3 cleanup" "$V3_LEFTOVER" 1 \
  "docker stop nova-ollama-1"
expect_case "leftover v3 ollama: names the v3 tree teardown" "$V3_LEFTOVER" 1 \
  "compose --profile inference down"

# A v3 container created from inside a container carries a path that does not
# exist on this filesystem. It must still compare as foreign, not explode.
expect_case "foreign label naming a path that does not exist here" \
  "$(run_decide "docker-proxy(1)" 0 "" "/compose/docker-compose.yml" 0)" 1 \
  "is not this stack's"

# A container with no compose label at all is not ours either.
expect_case "unlabelled container on the slot is not adopted" \
  "$(run_decide "docker-proxy(1)" 0 "" "" 0)" 1 "carries no compose config-files label"

# "Cannot ask docker" is its own answer, distinct from "nothing is there".
expect_case "docker error: refuses, and does not claim to know" \
  "$(run_decide "docker-proxy(1)" 0 "" "" 2)" 1 \
  "could not be established"

# ── something else on the port is a different sentence ──────────────────────
expect_case "foreign listener: says it did not answer as an ollama" \
  "$(run_decide "nc(99)" 1 "")" 1 "did not answer as an ollama"

# ── no HTTP client: say so rather than guess ────────────────────────────────
expect_case "no curl or wget: does not claim to know what is there" \
  "$(run_decide "something(7)" 2 "")" 1 "could not be checked"

# ── the documented escape hatch ─────────────────────────────────────────────
expect_case "NOVA_SKIP_INFERENCE=1: skips even with the port busy" \
  "$(run_decide "ollama(4242)" 0 "1")" 0 "bundled ollama skipped"

# ── bundled_ollama_running, driven directly through fixture labels ──────────
# Same real body as above, asserted on its own return code and stated reason
# rather than through decide_inference's messages.
#
#   $1 seam stdout   $2 seam exit code   -> "<rc>|<reason>"
run_ours_check() {
  (
    # shellcheck source=/dev/null
    . "$SCRIPT_DIR/install.sh"
    set +e
    ollama_slot_config_files() { printf '%s' "$SLOT_LABEL"; return "$SLOT_RC"; }
    SLOT_LABEL="$1"
    SLOT_RC="$2"
    bundled_ollama_running; rc=$?
    printf '%s|%s' "$rc" "$BUNDLED_OLLAMA_REASON"
  )
}

expect_ours() {
  local name="$1" out="$2" want_rc="$3" want_text="$4"
  local rc="${out%%|*}" reason="${out#*|}"
  if [ "$rc" != "$want_rc" ]; then
    report 1 "$name" "rc $rc, wanted $want_rc — reason: $reason"
    return
  fi
  case "$reason" in
    *"$want_text"*) report 0 "$name" ;;
    *) report 1 "$name" "reason did not mention '$want_text' — reason: $reason" ;;
  esac
}

expect_ours "ours: this repo's compose file is in the label" \
  "$(run_ours_check "$OURS_LABEL" 0)" 0 "$SCRIPT_DIR/docker-compose.yml"
expect_ours "ours: matches even when listed after other files" \
  "$(run_ours_check "/somewhere/else.yml,$SCRIPT_DIR/docker-compose.yml" 0)" 0 "created from"
expect_ours "ours: an unresolved but equivalent path still matches" \
  "$(run_ours_check "$SCRIPT_DIR/../deploy/docker-compose.yml" 0)" 0 "created from"
expect_ours "v3: same project and service, different compose file" \
  "$(run_ours_check "$V3_LABEL" 0)" 1 "not from"
expect_ours "v3: a config path that does not exist on this host" \
  "$(run_ours_check "/compose/docker-compose.yml" 0)" 1 "not from"
expect_ours "no label on the container" \
  "$(run_ours_check "" 0)" 1 "no compose config-files label"
expect_ours "no container occupies the slot" \
  "$(run_ours_check "" 1)" 1 "no container occupies"
expect_ours "docker could not be asked" \
  "$(run_ours_check "" 2)" 2 "docker could not be asked"

# A near-miss must not pass: same directory, different file.
expect_ours "a sibling compose file is not this one" \
  "$(run_ours_check "$SCRIPT_DIR/docker-compose.gpu.yml" 0)" 1 "not from"

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

# ── secrets: INSTANCE_SECRET is dead config, and .env is never world-readable ──
# INSTANCE_SECRET is dropped from SECRET_KEYS (S2 seam-hygiene): nothing reads
# it, so a fresh .env must not generate one, an idempotent re-run must not
# require one, and a real operator's EXISTING .env carrying a stale value from
# before this change must be left exactly as it was — never edited, never a
# reason to fail.
run_secrets() {
  (
    # shellcheck source=/dev/null
    . "$SCRIPT_DIR/install.sh"
    set +e
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    # shellcheck disable=SC2034
    ENV_EXAMPLE="$SCRIPT_DIR/.env.example"
    # shellcheck disable=SC2034
    ENV_FILE="$tmp/.env"
    if [ -n "${1:-}" ]; then
      cp "$ENV_EXAMPLE" "$ENV_FILE"
      printf '%s\n' "$1" >> "$ENV_FILE"
      chmod 644 "$ENV_FILE"
    fi
    generate_secrets >/dev/null 2>&1
    perms="$(stat -c '%a' "$ENV_FILE" 2>/dev/null || stat -f '%Lp' "$ENV_FILE" 2>/dev/null)"
    printf '%s|%s' "$perms" "$(cat "$ENV_FILE")"
  )
}

FRESH_SECRETS="$(run_secrets)"
FRESH_PERMS="${FRESH_SECRETS%%|*}"
FRESH_BODY="${FRESH_SECRETS#*|}"
case "$FRESH_PERMS" in
  600) report 0 "fresh .env: written chmod 600" ;;
  *) report 1 "fresh .env: written chmod 600" "got mode '$FRESH_PERMS'" ;;
esac
case "$FRESH_BODY" in
  *INSTANCE_SECRET*) report 1 "fresh .env: no INSTANCE_SECRET generated" "$FRESH_BODY" ;;
  *) report 0 "fresh .env: no INSTANCE_SECRET generated" ;;
esac
case "$FRESH_BODY" in
  *"CORE_MEMORY_TOKEN="?*) report 0 "fresh .env: real secrets still generated" ;;
  *) report 1 "fresh .env: real secrets still generated" "$FRESH_BODY" ;;
esac

# The realistic idempotent re-run: every real key is ALREADY populated, so
# ensure_secret returns early for each one and never rewrites the file via
# set_env_value at all. That path must chmod the file on its own — proving
# this against a fully-populated .env is the only way to rule out the
# unrelated side effect of set_env_value's own mktemp+mv (which happens to
# leave 600 behind by accident whenever it actually runs).
run_secrets_noop() {
  (
    # shellcheck source=/dev/null
    . "$SCRIPT_DIR/install.sh"
    set +e
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    # shellcheck disable=SC2034
    ENV_EXAMPLE="$SCRIPT_DIR/.env.example"
    # shellcheck disable=SC2034
    ENV_FILE="$tmp/.env"
    {
      printf 'POSTGRES_PASSWORD=already-set\n'
      printf 'CORE_TOKEN=already-set\n'
      printf 'CORE_GATEWAY_TOKEN=already-set\n'
      printf 'CORE_MEMORY_TOKEN=already-set\n'
    } > "$ENV_FILE"
    chmod 644 "$ENV_FILE"
    generate_secrets >/dev/null 2>&1
    stat -c '%a' "$ENV_FILE" 2>/dev/null || stat -f '%Lp' "$ENV_FILE" 2>/dev/null
  )
}
NOOP_PERMS="$(run_secrets_noop)"
case "$NOOP_PERMS" in
  600) report 0 "idempotent re-run with nothing to generate: still chmod 600" ;;
  *) report 1 "idempotent re-run with nothing to generate: still chmod 600" "got mode '$NOOP_PERMS'" ;;
esac

STALE_SECRETS="$(run_secrets "INSTANCE_SECRET=old-stale-value")"
STALE_PERMS="${STALE_SECRETS%%|*}"
STALE_BODY="${STALE_SECRETS#*|}"
case "$STALE_PERMS" in
  600) report 0 "existing .env with a stale INSTANCE_SECRET: still chmod 600" ;;
  *) report 1 "existing .env with a stale INSTANCE_SECRET: still chmod 600" "got mode '$STALE_PERMS'" ;;
esac
case "$STALE_BODY" in
  *"INSTANCE_SECRET=old-stale-value"*)
    report 0 "existing .env: stale INSTANCE_SECRET left harmlessly in place" ;;
  *)
    report 1 "existing .env: stale INSTANCE_SECRET left harmlessly in place" "$STALE_BODY" ;;
esac

# ── preflight: openssl is required to generate secrets, so check for it ────
run_openssl_check() {
  (
    # shellcheck source=/dev/null
    . "$SCRIPT_DIR/install.sh"
    set +e
    OPENSSL_RC="$1"
    have_openssl() { return "$OPENSSL_RC"; }
    err="$(check_openssl 2>&1)"; code=$?
    printf '%s|%s' "$code" "$(printf '%s' "$err" | tr '\n' ' ')"
  )
}

expect_case "openssl present: preflight passes" "$(run_openssl_check 0)" 0 "openssl: present"
expect_case "openssl missing: refuses instead of failing later inside generate_secrets" \
  "$(run_openssl_check 1)" 1 "openssl not found"
expect_case "openssl missing: states a remedy" "$(run_openssl_check 1)" 1 "install"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
