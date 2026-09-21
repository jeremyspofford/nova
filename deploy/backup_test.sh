#!/usr/bin/env bash
# Tests for deploy/backup.sh and deploy/compose_read.sh.
#
# Same shape as deploy/install_test.sh: source the real scripts (both guard
# their entry points), stub ONLY the seams that touch the outside world
# (docker, git), hand-rolled PASS/FAIL counters, no framework.
#
# No docker, no network, no live stack, no writes outside a temp dir:
#     deploy/backup_test.sh
#
# `set -e` is deliberately OFF (install_test.sh:13 says why): a case that
# fails must not take the harness with it.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
FIXTURES="$SCRIPT_DIR/backup/fixtures"
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

# Exact string equality.
expect_str() {
  local name="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then
    report 0 "$name"
  else
    report 1 "$name" "got '$got', wanted '$want'"
  fi
}

# Substring present / absent.
expect_has() {
  local name="$1" got="$2" want="$3"
  case "$got" in
    *"$want"*) report 0 "$name" ;;
    *) report 1 "$name" "output did not contain '$want' — output: $(printf '%s' "$got" | tr '\n' ' ')" ;;
  esac
}

expect_lacks() {
  local name="$1" got="$2" want="$3"
  case "$got" in
    *"$want"*) report 1 "$name" "output contained '$want' — output: $(printf '%s' "$got" | tr '\n' ' ')" ;;
    *) report 0 "$name" ;;
  esac
}

# shellcheck source=/dev/null
. "$SCRIPT_DIR/compose_read.sh"

printf '\n── compose readers ──────────────────────────────────────────────────\n'

PROBE_YAML="$FIXTURES/probe-v5.3.0.yaml"
PROBE_JSON="$FIXTURES/probe-v5.3.0.json"
PROBE_SRC="$FIXTURES/probe-compose.yml"
PROBE_OVERLAY="$FIXTURES/probe-compose.overlay.yml"

for f in "$PROBE_YAML" "$PROBE_JSON" "$PROBE_SRC" "$PROBE_OVERLAY"; do
  [ -f "$f" ] || { printf 'FAIL missing fixture %s\n' "$f"; exit 1; }
done

# A volume's disposition and its reason, off the YAML render. The reason is a
# single-quoted scalar in the fixture ("the notes: they matter" has a colon),
# so this also pins the unquoting.
expect_str "reads_volume_disposition_from_the_yaml_render" \
  "$(cfg_volume_disposition vol_one < "$PROBE_YAML")" \
  "$(printf 'include\tthe notes: they matter')"

# A folded (`>-`) reason renders onto ONE line — measured, and the reason the
# readers can be line-based at all.
expect_str "reads_a_folded_reason_as_one_line" \
  "$(cfg_volume_disposition vol_two < "$PROBE_YAML")" \
  "$(printf 'exclude-ephemeral\ta cache declared only in the overlay.')"

# The full name is READ, never assembled from <project>_<key>.
expect_str "reads_the_full_volume_name_from_the_render" \
  "$(cfg_volume_name vol_one < "$PROBE_YAML")" "novaxprobe_vol_one"

# A long-syntax mount carries its own disposition, keyed by (service, target).
expect_str "reads_bind_disposition_from_a_long_syntax_mount" \
  "$(cfg_bind_disposition alpha /b < "$PROBE_YAML")" \
  "$(printf 'exclude-code\tfrom git')"

# The service extension for the volumes an IMAGE declares.
expect_str "reads_anon_disposition_from_a_service_extension" \
  "$(cfg_anon_disposition searxng-like /var/cache/thing < "$PROBE_YAML")" ""
expect_str "reads_anon_disposition_from_a_service_extension" \
  "$(cfg_anon_disposition alpha /var/cache/thing < "$PROBE_YAML")" \
  "$(printf 'exclude-ephemeral\ta cache; it regenerates on use.')"

# design-verdict.md §3, both halves, against the two renders of ONE source
# file. A top-level x- key survives the JSON render; a volume's, a service's
# and a long-syntax mount's do not. This is why the dispositions are read out
# of the YAML — and it is what notices the day compose starts keeping them.
expect_has "json_render_strips_nested_x_keys_so_the_reader_must_use_yaml" \
  "$(cat "$PROBE_JSON")" '"x-nova-top-level": "kept-or-not"'
