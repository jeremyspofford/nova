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

# ── the entry guard: install.sh runs under bash, or not at all ─────────────
# Sourced from a shell that is not bash, install.sh read "executed" off
# BASH_SOURCE (only bash sets it) and ran main: from zsh, cmd_install's
# preflight ran against the live docker (S42b Task 27). Its first lines now
# refuse, one line on stderr — `return` when sourced, so the shell that
# sourced it lives on, `exit` when run.
#
# These cases stay harmless if the guard is ever gone. They run a COPY in a
# temp dir (nothing it writes can land in this checkout), with a PATH whose
# first directory stubs every program that reaches outside (each records
# that it was reached, and fails), and they hand the script an unknown verb,
# so a main that is reached refuses the verb instead of installing — a fact
# the bash control below shows is visible. Nothing reached outside, main
# never reached: both asserted, not assumed.
GUARD_T="$(mktemp -d)"
mkdir -p "$GUARD_T/deploy" "$GUARD_T/stub"
cp "$SCRIPT_DIR/install.sh" "$SCRIPT_DIR/subnet.sh" "$GUARD_T/deploy/"
for GUARD_TOOL in docker curl wget git openssl sudo systemctl nvidia-smi lsof ss; do
  cat > "$GUARD_T/stub/$GUARD_TOOL" <<EOF
#!/bin/sh
echo "$GUARD_TOOL \$*" >> "$GUARD_T/reached"
exit 1
EOF
  chmod +x "$GUARD_T/stub/$GUARD_TOOL"
done
GUARD_PATH="$GUARD_T/stub:/usr/bin:/bin"
GUARD_COPY="$GUARD_T/deploy/install.sh"
GUARD_SAYS="— run ./install, or bash deploy/install.sh"
GUARD_MAIN="ERROR: unknown subcommand: not-a-verb (expected: install, update, backup, restore, drill, undo-move)"
# Runs "$@" under the guard PATH. Prints "<exit>|<stdout>|<stderr's line
# count>|<stderr>|<what the stubs saw>", newlines as spaces — stderr's count
# beside it, so "one line" is checked too.
guard_run() {
  local rc=0
  : > "$GUARD_T/reached"
  PATH="$GUARD_PATH" "$@" > "$GUARD_T/out" 2> "$GUARD_T/err" || rc=$?
  printf '%s|%s|%s|%s|%s' "$rc" "$(tr '\n' ' ' < "$GUARD_T/out")" "$(grep -c '' < "$GUARD_T/err")" \
    "$(tr '\n' ' ' < "$GUARD_T/err")" "$(tr '\n' ' ' < "$GUARD_T/reached")"
}
guard_is() { # $1 name  $2 got  $3 wanted
  if [ "$2" = "$3" ]; then report 0 "$1"; else report 1 "$1" "got '$2', wanted '$3'"; fi
}
# A POSIX shell that is not bash: dash where there is one (Debian's /bin/sh;
# /bin/dash on macOS), else a /bin/sh that is not bash (busybox).
GUARD_SH="$(command -v dash || true)"
if [ -z "$GUARD_SH" ] && [ "$(/bin/sh -c 'echo "${BASH_VERSION:-not bash}"' 2>/dev/null)" = "not bash" ]; then
  GUARD_SH=/bin/sh
fi
GUARD_ZSH="$(command -v zsh || true)"

if [ -n "$GUARD_SH" ]; then
  guard_is "entry guard: sourced from sh ($GUARD_SH), it refuses in one line and returns — that shell lives on" \
    "$(guard_run "$GUARD_SH" -c 'PATH="$2"; . "$1"; echo "back in the sourcing shell, status $?"' sh "$GUARD_COPY" "$GUARD_PATH")" \
    "0|back in the sourcing shell, status 1 |1|install.sh: cannot run under sh $GUARD_SAYS |"
  guard_is "entry guard: run by sh ($GUARD_SH), it refuses in one line and exits non-zero" \
    "$(guard_run "$GUARD_SH" "$GUARD_COPY" not-a-verb)" \
    "1||1|install.sh: cannot run under sh $GUARD_SAYS |"
else
  report 1 "entry guard: sourced from and run by sh" \
    "no POSIX sh other than bash on this runner (no dash, and /bin/sh is bash) — the guard was NOT checked"
fi
if [ -n "$GUARD_ZSH" ]; then
  guard_is "entry guard: sourced from zsh, it refuses in one line and returns — that shell lives on" \
    "$(guard_run "$GUARD_ZSH" -f -c 'PATH="$2"; . "$1" not-a-verb; print -r -- "back in the sourcing shell, status $?"' zsh "$GUARD_COPY" "$GUARD_PATH")" \
    "0|back in the sourcing shell, status 1 |1|install.sh: cannot run under zsh $GUARD_SAYS |"
  guard_is "entry guard: run by zsh, it refuses in one line and exits non-zero" \
    "$(guard_run "$GUARD_ZSH" -f "$GUARD_COPY" not-a-verb)" \
    "1||1|install.sh: cannot run under zsh $GUARD_SAYS |"
else
  NOT_RUN="${NOT_RUN:-}${NOT_RUN:+; }the entry guard under zsh (2 cases: no zsh on this runner)"
  printf 'NOT RUN the entry guard under zsh: there is no zsh on this runner, so its two cases did not run here (the sh cases did)\n'
fi
# bash itself: sourced, the file only defines (main is not run); run, main
# answers — the control that shows "main was reached" would be seen above.
guard_is "entry guard: sourced from bash, nothing is refused and main is not run" \
  "$(guard_run "$BASH" -c 'PATH="$2"; . "$1"; echo "sourced, status $?"' bash "$GUARD_COPY" "$GUARD_PATH")" \
  "0|sourced, status 0 |0||"
guard_is "entry guard: run by bash, main is reached (it refuses the unknown verb)" \
  "$(guard_run "$BASH" "$GUARD_COPY" not-a-verb)" \
  "1||1|$GUARD_MAIN |"
rm -rf "$GUARD_T"

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

# A v3-SHAPED compose file, written here rather than pointed at a path that
# happens to exist on one machine. Two reasons, and the second is the sharp one:
#
#   1. The literal path this used to carry was a real home directory with a
#      username in it, in a public repo.
#   2. classify_container only reads a config file it can actually open
#      (install.sh:615). On the machine these cases were written on, that path
#      existed, so they exercised the branch that matters: v3 ALSO declares
#      `name: nova`, and is foreign only because its volume keys are not a
#      subset of ours. On any machine without that file the loop skips, the
#      verdict is still `foreign` -- for the wrong reason -- and the case goes
#      green having measured nothing. A fixture that decides what it tests by
#      what is lying around on the host is not a fixture.
V3_DIR="$(mktemp -d)"
TMPDIRS="${TMPDIRS:-} $V3_DIR"
cat > "$V3_DIR/docker-compose.yml" <<'V3EOF'
name: nova
services:
  ollama:
    image: ollama/ollama:0.1.0
    profiles: ["inference"]
volumes:
  ollama_models:
  postgres_data:
V3EOF
cp "$V3_DIR/docker-compose.yml" "$V3_DIR/docker-compose.gpu.yml"
V3_LABEL="$V3_DIR/docker-compose.yml,$V3_DIR/docker-compose.gpu.yml"

# NOT PINNED, and it cannot be from here: install.sh:615-623 decides that
# another compose file belongs to THIS project by reading it -- same project
# name, volume keys a subset. `run_decide` sources install.sh and calls
# decide_inference directly, so NOVA_OURS_PROJECT and NOVA_OURS_VOLK are still
# the empty strings install.sh:546-547 initialises them to; they are only
# populated at :562-571, by a path no test runs. With an empty ours-set the
# subset test can never succeed, so that branch returns `foreign` for every
# input a test can construct.
#
# Measured, 2026-09-22: a fixture with `name: nova` and volume keys v4_ollama +
# v4_models -- a strict subset of ours -- is classified FOREIGN. And changing
# the v3 fixture's project name to something else leaves all 374 cases green,
# because "is it foreign" is true either way. So the v3 cases below assert the
# verdict, not the reason for it.
#
# Pinning it means teaching the harness to populate the ours-set, which changes
# what every foreign case measures. Carried deliberately rather than bodged.

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
  "$V3_DIR/docker-compose.yml"
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
    # The two seams that ask the machine: the real ones run `docker info` and
    # nvidia-smi, and this suite runs neither (S42b Task 27, fix round 0: the
    # real `docker info` was measured reached from here, twice a run). The
    # profile this case is about depends on neither.
    detect_gpu_runtime() { printf 'false'; }
    detect_gpus_json() { printf '[]'; }
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
# Anchored to a real assignment line, not a substring of the whole file:
# since S41, .env.example carries a COMMENTED-OUT `# INSTANCE_SECRET=` so the
# key has a `# nova-backup:` disposition (it is written into a real .env by
# something other than that file, and an undeclared key refuses every backup).
# A plain substring test reads that declaration as a generated secret.
if printf '%s\n' "$FRESH_BODY" | grep -q '^INSTANCE_SECRET='; then
  report 1 "fresh .env: no INSTANCE_SECRET generated" "$FRESH_BODY"
else
  report 0 "fresh .env: no INSTANCE_SECRET generated"
fi
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

# ── preflight: git, since ./install builds the agent from the committed tree ──
# (S42b P23). Refused in preflight, before anything is pulled or started —
# not after the stack is up, inside install_hub_agent.
run_git_check() {
  (
    # shellcheck source=/dev/null
    . "$SCRIPT_DIR/install.sh"
    set +e
    GIT_RC="$1"
    have_git() { return "$GIT_RC"; }
    if [ "${2:-}" = preflight ]; then
      check_docker() { :; }; check_compose() { :; }; check_foreign_project() { :; }
      check_openssl() { :; }; check_disk() { log "disk: checked"; }; check_ports() { :; }
      decide_inference() { :; }
      err="$(preflight 2>&1)"; code=$?
    else
      err="$(check_git 2>&1)"; code=$?
    fi
    printf '%s|%s' "$code" "$(printf '%s' "$err" | tr '\n' ' ')"
  )
}
expect_case "git present: preflight passes" "$(run_git_check 0)" 0 "git: present"
expect_case "git missing: refused, saying why ./install needs it" "$(run_git_check 1)" 1 \
  "git is needed: ./install builds Nova's agent from this checkout's committed tree"
GIT_PREFLIGHT="$(run_git_check 1 preflight)"
expect_case "git missing: preflight itself refuses" "$GIT_PREFLIGHT" 1 "git is needed"
case "$GIT_PREFLIGHT" in
  *"disk: checked"*) report 1 "git missing: refused before the disk check" "$GIT_PREFLIGHT" ;;
  *) report 0 "git missing: refused before the disk check" ;;
esac


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
expect_tn "the browser engine is always health-checked (S38)" "$TN_OFF" 0 3 "browser"
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
#   $3 how the hub machine's own agent goes (ok/fail; default ok) — its own
#      cases are further down; here it is a marker, so the ORDER is what is
#      tested: after the compute check, before "Nova is up", and its failure
#      fails ./install with nothing taken down.
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
    NVIDIA="$1"; FAKE_LOG="$2"; HUB_AGENT="${3:-ok}"
    install_hub_agent() {
      log "HUB AGENT REACHED"
      [ "$HUB_AGENT" = ok ] || die "the hub's agent was not installed (stub) — the stack is up"
    }
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
    # decide_subnet runs for real on this path (that is the point — deleting
    # its call from cmd_install turns the NOVA_SUBNET assertions below red).
    # Its four outside-world seams are answered here so the answer is the same
    # on every machine: no docker networks, one docker0 route.
    check_foreign_project() { :; }
    docker_network_ids() { :; }
    have_cmd() { [ "$1" = ip ]; }
    ip_route_text() { printf '%s\n' '172.17.0.0/16 dev docker0 proto kernel scope link src 172.17.0.1'; }
    compose_project_name() { printf '%s' nova; }
    unset NOVA_TAILNET NOVA_SKIP_INFERENCE NOVA_SUBNET
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
# decide_subnet is REACHED from cmd_install, and writes all five keys.
expect_tn "install: the subnet decision reaches .env" "$INST_OK" 0 2 "NOVA_SUBNET=172.18.0.0/16;"
expect_tn "install: and the derived web address with it" "$INST_OK" 0 2 "NOVA_WEB_ADDR=172.18.128.10;"

# The hub machine's own agent (S42b P23) is REACHED from cmd_install: after
# the compute check, before "Nova is up". Delete the call and these go red.
case "$(tn_field "$INST_OK" 3)" in
  *"ollama reports library=CUDA"*"HUB AGENT REACHED"*"Nova is up"*)
    report 0 "install: the hub machine's agent comes after the compute check, before 'Nova is up'" ;;
  *) report 1 "install: the hub machine's agent comes after the compute check, before 'Nova is up'" "$INST_OK" ;;
esac
INST_HUBFAIL="$(run_install 1 "$DECOY_LINE\n$CUDA_LINE\n" fail)"
expect_tn "install, hub agent fails: ./install fails" "$INST_HUBFAIL" 1 3 "the hub's agent was not installed"
expect_tn_lacks "install, hub agent fails: never says Nova is up" "$INST_HUBFAIL" 3 "Nova is up"
expect_tn_lacks "install, hub agent fails: nothing is taken down (no other docker call)" "$INST_HUBFAIL" 3 \
  "unexpected docker call"

INST_CPU="$(run_install 1 "$DECOY_LINE\n$CPU_LINE\n")"
expect_tn "install, gpu + cpu: refuses after a green table" "$INST_CPU" 1 3 "came up WITHOUT the GPU"
expect_tn "install, gpu + cpu: the table WAS green (the point)" "$INST_CPU" 1 3 "ollama     healthy"
expect_tn "install, gpu + cpu: names the overlay" "$INST_CPU" 1 3 "docker-compose.gpu.yml"
expect_tn_lacks "install, gpu + cpu: never says Nova is up" "$INST_CPU" 3 "Nova is up"
expect_tn_lacks "install, gpu + cpu: the hub's agent is never reached" "$INST_CPU" 3 "HUB AGENT REACHED"

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
# Field 3 is the whole .env text, which carries COMPOSE_FILE=<abs path>. A
# checkout whose PATH contains "inference" (this one does) made a correct
# implementation fail here. Assert on the value of COMPOSE_PROFILES, which
# is what the case is about, not on every byte of the file.
expect_tn "profiles: bundled off, never listed ⇒ inference absent" "$PE_SKIP_NONE" 0 3 "COMPOSE_PROFILES=;"
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

# ── set_env_value: a .env that does not exist yet ───────────────────────────
# The defect (design-verdict.md §9.2 step 2; port-v3 M2 / python-tool M3):
# set_env_value reads the file it is about to rewrite — `done < "$ENV_FILE"` —
# so on a bare target it dies with "No such file or directory" instead of
# writing the key. Every caller that writes a key before generate_secrets has
# run hits it: restore on an empty machine, and decide_subnet.
#   $1 key   $2 initial .env body ("" = the file does not exist)
# Prints "<exit>|<.env with ;>|<stderr>".
run_set_env() {
  (
    # shellcheck source=/dev/null
    . "$SCRIPT_DIR/install.sh"
    set +e
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    # shellcheck disable=SC2034
    ENV_FILE="$tmp/.env"
    if [ -n "${2:-}" ]; then printf '%b' "$2" > "$ENV_FILE"; fi
    # errexit restored for the call itself: install.sh runs with `set -e`, so
    # the failed redirect below IS fatal in the real installer even though the
    # harness turns errexit off for its own bookkeeping.
    err="$( ( set -e; set_env_value "$1" value-written ) 2>&1 )"; code=$?
    printf '%s|%s|%s' "$code" "$(tr '\n' ';' < "$ENV_FILE" 2>/dev/null)" \
      "$(printf '%s' "$err" | tr '\n' ' ')"
  )
}
SEV_NEW="$(run_set_env NOVA_SUBNET)"
expect_tn "set_env_value: a missing .env is created, not a crash" "$SEV_NEW" 0 2 "NOVA_SUBNET=value-written;"
expect_tn_lacks "set_env_value: says nothing about a missing file" "$SEV_NEW" 3 "No such file"
expect_str "set_env_value: the new file holds exactly one line" \
  "$(tn_field "$SEV_NEW" 2 | tr ';' '\n' | grep -c .)" "1"
# The existing behaviour is unchanged: replace in place, append when absent.
SEV_REPLACE="$(run_set_env NOVA_SUBNET 'A=1\nNOVA_SUBNET=old\nB=2\n')"
expect_tn "set_env_value: an existing key is still replaced in place" "$SEV_REPLACE" 0 2 \
  "A=1;NOVA_SUBNET=value-written;B=2;"
SEV_APPEND="$(run_set_env NOVA_SUBNET 'A=1\n')"
expect_tn "set_env_value: a new key is still appended" "$SEV_APPEND" 0 2 "A=1;NOVA_SUBNET=value-written;"

