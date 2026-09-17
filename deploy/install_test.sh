#!/usr/bin/env bash
# Tests for deploy/install.sh's decisions: the inference one and the tailnet
# one.
#
# install.sh guards its own entry point (`if [ "${BASH_SOURCE[0]}" = "$0" ]`),
# so this file sources it to get the real functions and then stubs only what
# touches the outside world — what holds the port, whether an ollama answers
# on it, whether the tailnet state volume holds a node, the terminal.
# Everything under test is the shipped code path.
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
      # Every key in SECRET_KEYS must be pre-populated for this to be a genuine
      # no-op: SEARXNG_SECRET joined that list with web search, so it belongs
      # here too, or generate_secrets would rewrite the file via set_env_value
      # and this would stop testing the chmod-on-noop path it exists for.
      printf 'SEARXNG_SECRET=already-set\n'
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

# REGRESSION (rd7): a newly-added secret ABSENT from an existing .env must not
# abort generate_secrets. get_env_value's `grep | cut` returns 1 on a miss under
# `set -o pipefail`, and `existing="$(get_env_value …)"` in ensure_secret is a
# simple command whose non-zero status trips `set -e` — which aborted the whole
# install right before it would have generated the missing key. SEARXNG_SECRET
# (added with web search) was the first key that could be missing from an
# existing .env, and it did exactly this in production. This case runs
# generate_secrets WITH set -e ACTIVE (as the real install does) — unlike
# run_secrets above, which sets +e and so cannot see this abort — against a .env
# holding the OLD keys but not the new one.
run_secrets_missing_new_key() {
  (
    # shellcheck source=/dev/null
    . "$SCRIPT_DIR/install.sh"   # sets -euo pipefail — deliberately NOT relaxed
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    # shellcheck disable=SC2034
    ENV_FILE="$tmp/.env"
    # shellcheck disable=SC2034
    ENV_EXAMPLE="$SCRIPT_DIR/.env.example"
    {
      printf 'POSTGRES_PASSWORD=already-set\n'
      printf 'CORE_TOKEN=already-set\n'
      printf 'CORE_GATEWAY_TOKEN=already-set\n'
      printf 'CORE_MEMORY_TOKEN=already-set\n'
      # SEARXNG_SECRET deliberately ABSENT — the existing-install upgrade case.
    } > "$ENV_FILE"
    generate_secrets >/dev/null 2>&1   # set -e active: aborts HERE if the bug is back
    # Reached only if generate_secrets did NOT abort:
    grep -q '^SEARXNG_SECRET=..*' "$ENV_FILE" && printf 'GENERATED'
  )
}
# NO `|| true` here: putting the call in a `||` list would make bash IGNORE
# `set -e` for its whole body (subshell included), so generate_secrets could not
# abort and this case would be vacuous. A bare command-substitution assignment
# keeps the subshell's `set -e` live; the outer script is `set -uo pipefail`
# (no -e), so a subshell that DOES abort just yields an empty string here — which
# is exactly the failure this case reports.
MISSING_KEY_RESULT="$(run_secrets_missing_new_key)"
case "$MISSING_KEY_RESULT" in
  GENERATED)
    report 0 "existing .env missing a newly-added secret: generated it, no abort under set -e" ;;
  *)
    report 1 "existing .env missing a newly-added secret: generated it, no abort under set -e" \
      "aborted or not generated (got '$MISSING_KEY_RESULT')" ;;
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


# ── tailnet: the profile refuses an engine it cannot start ──────────────────
# decide_tailnet runs for real against a temp .env. Stubbed are the three
# seams that touch the outside world: the state volume
# (tailscale_state_present), the terminal (have_tty) and the prompt
# (prompt_value, which also records that it was asked). The wiring it leaves
# behind — COMPOSE_ARGS, HEALTH_CHECKED_SERVICES — is written out by the same
# shell that ran it, so a refusal (exit 1) leaves them empty here. .env is
# then written by record_compose_profiles, as cmd_install does.
#
#   $1 NOVA_TAILNET value ("" = unset)
#   $2 tailscale_state_present exit code (0 node present, 1 none, 2 no docker)
#   $3 have_tty exit code (0 terminal, 1 none)
#   $4 what the operator types at every prompt ("" = accept the default)
#   $5 initial .env body (printf %b escapes)
#   $6 "lowseams" to run the real tailscale_state_present over stubbed docker
# Prints "<exit>|<COMPOSE_ARGS>|<HEALTH_CHECKED_SERVICES>|<.env with ; for
# newlines>|<prompts asked>|<stderr>".
# What `docker compose --profile tailnet config` prints, in miniature, with
# decoys on every side of the lines the readers must pick out.
FIXTURE_CFG='name: nova
services:
  core:
    image: decoy/core:1
  tailscale:
    hostname: nova
    image: tailscale/tailscale:v9.9.9
  web:
    image: decoy/web:1
volumes:
  v4_pgdata:
    name: nova_v4_pgdata
  v4_tailscale:
    name: nova_v4_tailscale
  v4_workspace:
    name: nova_v4_workspace
'
run_tailnet() {
  (
    # shellcheck source=/dev/null
    . "$SCRIPT_DIR/install.sh"
    set +e
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    # shellcheck disable=SC2034
    ENV_FILE="$tmp/.env"
    printf '%b' "$5" > "$ENV_FILE"
    STATE_RC="$2"
    TTY_RC="$3"
    PROMPT_ANSWER="$4"
    if [ "${6:-}" = "lowseams" ]; then
      # tailscale_state_present runs for REAL; what is stubbed is docker
      # underneath it, in the migrated-node shape: compose resolves the
      # names, the label lookup finds nothing, the volume exists by name
      # and holds a state file.
      compose_config_text() { printf '%s' "$FIXTURE_CFG"; }
      state_volume_by_label() { printf ''; }
      state_volume_exists() { return 0; }
      state_file_on_volume() { return 0; }
    else
      tailscale_state_present() {
        # Read by decide_tailnet in the sourced install.sh, not here.
        # shellcheck disable=SC2034
        TAILNET_STATE_REASON="stub: state volume answer $STATE_RC"
        return "$STATE_RC"
      }
    fi
    have_tty() { return "$TTY_RC"; }
    prompt_value() {
      printf 'PROMPTED[%s];' "$1" >> "$tmp/prompts"
      printf '%s' "${PROMPT_ANSWER:-$2}"
    }
    if [ -n "$1" ]; then export NOVA_TAILNET="$1"; else unset NOVA_TAILNET; fi
    (
      decide_tailnet 2> "$tmp/err"
      # The shipped sequence: cmd_install writes COMPOSE_PROFILES right after
      # every --profile decision, from the one derived writer — a refusal
      # above exits this subshell first and leaves .env untouched.
      record_compose_profiles 2>> "$tmp/err"
      printf '%s' "${COMPOSE_ARGS[*]}" > "$tmp/args"
      printf '%s' "$HEALTH_CHECKED_SERVICES" > "$tmp/health"
    )
    code=$?
    printf '%s|%s|%s|%s|%s|%s' "$code" \
      "$(cat "$tmp/args" 2>/dev/null)" \
      "$(cat "$tmp/health" 2>/dev/null)" \
      "$(tr '\n' ';' < "$ENV_FILE")" \
      "$(cat "$tmp/prompts" 2>/dev/null)" \
      "$(tr '\n' ' ' < "$tmp/err")"
  )
}

# Field n (1-based) of a run_tailnet result.
tn_field() {
  printf '%s' "$1" | cut -d'|' -f"$2"
}