expect_lacks "json_render_strips_nested_x_keys_so_the_reader_must_use_yaml" \
  "$(cat "$PROBE_JSON")" 'x-nova-backup:'
expect_lacks "json_render_strips_nested_x_keys_so_the_reader_must_use_yaml" \
  "$(cat "$PROBE_JSON")" 'x-nova-backup-anon'
expect_lacks "json_render_strips_nested_x_keys_so_the_reader_must_use_yaml" \
  "$(cat "$PROBE_JSON")" 'x-nova-backup-reason'
# ...and the YAML render keeps all four.
expect_has "yaml_render_keeps_every_nested_x_key" "$(cat "$PROBE_YAML")" 'x-nova-backup: include'
expect_has "yaml_render_keeps_every_nested_x_key" "$(cat "$PROBE_YAML")" 'x-nova-backup-anon:'
expect_has "yaml_render_keeps_every_nested_x_key" "$(cat "$PROBE_YAML")" 'x-nova-backup: exclude-code'

# shell-first C2: `vol_three` is declared and mounted by no service. Compose
# prunes it out of BOTH renders, so the declared set can only come from the
# raw text. The two halves are asserted together, because either one alone
# permits the wrong implementation.
RAW_VOLS="$(cat "$PROBE_SRC" "$PROBE_OVERLAY" | raw_volume_keys)"
expect_has "raw_volume_keys_sees_a_volume_the_render_prunes" "$RAW_VOLS" "vol_three"
expect_lacks "the_render_really_did_prune_it" "$(cat "$PROBE_YAML")" "vol_three"
expect_lacks "the_render_really_did_prune_it" "$(cat "$PROBE_JSON")" "vol_three"

# Every file in COMPOSE_FILE, not just the first: the GPU overlay makes this
# two files on any host with an NVIDIA runtime.
RAW_SVCS="$(cat "$PROBE_SRC" "$PROBE_OVERLAY" | raw_service_keys)"
expect_has "raw_service_keys_reads_every_file_in_COMPOSE_FILE" "$RAW_SVCS" "alpha"
expect_has "raw_service_keys_reads_every_file_in_COMPOSE_FILE" "$RAW_SVCS" "beta"
expect_str "raw_volume_keys_reads_every_file_in_COMPOSE_FILE" \
  "$(printf '%s' "$RAW_VOLS" | tr '\n' ' ')" "vol_one vol_three vol_two"

# A service's own `volumes:` block sits at four spaces and its entries at six;
# neither is a top-level declaration. A reader that keys on the word alone
# reports `- vol_one:/one` as a declared volume.
expect_lacks "raw_volume_keys_ignores_a_services_own_volumes_block" "$RAW_VOLS" "/one"
expect_lacks "raw_service_keys_ignores_indented_keys" "$RAW_SVCS" "image"

expect_str "reads_the_project_name_from_the_raw_text" \
  "$(cat "$PROBE_SRC" "$PROBE_OVERLAY" | raw_project_name)" "novaxprobe"
expect_str "reads_the_project_name_from_the_render" \
  "$(cfg_project_name < "$PROBE_YAML")" "novaxprobe"

expect_str "cfg_service_keys_lists_every_service_in_the_render" \
  "$(cfg_service_keys < "$PROBE_YAML" | tr '\n' ' ')" "alpha beta "

# dispositions.json is what crosses into the container, so the container needs
# no YAML parser. Shape is the contract; T3 renders it, novabundle.py reads it.
DISP="$(dispositions_json < "$PROBE_YAML")"
expect_has "dispositions_json_carries_volumes_keyed_by_compose_key" "$DISP" \
  '"vol_one": {"disposition": "include", "reason": "the notes: they matter"}'
expect_has "dispositions_json_carries_binds_keyed_by_service_and_target" "$DISP" \
  '"/b": {"disposition": "exclude-code", "reason": "from git"'