# ── refuse_if_moved: a parked host refuses FIRST ────────────────────────────
# `./install backup --move` parks this machine: it writes deploy/.moved and
# deploy/tailscale/MOVED_TO (design-verdict.md §9.5). Bringing the stack up
# here again puts a SECOND tailscaled on the same node identity and the two
# flap. cmd_install must refuse before it reads, pulls or starts anything —
# the assertion below counts the docker calls, so a refusal that runs after
# preflight fails even though its text is right.
#   $1 marker body ("" = no marker)
# Prints "<exit>|<docker call count>|<combined output>".
run_moved() {
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
    # shellcheck disable=SC2034
    MOVED_MARKER="$tmp/.moved"
    : > "$tmp/docker-calls"
    if [ -n "${1:-}" ]; then printf '%b' "$1" > "$MOVED_MARKER"; fi
    docker() {
      printf '%s\n' "$*" >> "$tmp/docker-calls"
      case "$*" in
        info) printf 'Runtimes: runc\n' ;;
        "compose version") ;;
        *" up -d --build") ;;
        *" ps -q "*) printf 'cid\n' ;;
        "inspect "*) printf 'healthy\n' ;;
        *" logs --no-log-prefix ollama") printf 'inference compute id=0 library=cpu\n' ;;
        *) ;;
      esac
    }
    check_foreign_project() { :; }
    decide_subnet() { :; }
    detect_gpus_json() { printf '[]'; }
    detect_disk_free_gb() { printf '100'; }
    port_holder() { printf ''; }
    # The hub machine's own agent has its own cases (run_hub_agent); here it
    # must not reach out — its real seams would build and fetch.
    install_hub_agent() { :; }
    unset NOVA_TAILNET NOVA_SKIP_INFERENCE
    out="$(cmd_install 2>&1)"; code=$?
    printf '%s|%s|%s' "$code" "$(grep -c . "$tmp/docker-calls" 2>/dev/null)" \
      "$(printf '%s' "$out" | tr '\n' ' ')"
  )
}
MOVED_BODY='moved_at=20260921T143012Z\nbundle=nova-backup-srchost-20260921T143012Z.tar\nbundle_sha256=0123456789abcdef\nsource_host=srchost\n'
MV="$(run_moved "$MOVED_BODY")"
expect_tn "refuse_if_moved: a parked host refuses" "$MV" 1 3 "parked by"
expect_tn "refuse_if_moved: prints the marker verbatim" "$MV" 1 3 \
  "bundle=nova-backup-srchost-20260921T143012Z.tar"
expect_tn "refuse_if_moved: names the file that says so" "$MV" 1 3 ".moved"
expect_tn "refuse_if_moved: states the flap it is preventing" "$MV" 1 3 "node identity"
expect_tn "refuse_if_moved: names undo-move as the way back" "$MV" 1 3 "./install undo-move"
expect_str "refuse_if_moved: refuses before ANY docker call" "$(tn_field "$MV" 2)" "0"
# No marker: the ordinary machine is untouched by this check.
MV_NONE="$(run_moved "")"
expect_tn "refuse_if_moved: no marker ⇒ the install runs" "$MV_NONE" 0 3 "Nova is up"
expect_tn_lacks "refuse_if_moved: no marker ⇒ says nothing about a move" "$MV_NONE" 3 "parked by"

# ── the subnet: decided from what is in use, never from a table ─────────────
# deploy/subnet.sh + decide_subnet (design-verdict.md §10.2). 172.18/16 is a
# hardcoded literal in docker-compose.yml today and NOVA_SUBNET appears
# nowhere, so a second Nova on a machine that already uses 172.18 collides.
# Everything here runs the real decision; stubbed are the four seams that
# touch the outside world — `docker network ls`/`inspect`, whether `ip` and
# `netstat` exist, and what each prints.
#
# Fixture shape: SB_NETWORKS is one network per line,
#   <name>;<com.docker.compose.project>/<com.docker.compose.network>;<space-separated subnets>
# That is the shape docker_network_row really emits. It used to be the network's
# config_files label, which compose never writes on a network — so every case
# here tested a network the real world cannot produce.
#   $1 SB_NETWORKS   $2 SB_IP_ROUTES (printf %b)   $3 initial .env body
#   $4 NOVA_SUBNET in the environment ("" = unset)
#   $5 "1" = `ip` exists     $6 "1" = `netstat` exists, with $7 its output
#   $8 "0" = docker cannot be asked
# Prints "<exit>|<.env with ;>|<stderr>".
run_subnet() {
  (
    # shellcheck source=/dev/null
    . "$SCRIPT_DIR/install.sh"
    set +e
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    # shellcheck disable=SC2034
    ENV_FILE="$tmp/.env"
    printf '%b' "${3:-}" > "$ENV_FILE"
    SB_NETWORKS="$1"; SB_IP="$2"; SB_HAVE_IP="${5:-1}"
    SB_HAVE_NETSTAT="${6:-0}"; SB_BSD="${7:-}"; SB_DOCKER_OK="${8:-1}"
    docker_network_ids() {
      [ "$SB_DOCKER_OK" = 1 ] || return 1
      printf '%b\n' "$SB_NETWORKS" | awk 'NF { c++; print c }'
    }
    docker_network_row() {
      printf '%b\n' "$SB_NETWORKS" | awk -v n="$1" 'NF { c++; if (c == n) print }' | tr ';' '\t'
    }
    have_cmd() {
      case "$1" in
        ip) [ "$SB_HAVE_IP" = 1 ] ;;
        netstat) [ "$SB_HAVE_NETSTAT" = 1 ] ;;
        *) command -v "$1" >/dev/null 2>&1 ;;
      esac
    }
    ip_route_text() { printf '%b' "$SB_IP"; }
    netstat_route_text() { printf '%b' "$SB_BSD"; }
    compose_project_name() { printf '%s' "nova"; }
    if [ -n "${4:-}" ]; then export NOVA_SUBNET="$4"; else unset NOVA_SUBNET; fi
    err="$(decide_subnet 2>&1)"; code=$?
    printf '%s|%s|%s' "$code" "$(tr '\n' ';' < "$ENV_FILE")" \
      "$(printf '%s' "$err" | tr '\n' ' ')"
  )
}
# One function, sourced for real, driven with arguments.
run_sb() {
  (
    # shellcheck source=/dev/null
    . "$SCRIPT_DIR/install.sh"
    set +e
    "$@"
  )
}

SB_OURS="nova/default"
# The Dell's own shape: docker0 plus the project network.
SB_IP_FREE='172.17.0.0/16 dev docker0 proto kernel scope link src 172.17.0.1\ndefault via 192.168.0.1 dev eth0 proto dhcp\n192.168.0.0/24 dev eth0 proto kernel scope link src 192.168.0.9\n'

# Branch 1: the project network exists AND its config-files label is this
# checkout's — the only case in which its addressing may be adopted.
SB_ADOPT="$(run_subnet "nova_default;$SB_OURS;172.25.0.0/16" "$SB_IP_FREE")"
expect_tn "subnet: adopts this checkout's own project network" "$SB_ADOPT" 0 2 "NOVA_SUBNET=172.25.0.0/16;"
expect_tn "subnet: says it adopted rather than picked" "$SB_ADOPT" 0 3 "adopted"
expect_tn "subnet: adopt writes NOVA_SUBNET_RANGE" "$SB_ADOPT" 0 2 "NOVA_SUBNET_RANGE=172.25.0.0/17;"
expect_tn "subnet: adopt writes NOVA_SUBNET_GATEWAY" "$SB_ADOPT" 0 2 "NOVA_SUBNET_GATEWAY=172.25.0.1;"
expect_tn "subnet: adopt writes NOVA_WEB_ADDR" "$SB_ADOPT" 0 2 "NOVA_WEB_ADDR=172.25.128.10;"
expect_tn "subnet: adopt writes NOVA_TAILSCALE_ADDR" "$SB_ADOPT" 0 2 "NOVA_TAILSCALE_ADDR=172.25.128.20;"

# python-tool M5. §10.1 removes foreign containers and volumes but NOT
# networks, so a dead project's `nova_default` outlives the cleanup. Adopting
# it by NAME would take addressing someone else chose — and the compose
# comment at docker-compose.yml:374-386 says the fixed address IS web's trust
# boundary. It must be treated as in use, not as ours.
# A nova_default made BY HAND (`docker network create nova_default`) carries no
# compose labels at all, so it reads "/" — not ours, whatever it is called.
SB_FOREIGN="$(run_subnet "nova_default;/;172.18.0.0/16" "$SB_IP_FREE")"
expect_tn "subnet: a nova_default compose did not make for this project is NOT adopted" "$SB_FOREIGN" 0 2 "NOVA_SUBNET=172.19.0.0/16;"
expect_tn_lacks "subnet: the foreign network is not called adopted" "$SB_FOREIGN" 3 "adopted"
expect_tn "subnet: the foreign network counts as in use instead" "$SB_FOREIGN" 0 3 "is taken by 172.18.0.0/16 network nova_default"

# Adopting a network that is not a /16 cannot produce the two .128 addresses,
# and writing addresses outside the network is how `up` fails later.
SB_SLASH24="$(run_subnet "nova_default;$SB_OURS;172.25.0.0/24" "$SB_IP_FREE")"
expect_tn "subnet: refuses to derive the .128 addresses from a non-/16" "$SB_SLASH24" 1 3 "not a /16"
expect_tn "subnet: names the network it could not derive from" "$SB_SLASH24" 1 3 "172.25.0.0/24"

# Branch 3: pick, avoiding every network and every route.
SB_PICK="$(run_subnet "a;;172.18.0.0/16\nb;;172.19.0.0/16" "$SB_IP_FREE")"
expect_tn "subnet: picks the first candidate nothing else holds" "$SB_PICK" 0 2 "NOVA_SUBNET=172.20.0.0/16;"
expect_tn "subnet: logs each candidate it rejected, and why" "$SB_PICK" 0 3 "172.18.0.0/16 is taken by 172.18.0.0/16 network a"

# Branch 2: a pinned NOVA_SUBNET is never silently moved.
SB_PIN_OK="$(run_subnet "a;;172.18.0.0/16" "$SB_IP_FREE" "" "10.77.0.0/16")"
expect_tn "subnet: a free pinned NOVA_SUBNET is honoured" "$SB_PIN_OK" 0 2 "NOVA_SUBNET=10.77.0.0/16;"
expect_tn "subnet: a pinned subnet derives its own addresses" "$SB_PIN_OK" 0 2 "NOVA_WEB_ADDR=10.77.128.10;"
SB_PIN_BAD="$(run_subnet "othernet;;172.20.0.0/16" "$SB_IP_FREE" "" "172.20.0.0/16")"
expect_tn "subnet: a colliding pinned NOVA_SUBNET dies" "$SB_PIN_BAD" 1 3 "collides"
expect_tn "subnet: the collision names the network" "$SB_PIN_BAD" 1 3 "network othernet"
expect_tn_lacks "subnet: a colliding pin writes nothing" "$SB_PIN_BAD" 2 "NOVA_SUBNET="
SB_PIN_ROUTE="$(run_subnet "" "10.88.0.0/16 dev eth0 proto kernel scope link src 10.88.0.2\n" "" "10.88.0.0/16")"
expect_tn "subnet: a pin colliding with a host ROUTE dies too" "$SB_PIN_ROUTE" 1 3 "collides"
expect_tn "subnet: the collision names the route" "$SB_PIN_ROUTE" 1 3 "route 10.88.0.0/16"

# port-v3 m3, the BSD leg. netstat prints `172.16/12` with no length; an
# octet-count expansion calls it a /16 and reports 172.18 free, which it is
# not. The whole 172.16–172.31 band is covered, so the pick must fall through
# to the 10.200 band.
SB_BSD_FIX='Routing tables\n\nInternet:\nDestination        Gateway            Flags        Netif Expire\ndefault            192.168.0.1        UGScg          en0\n10.0.0/24          link#3             UCS            en0\n127.0.0.1          127.0.0.1          UH             lo0\n172.16             link#4             UCS            en0\n'
SB_BSD_RUN="$(run_subnet "" "" "" "" 0 1 "$SB_BSD_FIX")"
expect_tn "subnet: reads routes from netstat when ip is absent" "$SB_BSD_RUN" 0 3 "netstat -rn -f inet"
expect_tn "subnet: a BSD short form expands to the containing RFC1918 block" "$SB_BSD_RUN" 0 3 "172.16.0.0/12"
expect_tn "subnet: the whole 172 band is therefore taken" "$SB_BSD_RUN" 0 2 "NOVA_SUBNET=10.200.0.0/16;"
expect_tn_lacks "subnet: never expands 172.16 to a /16" "$SB_BSD_RUN" 3 "172.16.0.0/16"

# Neither tool: refuse to pick blind rather than pick.
SB_NOTOOLS="$(run_subnet "" "" "" "" 0 0 "")"
expect_tn "subnet: refuses to pick when neither ip nor netstat exists" "$SB_NOTOOLS" 1 3 "neither"
expect_tn "subnet: names both commands it looked for" "$SB_NOTOOLS" 1 3 "netstat"
expect_tn_lacks "subnet: writes nothing when it could not read the routes" "$SB_NOTOOLS" 2 "NOVA_SUBNET="

# A docker call that fails is a refusal, not an empty set.
SB_NODOCKER="$(run_subnet "a;;172.18.0.0/16" "$SB_IP_FREE" "" "" 1 0 "" 0)"
expect_tn "subnet: docker that cannot be asked is a refusal" "$SB_NODOCKER" 1 3 "docker"
expect_tn_lacks "subnet: a docker failure writes nothing" "$SB_NODOCKER" 2 "NOVA_SUBNET="

# A destination that cannot become a CIDR is PRINTED, never silently dropped.
SB_JUNK="$(run_subnet "" "224.0.0 dev eth0\n172.17.0.0/16 dev docker0\n" "")"
expect_tn "subnet: an unparseable route destination is named out loud" "$SB_JUNK" 0 3 "224.0.0"
expect_tn "subnet: and the run still completes" "$SB_JUNK" 0 2 "NOVA_SUBNET=172.18.0.0/16;"

# A write that does not read back is a failure, not a shrug. The one seam
# stubbed here makes .env come back missing the key that was just written to
# it — the shape of a silently-failed write.
SB_LIAR="$(
  (
    # shellcheck source=/dev/null
    . "$SCRIPT_DIR/install.sh"
    set +e
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    # shellcheck disable=SC2034
    ENV_FILE="$tmp/.env"
    : > "$ENV_FILE"
    docker_network_ids() { :; }
    have_cmd() { [ "$1" = ip ]; }
    ip_route_text() { printf '%b' '172.17.0.0/16 dev docker0\n'; }
    compose_project_name() { printf '%s' nova; }
    get_env_value() {
      [ "$1" = NOVA_WEB_ADDR ] && return 0
      grep -m1 "^${1}=" "$ENV_FILE" 2>/dev/null | cut -d'=' -f2- || true
    }
    unset NOVA_SUBNET
    err="$(decide_subnet 2>&1)"; code=$?
    printf '%s|%s|%s' "$code" "$(tr '\n' ';' < "$ENV_FILE")" "$(printf '%s' "$err" | tr '\n' ' ')"
  )
)"
expect_tn "subnet: a key that does not read back is a failure" "$SB_LIAR" 1 3 "NOVA_WEB_ADDR"
expect_tn "subnet: the failure says what came back instead" "$SB_LIAR" 1 3 "read back"

# The pure arithmetic, on its own.
expect_str "subnet_overlaps: identical blocks overlap" \
  "$(run_sb eval 'subnet_overlaps 172.18.0.0/16 172.18.0.0/16; printf %s $?')" "0"
expect_str "subnet_overlaps: a /24 inside a /16 overlaps" \
  "$(run_sb eval 'subnet_overlaps 172.18.0.0/16 172.18.5.0/24; printf %s $?')" "0"
expect_str "subnet_overlaps: the containing /12 overlaps a /16 inside it" \
  "$(run_sb eval 'subnet_overlaps 172.18.0.0/16 172.16.0.0/12; printf %s $?')" "0"
expect_str "subnet_overlaps: neighbours do not overlap" \
  "$(run_sb eval 'subnet_overlaps 172.18.0.0/16 172.19.0.0/16; printf %s $?')" "1"
expect_str "subnet_overlaps: 10/8 does not reach 172.18" \
  "$(run_sb eval 'subnet_overlaps 172.18.0.0/16 10.0.0.0/8; printf %s $?')" "1"
expect_str "subnet_overlaps: garbage is its own answer, not 'no'" \
  "$(run_sb eval 'subnet_overlaps 172.18.0.0/16 not-a-cidr; printf %s $?')" "2"
expect_str "expand_route_dest: an explicit length is honoured, octets padded" \
  "$(run_sb expand_route_dest 10.0.0/24)" "10.0.0.0/24"