expect_tn() {
  # $1 name  $2 result  $3 want exit  $4 field number  $5 needle ("" = any)
  local name="$1" out="$2" want_code="$3" fno="$4" needle="$5"
  local code text
  code="$(tn_field "$out" 1)"
  text="$(tn_field "$out" "$fno")"
  if [ "$code" != "$want_code" ]; then
    report 1 "$name" "exit $code, wanted $want_code — stderr: $(tn_field "$out" 6)"
    return
  fi
  case "$text" in
    *"$needle"*) report 0 "$name" ;;
    *) report 1 "$name" "field $fno did not contain '$needle' — got: $text" ;;
  esac
}

expect_tn_lacks() {
  local name="$1" out="$2" fno="$3" needle="$4" text
  text="$(tn_field "$out" "$fno")"
  case "$text" in
    *"$needle"*) report 1 "$name" "field $fno contained '$needle' — got: $text" ;;
    *) report 0 "$name" ;;
  esac
}

BASE_ENV='POSTGRES_PASSWORD=x\nTS_AUTHKEY=\nTAILNET_HOSTNAME=\nCOMPOSE_PROFILES=\n'

# ── off is the default, and says how to turn it on ──────────────────────────
TN_OFF="$(run_tailnet "" 1 1 "" "$BASE_ENV")"
expect_tn "tailnet off by default" "$TN_OFF" 0 6 "tailnet: off"
expect_tn "tailnet off: names the switch" "$TN_OFF" 0 6 "NOVA_TAILNET=1 ./install"
expect_tn_lacks "tailnet off: no --profile tailnet" "$TN_OFF" 2 "tailnet"
expect_tn_lacks "tailnet off: tailscale not health-checked" "$TN_OFF" 3 "tailscale"
expect_tn_lacks "tailnet off: COMPOSE_PROFILES untouched" "$TN_OFF" 4 "COMPOSE_PROFILES=tailnet"
expect_tn_lacks "tailnet off: nothing prompted (really)" "$TN_OFF" 5 "PROMPTED"

# ── the refusal this exists for: no key, no node, no terminal ───────────────
TN_REFUSE="$(run_tailnet 1 1 1 "" "$BASE_ENV")"
expect_tn "no key, no node: refuses" "$TN_REFUSE" 1 6 "no way to log in"
expect_tn "no key, no node: names TS_AUTHKEY" "$TN_REFUSE" 1 6 "TS_AUTHKEY is blank"
expect_tn "no key, no node: says where a key comes from" "$TN_REFUSE" 1 6 \
  "https://login.tailscale.com/admin/settings/keys"
expect_tn "no key, no node: recommends a non-reusable key" "$TN_REFUSE" 1 6 "NON-reusable"
expect_tn "no key, no node: offers the migration path" "$TN_REFUSE" 1 6 "Migrating an existing node"
expect_tn "no key, no node: offers leaving it off" "$TN_REFUSE" 1 6 "Leave the tailnet off"
expect_tn "no key, no node: the state reason is quoted" "$TN_REFUSE" 1 6 "state volume answer 1"
expect_tn_lacks "no key, no node: nothing wired" "$TN_REFUSE" 2 "--profile tailnet"
expect_tn_lacks "no key, no node: COMPOSE_PROFILES not written" "$TN_REFUSE" 4 "COMPOSE_PROFILES=tailnet"

# ── a key in .env is enough ─────────────────────────────────────────────────
TN_KEY="$(run_tailnet 1 1 1 "" 'POSTGRES_PASSWORD=x\nTS_AUTHKEY=tskey-auth-set\nCOMPOSE_PROFILES=\n')"
expect_tn "key set: proceeds" "$TN_KEY" 0 6 "tailnet: on"
expect_tn "key set: compose gets --profile tailnet" "$TN_KEY" 0 2 "--profile tailnet"
expect_tn "key set: tailscale is health-checked" "$TN_KEY" 0 3 "tailscale"
expect_tn "key set: COMPOSE_PROFILES=tailnet written to .env" "$TN_KEY" 0 4 "COMPOSE_PROFILES=tailnet;"
expect_tn "key set: hostname defaults to nova without a terminal" "$TN_KEY" 0 4 "TAILNET_HOSTNAME=nova;"
expect_tn "key set: the key is left as it was" "$TN_KEY" 0 4 "TS_AUTHKEY=tskey-auth-set;"
expect_tn_lacks "key set: the key value is never logged" "$TN_KEY" 6 "tskey-auth-set"
expect_tn_lacks "key set: no state-volume lookup was needed" "$TN_KEY" 6 "state volume answer"

# ── a node already on the volume is enough (re-install, migrated node) ──────
TN_NODE="$(run_tailnet 1 0 0 "" "$BASE_ENV")"
expect_tn "node on the volume: proceeds without a key" "$TN_NODE" 0 6 "no auth key needed"
expect_tn "node on the volume: the reason is quoted" "$TN_NODE" 0 6 "state volume answer 0"
expect_tn "node on the volume: compose gets --profile tailnet" "$TN_NODE" 0 2 "--profile tailnet"
expect_tn "node on the volume: hostname was asked (terminal present)" "$TN_NODE" 0 5 "PROMPTED[Node name"
expect_tn_lacks "node on the volume: the key was NOT asked for" "$TN_NODE" 5 "TS_AUTHKEY"
expect_tn "node on the volume: default hostname accepted" "$TN_NODE" 0 4 "TAILNET_HOSTNAME=nova;"

# ── with a terminal, the key is asked for — and saved ───────────────────────
TN_TYPED="$(run_tailnet 1 1 0 "tskey-auth-typed" 'TS_AUTHKEY=\nTAILNET_HOSTNAME=nova\nCOMPOSE_PROFILES=\n')"
expect_tn "typed key: proceeds" "$TN_TYPED" 0 6 "TS_AUTHKEY saved"
expect_tn "typed key: the key prompt was shown" "$TN_TYPED" 0 5 "PROMPTED[TS_AUTHKEY"
expect_tn "typed key: saved to .env" "$TN_TYPED" 0 4 "TS_AUTHKEY=tskey-auth-typed;"
expect_tn_lacks "typed key: the value is never logged" "$TN_TYPED" 6 "tskey-auth-typed"
expect_tn "typed key: prompt explained the one-time key" "$TN_TYPED" 0 6 "NON-reusable key is recommended"

# ── with a terminal but nothing typed: still a refusal, not a guess ─────────
TN_BLANK="$(run_tailnet 1 1 0 "" 'TS_AUTHKEY=\nTAILNET_HOSTNAME=nova\nCOMPOSE_PROFILES=\n')"
expect_tn "blank at the prompt: refuses" "$TN_BLANK" 1 6 "no way to log in"
expect_tn_lacks "blank at the prompt: nothing wired" "$TN_BLANK" 2 "--profile tailnet"

# ── a hostname typed at the prompt lands in .env ────────────────────────────
TN_HOST="$(run_tailnet 1 1 0 "nova-lab" 'TS_AUTHKEY=tskey-auth-set\nTAILNET_HOSTNAME=\n')"
expect_tn "typed hostname: saved" "$TN_HOST" 0 4 "TAILNET_HOSTNAME=nova-lab;"
expect_tn "typed hostname: named in the decision" "$TN_HOST" 0 6 "node 'nova-lab'"
TN_HOST_KEPT="$(run_tailnet 1 1 0 "ignored" 'TS_AUTHKEY=tskey-auth-set\nTAILNET_HOSTNAME=kept\n')"
expect_tn "existing hostname: not asked again" "$TN_HOST_KEPT" 0 4 "TAILNET_HOSTNAME=kept;"
expect_tn_lacks "existing hostname: no prompt" "$TN_HOST_KEPT" 5 "PROMPTED"