expect_has "dispositions_json_carries_anon_keyed_by_service_and_target" "$DISP" \
  '"/var/cache/thing": {"disposition": "exclude-ephemeral", "reason": "a cache; it regenerates on use."}'
# ── the raw file, not a capture of it ───────────────────────────────────────
#
# Every assertion above reads a RENDER. A render is a capture, so on its own it
# says nothing about the file a human edits: deleting a disposition from
# deploy/docker-compose.yml and leaving the capture alone left this whole suite
# green while the next real backup refused. raw_dispositions reads the file
# itself, and this compares the two SETS — which is also what notices a fixture
# nobody refreshed.
render_rows() {
  local text svc key line
  text="$(cat)"
  for key in $(printf '%s' "$text" | cfg_volume_keys); do
    line="$(printf '%s' "$text" | cfg_volume_disposition "$key")"
    printf 'volume		%s	%s	%s
' "$key" "${line%%	*}" \
      "$([ -n "${line#*	}" ] && [ -n "$line" ] && printf yes || printf no)"
  done
  for svc in $(printf '%s' "$text" | cfg_service_keys); do
    printf '%s' "$text" | cfg_mounts "$svc" |
      awk -F'	' -v s="$svc" '$1 == "bind" { printf "bind\t%s\t%s\t%s\t%s\n", s, $3, $5, ($6 == "" ? "no" : "yes") }'
    printf '%s' "$text" | cfg_anon "$svc" |
      awk -F'	' -v s="$svc" '{ printf "anon\t%s\t%s\t%s\t%s\n", s, $1, $2, ($3 == "" ? "no" : "yes") }'
  done
}

expect_str "the_real_compose_file_and_the_checked_in_render_declare_the_same_rows" \
  "$(raw_dispositions < "$SCRIPT_DIR/docker-compose.yml" | sort)" \
  "$(render_rows < "$FIXTURES/compose-v5.3.0.yaml" | sort)"

RAW_DISP="$(raw_dispositions < "$SCRIPT_DIR/docker-compose.yml")"
expect_has "raw_dispositions_reads_a_volumes_row_from_the_file" "$RAW_DISP" \
  "$(printf 'volume		v4_memdata	include	yes')"
expect_has "raw_dispositions_reads_a_long_syntax_binds_row_from_the_file" "$RAW_DISP" \
  "$(printf 'bind	searxng	/etc/searxng	exclude-code	yes')"
expect_has "raw_dispositions_reads_an_anon_row_from_the_file" "$RAW_DISP" \
  "$(printf 'anon	searxng	/var/cache/searxng	exclude-ephemeral	yes')"
# A short-syntax volume mount cannot carry a disposition and must not be
# reported as a bind that is missing one.
expect_lacks "raw_dispositions_ignores_a_short_syntax_mount" "$RAW_DISP" \
  "$(printf 'bind	postgres	/var/lib/postgresql/data')"

expect_has "dispositions_json_is_parseable" \
  "$(printf '%s' "$DISP" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(sorted(d))')" \
  "['anon', 'binds', 'volumes']"

printf '\n── coverage: the renderers, and what novabundle.py does with them ──────\n'

# The seam this block exists for: the FACTS the shipped renderers write are
# the facts coverage reads. The python suite drives coverage() with fact dicts
# it builds itself; only this block proves the shell writes those shapes.
#
# No docker, no network, no live stack. `bk_docker` is a shell function, so a
# stub replaces it without a binary anywhere on PATH; `bk_git` delegates to
# the REAL git inside a throwaway repository built in a temp dir, because the
# trailing-slash behaviour is the thing being pinned and a stubbed git would
# pin the stub.

if ! command -v python3 >/dev/null 2>&1; then
  report 1 "coverage block" "no python3 on PATH — novabundle.py cannot be run, so this
     block would pass vacuously. It fails instead."
  printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
  exit 1
fi

# shellcheck source=/dev/null
. "$SCRIPT_DIR/backup.sh"

WORLD="$(mktemp -d "${TMPDIR:-/tmp}/nova-backup-test.XXXXXX")"
trap 'rm -rf "$WORLD"' EXIT