expect_str "expand_route_dest: a four-octet host route is a /32" \
  "$(run_sb expand_route_dest 127.0.0.1)" "127.0.0.1/32"
expect_str "expand_route_dest: 172.16 is the /12, not the classful guess" \
  "$(run_sb expand_route_dest 172.16)" "172.16.0.0/12"
expect_str "expand_route_dest: 192.168 is the /16" \
  "$(run_sb expand_route_dest 192.168)" "192.168.0.0/16"
expect_str "expand_route_dest: 10.0.0 is the whole /8" \
  "$(run_sb expand_route_dest 10.0.0)" "10.0.0.0/8"
expect_str "expand_route_dest: a short form outside RFC1918 is refused" \
  "$(run_sb eval 'expand_route_dest 224.0.0 >/dev/null; printf %s $?')" "1"

# #23: the two fixed addresses must sit OUTSIDE the dynamic range, or the
# allocator can hand web's address to something else and nginx's trust
# boundary stops meaning anything.
SB_ADDRS="$(run_sb derive_subnet_addrs 172.22.0.0/16)"
expect_str "derive_subnet_addrs: the dynamic range is the lower /17" \
  "$(printf '%s\n' "$SB_ADDRS" | grep '^NOVA_SUBNET_RANGE=' | cut -d= -f2)" "172.22.0.0/17"
expect_str "derive_subnet_addrs: web sits outside the dynamic range" \
  "$(run_sb eval 'subnet_overlaps 172.22.128.10/32 172.22.0.0/17; printf %s $?')" "1"
expect_str "derive_subnet_addrs: the sidecar sits outside the dynamic range" \
  "$(run_sb eval 'subnet_overlaps 172.22.128.20/32 172.22.0.0/17; printf %s $?')" "1"
expect_str "derive_subnet_addrs: web sits INSIDE the subnet itself" \
  "$(run_sb eval 'subnet_overlaps 172.22.128.10/32 172.22.0.0/16; printf %s $?')" "0"
expect_str "derive_subnet_addrs: a non-/16 derives nothing" \
  "$(run_sb eval 'derive_subnet_addrs 172.22.0.0/24 >/dev/null; printf %s $?')" "1"

# ── the foreign `nova` compose project, and the one irreversible path ───────
# design-verdict.md §10.1, owner ruling 1: name everything found, then offer
# to delete exactly that, defaulting to nothing.
#
# The fixtures below are the mini PC's PRE-CLEANUP reading
# (docs/plans/rebuild/s41/map-minipc-measured.md:20-30,45-56) with its home
# paths replaced by neutral ones. They are the only place those objects still
# exist: all three old projects were archived and removed on 2026-09-21, so
# this refusal and its deletion loop can no longer be walked against a real
# foreign project on any machine we have (§10.1, §13 T7). Nothing here is
# hand-invented, and nothing here touches docker.
#
# The measured near-miss this exists to stop: `nova_pgdata` and
# `nova_redis_data` were NAMED with the `nova_` prefix while their
# com.docker.compose.project label said `docker` — a different project of his.
# A name-prefix selection destroys 75.8 MB of it.
#
# World, mutable across a run so the post-checks are real:
#   FX_CONTAINERS  id;name;service;state;config_files   (labelled project=nova)
#   FX_VOLUMES     name;project label;compose volume key label
#   FX_HOLDERS     volume;container id
#   $1 render text ($2 "" = use the REAL deploy/docker-compose.yml as the raw
#      text; otherwise this text is written as the compose file)
#   $3 tty (1/0)   $4 what the operator types   $5 shell run just before the
#      answer, so a case can change the world BETWEEN naming and deletion
#   $6 volumes that hold a tailscaled.state, space-separated
# Prints "<exit>|<removal log with ;>|<stderr>".
run_foreign() {
  (
    # shellcheck source=/dev/null
    . "$SCRIPT_DIR/install.sh"
    set +e
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    FX_RENDER="$1"; FX_TTY="${3:-1}"; FX_ANSWER="${4:-}"
    FX_ON_ANSWER="${5:-}"; FX_STATE_VOLS="${6:-}"
    if [ -n "${2:-}" ]; then
      printf '%b' "$2" > "$tmp/docker-compose.yml"
      COMPOSE_FILE="$tmp/docker-compose.yml"
    fi
    COMPOSE_ARGS=(-f "$COMPOSE_FILE")
    printf '%b\n' "$FX_CONTAINERS" | awk 'NF' > "$tmp/world-containers"
    printf '%b\n' "$FX_VOLUMES" | awk 'NF' > "$tmp/world-volumes"
    printf '%b\n' "${FX_HOLDERS:-}" | awk 'NF' > "$tmp/world-holders"
    : > "$tmp/removed"
    compose_config_text_all_profiles() { printf '%b' "$FX_RENDER"; }
    project_containers() {
      # The hazard T1 found elsewhere: an EMPTY value here matches every
      # container on the host. The seam refuses it rather than trusting a
      # caller to have checked.
      [ -n "$1" ] || { printf 'EMPTY PROJECT FILTER\n' >&2; return 2; }
      awk -F';' '{ printf "%s\t%s\t%s\t%s\n", $1, $2, $3, $4 }' "$tmp/world-containers"
    }
    container_config_files() { awk -F';' -v i="$1" '$1 == i { print $5 }' "$tmp/world-containers"; }
    container_exists() { awk -F';' -v i="$1" '$1 == i { f = 1 } END { exit !f }' "$tmp/world-containers"; }
    container_id_of() { awk -F';' -v n="$1" '$2 == n { print $1; f = 1 } END { exit !f }' "$tmp/world-containers"; }
    container_mounted_volumes() { awk -F';' -v i="$1" '$2 == i { print $1 }' "$tmp/world-holders"; }
    containers_using_volume() { awk -F';' -v v="$1" '$1 == v { print $2 }' "$tmp/world-holders"; }
    project_labelled_volumes() {
      [ -n "$1" ] || { printf 'EMPTY PROJECT FILTER\n' >&2; return 2; }
      awk -F';' -v p="$1" '$2 == p { print $1 }' "$tmp/world-volumes"
    }
    all_volume_names() { awk -F';' '{ print $1 }' "$tmp/world-volumes"; }
    volume_exists() { awk -F';' -v v="$1" '$1 == v { f = 1 } END { exit !f }' "$tmp/world-volumes"; }
    volume_label() {
      awk -F';' -v v="$1" -v l="$2" \
        '$1 == v { print (l == "com.docker.compose.project" ? $2 : $3) }' "$tmp/world-volumes"
    }
    state_file_on_volume() {
      case " $FX_STATE_VOLS " in *" $1 "*) return 0 ;; esac
      return 1
    }
    docker_volume_rm() {
      printf 'volume rm %s\n' "$1" >> "$tmp/removed"
      awk -F';' -v v="$1" '$1 != v' "$tmp/world-volumes" > "$tmp/w" && mv "$tmp/w" "$tmp/world-volumes"
    }
    docker_container_rm() {
      printf 'container rm %s\n' "$1" >> "$tmp/removed"
      awk -F';' -v i="$1" '$1 != i' "$tmp/world-containers" > "$tmp/w" && mv "$tmp/w" "$tmp/world-containers"
    }
    have_tty() { [ "$FX_TTY" = 1 ]; }
    prompt_delete_answer() { eval "$FX_ON_ANSWER"; printf '%s' "$FX_ANSWER"; }
    err="$(check_foreign_project 2>&1)"; code=$?
    printf '%s|%s|%s' "$code" "$(tr '\n' ';' < "$tmp/removed")" \
      "$(printf '%s' "$err" | tr '\n' ' ')"
  )
}

# The render `--profile tailnet` gives: FOUR volumes. v4_ollama and
# v4_tailscale are behind the inference profile and are simply absent, which
# is port-v3 C1 / shell-first C1 / python-tool C2 — under a render-only
# ours-set both classify FOREIGN and land in the delete block, and one of
# them is the tailnet node identity. The raw compose TEXT is what closes it,
# and the raw text used below is the REAL deploy/docker-compose.yml, so the
# ours-set is never hand-written.
FX_RENDER_TAILNET='name: nova\nservices:\n  postgres:\n    image: postgres:16\n  web:\n    image: nova-web\n  searxng:\n    image: searxng/searxng\n  tailscale:\n    image: tailscale/tailscale:v1.102.3\nvolumes:\n  v4_memdata:\n    name: nova_v4_memdata\n  v4_models:\n    name: nova_v4_models\n  v4_pgdata:\n    name: nova_v4_pgdata\n  v4_workspace:\n    name: nova_v4_workspace\n'

OLD_CFG='/opt/old-nova/docker-compose.yml'
# The nine exited containers of the old platform-line project, abbreviated to
# the three whose service names matter; full 64-hex ids, because the deletion
# loop compares against `docker inspect -f {{.Id}}`, which never truncates.
FX_OLD_CONTAINERS="0000000000000000000000000000000000000000000000000000000000003f21;nova-postgres-1;postgres;exited;$OLD_CFG\n0000000000000000000000000000000000000000000000000000000000004b8c;nova-orchestrator-1;orchestrator;exited;$OLD_CFG\n0000000000000000000000000000000000000000000000000000000000005d9e;nova-redis-1;redis;exited;$OLD_CFG"
# The measured volume set: two of the old project, two NAMED nova_* but
# labelled for project `docker`, all six of v4's, and one of jobhunter's.
FX_OLD_VOLUMES='nova_postgres-data;nova;postgres-data\nnova_redis-data;nova;redis-data\nnova_pgdata;docker;nova_pgdata\nnova_redis_data;docker;nova_redis_data\nnova_v4_pgdata;nova;v4_pgdata\nnova_v4_models;nova;v4_models\nnova_v4_memdata;nova;v4_memdata\nnova_v4_workspace;nova;v4_workspace\nnova_v4_ollama;nova;v4_ollama\nnova_v4_tailscale;nova;v4_tailscale\njobhunter_postgres_data;jobhunter;postgres_data'

FX_CONTAINERS="$FX_OLD_CONTAINERS"
FX_VOLUMES="$FX_OLD_VOLUMES"
FX_HOLDERS='nova_postgres-data;0000000000000000000000000000000000000000000000000000000000003f21\nnova_redis-data;0000000000000000000000000000000000000000000000000000000000005d9e'

FG="$(run_foreign "$FX_RENDER_TAILNET" "" 1 delete)"
expect_tn "foreign: refuses and says what would be adopted" "$FG" 0 3 "REFUSED"
expect_tn "foreign: names every foreign container it found" "$FG" 0 3 "nova-postgres-1"
expect_tn "foreign: names the orchestrator too" "$FG" 0 3 "nova-orchestrator-1"
expect_tn "foreign: prints the label that selected each container" "$FG" 0 3 "com.docker.compose.project=nova"
expect_tn "foreign: names the config file the container came from" "$FG" 0 3 "$OLD_CFG"
expect_tn "foreign: names every foreign volume it found" "$FG" 0 3 "nova_postgres-data"
expect_tn "foreign: names the second foreign volume" "$FG" 0 3 "nova_redis-data"
expect_tn "foreign: names the service name that would be adopted" "$FG" 0 3 "also declares: postgres"

# THE test owner ruling 1 demands. A `nova_`-named volume owned by another
# project, and six real v4 volumes, are all in the same world as the two the
# label really selects.
expect_str "foreign: the removal set is EXACTLY the two label-selected volumes and the three containers" \
  "$(tn_field "$FG" 2)" \
  "volume rm nova_postgres-data;volume rm nova_redis-data;container rm 0000000000000000000000000000000000000000000000000000000000003f21;container rm 0000000000000000000000000000000000000000000000000000000000004b8c;container rm 0000000000000000000000000000000000000000000000000000000000005d9e;"
expect_tn_lacks "foreign: no v4 volume can ever be caught (by name, over every removal)" "$FG" 2 "nova_v4_"
expect_tn_lacks "foreign: the decoy nova_pgdata is never removed" "$FG" 2 "nova_pgdata"
expect_tn_lacks "foreign: the decoy nova_redis_data is never removed" "$FG" 2 "nova_redis_data"
expect_tn_lacks "foreign: another project's volume is never removed" "$FG" 2 "jobhunter"
expect_tn "foreign: the decoy is NAMED as left alone, with its own label" "$FG" 0 3 "nova_pgdata"
expect_tn "foreign: and the label that left it alone is printed" "$FG" 0 3 "project=docker"
expect_tn "foreign: this stack's own volumes are named as left alone" "$FG" 0 3 "nova_v4_pgdata"
# The two the tailnet render prunes are protected by the raw text alone.
expect_tn "foreign: the inference-profile volume is ours, not foreign" "$FG" 0 3 "nova_v4_ollama"
expect_tn "foreign: the node identity volume is ours, not foreign" "$FG" 0 3 "nova_v4_tailscale"
expect_tn "foreign: volumes are removed BEFORE containers" "$FG" 0 2 "volume rm nova_redis-data;container rm"
expect_tn "foreign: the install continues once the refusal's cause is gone" "$FG" 0 3 "continuing with the install"

# ── the SECOND derivation: the label has to be the arbiter there too ─────────
# foreign_volumes() unions two derivations — the com.docker.compose.project
# label filter, and the mounts of the foreign containers (python-tool M8: a
# `docker compose down` without -v leaves volumes whose containers are gone,
# so the mounts alone are not enough either). The label half arrives
# pre-filtered by docker. The mounts half does NOT: `docker inspect .Mounts`
# returns whatever that container happens to mount, and an old `nova` project
# container is perfectly free to mount a volume belonging to another project
# of his, or to no project at all.
#
# So ruling 1's Global Constraint — "nothing is selected by name; containers,
# volumes and projects are selected by the com.docker.compose.project label
# read from docker" — has to be applied at CLASSIFICATION, to both halves.
# Applying it at deletion time does not work: the re-check there compares the
# freshly-read label to the value THIS capture recorded, so on a wrongly
# captured volume it agrees with itself and passes.
#
# Until this block existed, every FX_HOLDERS row in this file named a volume
# the label filter already returned, so the mounts half contributed zero
# volumes in zero cases and "another project's volume is never removed"
# above passed vacuously.
FX_CONTAINERS="$FX_OLD_CONTAINERS"
FX_VOLUMES="$FX_OLD_VOLUMES"
FG_HOLD2='nova_postgres-data;0000000000000000000000000000000000000000000000000000000000003f21\nnova_redis-data;0000000000000000000000000000000000000000000000000000000000005d9e'
FG_ORCH='0000000000000000000000000000000000000000000000000000000000004b8c'
# What the removal set must stay, in every case below: the two the LABEL
# selected, and the three containers. Nothing a mount dragged in.
FG_ONLY2="volume rm nova_postgres-data;volume rm nova_redis-data;container rm 0000000000000000000000000000000000000000000000000000000000003f21;container rm $FG_ORCH;container rm 0000000000000000000000000000000000000000000000000000000000005d9e;"

# (a) another project's OWN labelled volume, mounted by a foreign container.
FX_HOLDERS="$FG_HOLD2\njobhunter_postgres_data;$FG_ORCH"
FG_MOUNT_OTHER="$(run_foreign "$FX_RENDER_TAILNET" "" 1 delete)"
expect_tn_lacks "foreign: a volume labelled for another project is not removed for being mounted" \
  "$FG_MOUNT_OTHER" 2 "jobhunter"
expect_str "foreign: mounting another project's volume does not widen the removal set" \
  "$(tn_field "$FG_MOUNT_OTHER" 2)" "$FG_ONLY2"
expect_tn "foreign: it is printed as left alone, with the label that spared it" \
  "$FG_MOUNT_OTHER" 0 3 "jobhunter_postgres_data   label project=jobhunter   (mounted by a foreign container)"
expect_tn "foreign: and why it was looked at at all is printed" \
  "$FG_MOUNT_OTHER" 0 3 "mounted by a foreign container"
expect_tn "foreign: the left-alone heading counts it" \
  "$FG_MOUNT_OTHER" 0 3 "not labelled com.docker.compose.project=nova (3)"
expect_tn "foreign: the count of foreign volumes does not include it" \
  "$FG_MOUNT_OTHER" 0 3 "Foreign volumes (2)"

# (b) the measured near-miss itself: nova_pgdata is NAMED nova_* and labelled
# project=docker (75.8 MB of his nova-ai-platform). A foreign container
# mounting it must not move it out of the spared list and into the delete
# list — which is exactly what the unfiltered mounts half did.
FX_HOLDERS="$FG_HOLD2\nnova_pgdata;$FG_ORCH"
FG_MOUNT_DECOY="$(run_foreign "$FX_RENDER_TAILNET" "" 1 delete)"
expect_tn_lacks "foreign: the measured decoy is not removed for being mounted" \
  "$FG_MOUNT_DECOY" 2 "nova_pgdata"
expect_str "foreign: mounting the decoy does not widen the removal set" \
  "$(tn_field "$FG_MOUNT_DECOY" 2)" "$FG_ONLY2"