# ── docker cannot be asked: its own answer, not "no node" ───────────────────
TN_NODOCKER="$(run_tailnet 1 2 0 "would-be-typed" "$BASE_ENV")"
expect_tn "docker error: refuses" "$TN_NODOCKER" 1 6 "could not be established"
expect_tn "docker error: does not claim there is no node" "$TN_NODOCKER" 1 6 "Refusing rather than guessing"
expect_tn_lacks "docker error: the key was not asked for" "$TN_NODOCKER" 5 "TS_AUTHKEY"

# ── COMPOSE_PROFILES is merged, never clobbered or duplicated ───────────────
TN_MERGE="$(run_tailnet 1 1 1 "" 'TS_AUTHKEY=tskey-auth-set\nCOMPOSE_PROFILES=inference\n')"
expect_tn "existing profiles: tailnet appended" "$TN_MERGE" 0 4 "COMPOSE_PROFILES=inference,tailnet;"
# The idempotent re-run: .env already says tailnet, NOVA_TAILNET unset, the
# node is on the volume from last time.
TN_RERUN="$(run_tailnet "" 0 1 "" 'TS_AUTHKEY=\nTAILNET_HOSTNAME=nova\nCOMPOSE_PROFILES=tailnet\n')"
expect_tn "re-run: .env's profile turns it on without NOVA_TAILNET" "$TN_RERUN" 0 2 "--profile tailnet"
expect_tn "re-run: no key needed (node on the volume)" "$TN_RERUN" 0 6 "no auth key needed"
expect_tn "re-run: profile not duplicated" "$TN_RERUN" 0 4 "COMPOSE_PROFILES=tailnet;"
expect_tn_lacks "re-run: profile not duplicated (really)" "$TN_RERUN" 4 "tailnet,tailnet"
# A re-run whose node has since vanished must refuse again, not coast.
TN_RERUN_GONE="$(run_tailnet "" 1 1 "" 'TS_AUTHKEY=\nTAILNET_HOSTNAME=nova\nCOMPOSE_PROFILES=tailnet\n')"
expect_tn "re-run without a node or key: refuses" "$TN_RERUN_GONE" 1 6 "no way to log in"

# ── NOVA_TAILNET=0 turns it off and un-writes the profile ──────────────────
TN_OFF_SWITCH="$(run_tailnet 0 0 1 "" 'TS_AUTHKEY=tskey-auth-set\nCOMPOSE_PROFILES=inference,tailnet\n')"
expect_tn "NOVA_TAILNET=0: off" "$TN_OFF_SWITCH" 0 6 "the profile comes out of COMPOSE_PROFILES (NOVA_TAILNET=0)"
expect_tn "NOVA_TAILNET=0: the writer reports the removal" "$TN_OFF_SWITCH" 0 6 "now lists inference (removed: tailnet)"
expect_tn "NOVA_TAILNET=0: other profiles kept" "$TN_OFF_SWITCH" 0 4 "COMPOSE_PROFILES=inference;"
expect_tn_lacks "NOVA_TAILNET=0: not wired" "$TN_OFF_SWITCH" 2 "--profile tailnet"
expect_tn "NOVA_TAILNET=0: says the container is left alone and how to stop it" "$TN_OFF_SWITCH" 0 6 \
  "--profile tailnet stop tailscale"

# ── garbage is refused, not treated as off ──────────────────────────────────
expect_tn "NOVA_TAILNET=maybe: refused" "$(run_tailnet maybe 1 1 "" "$BASE_ENV")" 1 6 "must be 1 or 0"

expect_str() {
  if [ "$2" = "$3" ]; then report 0 "$1"; else report 1 "$1" "got '$2', wanted '$3'"; fi
}
# ── the hostname is a DNS label, typed or already in .env ───────────────────
expect_tn "typed hostname with a space: refused" \
  "$(run_tailnet 1 1 0 "Nova Lab" 'TS_AUTHKEY=tskey-auth-set\nTAILNET_HOSTNAME=\n')" 1 6 "must be a DNS label"
expect_tn "bad hostname already in .env: refused" \
  "$(run_tailnet 1 1 1 "" 'TS_AUTHKEY=tskey-auth-set\nTAILNET_HOSTNAME=Bad_Name\n')" 1 6 "must be a DNS label"
expect_tn "hostname with digits and hyphens: accepted" \
  "$(run_tailnet 1 1 0 "nova-2" 'TS_AUTHKEY=tskey-auth-set\nTAILNET_HOSTNAME=\n')" 0 4 "TAILNET_HOSTNAME=nova-2;"

# ── the migrated node: found by the name compose resolves, not by label ─────
# A volume created by hand (`docker run -v nova_v4_tailscale:/to`, the
# migration recipe) carries NO compose labels, so the label lookup answers
# "nothing". The fallback finds it by the name `compose config` resolves and
# the node is accepted without a key. tailscale_state_present runs for real
# here (see run_tailnet's lowseams mode).
TN_MIGRATED="$(run_tailnet 1 1 0 "" "$BASE_ENV" lowseams)"
expect_tn "migrated node (unlabelled volume): accepted without a key" "$TN_MIGRATED" 0 6 \
  "no auth key needed — volume nova_v4_tailscale already holds a node"
expect_tn "migrated node: wired" "$TN_MIGRATED" 0 2 "--profile tailnet"
expect_tn_lacks "migrated node: the key was NOT asked for" "$TN_MIGRATED" 5 "TS_AUTHKEY"

# tailscale_state_present on its own, over the four docker seams.
#   $1 compose config text ("" = compose fails)   $2 label lookup stdout
#   $3 state_volume_exists rc                       $4 state_file_on_volume rc
# Prints "<rc>|<reason>|<volume looked in>|<image used>|<name existence asked>".
run_state_present() {
  (
    # shellcheck source=/dev/null
    . "$SCRIPT_DIR/install.sh"
    set +e
    CFG="$1"; LABEL_VOL="$2"; EXISTS_RC="$3"; FILE_RC="$4"
    compose_config_text() { [ -n "$CFG" ] || return 1; printf '%s' "$CFG"; }
    state_volume_by_label() { printf '%s' "$LABEL_VOL"; }
    state_volume_exists() { ASKED_EXISTS="$1"; return "$EXISTS_RC"; }
    state_file_on_volume() { ASKED_VOL="$1"; ASKED_IMAGE="$2"; return "$FILE_RC"; }
    ASKED_VOL=""; ASKED_IMAGE=""; ASKED_EXISTS=""
    tailscale_state_present; rc=$?
    printf '%s|%s|%s|%s|%s' "$rc" "$TAILNET_STATE_REASON" "$ASKED_VOL" "$ASKED_IMAGE" "$ASKED_EXISTS"
  )
}
expect_sp() {
  # $1 name $2 result $3 want rc $4 field $5 needle
  local name="$1" out="$2" want="$3" fno="$4" needle="$5" rc text
  rc="$(tn_field "$out" 1)"; text="$(tn_field "$out" "$fno")"
  if [ "$rc" != "$want" ]; then report 1 "$name" "rc $rc, wanted $want — $out"; return; fi
  case "$text" in
    *"$needle"*) report 0 "$name" ;;
    *) report 1 "$name" "field $fno did not contain '$needle' — got: $out" ;;
  esac
}
SP_LABEL="$(run_state_present "$FIXTURE_CFG" "nova_v4_tailscale" 0 0)"
expect_sp "state: labelled volume with a state file → present" "$SP_LABEL" 0 2 "nova_v4_tailscale already holds a node"
expect_sp "state: looked inside the labelled volume" "$SP_LABEL" 0 3 "nova_v4_tailscale"
expect_sp "state: with the sidecar's image from compose config (not a decoy)" "$SP_LABEL" 0 4 "tailscale/tailscale:v9.9.9"
expect_sp "state: no name fallback needed when the label finds it" "$SP_LABEL" 0 5 ""
SP_NAME="$(run_state_present "$FIXTURE_CFG" "" 0 0)"
expect_sp "state: unlabelled volume found by the resolved name → present" "$SP_NAME" 0 2 "nova_v4_tailscale already holds a node"
expect_sp "state: the resolved name was what existence was asked about" "$SP_NAME" 0 5 "nova_v4_tailscale"
expect_sp "state: resolved name exists, no state file → absent" \
  "$(run_state_present "$FIXTURE_CFG" "" 0 1)" 1 2 "exists but holds no tailscaled.state"