# A throwaway checkout that looks like this one to the git scan: the same
# deploy/ layout, the same two .gitignore lines that matter, and REAL git.
build_world() {
  rm -rf "$WORLD/repo"
  mkdir -p "$WORLD/repo/deploy/postgres-init" "$WORLD/repo/deploy/tailscale" \
    "$WORLD/repo/searxng" "$WORLD/repo/data"
  printf 'data/\n.env\n' > "$WORLD/repo/.gitignore"
  cp "$SCRIPT_DIR/docker-compose.yml" "$WORLD/repo/deploy/docker-compose.yml"
  cp "$SCRIPT_DIR/.env.example" "$WORLD/repo/deploy/.env.example"
  printf 'x\n' > "$WORLD/repo/deploy/postgres-init/01-databases.sql"
  printf 'x\n' > "$WORLD/repo/deploy/tailscale/start.sh"
  printf 'x\n' > "$WORLD/repo/searxng/settings.yml"
  printf 'hardware\n' > "$WORLD/repo/data/hardware.json"
  # The one file nothing can regenerate. KEY NAMES are all the renderer reads;
  # the values here are throwaway and never leave this temp dir.
  for k in POSTGRES_PASSWORD CORE_TOKEN CORE_GATEWAY_TOKEN CORE_MEMORY_TOKEN \
    SEARXNG_SECRET COMPOSE_FILE INSTANCE_SECRET; do
    printf '%s=throwaway\n' "$k"
  done > "$WORLD/repo/deploy/.env"
  ( cd "$WORLD/repo" && git init -q . && git add -A . && \
    git -c user.email=t@t -c user.name=t commit -qm fixtures ) >/dev/null 2>&1
  # The captured containers fixture, one file per id, so the docker stub can
  # answer `inspect` without a JSON parser in the shell.
  mkdir -p "$WORLD/containers"
  python3 - "$FIXTURES/$CONTAINERS_FIXTURE" "$WORLD" "$WORLD/repo" <<'PY'
import json, sys
src, world, root = sys.argv[1], sys.argv[2], sys.argv[3]
fact = json.load(open(src, encoding="utf-8"))
ids = []
for c in fact["containers"]:
    c = json.loads(json.dumps(c).replace("/repo", root))
    ids.append(c["id"])
    with open(f"{world}/containers/{c['id']}.json", "w", encoding="utf-8") as fh:
        json.dump(c, fh)
open(f"{world}/ids.txt", "w", encoding="utf-8").write("\n".join(ids) + "\n")
PY
}

# Every docker call the renderers make, answered from the checked-in captures
# with /repo rewritten to this world's root.
stub_docker() {
  case "$1" in
    compose)
      [ -n "$STUB_COMPOSE_STDERR" ] && printf '%s\n' "$STUB_COMPOSE_STDERR" >&2
      [ -n "$STUB_COMPOSE_EMPTY" ] && return 0
      case " $* " in
        *" --format json "*) sed "s|/repo|$WORLD/repo|g" "$FIXTURES/compose-v5.3.0.json" ;;
        *)
          if [ -n "$STUB_COMPOSE_SED" ]; then
            sed -e "s|/repo|$WORLD/repo|g" -e "$STUB_COMPOSE_SED" "$FIXTURES/compose-v5.3.0.yaml"
          else
            sed "s|/repo|$WORLD/repo|g" "$FIXTURES/compose-v5.3.0.yaml"
          fi
          ;;
      esac
      return "$STUB_COMPOSE_RC"
      ;;
    ps) cat "$WORLD/ids.txt"; return 0 ;;
    inspect)
      case " $* " in
        *'{{.Image}}'*) printf 'sha256:0000000000000000000000000000000000000000000000000000000000000000\n' ;;
        *) cat "$WORLD/containers/$2.json" ;;
      esac
      return 0
      ;;
    volume) return 0 ;;
    run) return 0 ;;
    exec) printf '%s\n' "$STUB_DATABASES"; return 0 ;;
  esac
  return 0
}

GIT_LOG=""
stub_git() {
  printf '%s\n' "$*" >> "$GIT_LOG"
  git "$@"
}