expect_tn "foreign: a mounted decoy stays in the left-alone list, with its label" \
  "$FG_MOUNT_DECOY" 0 3 "nova_pgdata   label project=docker   (named nova_*, mounted by a foreign container)"
expect_tn "foreign: and the left-alone list still holds both decoys" \
  "$FG_MOUNT_DECOY" 0 3 "not labelled com.docker.compose.project=nova (2)"

# (c) a volume with NO project label at all, mounted by a foreign container.
# "unlabelled" is not "this project's" — the constraint says the label
# selects, and there is no label to read. It is left exactly as it is, and
# the refusal has to SAY so, because "absent from the delete list" is not
# something an operator can read off a page.
FX_VOLUMES="$FX_OLD_VOLUMES\nstray_cache;;"
FX_HOLDERS="$FG_HOLD2\nstray_cache;$FG_ORCH"
FG_MOUNT_BARE="$(run_foreign "$FX_RENDER_TAILNET" "" 1 delete)"
expect_tn_lacks "foreign: an unlabelled volume a foreign container mounts is not removed" \
  "$FG_MOUNT_BARE" 2 "stray_cache"
expect_str "foreign: mounting an unlabelled volume does not widen the removal set" \
  "$(tn_field "$FG_MOUNT_BARE" 2)" "$FG_ONLY2"
expect_tn "foreign: the unlabelled volume is named, and its missing label said out loud" \
  "$FG_MOUNT_BARE" 0 3 "stray_cache   label project=none   (mounted by a foreign container)"
expect_tn "foreign: and the refusal says what happens to a volume with no project label" \
  "$FG_MOUNT_BARE" 0 3 "names no project, so nothing here can show"
FX_VOLUMES="$FX_OLD_VOLUMES"
FX_HOLDERS="$FG_HOLD2"

# (d) the second line, tested rather than asserted. The classifier above is
# the control — the row is never written. This drives the case where one IS
# written anyway, by injecting it into the capture between the operator
# reading the list and the removal loop reading the file, and shows the
# re-derivation next to `docker volume rm` catches it. It bites only because
# that check compares the label to $project; comparing it to the project the
# capture itself recorded would agree with itself and remove the volume.
FX_HOLDERS=""
FG_FORGED="$(run_foreign "$FX_RENDER_TAILNET" "" 1 delete \
  'printf "jobhunter_postgres_data\tjobhunter\tpostgres_data\n" >> "$dir/foreign_volumes.tsv"')"
expect_tn_lacks "foreign: a capture row naming another project is refused at the removal itself" \
  "$FG_FORGED" 2 "jobhunter"
expect_tn "foreign: and the skip names the project the capture claimed" \
  "$FG_FORGED" 0 3 "the capture names it under project 'jobhunter', and this run removes 'nova'"
FX_HOLDERS="$FG_HOLD2"

# Default is to do nothing, and only the exact word proceeds.
for FG_WORD in "" y Y yes DELETE "delete " " delete" no; do
  FG_TRY="$(run_foreign "$FX_RENDER_TAILNET" "" 1 "$FG_WORD")"
  expect_str "foreign: '$FG_WORD' is not the word delete, so nothing is removed" "$(tn_field "$FG_TRY" 2)" ""
done
FG_DECLINE="$(run_foreign "$FX_RENDER_TAILNET" "" 1 no)"
expect_tn "foreign: declining says nothing was deleted" "$FG_DECLINE" 1 3 "nothing was deleted"
expect_tn "foreign: declining with a colliding service name still refuses the install" "$FG_DECLINE" 1 3 "postgres"

# port-v3 M9(c): ./install is documented idempotent and an agent or CI runs it
# with no terminal. A non-TTY run never prompts, and exits 1 ONLY when a
# foreign container's service name collides with one this file declares.
FG_NOTTY="$(run_foreign "$FX_RENDER_TAILNET" "" 0)"
expect_tn "foreign: no terminal ⇒ offers nothing" "$FG_NOTTY" 1 3 "No terminal"
expect_str "foreign: no terminal ⇒ removes nothing" "$(tn_field "$FG_NOTTY" 2)" ""
expect_tn "foreign: no terminal ⇒ prints the exact volume removal line" "$FG_NOTTY" 1 3 \
  "docker volume rm nova_postgres-data"
expect_tn "foreign: no terminal ⇒ prints the exact container removal line" "$FG_NOTTY" 1 3 \
  "docker rm 0000000000000000000000000000000000000000000000000000000000003f21"
expect_tn "foreign: no terminal ⇒ exits 1 on a service-name collision" "$FG_NOTTY" 1 3 "would adopt"

# No collision: a warning, and the install goes on. An unattended run must
# never destroy data, and it must not brick every non-interactive ./install.
FX_CONTAINERS="0000000000000000000000000000000000000000000000000000000000004b8c;nova-orchestrator-1;orchestrator;exited;$OLD_CFG"
FG_NOCOLLIDE="$(run_foreign "$FX_RENDER_TAILNET" "" 0)"
expect_tn "foreign: no terminal, no colliding service ⇒ the install continues" "$FG_NOCOLLIDE" 0 3 "orchestrator"
expect_str "foreign: no terminal, no colliding service ⇒ still removes nothing" "$(tn_field "$FG_NOCOLLIDE" 2)" ""

# python-tool M8: `docker compose down` without -v leaves volumes with no
# containers at all. Deriving the volume set from surviving containers alone
# misses them, and ruling 1 says name every volume.
FX_CONTAINERS=""
FX_HOLDERS=""
FG_ORPHAN="$(run_foreign "$FX_RENDER_TAILNET" "" 0)"
expect_tn "foreign: an orphaned volume with no container is still named" "$FG_ORPHAN" 0 3 "nova_postgres-data"
expect_tn "foreign: and its own project label with it" "$FG_ORPHAN" 0 3 "project=nova"

# shell-first M1: the one volume in the system that cannot be regenerated.
FX_VOLUMES="$FX_OLD_VOLUMES\nnova_tailscale_state;nova;tailscale_state"
FG_STATE="$(run_foreign "$FX_RENDER_TAILNET" "" 0 "" "" "nova_tailscale_state")"
expect_tn "foreign: a volume holding tailscaled.state is annotated" "$FG_STATE" 0 3 "TAILSCALE NODE IDENTITY"
expect_tn "foreign: the annotation says what deleting it costs" "$FG_STATE" 0 3 "re-authenticated"
FX_VOLUMES="$FX_OLD_VOLUMES"

# port-v3's `sibling` class, and it is measured-real: the live v4 stack was
# created from a DIFFERENT checkout's compose file than this worktree's. A
# classifier that tests only "config files equal mine" calls the whole running
# stack foreign and offers to delete it on the first run from any worktree.
FG_SIB_DIR="$(mktemp -d)"
printf '%b' 'name: nova\nservices:\n  postgres:\n    image: postgres:16\nvolumes:\n  v4_pgdata:\n  v4_memdata:\n' \
  > "$FG_SIB_DIR/docker-compose.yml"
FX_CONTAINERS="0000000000000000000000000000000000000000000000000000000000006a1b;nova-postgres-1;postgres;running;$FG_SIB_DIR/docker-compose.yml"
FX_HOLDERS=""
FG_SIBLING="$(run_foreign "$FX_RENDER_TAILNET" "" 0)"
expect_tn_lacks "foreign: a second checkout of this same stack is NOT foreign" "$FG_SIBLING" 3 "nova-postgres-1"
rm -rf "$FG_SIB_DIR"

# A container with no compose config-files label at all is foreign: nothing
# says it is ours, and "unlabelled" is not "mine".
FX_CONTAINERS="0000000000000000000000000000000000000000000000000000000000007c2d;nova-mystery-1;mystery;exited;"
FG_NOLABEL="$(run_foreign "$FX_RENDER_TAILNET" "" 0)"
expect_tn "foreign: a container with no config-files label is foreign" "$FG_NOLABEL" 0 3 "nova-mystery-1"
expect_tn "foreign: and the refusal says the label is missing" "$FG_NOLABEL" 0 3 "no compose config-files label"

# port-v3 M9(a). `docker volume rm` fails on a mounted volume, so a
# containers-first order destroys every foreign container irreversibly, then
# fails on the volumes, leaving an operator who consented to a SET with a
# partial and no rollback. Nothing is removed at all in that case.
FX_CONTAINERS="$FX_OLD_CONTAINERS"
FX_HOLDERS="nova_postgres-data;000000000000000000000000000000000000000000000000000000000000beef"
FG_HELD="$(run_foreign "$FX_RENDER_TAILNET" "" 1 delete)"
expect_tn "foreign: a captured volume held by an uncaptured container refuses" "$FG_HELD" 1 3 "beef"
expect_str "foreign: and nothing at all is removed" "$(tn_field "$FG_HELD" 2)" ""
FX_HOLDERS=""

# The capture is the whole world the removal loop can see: an object that
# appears after the operator has been shown the list cannot be removed.
FG_INJECT="$(run_foreign "$FX_RENDER_TAILNET" "" 1 delete \
  'printf "%s\n" "nova_late-data;nova;late-data" >> "$tmp/world-volumes"')"
expect_tn_lacks "foreign: an object that appeared after the capture is not removed" "$FG_INJECT" 2 "nova_late-data"

# Re-derived next to the destructive command, not trusted from the capture.
FG_RELABEL="$(run_foreign "$FX_RENDER_TAILNET" "" 1 delete \
  'sed "s/^nova_redis-data;nova;/nova_redis-data;someoneelse;/" "$tmp/world-volumes" > "$tmp/w2"; mv "$tmp/w2" "$tmp/world-volumes"')"
expect_tn_lacks "foreign: a volume whose project label changed is not removed" "$FG_RELABEL" 2 "volume rm nova_redis-data"
expect_tn "foreign: and the skip says what the label now reads" "$FG_RELABEL" 0 3 "someoneelse"
FG_RECREATE="$(run_foreign "$FX_RENDER_TAILNET" "" 1 delete \
  'sed "s/^[0-9a-f]*;nova-redis-1;/00000000000000000000000000000000000000000000000000000000cafecafe;nova-redis-1;/" "$tmp/world-containers" > "$tmp/w2"; mv "$tmp/w2" "$tmp/world-containers"')"
expect_tn_lacks "foreign: a container recreated since the capture is not removed" "$FG_RECREATE" 2 \
  "container rm 0000000000000000000000000000000000000000000000000000000000005d9e"
expect_tn "foreign: and the skip says which id is there now" "$FG_RECREATE" 0 3 "cafecafe"

# port-v3 C1's second half: the post-check must be computed from the LIVE
# listing captured at naming time, not from ours_volk — "every key in
# ours_volk still exists" is vacuous exactly when the ours-set is wrong,
# which is the only case it needed to catch.
FG_VANISH="$(run_foreign "$FX_RENDER_TAILNET" "" 1 delete \
  'grep -v "^nova_v4_memdata;" "$tmp/world-volumes" > "$tmp/w2"; mv "$tmp/w2" "$tmp/world-volumes"')"
expect_tn "foreign: a volume that vanished and was never named is a loud failure" "$FG_VANISH" 1 3 "nova_v4_memdata"
expect_tn "foreign: and it says the run did not name it" "$FG_VANISH" 1 3 "this run never named them"

# The empty-project hazard, at the seam rather than at the caller: an empty
# value in --filter label=com.docker.compose.project= matches EVERY container
# on the host.
FG_NOPROJ="$(run_foreign 'services:\n  postgres:\n    image: postgres:16\nvolumes:\n  v4_pgdata:\n    name: nova_v4_pgdata\n' \
  'services:\n  postgres:\n    image: postgres:16\nvolumes:\n  v4_pgdata:\n')"
expect_tn "foreign: no project name ⇒ refuses rather than filtering on empty" "$FG_NOPROJ" 1 3 "no project name"
expect_str "foreign: no project name ⇒ removes nothing" "$(tn_field "$FG_NOPROJ" 2)" ""
expect_str "foreign: the seam itself refuses an empty project filter" \
  "$(run_sb eval 'project_containers "" >/dev/null 2>&1; printf %s $?')" "2"
expect_str "foreign: and so does the volume seam" \
  "$(run_sb eval 'project_labelled_volumes "" >/dev/null 2>&1; printf %s $?')" "2"

# A render that fails is a refusal carrying compose's own words, not "no
# volumes found" (port-v3 m5: compose_config_text discards stderr).
FG_RENDERFAIL="$(
  (
    # shellcheck source=/dev/null
    . "$SCRIPT_DIR/install.sh"
    set +e
    compose_config_text_all_profiles() { printf 'no configuration file provided\n' > "$1"; return 1; }
    err="$(check_foreign_project 2>&1)"; code=$?
    printf '%s||%s' "$code" "$(printf '%s' "$err" | tr '\n' ' ')"
  )
)"
expect_tn "foreign: a failed render is a refusal" "$FG_RENDERFAIL" 1 3 "config failed"

# Nothing foreign on this machine: one line, no block, no offer.
FX_CONTAINERS=""
FX_VOLUMES='nova_v4_pgdata;nova;v4_pgdata\nnova_v4_memdata;nova;v4_memdata\njobhunter_postgres_data;jobhunter;postgres_data'
FG_CLEAN="$(run_foreign "$FX_RENDER_TAILNET" "" 0)"
expect_tn "foreign: nothing foreign ⇒ one line and no offer" "$FG_CLEAN" 0 3 "nothing on this machine belongs to another project"
expect_tn_lacks "foreign: nothing foreign ⇒ no refusal block" "$FG_CLEAN" 3 "REFUSED"
expect_str "foreign: nothing foreign ⇒ nothing removed" "$(tn_field "$FG_CLEAN" 2)" ""