expect_sp "state: no volume by label or by name → absent, says the name" \
  "$(run_state_present "$FIXTURE_CFG" "" 1 0)" 1 2 "no nova_v4_tailscale volume exists yet"
expect_sp "state: docker run failure is not 'no node'" \
  "$(run_state_present "$FIXTURE_CFG" "nova_v4_tailscale" 0 125)" 2 2 "could not be read (docker run exit 125)"
expect_sp "state: compose config failing is its own answer" \
  "$(run_state_present "" "" 0 0)" 2 2 "docker compose config could not be read"
NO_VOL_CFG="$(printf '%s' "$FIXTURE_CFG" | grep -v 'v4_tailscale')"
expect_sp "state: a compose file without the volume key is a config error, not 'no node'" \
  "$(run_state_present "$NO_VOL_CFG" "" 0 0)" 2 2 "compose names no v4_tailscale volume"

# The readers of `compose config` output, on the fixture with decoys.
run_parse() {
  (
    # shellcheck source=/dev/null
    . "$SCRIPT_DIR/install.sh"
    set +e
    printf '%s' "$FIXTURE_CFG" | "$@"
  )
}
expect_str "config reader: project name" "$(run_parse config_project_name)" "nova"
expect_str "config reader: the tailnet volume's resolved name" "$(run_parse config_volume_name v4_tailscale)" "nova_v4_tailscale"
expect_str "config reader: a neighbouring volume is not confused with it" "$(run_parse config_volume_name v4_pgdata)" "nova_v4_pgdata"
expect_str "config reader: an undeclared key yields nothing" "$(run_parse config_volume_name v4_nope)" ""
expect_str "config reader: the tailscale service's image, not a decoy's" "$(run_parse config_service_image tailscale)" "tailscale/tailscale:v9.9.9"
expect_str "config reader: another service's image" "$(run_parse config_service_image web)" "decoy/web:1"

# ── the profile-list helpers, on their own ──────────────────────────────────
run_profiles() {
  (
    # shellcheck source=/dev/null
    . "$SCRIPT_DIR/install.sh"
    set +e
    "$@"
  )
}
expect_str "add_profile to an empty list" "$(run_profiles add_profile tailnet "")" "tailnet"
expect_str "add_profile appends" "$(run_profiles add_profile tailnet inference)" "inference,tailnet"
expect_str "add_profile is idempotent" "$(run_profiles add_profile tailnet inference,tailnet)" "inference,tailnet"
expect_str "remove_profile keeps the rest in order" \
  "$(run_profiles remove_profile tailnet inference,tailnet,e2e)" "inference,e2e"
expect_str "remove_profile from a list without it" "$(run_profiles remove_profile tailnet inference)" "inference"
expect_str "remove_profile to empty" "$(run_profiles remove_profile tailnet tailnet)" ""
if run_profiles profile_listed tailnet tailnet-x; then
  report 1 "profile_listed does not prefix-match" "tailnet matched tailnet-x"
else
  report 0 "profile_listed does not prefix-match"
fi

# ── tripwires: the names install.sh relies on are the compose file's ────────
# TAILSCALE_STATE_VOLUME_KEY must be a declared volume AND the one the
# tailscale service mounts at its state dir; the profile must be `tailnet`.
# Read from the compose file as text — no docker in this suite.
VOL_KEY="$(run_profiles eval 'printf "%s" "$TAILSCALE_STATE_VOLUME_KEY"')"
[ -n "$VOL_KEY" ] || report 1 "tripwire: install.sh names a state volume key" "TAILSCALE_STATE_VOLUME_KEY is empty"
if grep -q "^  ${VOL_KEY}:" "$SCRIPT_DIR/docker-compose.yml"; then
  report 0 "tripwire: $VOL_KEY is declared under volumes: in docker-compose.yml"
else
  report 1 "tripwire: $VOL_KEY is declared under volumes: in docker-compose.yml" "no '  $VOL_KEY:' line"
fi
if grep -q -- "- ${VOL_KEY}:/var/lib/tailscale" "$SCRIPT_DIR/docker-compose.yml"; then
  report 0 "tripwire: the tailscale service mounts $VOL_KEY at /var/lib/tailscale"
else
  report 1 "tripwire: the tailscale service mounts $VOL_KEY at /var/lib/tailscale" "mount line not found"
fi
if grep -q 'profiles: \["tailnet"\]' "$SCRIPT_DIR/docker-compose.yml"; then
  report 0 "tripwire: the compose profile is named tailnet"
else
  report 1 "tripwire: the compose profile is named tailnet" "no profiles: [\"tailnet\"] line"
fi
for key in TS_AUTHKEY TAILNET_HOSTNAME COMPOSE_PROFILES; do
  if grep -q "^${key}=" "$SCRIPT_DIR/.env.example"; then
    report 0 "tripwire: .env.example documents $key"
  else
    report 1 "tripwire: .env.example documents $key" "no '$key=' line"
  fi
done


# ── gpu: ollama's own compute line is read, and cpu is a refusal ────────────
# The defect (measured 2026-09-04): the stack came up without the GPU overlay,
# ollama logged `inference compute id=cpu library=cpu`, a 27B model loaded
# onto the CPU, and every healthcheck stayed green (`ollama list` passes on
# the CPU) until the next chat turn hit the 300 s gateway timeout.
# check_inference_compute runs for real here; stubbed is the one seam that
# touches docker (ollama_log_text) and the wait bound (0, so an absent line
# fails at once rather than after 60 s). Reverting the check — or making an
# unreadable log return 0 — turns the refusal cases below into "ok", which is
# the green-on-cpu this file exists to keep red.
#
#   $1 EXPECTED_INFERENCE_LIBRARY ("" = no overlay merged)
#   $2 BUNDLED_INFERENCE
#   $3 what `docker compose logs ollama` prints (printf %b escapes)
#   $4 its exit code
# Prints "<exit>|<stderr>".
run_compute_check() {
  (
    # shellcheck source=/dev/null
    . "$SCRIPT_DIR/install.sh"
    set +e
    LOG_TEXT="$3"; LOG_RC="$4"
    ollama_log_text() { printf '%b' "$LOG_TEXT"; return "$LOG_RC"; }
    # Read by the sourced install.sh, not by anything in this file.
    # shellcheck disable=SC2034
    EXPECTED_INFERENCE_LIBRARY="$1"
    # shellcheck disable=SC2034
    BUNDLED_INFERENCE="$2"
    # shellcheck disable=SC2034
    INFERENCE_COMPUTE_TIMEOUT=0
    err="$(check_inference_compute 2>&1)"; code=$?
    printf '%s|%s' "$code" "$(printf '%s' "$err" | tr '\n' ' ')"
  )
}