# Render every fact in this world and run coverage over it. Prints
# "<exit>|<stderr as one line>".
run_coverage() {
  (
    cd "$WORLD/repo" || exit 9
    bk_docker() { stub_docker "$@"; }
    bk_git() { stub_git "$@"; }
    BK_COMPOSE_FILES="$WORLD/repo/deploy/docker-compose.yml"
    BK_ENV_FILE="$WORLD/repo/deploy/.env"
    BK_ENV_EXAMPLE="$WORLD/repo/deploy/.env.example"
    export BK_COMPOSE_FILES BK_ENV_FILE BK_ENV_EXAMPLE
    rm -rf "$WORLD/stage"
    mkdir -p "$WORLD/stage/facts"
    err="$(render_facts "$WORLD/stage" "${1:-routine}" 2>&1)" || {
      printf '%s|%s' 9 "$(printf '%s' "$err" | tr '\n' ' ')"
      exit 0
    }
    out="$(python3 "$SCRIPT_DIR/backup/novabundle.py" coverage \
      --facts "$WORLD/stage/facts" --mode "${1:-routine}" 2>&1)"
    printf '%s|%s' "$?" "$(printf '%s' "$out" | tr '\n' ' ')"
  )
}

expect_cov() {
  local name="$1" out="$2" want_code="$3" want_text="${4:-}"
  local code="${out%%|*}" text="${out#*|}"
  if [ "$code" != "$want_code" ]; then
    report 1 "$name" "exit $code, wanted $want_code — $text"
    return
  fi
  if [ -n "$want_text" ]; then
    case "$text" in
      *"$want_text"*) report 0 "$name" ;;
      *) report 1 "$name" "output did not mention '$want_text' — $text" ;;
    esac
  else
    report 0 "$name"
  fi
}

CONTAINERS_FIXTURE="containers-v4.json"
STUB_COMPOSE_RC=0
STUB_COMPOSE_SED=""
STUB_COMPOSE_EMPTY=""
STUB_COMPOSE_STDERR=""
STUB_DATABASES="nova_core|core
nova_gateway|gateway
nova_memory|memory"
GIT_LOG="$WORLD/git.log"
build_world

# The headline: the real renderers, the real readers, the real compose file,
# and coverage says yes.
CLEAN="$(run_coverage routine)"
expect_cov "the_rendered_facts_of_this_compose_file_cover_themselves" "$CLEAN" 0 '"may_backup": true'
expect_cov "the_plan_names_the_volume_it_will_carry" "$CLEAN" 0 '"name": "v4_memdata"'
expect_cov "the_plan_names_the_anonymous_volume_only_docker_can_see" "$CLEAN" 0 '"kind": "anon"'

# port-v3 §4.5's bug, which would make every v4 backup refuse on day one.
# Asserted on the RECORDED ARGV, not on the outcome: an outcome can be right
# for the wrong reason.
if grep -q 'check-ignore -q data/' "$GIT_LOG"; then
  report 0 "git_check_ignore_is_probed_with_a_trailing_slash"
else
  report 1 "git_check_ignore_is_probed_with_a_trailing_slash" \
    "no `git check-ignore -q data/` in the recorded argv: $(tr '\n' ' ' < "$GIT_LOG")"
fi
if grep -q 'check-ignore -q data$' "$GIT_LOG"; then
  report 1 "the_bare_form_is_never_used_for_a_directory" "probed `data` without the slash"
else
  report 0 "the_bare_form_is_never_used_for_a_directory"
fi

# DoD 6: proven by adding a volume to the file, not by argument.
cp "$SCRIPT_DIR/docker-compose.yml" "$WORLD/repo/deploy/docker-compose.yml"
printf '  v4_vectors:\n' >> "$WORLD/repo/deploy/docker-compose.yml"
UNDECLARED="$(run_coverage routine)"
expect_cov "refuses_an_undeclared_volume" "$UNDECLARED" 3 "R2_UNCLASSIFIED"
expect_cov "refuses_an_undeclared_volume_by_name" "$UNDECLARED" 3 "volume v4_vectors"
expect_cov "and_says_it_is_mounted_by_no_service" "$UNDECLARED" 3 "mounted by no service"
expect_cov "and_names_the_file_to_edit" "$UNDECLARED" 3 "docker-compose.yml"
# A PRUNED volume's fix is not "add a disposition" — it cannot have one that
# any render would show. The fix it prints is the one that is actually open.
expect_cov "and_the_fix_it_offers_is_the_one_that_works" "$UNDECLARED" 3 \
  "mount it from the service that owns it, or delete the declaration"
