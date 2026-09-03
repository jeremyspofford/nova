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
# shell that ran it, so a refusal (exit 1) leaves them empty here.
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
expect_tn "NOVA_TAILNET=0: off" "$TN_OFF_SWITCH" 0 6 "profile removed from COMPOSE_PROFILES"
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

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