# The lines as ollama 0.33 prints them (the cpu one is the measured defect).
CUDA_LINE='time=2026-09-04T18:02:11.000Z level=INFO source=types.go:60 msg="inference compute" id=GPU-2f1c library=CUDA compute=8.9 name=CUDA0 description="NVIDIA GeForce RTX 4090" total="23.9 GiB" available="22.5 GiB"'
CPU_LINE='time=2026-09-04T18:02:11.000Z level=INFO source=types.go:60 msg="inference compute" id=cpu library=cpu compute="" name=cpu description=cpu total="62.7 GiB" available="55.1 GiB"'
DECOY_LINE='time=2026-09-04T18:02:10.000Z level=INFO source=routes.go:1288 msg="Listening on [::]:11434 (version 0.33.1)"'

GPU_OK="$(run_compute_check CUDA 1 "$DECOY_LINE\n$CUDA_LINE\n" 0)"
expect_case "gpu: log says CUDA → passes" "$GPU_OK" 0 "library=CUDA"
expect_case "gpu: the exact line read is printed" "$GPU_OK" 0 "id=GPU-2f1c"

GPU_CPU="$(run_compute_check CUDA 1 "$DECOY_LINE\n$CPU_LINE\n" 0)"
expect_case "gpu: log says cpu → refuses" "$GPU_CPU" 1 "came up WITHOUT the GPU"
expect_case "gpu: cpu refusal names the overlay" "$GPU_CPU" 1 "docker-compose.gpu.yml"
expect_case "gpu: cpu refusal quotes the exact fact read" "$GPU_CPU" 1 "id=cpu library=cpu"
expect_case "gpu: cpu refusal says what was expected" "$GPU_CPU" 1 "Expected library=CUDA, read library=cpu"
expect_case "gpu: cpu refusal gives the recreate command with the overlay" "$GPU_CPU" 1 \
  "--project-directory $SCRIPT_DIR --profile inference up -d --force-recreate ollama"
expect_case "gpu: cpu refusal says a -f replaces COMPOSE_FILE" "$GPU_CPU" 1 "any -f REPLACES that list"
expect_case "gpu: cpu refusal offers the runtime checks" "$GPU_CPU" 1 "docker info | grep -i nvidia"
expect_case "gpu: cpu refusal offers the skip flag" "$GPU_CPU" 1 "NOVA_SKIP_INFERENCE=1 ./install"

# An unreadable log is a refusal, never a pass.
GPU_NOLINE="$(run_compute_check CUDA 1 "$DECOY_LINE\n" 0)"
expect_case "gpu: no compute line → refuses, does not claim to know" "$GPU_NOLINE" 1 \
  "could not read ollama's inference compute line"
expect_case "gpu: no compute line → says why" "$GPU_NOLINE" 1 "no 'inference compute' line in ollama's log yet"
expect_case "gpu: no compute line → names the bound" "$GPU_NOLINE" 1 "within 0s"
expect_case "gpu: empty log → refuses" "$(run_compute_check CUDA 1 "" 0)" 1 "could not read ollama's inference compute line"
GPU_NODOCKER="$(run_compute_check CUDA 1 "$CUDA_LINE\n" 1)"
expect_case "gpu: docker compose logs failing → refuses" "$GPU_NODOCKER" 1 "could not read ollama's inference compute line"
expect_case "gpu: docker compose logs failing → says so" "$GPU_NODOCKER" 1 "docker compose logs ollama failed"

# The LAST line is the current fact: a container's log spans its restarts.
expect_case "gpu: cpu at an earlier start, CUDA at the latest → passes" \
  "$(run_compute_check CUDA 1 "$CPU_LINE\n$DECOY_LINE\n$CUDA_LINE\n" 0)" 0 "library=CUDA"
expect_case "gpu: CUDA at an earlier start, cpu at the latest → refuses" \
  "$(run_compute_check CUDA 1 "$CUDA_LINE\n$DECOY_LINE\n$CPU_LINE\n" 0)" 1 "came up WITHOUT the GPU"
expect_case "gpu: two cards, two CUDA lines → passes" \
  "$(run_compute_check CUDA 1 "$CUDA_LINE\n${CUDA_LINE/GPU-2f1c/GPU-9a00}\n" 0)" 0 "library=CUDA"
# Older ollama spells it library=cuda; the fact is the same, the case is not.
expect_case "gpu: lowercase library=cuda (older ollama) → passes" \
  "$(run_compute_check CUDA 1 "${CUDA_LINE/library=CUDA/library=cuda}\n" 0)" 0 "library=cuda"
expect_case "gpu: some other backend → refuses and names it" \
  "$(run_compute_check CUDA 1 "${CUDA_LINE/library=CUDA/library=ROCm}\n" 0)" 1 "read library=ROCm"

# No overlay merged: the check is skipped, and says so — the log is not even read.
NO_GPU="$(run_compute_check "" 1 "$CPU_LINE\n" 0)"
expect_case "no gpu: check skipped with a note" "$NO_GPU" 0 "compute library is not checked"
expect_case "no gpu: note says it runs on the CPU" "$NO_GPU" 0 "runs on the CPU"
expect_case "no gpu: docker not needed (a failing seam is still a pass)" \
  "$(run_compute_check "" 1 "" 2)" 0 "not checked"
NO_BUNDLED="$(run_compute_check CUDA 0 "$CPU_LINE\n" 0)"
expect_case "bundled off: nothing to check, no refusal" "$NO_BUNDLED" 0 ""
case "${NO_BUNDLED#*|}" in
  *ERROR*) report 1 "bundled off: no error printed" "$NO_BUNDLED" ;;
  *) report 0 "bundled off: no error printed" ;;
esac

# The pure readers, on their own, against decoys.
expect_str "compute reader: the last compute line, decoys ignored" \
  "$(printf '%s\n%s\n%s\n%s\n' "$CPU_LINE" "$DECOY_LINE" "$CUDA_LINE" "$DECOY_LINE" | run_profiles last_inference_compute_line)" \
  "$CUDA_LINE"
expect_str "compute reader: no compute line yields nothing" \
  "$(printf '%s\n' "$DECOY_LINE" | run_profiles last_inference_compute_line)" ""
expect_str "library reader: CUDA" "$(printf '%s\n' "$CUDA_LINE" | run_profiles inference_compute_library)" "CUDA"
expect_str "library reader: cpu" "$(printf '%s\n' "$CPU_LINE" | run_profiles inference_compute_library)" "cpu"
expect_str "library reader: a quoted value is unquoted" \
  "$(printf '%s\n' 'msg="inference compute" id=x library="CUDA" name=y' | run_profiles inference_compute_library)" "CUDA"

# The mapping — ONE place — and the overlay it is keyed on.
expect_str "mapping: nvidia → CUDA" "$(run_profiles inference_library_for_driver nvidia)" "CUDA"
if run_profiles inference_library_for_driver something-else >/dev/null; then
  report 1 "mapping: an unknown driver is refused, not mapped to nothing" "returned 0"
else
  report 0 "mapping: an unknown driver is refused, not mapped to nothing"
fi
OVERLAY_DRIVER="$(run_profiles overlay_gpu_driver)"
expect_str "tripwire: docker-compose.gpu.yml reserves driver nvidia" "$OVERLAY_DRIVER" "nvidia"
if run_profiles eval 'inference_library_for_driver "$(overlay_gpu_driver)"' >/dev/null; then
  report 0 "tripwire: the mapping knows the overlay's driver"