expect_cov "and_says_no_bundle_was_written" "$UNDECLARED" 3 "No bundle was written."
expect_cov "and_says_nothing_was_stopped" "$UNDECLARED" 3 "Nothing was stopped, dumped or written."
build_world

# The declared set is the raw text's: the render the stub returns is the
# UNCHANGED capture, so the only way v4_vectors can be seen at all is that
# raw.json read the file.
grep -q 'v4_vectors' "$FIXTURES/compose-v5.3.0.yaml" && \
  report 1 "the_render_used_above_never_mentioned_the_new_volume" "the fixture carries it" || \
  report 0 "the_render_used_above_never_mentioned_the_new_volume"

# A renderer that fails takes the run with it and carries its stderr — the
# whole point of not writing `2>/dev/null` anywhere on this path.
STUB_COMPOSE_RC=1
STUB_COMPOSE_STDERR="could not find /nowhere/docker-compose.yml"
FACTFAIL="$(run_coverage routine)"
expect_cov "refuses_when_a_fact_renderer_fails" "$FACTFAIL" 9 "Error:"
expect_cov "refuses_when_a_fact_renderer_fails_and_names_the_command" "$FACTFAIL" 9 \
  "docker compose --profile '*' config"
expect_cov "refuses_when_a_fact_renderer_fails_and_prints_its_stderr" "$FACTFAIL" 9 \
  "could not find /nowhere/docker-compose.yml"
STUB_COMPOSE_RC=0
STUB_COMPOSE_STDERR=""

# Nothing is selected by name, so everything downstream is selected by the
# project LABEL — and a render with no `name:` leaves nothing to select by.
# The refusal has to say that, not fail three functions later with an empty
# filter that silently matches every container on the host.
STUB_COMPOSE_SED='/^name: /d'
STUB_COMPOSE_STDERR="compose said why"
NONAME="$(run_coverage routine)"
expect_cov "refuses_a_render_with_no_project_name" "$NONAME" 9 "no top-level"
expect_cov "and_carries_the_reason_compose_gave" "$NONAME" 9 "compose said why"
STUB_COMPOSE_SED=""
STUB_COMPOSE_STDERR=""

# A renderer that exits 0 and produces NOTHING is a reading that failed.
# Before this, deleting bk_verify_fact's whole empty branch cost nothing in
# either suite.
STUB_COMPOSE_EMPTY=1
EMPTYFACT="$(run_coverage routine)"
expect_cov "an_empty_but_successful_fact_is_a_failure" "$EMPTYFACT" 9 "produced nothing"
expect_cov "and_says_an_empty_fact_is_not_nothing_to_carry" "$EMPTYFACT" 9 \
  "An empty fact is a reading that failed"
STUB_COMPOSE_EMPTY=""


# R7: an empty database list is a reading that failed, not a stack with
# nothing in it.
STUB_DATABASES=""
NODB="$(run_coverage routine)"
expect_cov "refuses_when_the_database_list_is_empty" "$NODB" 3 "R7_NO_DATABASES"
STUB_DATABASES="nova_core|core"

# .env: an undeclared key refuses; only `carry` travels.
printf 'SOME_NEW_KEY=x\n' >> "$WORLD/repo/deploy/.env"
NEWKEY="$(run_coverage routine)"
expect_cov "env_refuses_an_undeclared_key" "$NEWKEY" 3 ".env key SOME_NEW_KEY"
expect_cov "env_refusal_names_the_file_to_declare_it_in" "$NEWKEY" 3 ".env.example"
build_world