# ── the tailnet sidecar runs THIS checkout's start.sh ───────────────────────
# Deploying PR #111 (2026-10-07): start.sh changed in git, ./install ran,
# compose saw no config change and left nova-tailscale-1 on a two-day-old
# start.sh, and install said "Nova is up". The scripts' hash now goes into
# .env and from there into a label on the service, so a script change is a
# config change. cmd_install runs for real against a real temp copy of
# deploy/tailscale; `docker` is a function that answers as compose does on
# that one point — `up` recreates the sidecar when the label's interpolated
# value differs from the running container's, and only then (measured with
# `docker compose config --hash`: same value, same hash; new value, new
# hash for tailscale alone) — and records every recreate. COMPOSE=stuck is a
# compose that never recreates: the PR #111 shape.
#   $1 world dir (persists across calls: .env, the scripts, the container)
#   $2 compose behaviour: honest | stuck
# Prints "<exit>|<.env with ;>|<combined output>|<recreates so far>".
run_ts_install() {
  (
    # shellcheck source=/dev/null
    . "$SCRIPT_DIR/install.sh"
    set +e
    W="$1"; COMPOSE="$2"
    # shellcheck disable=SC2034
    DATA_DIR="$W/data"
    # shellcheck disable=SC2034
    HARDWARE_JSON="$W/data/hardware.json"
    # shellcheck disable=SC2034
    ENV_FILE="$W/.env"
    # shellcheck disable=SC2034
    ENV_EXAMPLE="$SCRIPT_DIR/.env.example"
    # shellcheck disable=SC2034
    TAILSCALE_DIR="$W/tailscale"
    install_hub_agent() { log "HUB AGENT REACHED"; }
    tailnet_dns_name() { printf 'nova.example.ts.net'; }
    docker() {
      case "$*" in
        info) printf 'Runtimes: runc\n' ;;
        "compose version") ;;
        *" up -d --build")
          local wanted
          wanted="$(get_env_value NOVA_TAILSCALE_SCRIPTS)"
          if [ "$COMPOSE" = honest ] && [ "$wanted" != "$(cat "$W/label" 2>/dev/null)" ]; then
            printf '%s' "$wanted" > "$W/label"
            echo recreate >> "$W/recreates"
          fi ;;
        *" ps -q tailscale") printf 'tscid\n' ;;
        *" ps -q "*) printf 'cid\n' ;;
        "inspect --format {{index .Config.Labels \"nova.tailscale-scripts\"}} tscid")
          cat "$W/label" 2>/dev/null; printf '\n' ;;
        "inspect "*) printf 'healthy\n' ;;
        *) printf 'unexpected docker call: %s\n' "$*" >&2; return 1 ;;
      esac
    }
    detect_gpus_json() { printf '[]'; }
    detect_disk_free_gb() { printf '100'; }
    port_holder() { printf ''; }
    check_foreign_project() { :; }
    docker_network_ids() { :; }
    have_cmd() { [ "$1" = ip ]; }
    have_tty() { return 1; }
    ip_route_text() { printf '%s\n' '172.17.0.0/16 dev docker0 proto kernel scope link src 172.17.0.1'; }
    compose_project_name() { printf '%s' nova; }
    unset NOVA_SKIP_INFERENCE NOVA_SUBNET
    export NOVA_TAILNET=1
    out="$(cmd_install 2>&1)"; code=$?
    printf '%s|%s|%s|%s' "$code" "$(tr '\n' ';' < "$ENV_FILE")" "$(printf '%s' "$out" | tr '\n' ' ')" \
      "$(grep -c recreate "$W/recreates" 2>/dev/null || echo 0)"
  )
}
# A world whose sidecar was created from the scripts as they are now: the
# shipped scripts copied in, .env already carrying their hash, the running
# container labelled with it. Prints the world dir.
ts_world() {
  local w h
  w="$(mktemp -d)"
  mkdir -p "$w/tailscale" "$w/data"
  cp "$SCRIPT_DIR"/tailscale/*.sh "$w/tailscale/"
  h="$( . "$SCRIPT_DIR/install.sh"; TAILSCALE_DIR="$w/tailscale"; tailscale_scripts_hash )"
  { sed 's/^TS_AUTHKEY=$/TS_AUTHKEY=tskey-auth-x/' "$SCRIPT_DIR/.env.example"
    printf 'NOVA_TAILSCALE_SCRIPTS=%s\n' "$h"; } > "$w/.env"
  printf '%s' "$h" > "$w/label"
  printf '%s' "$w"
}

# Unchanged scripts: the sidecar is left alone, and install says so.
TSW="$(ts_world)"
TS_SAME="$(run_ts_install "$TSW" honest)"
expect_tn "tailnet scripts unchanged: install succeeds" "$TS_SAME" 0 3 "Nova is up"
expect_str "tailnet scripts unchanged: the sidecar is NOT recreated" "$(tn_field "$TS_SAME" 4)" 0
expect_tn "tailnet scripts unchanged: says it left the sidecar running" "$TS_SAME" 0 3 "sidecar scripts unchanged"
expect_tn_lacks "tailnet scripts unchanged: no 'changed' line" "$TS_SAME" 3 "sidecar scripts changed"

# A test file beside the scripts is not one the container runs.
printf '\n# edited\n' >> "$TSW/tailscale/start_test.sh"
TS_TESTONLY="$(run_ts_install "$TSW" honest)"
expect_str "tailnet: editing start_test.sh recreates nothing" "$(tn_field "$TS_TESTONLY" 4)" 0

# A changed start.sh: exactly one recreate, one line saying so, success.
printf '\n# a change that has to reach the running sidecar\n' >> "$TSW/tailscale/start.sh"
TS_CHANGED="$(run_ts_install "$TSW" honest)"
expect_tn "tailnet start.sh changed: install succeeds" "$TS_CHANGED" 0 3 "Nova is up"
expect_str "tailnet start.sh changed: exactly one recreate" "$(tn_field "$TS_CHANGED" 4)" 1
expect_str "tailnet start.sh changed: one log line says so" \
  "$(tn_field "$TS_CHANGED" 3 | grep -o 'sidecar scripts changed' | grep -c .)" 1
expect_str "tailnet start.sh changed: .env carries the new hash" \
  "$(env_key_value "$TS_CHANGED" 2 NOVA_TAILSCALE_SCRIPTS)" \
  "$( . "$SCRIPT_DIR/install.sh"; TAILSCALE_DIR="$TSW/tailscale"; tailscale_scripts_hash )"
expect_str "tailnet start.sh changed: still exactly one NOVA_TAILSCALE_SCRIPTS line" \
  "$(tn_field "$TS_CHANGED" 2 | tr ';' '\n' | grep -c '^NOVA_TAILSCALE_SCRIPTS=')" 1
# ...and the install after it does not recreate it again.
TS_AGAIN="$(run_ts_install "$TSW" honest)"
expect_str "tailnet: the next install leaves it alone (still one recreate in all)" "$(tn_field "$TS_AGAIN" 4)" 1
expect_tn "tailnet: the next install says unchanged" "$TS_AGAIN" 0 3 "sidecar scripts unchanged"

# serve_check.sh is the healthcheck's script, and counts the same.
printf '\n# edited\n' >> "$TSW/tailscale/serve_check.sh"
expect_str "tailnet serve_check.sh changed: one more recreate" \
  "$(tn_field "$(run_ts_install "$TSW" honest)" 4)" 2
rm -rf "$TSW"

# A first install after this change: .env has no hash yet, the container has
# no label. One recreate, and from then on the label is the repo's.
TSW="$(ts_world)"
TS_ENV_BODY="$(grep -v '^NOVA_TAILSCALE_SCRIPTS=' "$TSW/.env")"; printf '%s\n' "$TS_ENV_BODY" > "$TSW/.env"
: > "$TSW/label"
TS_FIRST="$(run_ts_install "$TSW" honest)"
expect_tn "tailnet, no hash recorded yet: install succeeds" "$TS_FIRST" 0 3 "Nova is up"
expect_str "tailnet, no hash recorded yet: exactly one recreate" "$(tn_field "$TS_FIRST" 4)" 1
rm -rf "$TSW"

# PR #111's shape: the script changed and compose did not recreate the
# sidecar. Install must fail, name it, and never say "Nova is up".
TSW="$(ts_world)"
printf '\n# changed\n' >> "$TSW/tailscale/start.sh"
TS_STUCK="$(run_ts_install "$TSW" stuck)"
expect_tn "tailnet, sidecar not recreated: install fails" "$TS_STUCK" 1 3 "not running this checkout's start.sh"
expect_tn "tailnet, sidecar not recreated: gives the command that fixes it" "$TS_STUCK" 1 3 \
  "up -d --force-recreate tailscale"
expect_tn_lacks "tailnet, sidecar not recreated: never says Nova is up" "$TS_STUCK" 3 "Nova is up"
expect_tn_lacks "tailnet, sidecar not recreated: the hub's agent is never reached" "$TS_STUCK" 3 "HUB AGENT REACHED"
# A sidecar the label cannot be read from is not one that was checked.
: > "$TSW/label"
TS_NOLABEL="$(run_ts_install "$TSW" stuck)"
expect_tn "tailnet, no label on the sidecar: install fails" "$TS_NOLABEL" 1 3 "not running this checkout's start.sh"
rm -rf "$TSW"

# No way to hash is a refusal, never an empty value that compose would
# read as "no change".
TS_NOHASH="$(
  . "$SCRIPT_DIR/install.sh"; set +e
  # shellcheck disable=SC2034
  TAILNET_ENABLED=1
  TAILSCALE_DIR="$(mktemp -d)"
  out="$( (record_tailscale_scripts) 2>&1 )"; code=$?
  rmdir "$TAILSCALE_DIR"
  printf '%s|%s' "$code" "$(printf '%s' "$out" | tr '\n' ' ')"
)"
expect_case "tailnet: no scripts to hash is a refusal" "$TS_NOHASH" 1 "could not hash the tailnet sidecar's scripts"

# Tripwires: the label install.sh reads back is the one the compose file sets
# on the tailscale service, fed from the .env key install.sh writes; the key
# is declared for the backup; and cmd_install records before `up` and
# verifies after it.
TS_LABEL_LINE="$(awk '
  /^  tailscale:$/ { f = 1; next }
  f && /^  [a-z]/ { f = 0 }
  f && /^    labels:$/ { l = 1; next }
  f && l && /^      / { print; next }
  { l = 0 }
' "$SCRIPT_DIR/docker-compose.yml" | sed 's/^ *//')"
expect_str "tripwire: the tailscale service carries the scripts label, fed from .env" \
  "$TS_LABEL_LINE" "$( . "$SCRIPT_DIR/install.sh"; printf '%s' "$TAILSCALE_SCRIPTS_LABEL"): \${NOVA_TAILSCALE_SCRIPTS:-}"
if awk '
    $0 ~ "^# nova-backup:" { d = 1; next }
    /^(# )?NOVA_TAILSCALE_SCRIPTS=/ { if (d) ok = 1 }
    { d = 0 }
    END { exit !ok }
  ' "$SCRIPT_DIR/.env.example"; then
  report 0 "tripwire: .env.example declares NOVA_TAILSCALE_SCRIPTS for the backup"
else
  report 1 "tripwire: .env.example declares NOVA_TAILSCALE_SCRIPTS for the backup" "no declared line"
fi
if awk '/^cmd_install\(\)/{f=1} f&&/^}/{exit}
        f&&/^  record_tailscale_scripts$/{r=NR} f&&/^  compose_up$/{u=NR} f&&/^  verify_tailscale_scripts$/{v=NR}
        END{exit !(r && u && v && r < u && u < v)}' "$SCRIPT_DIR/install.sh"; then
  report 0 "tailnet: cmd_install records the scripts hash before up and verifies it after"
else
  report 1 "tailnet: cmd_install records the scripts hash before up and verifies it after" "order or call missing"
fi

# ── record_repository: she is told which GitHub repository is her own ───────
# Walk finding (turn 641f312e): asked "why is CI red on main?", she spent all
# six tool rounds hunting for WHICH repository is hers. The installer runs
# from the checkout, so the checkout's own `origin` is the answer — derived,
# never typed in. A real throwaway git repo per case, real `git`, real
# set_env_value; only REPO_ROOT and ENV_FILE are pointed at a temp dir.
#   $1 origin url ("" = no origin)   $2 default branch for origin/HEAD ("" = none)
#   $3 initial .env body
# Prints "<exit>|<.env with ;>|<stderr>".
run_repo() {
  (
    # shellcheck source=/dev/null
    . "$SCRIPT_DIR/install.sh"
    set +e
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    # shellcheck disable=SC2034
    REPO_ROOT="$tmp/repo"
    # shellcheck disable=SC2034
    ENV_FILE="$tmp/.env"
    printf '%b' "${3:-}" > "$ENV_FILE"
    git init -q "$REPO_ROOT"
    if [ -n "$1" ]; then git -C "$REPO_ROOT" remote add origin "$1"; fi
    if [ -n "$2" ]; then
      git -C "$REPO_ROOT" -c user.name=t -c user.email=t@t commit -q --allow-empty -m init
      git -C "$REPO_ROOT" update-ref "refs/remotes/origin/$2" HEAD
      git -C "$REPO_ROOT" symbolic-ref refs/remotes/origin/HEAD "refs/remotes/origin/$2"
    fi
    err="$( ( set -e; record_repository ) 2>&1 )"; code=$?
    printf '%s|%s|%s' "$code" "$(tr '\n' ';' < "$ENV_FILE")" \
      "$(printf '%s' "$err" | tr '\n' ' ')"
  )
}
RP_HTTPS="$(run_repo https://github.com/jeremyspofford/nova main 'A=1\n')"
expect_tn "repo: https remote gives owner/repo" "$RP_HTTPS" 0 2 "NOVA_REPO=jeremyspofford/nova;"
expect_tn "repo: the default branch is written" "$RP_HTTPS" 0 2 "NOVA_REPO_BRANCH=main;"
expect_tn "repo: other keys untouched" "$RP_HTTPS" 0 2 "A=1;"
expect_tn "repo: says what it wrote" "$RP_HTTPS" 0 3 "jeremyspofford/nova"
expect_tn "repo: https with .git is stripped" \
  "$(run_repo https://github.com/o-1/r.x_y.git main '')" 0 2 "NOVA_REPO=o-1/r.x_y;"
RP_SSH="$(run_repo git@github.com:jeremyspofford/nova.git trunk '')"
expect_tn "repo: ssh git@github.com:o/r.git gives owner/repo" "$RP_SSH" 0 2 "NOVA_REPO=jeremyspofford/nova;"
expect_tn "repo: the branch is origin/HEAD's, not assumed main" "$RP_SSH" 0 2 "NOVA_REPO_BRANCH=trunk;"
expect_tn "repo: ssh:// form too" \
  "$(run_repo ssh://git@github.com/o/r.git main '')" 0 2 "NOVA_REPO=o/r;"
RP_NOHEAD="$(run_repo https://github.com/o/r '' '')"
expect_tn "repo: no origin/HEAD still writes the repo" "$RP_NOHEAD" 0 2 "NOVA_REPO=o/r;"
expect_tn_lacks "repo: no origin/HEAD writes no branch" "$RP_NOHEAD" 2 "NOVA_REPO_BRANCH"
RP_GITLAB="$(run_repo git@gitlab.com:o/r.git main 'A=1\n')"
expect_tn "repo: a non-GitHub remote writes nothing" "$RP_GITLAB" 0 2 "A=1;"
expect_tn_lacks "repo: a non-GitHub remote writes no NOVA_REPO" "$RP_GITLAB" 2 "NOVA_REPO"
expect_tn "repo: a non-GitHub remote says so" "$RP_GITLAB" 0 3 "not a GitHub repository"
RP_LOOKALIKE="$(run_repo https://github.com.evil.example/o/r main '')"
expect_tn_lacks "repo: a github.com look-alike host writes nothing" "$RP_LOOKALIKE" 2 "NOVA_REPO"
RP_NONE="$(run_repo '' '' 'A=1\n')"
expect_tn_lacks "repo: no origin writes nothing" "$RP_NONE" 2 "NOVA_REPO"
expect_tn "repo: no origin says so" "$RP_NONE" 0 3 "no git remote"
# A stale value from an earlier install is a guess once the remote stops
# answering for it: blanked, never left standing.
RP_STALE="$(run_repo '' '' 'NOVA_REPO=old/one\nNOVA_REPO_BRANCH=main\n')"
expect_tn "repo: a stale NOVA_REPO is blanked when there is no remote" "$RP_STALE" 0 2 "NOVA_REPO=;"
expect_tn "repo: a stale NOVA_REPO_BRANCH is blanked too" "$RP_STALE" 0 2 "NOVA_REPO_BRANCH=;"
RP_SAME="$(run_repo https://github.com/o/r main 'NOVA_REPO=o/r\nNOVA_REPO_BRANCH=main\n')"
expect_str "repo: a re-run leaves exactly one NOVA_REPO line" \
  "$(tn_field "$RP_SAME" 2 | tr ';' '\n' | grep -c '^NOVA_REPO=')" "1"
# cmd_install reaches it (delete the call and this goes red).
if awk '/^cmd_install\(\)/{f=1} f&&/^}/{exit} f&&/^  record_repository$/{found=1} END{exit !found}' \
  "$SCRIPT_DIR/install.sh"; then
  report 0 "repo: cmd_install calls record_repository"
else
  report 1 "repo: cmd_install calls record_repository" "no call in cmd_install"
fi
# Both keys are declared for the backup (an undeclared .env key refuses every
# backup by name) and handed to core by compose.
RP_MISSING=""
for RP_KEY in NOVA_REPO NOVA_REPO_BRANCH; do
  grep -q "^  *${RP_KEY}: \${${RP_KEY}:-}" "$SCRIPT_DIR/docker-compose.yml" \
    || RP_MISSING="$RP_MISSING docker-compose.yml:$RP_KEY"
  awk -v k="$RP_KEY" '
    $0 ~ "^# nova-backup:" { d = 1; next }
    $0 ~ ("^(# )?" k "=") { if (d) ok = 1 }
    { d = 0 }
    END { exit !ok }
  ' "$SCRIPT_DIR/.env.example" || RP_MISSING="$RP_MISSING .env.example:$RP_KEY"
done
if [ -z "$RP_MISSING" ]; then
  report 0 "repo: both keys are passed to core and declared in .env.example"
else
  report 1 "repo: both keys are passed to core and declared in .env.example" "missing:$RP_MISSING"
fi

# ── tripwire: the five keys decide_subnet writes have to MEAN something ─────
# It writes NOVA_SUBNET, NOVA_SUBNET_RANGE, NOVA_SUBNET_GATEWAY, NOVA_WEB_ADDR
# and NOVA_TAILSCALE_ADDR. Two of those are already read by
# docker-compose.yml; the other three are not, and until the `networks:
# default: ipam:` block reads them (design-verdict.md §10.2 — defaults are
# today's literals, so the live network does not move), a host where 172.18 is
# already taken gets a NOVA_WEB_ADDR on a network compose still pins at
# 172.18 and `up` fails with an address outside its own network.
#
# The same five have to carry a `# nova-backup:` disposition in .env.example,
# because an .env key with no declaration REFUSES every backup by name
# (design-verdict.md §6.2, shell-first m6) — and after this lands, every real
# .env has all five.
#
# This case is the line of code that refuses; it is not advice in a report.
SUB_MISSING=""
for SUB_KEY in NOVA_SUBNET NOVA_SUBNET_RANGE NOVA_SUBNET_GATEWAY; do
  grep -q "\${${SUB_KEY}:-" "$SCRIPT_DIR/docker-compose.yml" \
    || SUB_MISSING="$SUB_MISSING docker-compose.yml:\${$SUB_KEY:-…}"
done
for SUB_KEY in NOVA_SUBNET NOVA_SUBNET_RANGE NOVA_SUBNET_GATEWAY NOVA_WEB_ADDR NOVA_TAILSCALE_ADDR; do
  awk -v k="$SUB_KEY" '
    $0 ~ "^# nova-backup:" { d = 1; next }
    $0 ~ ("^" k "=") { if (d) ok = 1 }
    { if ($0 !~ "^# nova-backup:") d = 0 }
    END { exit !ok }
  ' "$SCRIPT_DIR/.env.example" || SUB_MISSING="$SUB_MISSING .env.example:$SUB_KEY"
done
if [ -z "$SUB_MISSING" ]; then
  report 0 "tripwire: every key decide_subnet writes is read by compose and declared in .env.example"
else
  report 1 "tripwire: every key decide_subnet writes is read by compose and declared in .env.example" \
    "missing:$SUB_MISSING"
fi

# ── the hub machine's own agent (S42b P23) ──────────────────────────────────
# install_hub_agent runs for real, with errexit on as ./install runs it.
# Stubbed is every seam that reaches outside: the version, the build, the
# loopback door (hub_request: one GET, answered from the case's script for
# that path — a status, a Retry-After, a body), the parser's interpreter (the
# host's python3 runs the very program install.sh hands core's Python), the
# mint, the WSL check, the sleep, the hostname and the binary itself: a
# script that records its argv and whether the one env var it may read held
# the minted code, then exits as told. sha256_of is the real one, over the
# bytes the stub door served.
#
# The pairing code is a credential, so nothing here PRINTS it, even when a
# case fails: the fake novad records env=minted (or none/other), never the
# value, and a failing case shows its output with the code masked.
#   $1 novad's first exit   $2 the build core serves   $3 WSL (0/1)
#   $4 the hostname         $5 shell run just before the call (a case's own
#                              stubs and knobs; optional)
# Prints "<exit>|<calls>|<GETs>|<novad runs>|<output>" (the output last: it
# is the one field that may hold a '|').
HA_CODE="ABCD-2345"
# The card's Windows line as core's JSON carries it (its quotes escaped), and
# as a person must see it.
HA_WINDOWS_JSON='& $f install --hub http://127.0.0.1:3000 --code {CODE}; if($LASTEXITCODE -ne 0){throw \"novad install failed (exit $LASTEXITCODE)\"}'
HA_WINDOWS_LINE='& $f install --hub http://127.0.0.1:3000 --code {CODE}; if($LASTEXITCODE -ne 0){throw "novad install failed (exit $LASTEXITCODE)"}'

# A served manifest in core's own compact shape: the signed body, the
# version beside it, the card's commands.
#   $1 the version   $2 linux-amd64's sha256   [$3 the commands JSON]
#   [$4 commands_reason JSON]
ha_manifest() {
  local cmds="${3:-}"
  [ -n "$cmds" ] || cmds="{\"linux\":\"l\",\"macos\":\"m\",\"windows\":\"$HA_WINDOWS_JSON\"}"
  printf '{"manifest":{"v":1,"version":"%s","built_at":"x","go":"go1.27.1","files":{"linux-amd64":{"name":"novad-linux-amd64","sha256":"%s","size":1},"linux-arm64":{"name":"novad-linux-arm64","sha256":"%064d","size":1}}},"sig":"x","version":"%s","commands":%s,"commands_reason":%s,"walks":{},"notes":{}}' \
    "$1" "$2" 7 "$1" "$cmds" "${4:-null}"
}

# C3: the same manifest as a re-serializer might write it — top-level keys,
# entries and each entry's keys in other orders, pretty-printed — with a
# decoy linux-amd64 object AFTER the real one (a greedy pattern over the
# text takes the last match). $1 linux-amd64's sha256.
ha_manifest_reordered() {
  printf '%s\n' \
    '{' \
    '  "sig": "x",' \
    '  "version": "aaaaaaaaaaaa",' \
    '  "manifest": {' \
    '    "files": {' \
    "      \"windows-arm64\": {\"size\": 1, \"sha256\": \"$(printf '%064d' 3)\", \"name\": \"novad-windows-arm64.exe\"}," \
    "      \"linux-arm64\": {\"sha256\": \"$(printf '%064d' 2)\", \"size\": 1, \"name\": \"novad-linux-arm64\"}," \
    "      \"linux-amd64\": {\"size\": 1, \"sha256\": \"$1\", \"name\": \"novad-linux-amd64\"}" \
    '    },' \
    '    "version": "aaaaaaaaaaaa",' \
    '    "v": 1' \
    '  },' \
    '  "commands": null,' \
    "  \"walks\": {\"linux-amd64\": {\"name\": \"novad-linux-amd64\", \"sha256\": \"$(printf '%064d' 9)\", \"size\": 1}}" \
    '}'
}

run_hub_agent() {
  (
    # shellcheck source=/dev/null
    . "$SCRIPT_DIR/install.sh"
    set +e
    HUB_T="$(mktemp -d)"
    # The run's own TMPDIR: whatever install_hub_agent leaves there is listed
    # in the calls field as LEFT:, so every exact calls check also asserts
    # that no download folder stays behind.
    mkdir "$HUB_T/tmp"
    export TMPDIR="$HUB_T/tmp"
    NOVAD_FIRST="$1"; SERVED="$2"; IN_WSL="$3"; HOST_NAME="$4"
    # The fake also reads its own environment: a variable called code or
    # minted there, or the code anywhere but NOVA_PAIRING_CODE, is a leak,
    # listed in the calls field as LEAK: — so every exact calls check asserts
    # none (J3).
    cat > "$HUB_T/fake-novad" <<EOF
#!/bin/sh
case "\${NOVA_PAIRING_CODE:-}" in
  "") env=none ;;
  "$HA_CODE") env=minted ;;
  *) env=other ;;
esac
leak=""
if env | grep -q '^code='; then leak="\$leak code"; fi
if env | grep -q '^minted='; then leak="\$leak minted"; fi
if env | grep -v '^NOVA_PAIRING_CODE=' | grep -qF '$HA_CODE'; then leak="\$leak the-code-elsewhere"; fi
if [ -n "\$leak" ]; then echo "LEAK:\$leak" >> "$HUB_T/calls"; fi
printf 'argv=%s env=%s\n' "\$*" "\$env" >> "$HUB_T/novad"
n=\$(wc -l < "$HUB_T/novad")
if [ "\$n" -eq 1 ]; then exit $NOVAD_FIRST; fi
exit 0
EOF
    HA_SUM="$(sha256_of "$HUB_T/fake-novad")"
    HA_MANIFEST="$(ha_manifest "$SERVED" "$HA_SUM")"
    # Per path, the answers in turn ("STATUS" or "STATUS:RETRY-AFTER"), the
    # last one repeating.
    HA_MANIFEST_SCRIPT=200
    HA_DIST_SCRIPT=200
    HA_DNS=""
    HA_TRACE=0
    # A Retry-After line to send as it stands on every 429 (an HTTP-date, an
    # empty value), in place of the script's STATUS:SECONDS one.
    HA_RA_LINE=""
    agent_version_of() { printf 'aaaaaaaaaaaa'; }
    build_agent_dist() { printf 'built %s\n' "$1" >> "$HUB_T/calls"; }
    hub_request() { # $1 path  $2 body file  $3 header file  $4 seconds
      local which script n i t tok status after
      printf 'GET %s\n' "$1" >> "$HUB_T/gets"
      case "$1" in
        /api/v1/agent/manifest*) which=manifest; script="$HA_MANIFEST_SCRIPT" ;;
        /api/v1/agent/dist/*) which=dist; script="$HA_DIST_SCRIPT" ;;
        *) printf '000'; return 7 ;;
      esac
      n=$(( $(cat "$HUB_T/n.$which" 2>/dev/null || echo 0) + 1 ))
      printf '%s\n' "$n" > "$HUB_T/n.$which"
      i=0; tok=""
      for t in $script; do i=$((i + 1)); tok="$t"; [ "$i" -lt "$n" ] || break; done
      status="${tok%%:*}"; after=""
      case "$tok" in *:*) after="${tok#*:}" ;; esac
      {
        printf 'HTTP/1.1 %s Stub\r\n' "$status"
        if [ -n "$HA_RA_LINE" ] && [ "$status" = 429 ]; then printf '%s\r\n' "$HA_RA_LINE"
        elif [ -n "$after" ]; then printf 'Retry-After: %s\r\n' "$after"; fi
        printf '\r\n'
      } > "$3"
      if [ "$status" = 200 ]; then
        if [ "$which" = manifest ]; then printf '%s' "$HA_MANIFEST" > "$2"; else cat "$HUB_T/fake-novad" > "$2"; fi
      else
        printf '{"error":"the stub answered %s"}' "$status" > "$2"
      fi
      printf '%s' "$status"
    }
    hub_python() { python3 "$@"; }
    hub_mint() {
      printf 'mint %s\n' "$1" >> "$HUB_T/calls"
      printf '{"code": "%s", "expires_at": "x", "repair": false}\n' "$HA_CODE"
    }
    hub_sleep() { printf 'slept %s\n' "$1" >> "$HUB_T/calls"; }
    running_in_wsl() { [ "$IN_WSL" = 1 ]; }
    hub_os_arch() { printf 'linux amd64'; }
    hub_hostname() { printf '%s' "$HOST_NAME"; }
    tailnet_dns_name() { [ -n "$HA_DNS" ] || return 1; printf '%s' "$HA_DNS"; }
    unset NOVA_HUB_AGENT_NAME NOVA_PAIRING_CODE
    if [ -n "${5:-}" ]; then eval "$5"; fi
    # `exec 2>&1` holds for the subshell's whole life, so what its EXIT trap
    # says (hub_cleanup) is captured too, not printed past the result.
    if [ "$HA_TRACE" = 1 ]; then
      err="$(exec 2>&1; set -e; set -x; install_hub_agent)"; code=$?
    else
      err="$(exec 2>&1; set -e; install_hub_agent)"; code=$?
    fi
    left="$(ls -A "$HUB_T/tmp" 2>/dev/null | tr '\n' ' ')"
    if [ -n "$left" ]; then printf 'LEFT: %s\n' "$left" >> "$HUB_T/calls"; fi
    # 2>/dev/null BEFORE the input: a file a case never wrote is "nothing
    # happened", and the shell says so on the stderr in force when it opens it.
    # The run's folder reads as <HUB_T> in the output, the same on every machine.
    printf '%s|%s|%s|%s|%s' "$code" \
      "$(tr '\n' ' ' 2>/dev/null < "$HUB_T/calls")" \
      "$(tr '\n' ' ' 2>/dev/null < "$HUB_T/gets")" \
      "$(tr '\n' ' ' 2>/dev/null < "$HUB_T/novad")" \
      "$(printf '%s' "$err" | sed "s#$HUB_T#<HUB_T>#g" | tr '\n' ' ')"
    rm -rf "$HUB_T"
  )
}

# A result fit to print: the code masked.
ha_masked() { printf '%s' "$1" | sed "s/$HA_CODE/<the minted code>/g"; }
# Field $2 of a result: 1 exit, 2 calls, 3 GETs, 4 novad runs, 5 the output.
ha_field() {
  if [ "$2" = 5 ]; then printf '%s' "$1" | cut -d'|' -f5-; else printf '%s' "$1" | cut -d'|' -f"$2"; fi
}
# $1 name  $2 result  $3 field  $4 what the field must be exactly
ha_is() {
  if [ "$(ha_field "$2" "$3")" = "$4" ]; then report 0 "$1"; else
    report 1 "$1" "field $3 is not '$4' — $(ha_masked "$2")"; fi
}
# $1 name  $2 result  $3 field  $4 what the field must hold
ha_has() {
  case "$(ha_field "$2" "$3")" in
    *"$4"*) report 0 "$1" ;;
    *) report 1 "$1" "field $3 lacks '$4' — $(ha_masked "$2")" ;;
  esac
}
ha_lacks() {
  case "$(ha_field "$2" "$3")" in
    *"$4"*) report 1 "$1" "field $3 holds '$4' — $(ha_masked "$2")" ;;
    *) report 0 "$1" ;;
  esac
}
# The minted code is nowhere in the result: not in an argv, not in a line of
# output, not in a trace.
ha_never() {
  case "$2" in
    *"$HA_CODE"*) report 1 "$1" "$(ha_masked "$2")" ;;
    *) report 0 "$1" ;;
  esac
}
# The reason ./install ENDED with: the output from the last "ERROR: " (die's
# prefix) to the end. A progress line saying 429 is not that reason — a run
# that went on past its 429s and failed on something else ends with
# something else (review a7374986a9ff4fbb4, J1). $3 is how it must begin.
ha_final() {
  local final
  final="$(ha_field "$2" 5 | sed 's/.*ERROR: /ERROR: /')"
  case "$final" in
    "$3"*) report 0 "$1" ;;
    *) report 1 "$1" "it ends: $(ha_masked "$final") — wanted it to begin: $3" ;;
  esac
}

LOOP_ARGV="argv=install --if-missing --hub http://127.0.0.1:3000 env=none "
MANIFEST_GET="GET /api/v1/agent/manifest?origin=loopback "

# The ordinary re-run: this machine's agent is installed and running.
HA_OK="$(run_hub_agent 0 aaaaaaaaaaaa 0 minipc)"
ha_is "hub agent installed and running: left alone, exit 0" "$HA_OK" 1 0
ha_is "hub agent installed and running: built first, no code minted" "$HA_OK" 2 "built aaaaaaaaaaaa "
ha_is "hub agent: the manifest (as the machine running the stack) and its build come through the loopback door" \
  "$HA_OK" 3 "${MANIFEST_GET}GET /api/v1/agent/dist/novad-linux-amd64 "
ha_is "hub agent installed and running: one run, --if-missing, nothing in its environment" "$HA_OK" 4 "$LOOP_ARGV"
ha_has "hub agent installed and running: says so" "$HA_OK" 5 "installed and running"

# Exit 3: not paired. A code named after the machine (lowercased) is minted
# and handed to the second run by environment — never argv, never output.
HA_PAIR="$(run_hub_agent 3 aaaaaaaaaaaa 0 MiniPC)"
ha_is "exit 3: pairs, exit 0" "$HA_PAIR" 1 0
ha_is "exit 3: a code named after the machine is minted" "$HA_PAIR" 2 "built aaaaaaaaaaaa mint minipc "
ha_is "exit 3: the second run gets the minted code by env, not argv" "$HA_PAIR" 4 \
  "${LOOP_ARGV}argv=install --hub http://127.0.0.1:3000 env=minted "
ha_never "exit 3: the pairing code is in no argv and no line of output" "$HA_PAIR"

# A traced run (`bash -x deploy/install.sh`) prints every assignment and
# command line. Tracing is off from the mint until the code is gone, and on
# again after it.
HA_TRACED="$(run_hub_agent 3 aaaaaaaaaaaa 0 minipc 'HA_TRACE=1')"
ha_is "set -x: still pairs" "$HA_TRACED" 1 0
ha_has "set -x: the trace was on before the code (it shows the build)" "$HA_TRACED" 5 "+ build_agent_dist aaaaaaaaaaaa"
ha_has "set -x: and on again after it (it shows the last line)" "$HA_TRACED" 5 "+ log 'Nova'"
ha_never "set -x: the pairing code is in no trace line" "$HA_TRACED"

# A NOVA_PAIRING_CODE already in ./install's own environment is not this
# run's: only the code ./install minted reaches the agent.
HA_STRAY="$(run_hub_agent 3 aaaaaaaaaaaa 0 minipc 'export NOVA_PAIRING_CODE=STRAY-CODE')"
ha_is "a stray NOVA_PAIRING_CODE reaches neither run; the minted one reaches the second" "$HA_STRAY" 4 \
  "${LOOP_ARGV}argv=install --hub http://127.0.0.1:3000 env=minted "

# J3 (review): neither the code nor the mint's answer reaches a child's
# environment. An exported code or minted stays exported under bash's
# `local`, and with `export -n` on the local alone the stray copy it shadows
# is what children get (measured under 5.2.21 and 3.2.57). The fake novad
# reads its own environment on both runs; a leak shows as LEAK: in calls.
HA_J3="$(run_hub_agent 3 aaaaaaaaaaaa 0 minipc 'export code=stray-code minted=stray-minted')"
ha_is "code and minted exported by the environment: no run sees either, stray or real" "$HA_J3" 2 \
  "built aaaaaaaaaaaa mint minipc "
ha_is "code and minted exported by the environment: the code reaches novad by NOVA_PAIRING_CODE alone" \
  "$HA_J3" 4 "${LOOP_ARGV}argv=install --hub http://127.0.0.1:3000 env=minted "
HA_J3A="$(run_hub_agent 3 aaaaaaaaaaaa 0 minipc 'set -a')"
ha_is "set -a (allexport): no run sees code or minted" "$HA_J3A" 2 "built aaaaaaaaaaaa mint minipc "
ha_is "set -a (allexport): the code reaches novad by NOVA_PAIRING_CODE alone" "$HA_J3A" 4 \
  "${LOOP_ARGV}argv=install --hub http://127.0.0.1:3000 env=minted "

# C1: never `hub`. A machine whose name resolves to it — any case, any
# padding — is refused before a code is minted, naming the word and the way.
for HA_HOST in hub HUB; do
  HA_HUB="$(run_hub_agent 3 aaaaaaaaaaaa 0 "$HA_HOST")"
  ha_is "a machine called $HA_HOST: refused" "$HA_HUB" 1 1
  ha_is "a machine called $HA_HOST: no code is minted" "$HA_HUB" 2 "built aaaaaaaaaaaa "
  ha_is "a machine called $HA_HOST: no second run" "$HA_HUB" 4 "$LOOP_ARGV"
  ha_has "a machine called $HA_HOST: names the reserved word" "$HA_HUB" 5 "cannot be named 'hub'"
  ha_has "a machine called $HA_HOST: says what to do" "$HA_HUB" 5 "NOVA_HUB_AGENT_NAME=<a name> ./install"
done
HA_HUB_ENV="$(run_hub_agent 3 aaaaaaaaaaaa 0 minipc 'export NOVA_HUB_AGENT_NAME=" Hub "')"
ha_is "NOVA_HUB_AGENT_NAME=' Hub ': refused" "$HA_HUB_ENV" 1 1
ha_is "NOVA_HUB_AGENT_NAME=' Hub ': no code is minted" "$HA_HUB_ENV" 2 "built aaaaaaaaaaaa "
HA_NAMED="$(run_hub_agent 3 aaaaaaaaaaaa 0 hub 'export NOVA_HUB_AGENT_NAME=Office-Box')"
ha_is "NOVA_HUB_AGENT_NAME names the machine (a host called hub is fine then)" "$HA_NAMED" 2 \
  "built aaaaaaaaaaaa mint office-box "
ha_is "NOVA_HUB_AGENT_NAME: pairs" "$HA_NAMED" 1 0

# The hub must serve the build agent-dist just made, or nothing is installed.
HA_OTHER="$(run_hub_agent 0 bbbbbbbbbbbb 0 minipc)"
ha_is "core serves another build: refused" "$HA_OTHER" 1 1
ha_has "core serves another build: said, naming both" "$HA_OTHER" 5 \
  "core serves a build other than aaaaaaaaaaaa, the one agent-dist just built (it serves bbbbbbbbbbbb)"
ha_is "core serves another build: nothing downloaded" "$HA_OTHER" 3 "$MANIFEST_GET"
ha_is "core serves another build: nothing run" "$HA_OTHER" 4 ""

# C4 (F9): a WSL hub installs nothing. It prints the Windows line core serves
# for the machine running the stack, and where the code comes from.
HA_WSL="$(run_hub_agent 0 aaaaaaaaaaaa 1 minipc)"
ha_is "WSL hub: exit 0" "$HA_WSL" 1 0
ha_is "WSL hub: built, nothing minted" "$HA_WSL" 2 "built aaaaaaaaaaaa "
ha_is "WSL hub: reads ?origin=loopback, downloads nothing" "$HA_WSL" 3 "$MANIFEST_GET"
ha_is "WSL hub: runs nothing" "$HA_WSL" 4 ""
ha_has "WSL hub: prints commands.windows exactly as a person must run it" "$HA_WSL" 5 "$HA_WINDOWS_LINE"
ha_has "WSL hub: says where the code comes from" "$HA_WSL" 5 "Settings → Devices → Pair a device"
ha_has "WSL hub: says where the Windows line runs" "$HA_WSL" 5 "Windows line"
HA_WSL_NONE="$(run_hub_agent 0 aaaaaaaaaaaa 1 minipc \
  'HA_MANIFEST="$(ha_manifest aaaaaaaaaaaa "$HA_SUM" null "\"no origin is known yet\"")"')"
ha_is "WSL hub, no Windows line served: refused" "$HA_WSL_NONE" 1 1
ha_has "WSL hub, no Windows line served: says why, in core's words" "$HA_WSL_NONE" 5 "no origin is known yet"

HA_FAILED="$(run_hub_agent 1 aaaaaaaaaaaa 0 minipc)"
ha_is "novad install failing: fails ./install" "$HA_FAILED" 1 1
ha_has "novad install failing: says novad's exit" "$HA_FAILED" 5 \
  "the hub's agent was not installed (novad install exited 1"
ha_has "novad install failing: and that the stack is up" "$HA_FAILED" 5 "the stack is up"

HA_SUMBAD="$(run_hub_agent 0 aaaaaaaaaaaa 0 minipc 'HA_MANIFEST="$(ha_manifest aaaaaaaaaaaa "$(printf "%064d" 1)")"')"
ha_is "a download whose sha256 is not the manifest's: refused" "$HA_SUMBAD" 1 1
ha_has "a download whose sha256 is not the manifest's: said" "$HA_SUMBAD" 5 \
  "sha256 is not the manifest's — nothing was run"
ha_is "a download whose sha256 is not the manifest's: never run" "$HA_SUMBAD" 4 ""

# C3: a real JSON parser reads the served manifest, never a pattern.
HA_ORDER="$(run_hub_agent 0 aaaaaaaaaaaa 0 minipc 'HA_MANIFEST="$(ha_manifest_reordered "$HA_SUM")"')"
ha_is "a manifest in another order and shape, a decoy after the real entry: read right" "$HA_ORDER" 1 0
ha_is "a manifest in another order and shape: the build it names is what ran" "$HA_ORDER" 4 "$LOOP_ARGV"
HA_NOENTRY="$(run_hub_agent 0 aaaaaaaaaaaa 0 minipc \
  'HA_MANIFEST="$(ha_manifest aaaaaaaaaaaa "$HA_SUM" | sed "s/\"linux-amd64\"/\"linux-amd65\"/")"')"
ha_is "a manifest with no entry for this machine: refused" "$HA_NOENTRY" 1 1
ha_has "a manifest with no entry for this machine: says which" "$HA_NOENTRY" 5 "no linux-amd64 entry"
ha_is "a manifest with no entry for this machine: nothing downloaded" "$HA_NOENTRY" 3 "$MANIFEST_GET"
HA_MISNAMED="$(run_hub_agent 0 aaaaaaaaaaaa 0 minipc \
  'HA_MANIFEST="$(ha_manifest aaaaaaaaaaaa "$HA_SUM" | sed "s/\"name\":\"novad-linux-amd64\"/\"name\":\"novad-linux-arm64\"/")"')"
ha_is "an entry that names another file: refused" "$HA_MISNAMED" 1 1
ha_has "an entry that names another file: said" "$HA_MISNAMED" 5 "is not novad-linux-amd64"
HA_NOTJSON="$(run_hub_agent 0 aaaaaaaaaaaa 0 minipc 'HA_MANIFEST="<html>gate</html>"')"
ha_is "a manifest that is not JSON: refused" "$HA_NOTJSON" 1 1
ha_has "a manifest that is not JSON: said" "$HA_NOTJSON" 5 "not JSON"
HA_NOPY="$(run_hub_agent 0 aaaaaaaaaaaa 0 minipc 'hub_python() { echo "service \"core\" is not running" >&2; return 1; }')"
ha_is "the parser cannot run: refused" "$HA_NOPY" 1 1
ha_has "the parser cannot run: in its own words" "$HA_NOPY" 5 "service \"core\" is not running"

# C2 (Task 18's ruling): a 429 is a 429 — said as one, its Retry-After
# waited (the sleep is stubbed and recorded), the ask repeated, within a
# bound on asks and on the whole wait. Never a checksum failure, never "did
# not arrive".
HA_429="$(run_hub_agent 0 aaaaaaaaaaaa 0 minipc 'HA_MANIFEST_SCRIPT="429:7 200"')"
ha_is "429 then 200 on the manifest: installs" "$HA_429" 1 0
ha_is "429 then 200 on the manifest: waits what Retry-After says, once" "$HA_429" 2 "built aaaaaaaaaaaa slept 7 "
ha_is "429 then 200 on the manifest: asks again" "$HA_429" 3 \
  "${MANIFEST_GET}${MANIFEST_GET}GET /api/v1/agent/dist/novad-linux-amd64 "
ha_has "429 then 200 on the manifest: says it was a 429" "$HA_429" 5 "429"
ha_has "429 then 200 on the manifest: and the Retry-After it waited" "$HA_429" 5 "Retry-After"
HA_429D="$(run_hub_agent 0 aaaaaaaaaaaa 0 minipc 'HA_DIST_SCRIPT="429:3 200"')"
ha_is "429 then 200 on the download: installs" "$HA_429D" 1 0
ha_is "429 then 200 on the download: waits, once" "$HA_429D" 2 "built aaaaaaaaaaaa slept 3 "
HA_429X="$(run_hub_agent 0 aaaaaaaaaaaa 0 minipc 'HUB_ASK_TRIES=3; HA_MANIFEST_SCRIPT="429:5"')"
ha_is "429 every time: gives up" "$HA_429X" 1 1
ha_is "429 every time: after HUB_ASK_TRIES asks (3 here) and the waits between" "$HA_429X" 2 \
  "built aaaaaaaaaaaa slept 5 slept 5 "
ha_final "429 every time: it ENDS with the 429, not a progress line saying one" "$HA_429X"   "ERROR: the hub's agent: core still answers 429 Too Many Requests for the agent manifest after 3 ask(s)"
ha_lacks "429 every time: never as a checksum failure" "$HA_429X" 5 "sha256"
ha_lacks "429 every time: never as unreachable" "$HA_429X" 5 "unreachable"
ha_lacks "429 every time: never as did not arrive" "$HA_429X" 5 "did not arrive"
ha_is "429 every time: nothing run" "$HA_429X" 4 ""
# The same on the DOWNLOAD, where the step after the fetch is the checksum: a
# 429 there must end as a 429 and run nothing — never fall through to "the
# download's sha256 is not the manifest's" (C2; review J1).
HA_429DX="$(run_hub_agent 0 aaaaaaaaaaaa 0 minipc 'HUB_ASK_TRIES=3; HA_DIST_SCRIPT="429:5"')"
ha_is "429 every time on the download: gives up" "$HA_429DX" 1 1
ha_is "429 every time on the download: after HUB_ASK_TRIES asks and the waits between" "$HA_429DX" 2   "built aaaaaaaaaaaa slept 5 slept 5 "
ha_final "429 every time on the download: it ENDS with the 429" "$HA_429DX"   "ERROR: the hub's agent: core still answers 429 Too Many Requests for novad-linux-amd64 after 3 ask(s)"
ha_lacks "429 every time on the download: no sha256 anywhere in the output" "$HA_429DX" 5 "sha256"
ha_is "429 every time on the download: nothing ran" "$HA_429DX" 4 ""
HA_429SUM="$(run_hub_agent 0 aaaaaaaaaaaa 0 minipc 'HUB_WAIT_MAX_S=10; HA_MANIFEST_SCRIPT="429:4"')"
ha_is "429s whose waits would pass HUB_WAIT_MAX_S: stops before the wait that would" "$HA_429SUM" 2 \
  "built aaaaaaaaaaaa slept 4 slept 4 "
ha_is "429s past the wait bound: exit 1" "$HA_429SUM" 1 1
ha_final "429s past the wait bound: it ENDS with the 429" "$HA_429SUM"   "ERROR: the hub's agent: core still answers 429 Too Many Requests for the agent manifest after 3 ask(s) and 8 s of waiting"
HA_429LONG="$(run_hub_agent 0 aaaaaaaaaaaa 0 minipc 'HA_MANIFEST_SCRIPT="429:600"')"
ha_is "a Retry-After past the bound: gives up without waiting" "$HA_429LONG" 2 "built aaaaaaaaaaaa "
ha_has "a Retry-After past the bound: says 429 and the wait asked for" "$HA_429LONG" 5 "600 s"
ha_final "a Retry-After past the bound: it ENDS with the 429" "$HA_429LONG"   "ERROR: the hub's agent: core still answers 429 Too Many Requests for the agent manifest after 1 ask(s) and 0 s of waiting, and its Retry-After asks 600 s more"
HA_429BARE="$(run_hub_agent 0 aaaaaaaaaaaa 0 minipc 'HA_MANIFEST_SCRIPT=429')"
ha_is "a 429 with no Retry-After: gives up without guessing a wait" "$HA_429BARE" 2 "built aaaaaaaaaaaa "
ha_has "a 429 with no Retry-After: says so" "$HA_429BARE" 5 "no Retry-After"
ha_final "a 429 with no Retry-After: it ENDS with the 429" "$HA_429BARE"   "ERROR: the hub's agent: core answered 429 Too Many Requests for the agent manifest, with no Retry-After to wait for"
HA_503="$(run_hub_agent 0 aaaaaaaaaaaa 0 minipc 'HA_MANIFEST_SCRIPT=503')"
ha_is "a 503: refused at once, nothing waited" "$HA_503" 2 "built aaaaaaaaaaaa "
ha_has "a 503: says core's status and words" "$HA_503" 5 "HTTP 503"
ha_has "a 503: core's words" "$HA_503" 5 "the stub answered 503"
HA_DOWN="$(run_hub_agent 0 aaaaaaaaaaaa 0 minipc 'hub_request() { printf 000; return 7; }')"
ha_is "nothing answering the loopback door: refused" "$HA_DOWN" 1 1
ha_has "nothing answering the loopback door: says curl's exit" "$HA_DOWN" 5 "curl exit 7"
# J2 (review): Retry-After is read in base 10 — "08" and "09" are 8 and 9 s,
# never bash's "value too great for base", and "010" is 10 s wherever it is
# counted — and one that is there but cannot be read is said as exactly
# that, never as no Retry-After.
HA_RA08="$(run_hub_agent 0 aaaaaaaaaaaa 0 minipc 'HA_MANIFEST_SCRIPT="429:08 200"')"
ha_is "Retry-After 08: installs" "$HA_RA08" 1 0
ha_is "Retry-After 08: waits 8 s" "$HA_RA08" 2 "built aaaaaaaaaaaa slept 8 "
HA_RA09="$(run_hub_agent 0 aaaaaaaaaaaa 0 minipc 'HA_MANIFEST_SCRIPT="429:09 200"')"
ha_is "Retry-After 09: waits 9 s" "$HA_RA09" 2 "built aaaaaaaaaaaa slept 9 "
HA_RA010="$(run_hub_agent 0 aaaaaaaaaaaa 0 minipc 'HA_MANIFEST_SCRIPT="429:010 200"')"
ha_is "Retry-After 010: waits 10 s" "$HA_RA010" 2 "built aaaaaaaaaaaa slept 10 "
HA_RA010B="$(run_hub_agent 0 aaaaaaaaaaaa 0 minipc 'HUB_WAIT_MAX_S=9; HA_MANIFEST_SCRIPT="429:010"')"
ha_is "Retry-After 010 against a 9 s bound: counted as 10, so it does not wait" "$HA_RA010B" 2 \
  "built aaaaaaaaaaaa "
ha_final "Retry-After 010 against a 9 s bound: it ENDS with the 429, asking 10 s" "$HA_RA010B" \
  "ERROR: the hub's agent: core still answers 429 Too Many Requests for the agent manifest after 1 ask(s) and 0 s of waiting, and its Retry-After asks 10 s more"
HA_RADATE="$(run_hub_agent 0 aaaaaaaaaaaa 0 minipc 'HA_MANIFEST_SCRIPT=429; HA_RA_LINE="Retry-After: Wed, 21 Oct 2015 07:28:00 GMT"')"
ha_is "an HTTP-date Retry-After: no wait is guessed" "$HA_RADATE" 2 "built aaaaaaaaaaaa "
ha_final "an HTTP-date Retry-After: it ENDS saying it could not read it, and what it was" "$HA_RADATE" \
  "ERROR: the hub's agent: core answered 429 Too Many Requests for the agent manifest, with a Retry-After it could not read (Wed, 21 Oct 2015 07:28:00 GMT)"
HA_RAEMPTY="$(run_hub_agent 0 aaaaaaaaaaaa 0 minipc 'HA_MANIFEST_SCRIPT=429; HA_RA_LINE="Retry-After: "')"
ha_is "an empty Retry-After: no wait is guessed" "$HA_RAEMPTY" 2 "built aaaaaaaaaaaa "
ha_final "an empty Retry-After: it ENDS saying it could not read it — never that there was none" "$HA_RAEMPTY" \
  "ERROR: the hub's agent: core answered 429 Too Many Requests for the agent manifest, with a Retry-After it could not read (empty)"
# retry_after_of alone, on each form: the seconds (exit 0); nothing (exit 1,
# no Retry-After); or the value as it came (exit 2, unreadable).
ra_of() { # $1 a Retry-After line ("" = none) → "<exit>:<printed>"
  (
    # shellcheck source=/dev/null
    . "$SCRIPT_DIR/install.sh"
    set +e
    f="$(mktemp)"
    { printf 'HTTP/1.1 429 Stub\r\n'; [ -z "$1" ] || printf '%s\r\n' "$1"; printf '\r\n'; } > "$f"
    out="$(retry_after_of "$f")"; rc=$?
    rm -f "$f"
    printf '%s:%s' "$rc" "$out"
  )
}
for RA_ROW in "Retry-After: 7|0:7" "Retry-After: 08|0:8" "Retry-After: 010|0:10" \
  "Retry-After: 000|0:0" "retry-after:   12  |0:12" "Retry-After: 999999|0:999999" \
  "Retry-After: 1234567|2:1234567" "Retry-After: -3|2:-3" "Retry-After: 1.5|2:1.5" \
  "Retry-After: |2:" "|1:"; do
  expect_str "retry_after_of: [${RA_ROW%%|*}] → ${RA_ROW#*|}" "$(ra_of "${RA_ROW%%|*}")" "${RA_ROW#*|}"
done
# The bounds themselves are finite and small: never waits forever.
HA_BOUNDS="$( ( . "$SCRIPT_DIR/install.sh"; printf '%s %s' "$HUB_ASK_TRIES" "$HUB_WAIT_MAX_S" ) )"
case "$HA_BOUNDS" in
  [2-9]" "[1-9][0-9] | [2-9]" "[1-5][0-9][0-9]) report 0 "the 429 bounds are finite: 2-9 asks, at most 599 s of waiting ($HA_BOUNDS)" ;;
  *) report 1 "the 429 bounds are finite: 2-9 asks, at most 599 s of waiting" "got '$HA_BOUNDS'" ;;
esac

# C5 (Task 26): the doors. ./install reaches core through the loopback door
# as itself: the real hub_request, with curl replaced by a recorder. And no
# -f, which would make a 429 curl's exit 22: a 429 said as "did not arrive".
# (No comment inside the $( ) below: bash 3.2 reads a quote in one as a quote.)
HA_CURL="$(
  (
    # shellcheck source=/dev/null
    . "$SCRIPT_DIR/install.sh"
    set +e
    t="$(mktemp -d)"
    curl() { printf '%s\n' "$@" > "$t/argv"; printf '200'; }
    hub_request "/api/v1/agent/manifest?origin=loopback" "$t/body" "$t/headers" 30 > /dev/null
    printf 'url=%s headers=%s proxy=%s fail=%s' \
      "$(grep -c '^http://127\.0\.0\.1:3000/api/v1/agent/manifest?origin=loopback$' "$t/argv")" \
      "$(grep -ciE '^(-H|--header)' "$t/argv")" \
      "$(grep -c '^--noproxy$' "$t/argv")" \
      "$(grep -cE '^(-[A-Za-z]*f[A-Za-z]*|--fail.*)$' "$t/argv")"
    rm -rf "$t"
  )
)"
expect_str "the door: the manifest is asked of http://127.0.0.1:3000, directly, with no header added and no -f" \
  "$HA_CURL" "url=1 headers=0 proxy=1 fail=0"
HA_RELAY_LINES="$(grep -niE 'cf-connecting-ip|tailscale-user-|x-forwarded-for|x-real-ip' "$SCRIPT_DIR/install.sh" \
  | grep -vE '^[0-9]+:[[:space:]]*#')"
expect_str "the door: no line of install.sh that runs sends a relay's header (Cf-Connecting-IP or the like)" \
  "$HA_RELAY_LINES" ""

# J4 (review): the real seams the cases above stub, their commands pinned.
# docker, git and uname are recorders here — functions in the subshell that
# sources the real install.sh — so a typo in any seam's command turns its
# line red, and nothing reaches the real docker.
SEAM_MINT="$(
  (
    # shellcheck source=/dev/null
    . "$SCRIPT_DIR/install.sh"
    set +e
    docker() { printf '%s\n' "$@"; }
    COMPOSE_ARGS=(-f /fixture/deploy/docker-compose.yml --profile inference)
    hub_mint office-box < /dev/null | tr '\n' ' '
  )
)"
expect_str "the real hub_mint: devices_cli mint --name, in core, through this run's compose files" \
  "$SEAM_MINT" \
  "compose -f /fixture/deploy/docker-compose.yml --profile inference exec -T core python -m app.devices_cli mint --name office-box "
SEAM_PY="$(
  (
    # shellcheck source=/dev/null
    . "$SCRIPT_DIR/install.sh"
    set +e
    docker() { printf '%s\n' "$@"; }
    COMPOSE_ARGS=(-f /fixture/deploy/docker-compose.yml)
    hub_python -c 'print(1)' version < /dev/null | tr '\n' ' '
  )
)"
expect_str "the real hub_python: core's own python, given the program and its ask" "$SEAM_PY" \
  "compose -f /fixture/deploy/docker-compose.yml exec -T core python -c print(1) version "
SEAM_BUILD="$(
  (
    # shellcheck source=/dev/null
    . "$SCRIPT_DIR/install.sh"
    set +e
    t="$(mktemp -d)"
    git() { printf '%s\n' "$@" > "$t/git"; printf 'TAR-BYTES'; }
    docker() { printf '%s\n' "$@" > "$t/docker"; cat > "$t/stdin"; }
    COMPOSE_ARGS=(-f /fixture/deploy/docker-compose.yml)
    # shellcheck disable=SC2034
    REPO_ROOT=/fixture
    build_agent_dist aaaaaaaaaaaa
    printf 'git: %s| docker: %s| piped: %s' "$(tr '\n' ' ' < "$t/git")" "$(tr '\n' ' ' < "$t/docker")" \
      "$(cat "$t/stdin")"
    rm -rf "$t"
  )
)"
expect_str "the real build_agent_dist: HEAD's apps/novad archived and piped into agent-dist" "$SEAM_BUILD" \
  "git: -C /fixture archive --format=tar HEAD apps/novad | docker: compose -f /fixture/deploy/docker-compose.yml --profile build run --rm -T agent-dist aaaaaaaaaaaa | piped: TAR-BYTES"
seam_os_arch() { # $1 what uname -s says  $2 what uname -m says → "<exit>:<printed>"
  (
    # shellcheck source=/dev/null
    . "$SCRIPT_DIR/install.sh"
    set +e
    UN_S="$1"; UN_M="$2"
    uname() { case "$1" in -s) printf '%s\n' "$UN_S" ;; -m) printf '%s\n' "$UN_M" ;; *) return 1 ;; esac; }
    out="$(hub_os_arch)"; rc=$?
    printf '%s:%s' "$rc" "$out"
  )
}
while read -r OA_S OA_M OA_WANT; do
  expect_str "the real hub_os_arch: $OA_S $OA_M → ${OA_WANT#*:}" "$(seam_os_arch "$OA_S" "$OA_M")" "$OA_WANT"
done <<'OAEOF'
Linux x86_64 0:linux amd64
Linux amd64 0:linux amd64
Linux aarch64 0:linux arm64
Linux arm64 0:linux arm64
Darwin x86_64 0:darwin amd64
Darwin amd64 0:darwin amd64
Darwin aarch64 0:darwin arm64
Darwin arm64 0:darwin arm64
FreeBSD amd64 1:
Linux riscv64 1:
OAEOF
seam_wsl() { # $1 the kernel's osrelease ("" = no such file) → wsl | not wsl
  (
    # shellcheck source=/dev/null
    . "$SCRIPT_DIR/install.sh"
    set +e
    t="$(mktemp -d)"
    if [ -n "$1" ]; then printf '%s\n' "$1" > "$t/osrelease"; fi
    # shellcheck disable=SC2034
    WSL_OSRELEASE="$t/osrelease"
    if running_in_wsl; then printf 'wsl'; else printf 'not wsl'; fi
    rm -rf "$t"
  )
}
expect_str "the real running_in_wsl: a WSL2 kernel" "$(seam_wsl 6.6.87.2-microsoft-standard-WSL2)" "wsl"
expect_str "the real running_in_wsl: a WSL1 kernel" "$(seam_wsl 4.4.0-19041-Microsoft)" "wsl"
expect_str "the real running_in_wsl: a kernel that is not WSL's" "$(seam_wsl 6.8.0-45-generic)" "not wsl"
expect_str "the real running_in_wsl: no osrelease at all (macOS)" "$(seam_wsl "")" "not wsl"

HA_TN="$(run_hub_agent 3 aaaaaaaaaaaa 0 minipc 'TAILNET_ENABLED=1; HA_DNS=nova.fake-tailnet.ts.net')"
ha_is "tailnet on: its name is the agent's second hub, the loopback door first" "$HA_TN" 4 \
  "argv=install --if-missing --hub http://127.0.0.1:3000 --hub https://nova.fake-tailnet.ts.net env=none argv=install --hub http://127.0.0.1:3000 --hub https://nova.fake-tailnet.ts.net env=minted "
HA_TN_OFF="$(run_hub_agent 0 aaaaaaaaaaaa 0 minipc 'HA_DNS=nova.fake-tailnet.ts.net')"
ha_is "tailnet off: the loopback door alone" "$HA_TN_OFF" 4 "$LOOP_ARGV"

HA_NOVER="$(run_hub_agent 0 aaaaaaaaaaaa 0 minipc 'agent_version_of() { echo "agent_version: cannot: dirty" >&2; return 1; }')"
ha_is "an unreadable version: refused" "$HA_NOVER" 1 1
ha_is "an unreadable version: nothing built" "$HA_NOVER" 2 ""
ha_has "an unreadable version: in agent_version's words" "$HA_NOVER" 5 "agent_version: cannot: dirty"
HA_NOBUILD="$(run_hub_agent 0 aaaaaaaaaaaa 0 minipc 'build_agent_dist() { return 2; }')"
ha_is "agent-dist failing: refused" "$HA_NOBUILD" 1 1
ha_is "agent-dist failing: nothing fetched" "$HA_NOBUILD" 3 ""
ha_has "agent-dist failing: names the build" "$HA_NOBUILD" 5 "agent-dist did not build aaaaaaaaaaaa"
HA_NOMINT="$(run_hub_agent 3 aaaaaaaaaaaa 0 minipc 'hub_mint() { echo "devices_cli: cannot: stub" >&2; return 1; }')"
ha_is "a mint that fails: refused" "$HA_NOMINT" 1 1
ha_is "a mint that fails: no second run" "$HA_NOMINT" 4 "$LOOP_ARGV"
ha_has "a mint that fails: in devices_cli's words" "$HA_NOMINT" 5 "devices_cli: cannot: stub"
HA_NOCODE="$(run_hub_agent 3 aaaaaaaaaaaa 0 minipc 'hub_mint() { printf "{\"expires_at\": \"x\", \"repair\": false}\n"; }')"
ha_is "a mint that prints no code: refused" "$HA_NOCODE" 1 1
ha_is "a mint that prints no code: no second run" "$HA_NOCODE" 4 "$LOOP_ARGV"
ha_has "a mint that prints no code: said" "$HA_NOCODE" 5 "the mint returned no code"

# J5 (review): a tool that fails is said, never a bare errexit. mktemp and
# chmod each end with a stated cannot; a sha256 that could not be computed is
# said as that, never as "not the manifest's" — a claim about the bytes,
# made only of a checksum that was computed.
HA_NOTMP="$(run_hub_agent 0 aaaaaaaaaaaa 0 minipc 'mktemp() { echo "mktemp: cannot create directory: Read-only file system" >&2; return 1; }')"
ha_is "mktemp failing: refused" "$HA_NOTMP" 1 1
ha_is "mktemp failing: nothing fetched" "$HA_NOTMP" 3 ""
ha_final "mktemp failing: it ENDS with a stated cannot naming mktemp and the folder" "$HA_NOTMP" \
  "ERROR: the hub's agent: cannot make a folder to download it into under <HUB_T>/tmp (mktemp failed; its words are above) — nothing was downloaded"
HA_NOCHMOD="$(run_hub_agent 0 aaaaaaaaaaaa 0 minipc 'chmod() { return 1; }')"
ha_is "chmod failing: refused, no download left behind" "$HA_NOCHMOD" 2 "built aaaaaaaaaaaa "
ha_is "chmod failing: nothing ran" "$HA_NOCHMOD" 4 ""
ha_final "chmod failing: it ENDS with a stated cannot naming chmod" "$HA_NOCHMOD" \
  "ERROR: the hub's agent: cannot make the download runnable (chmod failed; its words are above) — nothing was run"
HA_NOSUM="$(run_hub_agent 0 aaaaaaaaaaaa 0 minipc 'sha256sum() { return 127; }; shasum() { return 127; }')"
ha_is "neither sha256 tool runs: refused" "$HA_NOSUM" 1 1
ha_is "neither sha256 tool runs: nothing ran" "$HA_NOSUM" 4 ""
ha_final "neither sha256 tool runs: it ENDS saying exactly that" "$HA_NOSUM" \
  "ERROR: the hub's agent: cannot check the download: neither sha256sum nor shasum could compute its sha256 here — nothing was run"
ha_lacks "neither sha256 tool runs: never says the sha256 is not the manifest's" "$HA_NOSUM" 5 \
  "is not the manifest's"
SEAM_SUM="$(
  (
    # shellcheck source=/dev/null
    . "$SCRIPT_DIR/install.sh"
    set +e
    f="$(mktemp)"
    printf 'x' > "$f"
    # shellcheck disable=SC2123
    PATH=/nonexistent
    out="$(sha256_of "$f")"; rc=$?
    /bin/rm -f "$f"
    printf '%s:%s' "$rc" "$out"
  )
)"
expect_str "sha256_of with neither tool on PATH: non-zero, printing nothing" "$SEAM_SUM" "1:"

# J6 (review): 126 is the shell refusing to run the download. When a script
# put in the same folder is refused too, the folder is named and the way out
# given (TMPDIR); when the folder does run programs, that is said instead —
# a binary that is not this machine's gives 126 as well.
HA_NOEXEC="$(run_hub_agent 126 aaaaaaaaaaaa 0 minipc 'hub_dir_runs() { return 1; }')"
ha_is "novad exits 126 in a folder that runs nothing: refused" "$HA_NOEXEC" 1 1
ha_is "novad exits 126 in a folder that runs nothing: no download left behind" "$HA_NOEXEC" 2 \
  "built aaaaaaaaaaaa "
ha_final "novad exits 126 in a folder that runs nothing: names the folder and the TMPDIR way out" \
  "$HA_NOEXEC" \
  "ERROR: the hub's agent: <HUB_T>/tmp does not allow running programs (novad install exited 126, and a test script there was refused too, as on a noexec mount) — run ./install again with TMPDIR set to a folder that does, e.g. mkdir -p ~/.cache && TMPDIR=~/.cache ./install — the stack is up"
HA_126="$(run_hub_agent 126 aaaaaaaaaaaa 0 minipc)"
ha_final "novad exits 126 where programs do run (the real check): not blamed on the folder" "$HA_126" \
  "ERROR: the hub's agent: the download could not be run (novad install exited 126; the shell's words are above), though <HUB_T>/tmp does run programs — a test script there ran — the stack is up"
ha_is "novad exits 126 where programs do run: no download left behind" "$HA_126" 2 "built aaaaaaaaaaaa "

# The EXIT trap: a run that ends where nothing expected it to still leaves
# no download folder behind (calls would carry LEFT: otherwise).
HA_ABORT="$(run_hub_agent 0 aaaaaaaaaaaa 0 minipc 'running_in_wsl() { exit 9; }')"
ha_is "a run cut short by something unforeseen: ends as it did" "$HA_ABORT" 1 9
ha_is "a run cut short by something unforeseen: no download folder left behind" "$HA_ABORT" 2 \
  "built aaaaaaaaaaaa "

# ── install.ps1 (D20): a Windows hub is told cannot, and the one step ────────
# Its parse is CI's (pwsh). What a shell can hold it to: Windows PowerShell
# 5.1 reads a script that has no BOM in the ANSI code page, so one non-ASCII
# character prints as mojibake — the file is ASCII; and it installs nothing,
# so it never exits 0.
PS1_FILE="$SCRIPT_DIR/../install.ps1"
if [ -f "$PS1_FILE" ] && ! LC_ALL=C grep -q '[^ -~	]' "$PS1_FILE"; then
  report 0 "install.ps1: present, and ASCII (PowerShell 5.1 reads a BOM-less script as ANSI)"
else
  report 1 "install.ps1: present, and ASCII (PowerShell 5.1 reads a BOM-less script as ANSI)" \
    "$(LC_ALL=C grep -n '[^ -~	]' "$PS1_FILE" 2>&1 | head -3)"
fi
if grep -q 'cannot' "$PS1_FILE" 2>/dev/null && grep -q 'wsl --install' "$PS1_FILE" 2>/dev/null \
   && ! grep -qE 'exit[[:space:]]+0' "$PS1_FILE" 2>/dev/null; then
  report 0 "install.ps1: says cannot, gives wsl --install, never exits 0"
else
  report 1 "install.ps1: says cannot, gives wsl --install, never exits 0" "see $PS1_FILE"
fi

if [ -n "${NOT_RUN:-}" ]; then
  printf '\n%d passed, %d failed — NOT RUN: %s\n' "$PASS" "$FAIL" "$NOT_RUN"
else
  printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
fi
[ "$FAIL" -eq 0 ]