else
  report 1 "tripwire: the mapping knows the overlay's driver" "driver '$OVERLAY_DRIVER' has no row"
fi

# ── gpu wiring + COMPOSE_FILE: the overlay decision reaches .env, absolute ──
# detect_hardware and record_compose_files run for real; stubbed are the two
# hardware seams. A relative COMPOSE_FILE is resolved by compose from the
# shell's working directory (measured: from the repo root it loaded the v3
# docker-compose.yml), so every entry written must be absolute — and the set
# must be exactly the -f files this script itself passes.
#   $1 detect_gpu_runtime output   $2 detect_gpus_json output   $3 initial .env
# Prints "<COMPOSE_ARGS>|<EXPECTED_INFERENCE_LIBRARY>|<.env with ;>|<stderr>".
run_gpu_wiring() {
  (
    # shellcheck source=/dev/null
    . "$SCRIPT_DIR/install.sh"
    set +e
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    # shellcheck disable=SC2034
    DATA_DIR="$tmp"
    # shellcheck disable=SC2034
    HARDWARE_JSON="$tmp/hardware.json"
    # shellcheck disable=SC2034
    ENV_FILE="$tmp/.env"
    printf '%b' "$3" > "$ENV_FILE"
    RUNTIME="$1"; GPUS="$2"
    detect_gpu_runtime() { printf '%s' "$RUNTIME"; }
    detect_gpus_json() { printf '%s' "$GPUS"; }
    detect_hardware 2> "$tmp/err" >/dev/null
    record_compose_files 2>> "$tmp/err" >/dev/null
    printf '%s|%s|%s|%s' "${COMPOSE_ARGS[*]}" "$EXPECTED_INFERENCE_LIBRARY" \
      "$(tr '\n' ';' < "$ENV_FILE")" "$(tr '\n' ' ' < "$tmp/err")"
  )
}
# Field $3 of a run_gpu_wiring result contains $4 (no exit code to check:
# field 1 is COMPOSE_ARGS).
expect_gw() {
  local name="$1" out="$2" fno="$3" needle="$4" text
  text="$(tn_field "$out" "$fno")"
  case "$text" in
    *"$needle"*) report 0 "$name" ;;
    *) report 1 "$name" "field $fno did not contain '$needle' — got: $text" ;;
  esac
}
# The COMPOSE_FILE value in a run_gpu_wiring result.
gw_compose_file() {
  printf '%s' "$(tn_field "$1" 3)" | tr ';' '\n' | grep '^COMPOSE_FILE=' | cut -d'=' -f2-
}
# Every :-separated entry of $2 starts with a /.
expect_all_absolute() {
  local name="$1" list="$2" entry bad="" OLDIFS="$IFS"
  IFS=':'
  for entry in $list; do
    case "$entry" in
      /*) ;;
      *) bad="$bad '$entry'" ;;
    esac
  done
  IFS="$OLDIFS"
  if [ -n "$list" ] && [ -z "$bad" ]; then report 0 "$name"; else report 1 "$name" "not absolute:${bad:- (empty list)}"; fi
}
# The number of $4 flags (default -f) in $2 equals the number of entries in
# $3 (split on ':' or ',').
expect_same_count() {
  local name="$1" args="$2" list="$3" flag="${4:--f}" nf nl
  nf="$(printf '%s\n' "$args" | tr ' ' '\n' | grep -c -- "^${flag}\$")"
  nl="$(printf '%s\n' "$list" | tr ':,' '\n\n' | grep -c .)"
  if [ "$nf" -eq "$nl" ] && [ "$nl" -gt 0 ]; then report 0 "$name"; else report 1 "$name" "$flag count $nf, entries $nl"; fi
}
# The value of key $3 in field $2 of a result whose .env is ;-joined.
env_key_value() {
  printf '%s' "$(tn_field "$1" "$2")" | tr ';' '\n' | grep "^$3=" | cut -d'=' -f2-
}

A_CARD='[{"name":"NVIDIA GeForce RTX 4090","vram_mb":24564}]'
GW_ENV='POSTGRES_PASSWORD=x\nCOMPOSE_PROFILES=\n'

GW_GPU="$(run_gpu_wiring true "$A_CARD" "$GW_ENV")"
expect_gw "gpu wiring: compose gets the overlay" "$GW_GPU" 1 "-f $SCRIPT_DIR/docker-compose.gpu.yml"
expect_str "gpu wiring: the expected library is CUDA" "$(tn_field "$GW_GPU" 2)" "CUDA"
expect_str "gpu wiring: COMPOSE_FILE lists base then overlay, absolute" "$(gw_compose_file "$GW_GPU")" \
  "$SCRIPT_DIR/docker-compose.yml:$SCRIPT_DIR/docker-compose.gpu.yml"
expect_all_absolute "gpu wiring: every COMPOSE_FILE entry is absolute" "$(gw_compose_file "$GW_GPU")"
expect_same_count "gpu wiring: COMPOSE_FILE has exactly the -f files" "$(tn_field "$GW_GPU" 1)" "$(gw_compose_file "$GW_GPU")"
expect_gw "gpu wiring: other keys untouched" "$GW_GPU" 3 "POSTGRES_PASSWORD=x;"
expect_gw "gpu wiring: says the check is coming" "$GW_GPU" 4 "must say library=CUDA"
expect_gw "gpu wiring: says how to run compose afterwards" "$GW_GPU" 4 "--project-directory $SCRIPT_DIR"

GW_NONE="$(run_gpu_wiring false "[]" "$GW_ENV")"
expect_tn_lacks "no gpu wiring: no overlay" "$GW_NONE" 1 "docker-compose.gpu.yml"
expect_str "no gpu wiring: no expected library" "$(tn_field "$GW_NONE" 2)" ""
expect_str "no gpu wiring: COMPOSE_FILE is the base file alone, absolute" "$(gw_compose_file "$GW_NONE")" \
  "$SCRIPT_DIR/docker-compose.yml"
expect_all_absolute "no gpu wiring: the entry is absolute" "$(gw_compose_file "$GW_NONE")"
expect_same_count "no gpu wiring: COMPOSE_FILE has exactly the -f files" "$(tn_field "$GW_NONE" 1)" "$(gw_compose_file "$GW_NONE")"

# A card the runtime cannot hand over: warned, no overlay, no check.
GW_TOOLKIT="$(run_gpu_wiring false "$A_CARD" "$GW_ENV")"
expect_gw "gpu without runtime: warns about the toolkit" "$GW_TOOLKIT" 4 "docker has no NVIDIA runtime"
expect_tn_lacks "gpu without runtime: no overlay" "$GW_TOOLKIT" 1 "docker-compose.gpu.yml"
expect_str "gpu without runtime: no expected library" "$(tn_field "$GW_TOOLKIT" 2)" ""

# A stale relative line — the shape that loaded the v3 file — is replaced, once.
GW_STALE="$(run_gpu_wiring true "$A_CARD" 'COMPOSE_FILE=docker-compose.yml\nPOSTGRES_PASSWORD=x\n')"
expect_str "stale COMPOSE_FILE: replaced with the absolute set" "$(gw_compose_file "$GW_STALE")" \
  "$SCRIPT_DIR/docker-compose.yml:$SCRIPT_DIR/docker-compose.gpu.yml"
expect_str "stale COMPOSE_FILE: exactly one line remains" \
  "$(tn_field "$GW_STALE" 3 | tr ';' '\n' | grep -c '^COMPOSE_FILE=')" "1"
expect_gw "stale COMPOSE_FILE: reported as rewritten" "$GW_STALE" 4 "now lists"
# Already right: left alone, and said so.
GW_SAME="$(run_gpu_wiring true "$A_CARD" "COMPOSE_FILE=$SCRIPT_DIR/docker-compose.yml:$SCRIPT_DIR/docker-compose.gpu.yml\n")"
expect_gw "matching COMPOSE_FILE: left as it was" "$GW_SAME" 4 "already lists"
expect_str "matching COMPOSE_FILE: still exactly one line" \
  "$(tn_field "$GW_SAME" 3 | tr ';' '\n' | grep -c '^COMPOSE_FILE=')" "1"

# ── the whole install path, with docker replaced by a shell function ────────
# cmd_install runs for real — preflight, hardware, secrets, the file set, the
# tailnet decision, up, the health wait, the status table — and only THEN the
# compute check. `docker` is a function here, so every call the script makes
# is answered from the case below and no daemon is touched. This proves the
# check is REACHED from cmd_install after a green table, not only that the
# function works alone: delete the call from cmd_install and the cpu case
# below prints "Nova is up".
#   $1 does `docker info` name the nvidia runtime (1/0)   $2 ollama's log
# Prints "<exit>|<.env with ;>|<combined output>".
run_install() {
  (
    # shellcheck source=/dev/null
    . "$SCRIPT_DIR/install.sh"
    set +e
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    # shellcheck disable=SC2034
    DATA_DIR="$tmp"
    # shellcheck disable=SC2034
    HARDWARE_JSON="$tmp/hardware.json"
    # shellcheck disable=SC2034
    ENV_FILE="$tmp/.env"
    # shellcheck disable=SC2034
    ENV_EXAMPLE="$SCRIPT_DIR/.env.example"
    # shellcheck disable=SC2034
    INFERENCE_COMPUTE_TIMEOUT=0
    NVIDIA="$1"; FAKE_LOG="$2"
    docker() {
      case "$*" in
        info)
          if [ "$NVIDIA" = 1 ]; then printf 'Runtimes: nvidia runc\n'; else printf 'Runtimes: runc\n'; fi ;;
        "compose version") ;;
        *" up -d --build") ;;
        *" ps -q "*) printf 'cid\n' ;;
        "inspect "*) printf 'healthy\n' ;;
        *" logs --no-log-prefix ollama") printf '%b' "$FAKE_LOG" ;;
        *) printf 'unexpected docker call: %s\n' "$*" >&2; return 1 ;;
      esac
    }
    detect_gpus_json() { printf '[]'; }
    detect_disk_free_gb() { printf '100'; }
    port_holder() { printf ''; }
    unset NOVA_TAILNET NOVA_SKIP_INFERENCE
    out="$(cmd_install 2>&1)"; code=$?
    printf '%s|%s|%s' "$code" "$(tr '\n' ';' < "$ENV_FILE")" "$(printf '%s' "$out" | tr '\n' ' ')"
  )
}

INST_OK="$(run_install 1 "$DECOY_LINE\n$CUDA_LINE\n")"
expect_tn "install, gpu + CUDA: succeeds" "$INST_OK" 0 3 "Nova is up"
expect_tn "install, gpu + CUDA: reports the fact read" "$INST_OK" 0 3 "ollama reports library=CUDA"
expect_tn "install, gpu + CUDA: COMPOSE_FILE written with both absolute files" "$INST_OK" 0 2 \
  "COMPOSE_FILE=$SCRIPT_DIR/docker-compose.yml:$SCRIPT_DIR/docker-compose.gpu.yml;"
expect_tn "install, gpu + CUDA: secrets still generated" "$INST_OK" 0 2 "CORE_TOKEN="
expect_tn "install, gpu + CUDA: COMPOSE_PROFILES lists inference" "$INST_OK" 0 2 "COMPOSE_PROFILES=inference;"

INST_CPU="$(run_install 1 "$DECOY_LINE\n$CPU_LINE\n")"
expect_tn "install, gpu + cpu: refuses after a green table" "$INST_CPU" 1 3 "came up WITHOUT the GPU"
expect_tn "install, gpu + cpu: the table WAS green (the point)" "$INST_CPU" 1 3 "ollama     healthy"
expect_tn "install, gpu + cpu: names the overlay" "$INST_CPU" 1 3 "docker-compose.gpu.yml"
expect_tn_lacks "install, gpu + cpu: never says Nova is up" "$INST_CPU" 3 "Nova is up"

INST_NOLINE="$(run_install 1 "$DECOY_LINE\n")"
expect_tn "install, gpu + no line: refuses" "$INST_NOLINE" 1 3 "could not read ollama's inference compute line"
expect_tn_lacks "install, gpu + no line: never says Nova is up" "$INST_NOLINE" 3 "Nova is up"

INST_NOGPU="$(run_install 0 "$DECOY_LINE\n$CPU_LINE\n")"
expect_tn "install, no gpu: succeeds" "$INST_NOGPU" 0 3 "Nova is up"
expect_tn "install, no gpu: says the check was skipped" "$INST_NOGPU" 0 3 "compute library is not checked"
expect_tn "install, no gpu: COMPOSE_FILE is the base file alone" "$INST_NOGPU" 0 2 "COMPOSE_FILE=$SCRIPT_DIR/docker-compose.yml;"
# The VALUE, not the file: .env.example's comments name the overlay too.
expect_str "install, no gpu: the COMPOSE_FILE value carries no overlay" \
  "$(env_key_value "$INST_NOGPU" 2 COMPOSE_FILE)" "$SCRIPT_DIR/docker-compose.yml"

# ── COMPOSE_PROFILES: derived from the --profile args, one writer ───────────
# The property: after ANY install, a plain `docker compose --project-directory
# deploy up -d` converges every service the install started. The list is
# derived from the --profile args in COMPOSE_ARGS (as COMPOSE_FILE is from
# -f), merged into the existing line with the tailnet helpers — order kept,
# never duplicated, unmanaged profiles left alone — minus what an explicit
# off-switch turned off. detect_hardware, decide_tailnet and both writers run
# for real; stubbed are the hardware seams, the state volume and the terminal.
#   $1 BUNDLED_INFERENCE   $2 NOVA_TAILNET ("" = unset)   $3 initial .env body
# Prints "<exit>|<COMPOSE_ARGS>|<.env with ;>|<stderr>".
run_profile_env() {
  (
    # shellcheck source=/dev/null
    . "$SCRIPT_DIR/install.sh"
    set +e
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    # shellcheck disable=SC2034
    DATA_DIR="$tmp"
    # shellcheck disable=SC2034
    HARDWARE_JSON="$tmp/hardware.json"
    # shellcheck disable=SC2034
    ENV_FILE="$tmp/.env"
    printf '%b' "$3" > "$ENV_FILE"
    # shellcheck disable=SC2034
    BUNDLED_INFERENCE="$1"
    detect_gpu_runtime() { printf 'false'; }
    detect_gpus_json() { printf '[]'; }
    tailscale_state_present() {
      # shellcheck disable=SC2034
      TAILNET_STATE_REASON="stub: no node"
      return 1
    }
    have_tty() { return 1; }
    if [ -n "$2" ]; then export NOVA_TAILNET="$2"; else unset NOVA_TAILNET; fi
    (
      detect_hardware 2> "$tmp/err" >/dev/null
      decide_tailnet 2>> "$tmp/err"
      record_compose_files 2>> "$tmp/err"
      record_compose_profiles 2>> "$tmp/err"
      printf '%s' "${COMPOSE_ARGS[*]}" > "$tmp/args"
    )
    code=$?
    printf '%s|%s|%s|%s' "$code" "$(cat "$tmp/args" 2>/dev/null)" \
      "$(tr '\n' ';' < "$ENV_FILE")" "$(tr '\n' ' ' < "$tmp/err")"
  )
}
TN_ON_ENV='TS_AUTHKEY=tskey-auth-set\nTAILNET_HOSTNAME=nova\n'

PE_ON="$(run_profile_env 1 "" 'COMPOSE_PROFILES=\n')"
expect_tn "profiles: bundled inference ⇒ COMPOSE_PROFILES lists inference" "$PE_ON" 0 3 "COMPOSE_PROFILES=inference;"
expect_tn "profiles: bundled inference ⇒ the writer says so" "$PE_ON" 0 4 "now lists inference"
expect_same_count "profiles: exactly the --profile args" "$(tn_field "$PE_ON" 2)" "$(env_key_value "$PE_ON" 3 COMPOSE_PROFILES)" --profile

PE_BOTH="$(run_profile_env 1 1 "${TN_ON_ENV}COMPOSE_PROFILES=\n")"
expect_tn "profiles: inference + tailnet ⇒ both, in the order passed" "$PE_BOTH" 0 3 "COMPOSE_PROFILES=inference,tailnet;"
expect_same_count "profiles: both ⇒ exactly the --profile args" "$(tn_field "$PE_BOTH" 2)" "$(env_key_value "$PE_BOTH" 3 COMPOSE_PROFILES)" --profile
expect_tn_lacks "profiles: both ⇒ no duplicate" "$PE_BOTH" 3 "inference,inference"

# Order-stable: an existing line keeps its order, the new profile is appended.
PE_APPEND="$(run_profile_env 1 1 "${TN_ON_ENV}COMPOSE_PROFILES=tailnet\n")"
expect_tn "profiles: existing tailnet ⇒ inference appended, order kept" "$PE_APPEND" 0 3 "COMPOSE_PROFILES=tailnet,inference;"
expect_str "profiles: existing tailnet ⇒ exactly one line" \
  "$(tn_field "$PE_APPEND" 3 | tr ';' '\n' | grep -c '^COMPOSE_PROFILES=')" "1"

# A hand-written line that already says it all is left exactly as it is.
PE_SAME="$(run_profile_env 1 1 "${TN_ON_ENV}COMPOSE_PROFILES=inference,tailnet\n")"
expect_tn "profiles: hand-written inference,tailnet ⇒ already lists" "$PE_SAME" 0 4 "already lists inference,tailnet"
expect_tn "profiles: hand-written inference,tailnet ⇒ unchanged" "$PE_SAME" 0 3 "COMPOSE_PROFILES=inference,tailnet;"
PE_SAME_REV="$(run_profile_env 1 1 "${TN_ON_ENV}COMPOSE_PROFILES=tailnet,inference\n")"
expect_tn "profiles: hand-written tailnet,inference ⇒ not reordered" "$PE_SAME_REV" 0 3 "COMPOSE_PROFILES=tailnet,inference;"
expect_tn "profiles: hand-written tailnet,inference ⇒ already lists" "$PE_SAME_REV" 0 4 "already lists tailnet,inference"

# The explicit off-switch takes the profile out — mirroring NOVA_TAILNET=0 —
# and names the container it leaves running and how to stop it.
PE_SKIP="$(run_profile_env 0 1 "${TN_ON_ENV}COMPOSE_PROFILES=inference,tailnet\n")"
expect_tn "profiles: bundled off ⇒ inference absent, tailnet kept" "$PE_SKIP" 0 3 "COMPOSE_PROFILES=tailnet;"
expect_tn "profiles: bundled off ⇒ says the profile comes out" "$PE_SKIP" 0 4 \
  "inference: the profile comes out of COMPOSE_PROFILES (NOVA_SKIP_INFERENCE=1)"
expect_tn "profiles: bundled off ⇒ names the stop" "$PE_SKIP" 0 4 "--profile inference stop ollama"
expect_tn "profiles: bundled off ⇒ the writer reports the removal" "$PE_SKIP" 0 4 "(removed: inference)"
expect_tn_lacks "profiles: bundled off ⇒ no --profile inference passed" "$PE_SKIP" 2 "--profile inference"
# Never listed: nothing to take out, nothing to say about a container.
PE_SKIP_NONE="$(run_profile_env 0 "" 'COMPOSE_PROFILES=\n')"
expect_tn "profiles: bundled off, never listed ⇒ stays empty" "$PE_SKIP_NONE" 0 4 "already lists nothing"
expect_tn_lacks "profiles: bundled off, never listed ⇒ inference absent" "$PE_SKIP_NONE" 3 "inference"
expect_tn_lacks "profiles: bundled off, never listed ⇒ no stop advice" "$PE_SKIP_NONE" 4 "stop ollama"

# Profiles this script does not manage are left where they are.
PE_OTHER="$(run_profile_env 1 "" 'COMPOSE_PROFILES=e2e\n')"
expect_tn "profiles: an unmanaged profile is kept, inference appended" "$PE_OTHER" 0 3 "COMPOSE_PROFILES=e2e,inference;"
PE_BOTH_OFF="$(run_profile_env 0 0 'COMPOSE_PROFILES=inference,tailnet,e2e\n')"
expect_tn "profiles: both off-switches ⇒ only the unmanaged one remains" "$PE_BOTH_OFF" 0 3 "COMPOSE_PROFILES=e2e;"
expect_tn "profiles: both off-switches ⇒ both removals reported" "$PE_BOTH_OFF" 0 4 "(removed: inference tailnet)"

# The reader of COMPOSE_ARGS, alone: order kept, duplicates folded.
expect_str "compose_profile_set: --profile args in order, deduped" \
  "$(run_profiles eval 'COMPOSE_ARGS=(-f a --profile inference -f b --profile tailnet --profile inference); compose_profile_set')" \
  "inference,tailnet"
expect_str "compose_profile_set: none passed ⇒ empty" \
  "$(run_profiles eval 'COMPOSE_ARGS=(-f a -f b); compose_profile_set')" ""

# ── tripwire: COMPOSE_FILE is documented, and NOT pre-seeded as a value ─────
# An empty `COMPOSE_FILE=` makes compose resolve "" to the working directory
# and fail ("read /: is a directory" — measured 2026-09-04), which would break
# the bare `docker compose up` a hand-copied .env.example promises. So the key
# is documented in comment lines and install.sh's set_env_value appends the
# real, absolute line on install. That is why it is not in the value-line
# loop above: for this key a `^COMPOSE_FILE=` line in the example is the bug.
if grep -q '^# COMPOSE_FILE' "$SCRIPT_DIR/.env.example"; then
  report 0 "tripwire: .env.example documents COMPOSE_FILE"
else
  report 1 "tripwire: .env.example documents COMPOSE_FILE" "no '# COMPOSE_FILE' comment line"
fi
if grep -q '^COMPOSE_FILE=' "$SCRIPT_DIR/.env.example"; then
  report 1 "tripwire: .env.example has no COMPOSE_FILE= value line (an empty one breaks compose)" "found a value line"
else
  report 0 "tripwire: .env.example has no COMPOSE_FILE= value line (an empty one breaks compose)"
fi
if grep -q 'REPLACES' "$SCRIPT_DIR/.env.example" && grep -qi 'absolute' "$SCRIPT_DIR/.env.example"; then
  report 0 "tripwire: .env.example states the two COMPOSE_FILE facts (-f replaces; absolute paths)"
else
  report 1 "tripwire: .env.example states the two COMPOSE_FILE facts (-f replaces; absolute paths)" "missing"
fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