CARRIED="$(run_coverage routine)"
expect_cov "env_carries_the_generated_secrets" "$CARRIED" 0 '"POSTGRES_PASSWORD"'
case "${CARRIED#*|}" in
  *'"name": "COMPOSE_FILE", "disposition": "carry"'* | *'"name": "INSTANCE_SECRET", "disposition": "carry"'*)
    report 1 "env_carries_only_the_carry_disposition" "a host/drop key was marked carry" ;;
  *) report 0 "env_carries_only_the_carry_disposition" ;;
esac

# The mode overlay, end to end.
MOVE="$(run_coverage move)"
expect_cov "carries_v4_tailscale_only_in_move_mode" "$MOVE" 0 'this run is `--move`'
case "${CLEAN#*|}" in
  *'--move'*) report 1 "a_routine_run_leaves_the_node_identity_behind" "routine carried it" ;;
  *) report 0 "a_routine_run_leaves_the_node_identity_behind" ;;
esac

# The same machine's other truth: v3's stopped containers still carry the
# `nova` project label, so a backup HERE has state under its own label that
# this compose file cannot account for. Real capture, not an invented fixture.
CONTAINERS_FIXTURE="containers-foreign-v4.json"
build_world
FOREIGN="$(run_coverage routine)"
expect_cov "refuses_a_live_mount_compose_does_not_name" "$FOREIGN" 3 "R4_UNDECLARED_LIVE_MOUNT"
expect_cov "and_names_the_compose_file_that_container_came_from" "$FOREIGN" 3 "config_files"
CONTAINERS_FIXTURE="containers-v4.json"
build_world

# ── reachability is per include-class SOURCE, not per volume ───────────────
#
# carried_entries() returns any entry whose disposition is `include`, whatever
# kind it is. Before this, only named volumes and git-scanned host paths were
# probed, so declaring a BIND or an anonymous volume as state to carry put it
# in the bundle with nothing having proved this host can read it.

# bk_anon_mounts is the only thing that can name an anonymous volume: it has
# no compose key, and the 64-hex name lives only in `docker inspect` output.
ANON="$(cd "$WORLD/repo" && bk_docker() { stub_docker "$@"; }; bk_git() { stub_git "$@"; }; \
  BK_COMPOSE_FILES="$WORLD/repo/deploy/docker-compose.yml" \
  BK_ENV_FILE="$WORLD/repo/deploy/.env" BK_ENV_EXAMPLE="$WORLD/repo/deploy/.env.example" \
  render_containers "$WORLD/stage" >/dev/null 2>&1; bk_anon_mounts "$WORLD/stage")"
expect_has "bk_anon_mounts_finds_the_image_declared_volume" "$ANON" "searxng"
expect_has "bk_anon_mounts_reports_its_destination" "$ANON" "/var/cache/searxng"
case "$ANON" in
  *[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]*)
    report 0 "bk_anon_mounts_reports_the_64_hex_name_a_probe_can_address" ;;
  *) report 1 "bk_anon_mounts_reports_the_64_hex_name_a_probe_can_address" "$ANON" ;;
esac

# Declare the gateway's ../data bind as state to carry. Before the fix the run
# passed with the bind in the carried set and nothing in reachable.files.
STUB_COMPOSE_SED='s/x-nova-backup: exclude-derived/x-nova-backup: include/'
BINDINC="$(run_coverage routine)"
expect_cov "an_include_class_bind_is_carried_only_after_a_probe" "$BINDINC" 0 '"kind": "bind"'
if grep -q "$WORLD/repo/data\": {\"exists\": true, \"ok\": true" "$WORLD/stage/facts/reachable.json"; then
  report 0 "render_reachable_probes_an_include_class_bind_source"
else
  report 1 "render_reachable_probes_an_include_class_bind_source" \
    "$(tr -d '\n' < "$WORLD/stage/facts/reachable.json")"
fi

# ...and when the source is not there, the run refuses rather than tarring a
# path nothing proved readable.
rm -rf "$WORLD/repo/data"
GONE="$(run_coverage routine)"
expect_cov "refuses_an_include_class_bind_this_host_cannot_read" "$GONE" 3 "R6_UNREACHABLE"
expect_cov "and_names_the_bind_and_its_service" "$GONE" 3 "service \`gateway\`"
STUB_COMPOSE_SED=""
build_world

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
