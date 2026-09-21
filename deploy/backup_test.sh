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
SKIP=0

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

# shell-first C2: `vol_three` is declared and mounted by no service, and
# compose prunes it out of BOTH renders — which is the whole reason the
# declared set is read from the raw TEXT and never from a render.
#
# Only this half is a shell case now. Since 2026-09-21 (s41/rulings.md) the
# raw text is parsed by novabundle.py with PyYAML rather than by awk here, so
# the other half — that the reader sees `vol_three` in this same probe pair —
# is deploy/backup/tests/test_raw_compose.py's
# `test_a_volume_no_service_mounts_is_still_declared`, over these same two
# fixture files. Both halves still exist; one of them moved to where the
# parser went.
expect_has "the_probe_pair_really_declares_the_volume_nothing_mounts" \
  "$(cat "$PROBE_SRC")" "vol_three:"
expect_lacks "the_render_really_did_prune_it" "$(cat "$PROBE_YAML")" "vol_three"
expect_lacks "the_render_really_did_prune_it" "$(cat "$PROBE_JSON")" "vol_three"

expect_str "reads_the_project_name_from_the_render" \
  "$(cfg_project_name < "$PROBE_YAML")" "novaxprobe"

expect_str "cfg_service_keys_lists_every_service_in_the_render" \
  "$(cfg_service_keys < "$PROBE_YAML" | tr '\n' ' ')" "alpha beta "

# dispositions.json is what crosses into the container, already reduced to
# JSON. Shape is the contract; T3 renders it, novabundle.py reads it.
DISP="$(dispositions_json < "$PROBE_YAML")"
expect_has "dispositions_json_carries_volumes_keyed_by_compose_key" "$DISP" \
  '"vol_one": {"disposition": "include", "reason": "the notes: they matter"}'
expect_has "dispositions_json_carries_binds_keyed_by_service_and_target" "$DISP" \
  '"/b": {"disposition": "exclude-code", "reason": "from git"'
expect_has "dispositions_json_carries_anon_keyed_by_service_and_target" "$DISP" \
  '"/var/cache/thing": {"disposition": "exclude-ephemeral", "reason": "a cache; it regenerates on use."}'
# ── the raw file, not a capture of it ───────────────────────────────────────
#
# Every assertion above reads a RENDER, and a render is a capture: deleting a
# disposition from deploy/docker-compose.yml and leaving the capture alone left
# this whole suite green while the next real backup refused. The reading that
# looks at the file a human edits, and the two-direction set comparison that
# is also what notices a fixture nobody refreshed, are now in
# deploy/backup/tests/test_policy.py — `test_the_render_declares_exactly_what_
# the_file_declares`, whose raw half is novabundle.py's parser and whose
# rendered half is still the cfg_* readers above.
#
# They are there and not here because the raw parse moved into the pack
# container on 2026-09-21 (s41/rulings.md): four fix rounds found six real
# binds the awk reader did not see, each in a different place. Nothing in the
# shell parses compose YAML any more; `render_raw` stages its bytes, and the
# cases for THAT are in the coverage block below.

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

# novabundle.py parses the staged compose text with PyYAML (s41/rulings.md,
# 2026-09-21: the raw parse moved off awk and into the container, where the
# core image carries PyYAML through uvicorn[standard]). Out here it needs an
# interpreter that has it. Tried in order, and if NEITHER can import yaml this
# block FAILS — a coverage block that quietly does not run is a green suite
# that proved nothing.
NOVA_PY=""
if command -v python3 >/dev/null 2>&1 && python3 -c 'import yaml' >/dev/null 2>&1; then
  NOVA_PY="python3"
elif command -v uv >/dev/null 2>&1 &&
  uv run --project "$SCRIPT_DIR/backup" python -c 'import yaml' >/dev/null 2>&1; then
  NOVA_PY="uv"
fi
if [ -z "$NOVA_PY" ]; then
  report 1 "coverage block" "no interpreter here can import yaml — novabundle.py cannot
     be run, so this block would pass vacuously. It fails instead. Install PyYAML for
     python3, or uv (\`uv run --project deploy/backup pytest\` is what CI uses)."
  printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
  exit 1
fi

# The one place this suite runs novabundle.py.
nova_py() {
  case "$NOVA_PY" in
    uv) uv run --project "$SCRIPT_DIR/backup" python "$@" ;;
    *) python3 "$@" ;;
  esac
}

# ── the raw file, not a capture of it ───────────────────────────────────────
#
# Every disposition assertion above reads a RENDER, and a render is a capture:
# deleting a row from deploy/docker-compose.yml and leaving the capture alone
# left this whole suite green while the next real backup refused R2. This
# compares the two SETS, which is also what notices a fixture nobody refreshed
# — there is no independent hash or mtime check anywhere.
#
# The raw half is the SHIPPED parser, driven the way deploy/backup/tests/
# conftest.py drives the shell readers: through the real module, never a
# second copy of it. It is no longer awk (s41/rulings.md 2026-09-21), but it
# is still compared HERE as well as in test_policy.py, because one suite
# holding the only fixture-freshness tripwire is one place to forget.
raw_rows() {
  nova_py - "$SCRIPT_DIR/backup" "$1" <<'RAWROWS'
import sys

sys.path.insert(0, sys.argv[1])
from novabundle import raw_compose_rows

with open(sys.argv[2], encoding="utf-8") as fh:
    for row in raw_compose_rows(fh.read(), sys.argv[2]):
        print(
            "\t".join(
                [
                    row["kind"],
                    row["service"],
                    row["name"],
                    row["disposition"],
                    "yes" if row["reason"] else "no",
                ]
            )
        )
RAWROWS
}

# The same rows, as the checked-in render shows them.
render_rows() {
  local text svc key line
  text="$(cat)"
  for key in $(printf '%s' "$text" | cfg_volume_keys); do
    line="$(printf '%s' "$text" | cfg_volume_disposition "$key")"
    printf 'volume\t\t%s\t%s\t%s\n' "$key" "${line%%	*}" \
      "$([ -n "${line#*	}" ] && [ -n "$line" ] && printf yes || printf no)"
  done
  for svc in $(printf '%s' "$text" | cfg_service_keys); do
    printf '%s' "$text" | cfg_mounts "$svc" |
      awk -F'\t' -v s="$svc" '$1 == "bind" { printf "bind\t%s\t%s\t%s\t%s\n", s, $3, $5, ($6 == "" ? "no" : "yes") }'
    printf '%s' "$text" | cfg_anon "$svc" |
      awk -F'\t' -v s="$svc" '{ printf "anon\t%s\t%s\t%s\t%s\n", s, $1, $2, ($3 == "" ? "no" : "yes") }'
  done
}

# `interp` and `unreadable` rows are left out of the SET comparison — the
# first is a mount whose kind only the render can settle, the second is a
# stated cannot — and asserted to be absent immediately below, so leaving them
# out of the equality drops nothing.
expect_str "the_real_compose_file_and_the_checked_in_render_declare_the_same_rows" \
  "$(raw_rows "$SCRIPT_DIR/docker-compose.yml" |
     awk -F'\t' '$1 == "volume" || $1 == "bind" || $1 == "anon"' | sort)" \
  "$(render_rows < "$FIXTURES/compose-v5.3.0.yaml" | sort)"

expect_str "the_real_compose_file_uses_no_form_the_parser_cannot_read" \
  "$(raw_rows "$SCRIPT_DIR/docker-compose.yml" | awk -F'	' '$1 == "unreadable"')" ""

# shellcheck source=/dev/null
. "$SCRIPT_DIR/backup.sh"
# deploy/subnet.sh, for real: §9.3 step 3 has the drill pick its own /16 with
# pick_project_subnet, and a stub of that would be a test of the stub. It
# defines functions only and runs nothing; `log`, `die` and `docker` are the
# caller's, and the restore block below supplies all three.
# shellcheck source=/dev/null
. "$SCRIPT_DIR/subnet.sh"

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
  cp "$WORLD/repo/deploy/.env" "$WORLD/env.pristine"
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
    out="$(nova_py "$SCRIPT_DIR/backup/novabundle.py" coverage \
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

# ── the raw text is STAGED here, and parsed in the container ────────────────
#
# s41/rulings.md 2026-09-21: the declared set still comes from the RAW TEXT —
# compose prunes a volume no rendered service mounts out of every render — but
# the parse is PyYAML's, in novabundle.py, where the pack container already is.
# What the shell owns is the bytes: every file in COMPOSE_FILE, copied whole,
# with a manifest saying where each came from. These are the cases for that,
# and for each refusal it states instead of carrying on.
#
# The probe pair is two files on purpose: the GPU overlay makes COMPOSE_FILE
# two files on any host with an NVIDIA runtime, and a stager that reads only
# the first one loses a whole file's declarations.
RAWDIR="$WORLD/rawstage"
(
  BK_COMPOSE_FILES="$PROBE_SRC:$PROBE_OVERLAY"
  export BK_COMPOSE_FILES
  mkdir -p "$RAWDIR/facts"
  render_raw "$RAWDIR"
) >/dev/null 2>&1

expect_str "render_raw_stages_every_file_in_COMPOSE_FILE" \
  "$(ls "$RAWDIR/facts/compose" 2>/dev/null | tr '\n' ' ')" "000.yml 001.yml files.json "

if cmp -s "$PROBE_SRC" "$RAWDIR/facts/compose/000.yml" &&
  cmp -s "$PROBE_OVERLAY" "$RAWDIR/facts/compose/001.yml"; then
  report 0 "the_staged_copy_is_the_file_byte_for_byte"
else
  report 1 "the_staged_copy_is_the_file_byte_for_byte" \
    "a staged copy differs from the file it was copied from"
fi

RAW_MANIFEST="$(cat "$RAWDIR/facts/compose/files.json" 2>/dev/null)"
expect_has "the_manifest_says_where_the_first_file_came_from" "$RAW_MANIFEST" \
  "{\"source\": \"$PROBE_SRC\", \"staged\": \"000.yml\"}"
expect_has "the_manifest_says_where_the_second_file_came_from" "$RAW_MANIFEST" \
  "{\"source\": \"$PROBE_OVERLAY\", \"staged\": \"001.yml\"}"

# A second run must not leave a previous one's file behind for the parser to
# read: the stage is emptied, not written over.
printf 'name: stale\n' > "$RAWDIR/facts/compose/009.yml"
(
  BK_COMPOSE_FILES="$PROBE_SRC"
  export BK_COMPOSE_FILES
  render_raw "$RAWDIR"
) >/dev/null 2>&1
expect_str "re_staging_removes_what_the_last_run_staged" \
  "$(ls "$RAWDIR/facts/compose" 2>/dev/null | tr '\n' ' ')" "000.yml files.json "

# Each refusal, stated. "<exit>|<its own words>", so expect_cov reads it.
stage_raw() {
  (
    BK_COMPOSE_FILES="$1"
    export BK_COMPOSE_FILES
    rm -rf "$WORLD/rawtry"
    mkdir -p "$WORLD/rawtry/facts"
    out="$(render_raw "$WORLD/rawtry" 2>&1)" && { printf '0|%s' "$out"; exit 0; }
    printf '1|%s' "$(printf '%s' "$out" | tr '\n' ' ')"
  )
}

expect_cov "refuses_a_compose_file_this_host_cannot_read" \
  "$(stage_raw "$WORLD/not-a-file.yml")" 1 "cannot read it"
: > "$WORLD/empty-compose.yml"
expect_cov "refuses_an_empty_compose_file" \
  "$(stage_raw "$WORLD/empty-compose.yml")" 1 "An empty compose file is a reading that failed"
NOFILES="$(
  bk_compose_files() { :; }
  rm -rf "$WORLD/rawtry"
  mkdir -p "$WORLD/rawtry/facts"
  out="$(render_raw "$WORLD/rawtry" 2>&1)" && printf '0|%s' "$out" || \
    printf '1|%s' "$(printf '%s' "$out" | tr '\n' ' ')"
)"
expect_cov "refuses_when_COMPOSE_FILE_names_nothing" "$NOFILES" 1 \
  "no compose file, so there is no declared set to read"

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
# the compose text render_raw staged was read.
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
NONAME="$(run_coverage routine)"
expect_cov "refuses_a_render_with_no_project_name" "$NONAME" 9 "no top-level"
expect_cov "and_names_the_render_it_read_that_from" "$NONAME" 9 "config.yaml"
STUB_COMPOSE_SED=""

# The other half of the same function: with no render on disk it runs compose
# itself, and a failure there must carry compose's own words. Driven directly,
# because render_facts primes the name out of the render it just wrote and
# this path is the one refresh.sh and a standalone renderer take.
PROJFAIL="$(
  bk_docker() { stub_docker "$@"; }
  STUB_COMPOSE_RC=1
  STUB_COMPOSE_STDERR="could not find /nowhere/docker-compose.yml"
  # shellcheck disable=SC2034  # read by bk_set_project/bk_project
  BK_PROJECT=""
  bk_set_project 2>&1 | tr '\n' ' '
)"
expect_has "bk_set_project_without_a_render_carries_composes_stderr" "$PROJFAIL" \
  "could not find /nowhere/docker-compose.yml"
expect_has "bk_set_project_without_a_render_names_the_command" "$PROJFAIL" \
  "docker compose --profile '*' config"

# The THIRD arm, which the round-2 split created and left unpinned: no render
# on disk, compose exits 0, and what it returns carries no `name:`. Without
# the refusal here, bk_project prints an empty string and RETURNS 0, so
# `project="$(bk_project)" || return 1` does not fire and render_containers
# runs `docker ps -a --filter label=com.docker.compose.project=` — an empty
# filter that matches every container on the host. On this machine that is
# v4's eight, seven stopped v3 ones and anything else running. Selecting by
# label instead of by name is the whole point; an empty label selects
# everything.
PROJEMPTY="$(
  bk_docker() { stub_docker "$@"; }
  STUB_COMPOSE_RC=0
  STUB_COMPOSE_SED='/^name: /d'
  # shellcheck disable=SC2034  # read by bk_set_project/bk_project
  BK_PROJECT=""
  bk_set_project 2>&1 | tr '\n' ' '
)"
expect_has "bk_set_project_refuses_a_render_that_carries_no_name" "$PROJEMPTY" "no top-level"
PROJEMPTY_RC="$(
  bk_docker() { stub_docker "$@"; }
  STUB_COMPOSE_RC=0
  STUB_COMPOSE_SED='/^name: /d'
  # shellcheck disable=SC2034  # read by bk_set_project/bk_project
  BK_PROJECT=""
  bk_project >/dev/null 2>&1
  printf '%s' "$?"
)"
expect_str "and_bk_project_returns_non_zero_so_the_caller_refuses" "$PROJEMPTY_RC" "1"

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

# The same, for the other kind only `docker inspect` can see. Declaring
# searxng's image-declared volume `include` must make render_reachable probe
# it BY ITS 64-HEX NAME — it has no compose key to be probed by. The loop that
# does this shipped last round with nothing asserting over it: removing it
# entirely left both suites green.
STUB_COMPOSE_SED='s/disposition: exclude-ephemeral/disposition: include/'
ANONINC="$(run_coverage routine)"
expect_cov "an_include_class_anon_volume_is_carried_only_after_a_probe" "$ANONINC" 0 '"kind": "anon"'
ANON_NAME="$(bk_anon_mounts "$WORLD/stage" | awk -F'	' 'NR==1 {print $3}')"
if [ -n "$ANON_NAME" ] && grep -q "\"$ANON_NAME\": {\"exists\": true, \"ok\": true" \
  "$WORLD/stage/facts/reachable.json"; then
  report 0 "render_reachable_probes_an_include_class_anon_volume_by_its_64_hex_name"
else
  report 1 "render_reachable_probes_an_include_class_anon_volume_by_its_64_hex_name" \
    "name='$ANON_NAME' reachable=$(tr -d '\n' < "$WORLD/stage/facts/reachable.json")"
fi
STUB_COMPOSE_SED=""
build_world

# ── the capture tool refuses rather than corrupting its own output ─────────
#
# refresh.sh redacts by rewriting every occurrence of $HOME. Under `sudo` that
# is /root, and /root/.ollama is the ollama volume's mount TARGET inside the
# container: rewriting it corrupts compose-*.yaml, compose-*.json and
# containers-v4.json while both suites stay green on the result. It runs
# before any docker call, so this case needs no daemon.
#
# Run against a COPY in the temp world, never the one in the repo: a test of
# "this tool refuses before it writes" must not be able to write over the
# fixtures if the guard it is testing has regressed. (It can: running the
# unguarded version by hand while proving this rewrote six captured fixtures
# and left four files named after another compose version behind.) The guard
# sits before the script sources or reads anything, so the copy refuses in
# place.
REFRESH="$WORLD/refresh.sh"
cp "$SCRIPT_DIR/backup/fixtures/refresh.sh" "$REFRESH"
for bad_home in /root "" /; do
  out="$(HOME="$bad_home" "$REFRESH" 2>&1)"
  code=$?
  if [ "$code" -eq 0 ]; then
    report 1 "refresh_refuses_a_system_home_rather_than_redacting_into_it" \
      "HOME='$bad_home' exited 0"
  else
    case "$out" in
      *"not an operator's home directory"*)
        report 0 "refresh_refuses_a_system_home_rather_than_redacting_into_it" ;;
      *) report 1 "refresh_refuses_a_system_home_rather_than_redacting_into_it" \
           "HOME='$bad_home': $(printf '%s' "$out" | tr '\n' ' ')" ;;
    esac
  fi
done

printf '\n── the passphrase resolver seam ─────────────────────────────────────\n'

# shellcheck source=/dev/null
. "$SCRIPT_DIR/passphrase.sh"

# Every case runs against its own throwaway deploy dir, so none of them can
# read the operator's deploy/.env or write over his own passphrase file.
PW_WORLD="$(mktemp -d "${TMPDIR:-/tmp}/nova-passphrase.XXXXXX")"
trap 'rm -rf "$PW_WORLD"' EXIT

# Sets NP_DIR and NP_ENV_FILE in THIS shell, and `dir` with them. Never
# `pw_world x`: $( ) is a subshell, so the two globals the resolver
# reads would be set in a shell that has already exited — the same trap
# backup.sh's bk_set_project/bk_project split exists for.
pw_world() {
  NP_DIR="$PW_WORLD/$1"
  NP_ENV_FILE="$NP_DIR/.env"
  dir="$NP_DIR"
  mkdir -p "$NP_DIR"
  : > "$NP_ENV_FILE"
}

# The synthetic value every case below uses. Not a passphrase anything real is
# sealed with — this file is public.
PW_VALUE="aaaa-bbbb-cccc-dddd-eeee-ffff-gggg-hhhh"
BKT_PW_ORIGINAL="$PW_VALUE"
BKT_NO_PW=0

# ── absent permits a create; unavailable never does ─────────────────────────
#
# v3's hardest-won lesson (backend/app/backup_passphrase.py:55-73): a store
# that EXISTS and cannot be read must never read as "absent", or the next
# backup generates a replacement over the passphrase that still seals every
# existing bundle, and backups keep reporting green with nothing restorable
# behind them.
pw_world absent
resolve_passphrase >/dev/null 2>&1
code=$?
expect_str "absent_permits_create_exit_3" "$code" "3"

pw_world unreadable
printf '%s' "$PW_VALUE" > "$dir/.backup-passphrase"
chmod 000 "$dir/.backup-passphrase"
out="$(resolve_passphrase 2>&1)"
code=$?
if [ "$code" -eq 3 ]; then
  report 1 "unavailable_does_not_permit_a_create" \
    "an unreadable store read as ABSENT, which generates a replacement passphrase"
elif [ "$code" -eq 0 ]; then
  report 1 "unavailable_does_not_permit_a_create" "it returned a value: $out"
else
  report 0 "unavailable_does_not_permit_a_create"
fi
chmod 600 "$dir/.backup-passphrase"

# ── a pre-existing file is never overwritten ────────────────────────────────
pw_world existing
printf '%s' "$PW_VALUE" > "$dir/.backup-passphrase"
chmod 600 "$dir/.backup-passphrase"
out="$(create_passphrase printf '%s' 'a-brand-new-one')"
expect_str "create_re_reads_rather_than_writing_a_second_passphrase" "$out" "$PW_VALUE"
expect_str "the_file_on_disk_is_untouched" "$(cat "$dir/.backup-passphrase")" "$PW_VALUE"

# ── a mode that is not 0600 refuses, and names the mode it read ─────────────
pw_world wideopen
printf '%s' "$PW_VALUE" > "$dir/.backup-passphrase"
chmod 644 "$dir/.backup-passphrase"
out="$(resolve_passphrase 2>&1)"
code=$?
expect_str "refuses_a_passphrase_file_not_0600" "$code" "1"
expect_has "refuses_a_passphrase_file_not_0600_and_names_the_mode" "$out" "mode 644"

# ── an unknown source refuses BY NAME and lists the ones it has ─────────────
pw_world unknownsource ; printf 'NOVA_PASSPHRASE_SOURCE=vault\n' >> "$dir/.env"
out="$(resolve_passphrase 2>&1)"
code=$?
expect_str "dispatch_refuses_an_unknown_source" "$code" "1"
expect_has "dispatch_refuses_an_unknown_source_naming_it" "$out" "'vault'"
for known in file env prompt cmd; do
  expect_has "dispatch_names_the_source_it_has_${known}" "$out" "$known"
done

# ── cmd: a non-zero exit is UNAVAILABLE, never absent ───────────────────────
pw_world cmdfails
printf 'NOVA_PASSPHRASE_SOURCE=cmd\n' >> "$dir/.env"
printf 'NOVA_PASSPHRASE_CMD=exit 7\n' >> "$dir/.env"
out="$(resolve_passphrase 2>&1)"
code=$?
if [ "$code" -eq 3 ]; then
  report 1 "cmd_nonzero_is_unavailable_not_absent" \
    "a logged-out secrets manager read as absent, which generates a second passphrase"
else
  report 0 "cmd_nonzero_is_unavailable_not_absent"
fi
expect_has "cmd_nonzero_says_why" "$out" "UNAVAILABLE, not absent"

pw_world cmdworks
printf 'NOVA_PASSPHRASE_SOURCE=cmd\n' >> "$dir/.env"
printf "NOVA_PASSPHRASE_CMD=printf '%%s' '$PW_VALUE'\n" >> "$dir/.env"
expect_str "cmd_resolves_from_stdout" "$(resolve_passphrase)" "$PW_VALUE"

pw_world cmdempty
printf 'NOVA_PASSPHRASE_SOURCE=cmd\n' >> "$dir/.env"
printf 'NOVA_PASSPHRASE_CMD=true\n' >> "$dir/.env"
resolve_passphrase >/dev/null 2>&1
code=$?
expect_str "cmd_printing_nothing_is_a_refusal_not_an_empty_passphrase" "$code" "1"

# ── env ─────────────────────────────────────────────────────────────────────
pw_world envsource ; printf 'NOVA_PASSPHRASE_SOURCE=env\n' >> "$dir/.env"
NOVA_BACKUP_PASSPHRASE="" resolve_passphrase >/dev/null 2>&1
expect_str "env_unset_is_absent" "$?" "3"
expect_str "env_resolves" "$(NOVA_BACKUP_PASSPHRASE="$PW_VALUE" resolve_passphrase)" "$PW_VALUE"

# ── prompt without a tty is a STATED cannot, not a fallback ────────────────
pw_world promptsource ; printf 'NOVA_PASSPHRASE_SOURCE=prompt\n' >> "$dir/.env"
out="$(resolve_passphrase < /dev/null 2>&1)"
code=$?
expect_str "prompt_without_a_tty_is_not_absent" "$code" "1"
expect_has "prompt_without_a_tty_is_a_stated_cannot" "$out" "cannot prompt without a terminal"

# ── only `file` creates ─────────────────────────────────────────────────────
pw_world envcreate ; printf 'NOVA_PASSPHRASE_SOURCE=env\n' >> "$dir/.env"
out="$(create_passphrase printf '%s' 'should-never-be-written' 2>&1)"
code=$?
expect_str "only_the_file_source_creates" "$code" "1"
if [ -f "$dir/.backup-passphrase" ]; then
  report 1 "only_the_file_source_creates_nothing_on_disk" "it wrote a file anyway"
else
  report 0 "only_the_file_source_creates_nothing_on_disk"
fi

# ── a create writes 0600 and READS THE MODE BACK ───────────────────────────
pw_world create
out="$(create_passphrase printf '%s' "$PW_VALUE" 2>/dev/null)"
expect_str "create_returns_what_it_wrote" "$out" "$PW_VALUE"
expect_str "create_writes_0600" "$(np_mode_of "$dir/.backup-passphrase")" "600"
expect_str "create_is_readable_by_the_resolver" "$(resolve_passphrase)" "$PW_VALUE"

# ── two concurrent creates produce ONE passphrase ───────────────────────────
#
# Without the lock both runs generate, both write, and one of them then seals
# a bundle with a passphrase the other's write has already replaced: a bundle
# whose key exists nowhere.
pw_world concurrent
(
  create_passphrase sh -c 'sleep 0.2; printf %s first' > "$dir/one" 2>/dev/null
) &
sleep 0.05
create_passphrase sh -c 'printf %s second' > "$dir/two" 2>/dev/null
wait
stored="$(cat "$dir/.backup-passphrase" 2>/dev/null)"
one="$(cat "$dir/one" 2>/dev/null)"
two="$(cat "$dir/two" 2>/dev/null)"
if [ -z "$stored" ]; then
  report 1 "concurrent_create_produces_one_passphrase" "nothing was stored"
elif [ -n "$one" ] && [ -n "$two" ] && [ "$one" != "$two" ]; then
  report 1 "concurrent_create_produces_one_passphrase" \
    "two creators returned different values ('$one' and '$two')"
else
  report 0 "concurrent_create_produces_one_passphrase"
fi

# ── the documented set is the dispatched set ───────────────────────────────
#
# Adding a source without offering it — or offering one that does not exist —
# is a red suite, not a silent divergence.
CASE_ARMS="$(sed -n '/^resolve_passphrase()/,/^}/p' "$SCRIPT_DIR/passphrase.sh" \
  | sed -n 's/^    \([a-z|]*\)) *nova_pass_.*$/\1/p' | tr '|' '\n' | sort | tr '\n' ' ')"
FUNCS="$(sed -n 's/^nova_pass_\([a-z]*\)().*$/\1/p' "$SCRIPT_DIR/passphrase.sh" | sort | tr '\n' ' ')"
DOCUMENTED="$(sed -n 's/^# *NOVA_PASSPHRASE_SOURCE — one of: \(.*\)$/\1/p' "$SCRIPT_DIR/.env.example" \
  | tr ' ' '\n' | sort | tr '\n' ' ')"
DECLARED="$(printf '%s' "$NOVA_PASSPHRASE_SOURCES" | tr ' ' '\n' | sort | tr '\n' ' ')"
expect_str "resolvers_are_exactly_the_documented_set_arms" "$CASE_ARMS" "$DECLARED"
expect_str "resolvers_are_exactly_the_documented_set_functions" "$FUNCS" "$DECLARED"
expect_str "resolvers_are_exactly_the_documented_set_env_example" "$DOCUMENTED" "$DECLARED"

# ── the passphrase never reaches argv, and no -e carries it ────────────────
#
# §7.5: it reaches exactly one place, the first line of the pack container's
# stdin. `docker inspect` shows -e for a container's whole lifetime and `ps`
# shows argv to every user on the box — which is also why the design refuses
# `openssl enc`, whose key IS an argument.
pw_world argv
printf '%s' "$PW_VALUE" > "$dir/.backup-passphrase"
chmod 600 "$dir/.backup-passphrase"
ARGV_LOG="$dir/argv.log"
: > "$ARGV_LOG"
fake_runner() {
  printf '%s\n' "$*" >> "$ARGV_LOG"
  # what novabundle.py fingerprint prints
  printf '0123456789ab\n'
}
ZERO_SALT="00000000000000000000000000000000"
out="$(resolve_passphrase | passphrase_fingerprint "$ZERO_SALT" \
  fake_runner docker run --rm -i --network none nova-core python3 novabundle.py)"
expect_str "the_fingerprint_seam_returns_12_hex" "$out" "0123456789ab"
expect_lacks "passphrase_never_reaches_argv" "$(cat "$ARGV_LOG")" "$PW_VALUE"
expect_lacks "passphrase_never_reaches_a_dash_e" "$(cat "$ARGV_LOG")" " -e "
expect_has "the_fingerprint_seam_passes_the_salt_not_the_passphrase" \
  "$(cat "$ARGV_LOG")" "fingerprint --salt 00000000000000000000000000000000"

# ── the fingerprint seam refuses a salt that is not 16 bytes ───────────────
out="$(printf '%s' "$PW_VALUE" | passphrase_fingerprint "00" fake_runner 2>&1)"
code=$?
expect_str "the_fingerprint_seam_refuses_a_short_salt" "$code" "1"
expect_has "the_fingerprint_seam_names_what_a_salt_is" "$out" "16 bytes of hex"

unset NP_DIR NP_ENV_FILE

printf '\n── the backup verb ──────────────────────────────────────────────────\n'

# No docker, no network, no live stack — same rule as every block above. What
# is different here is the LEVEL the seam sits at. `docker run` is not
# answered with a canned string: each one is re-run ON THIS HOST with the
# container's mount points rewritten to the directories that stand in for
# them. So the shell scripts cmd_backup ships really execute, the real
# novabundle.py really plans, packs and verifies, the bundle really lands on
# disk, and step 19's host-side re-read really reads it. A stub that answered
# `{"verified": true}` would prove the argv and nothing else — which is the
# defect this whole slice exists against.
#
# Only postgres itself is faked, because nothing here has a server: `psql`
# answers from a table keyed on the SQL, and `pg_dump`/`pg_restore` are two
# small scripts on PATH. The SQL the census GENERATES is read back by the
# fake, so the generator is exercised rather than asserted.

BK_WORLD="$(mktemp -d "${TMPDIR:-/tmp}/nova-backup-verb.XXXXXX")"
trap 'rm -rf "$WORLD" "$PW_WORLD" "$BK_WORLD"' EXIT
BKT_VOLS="$BK_WORLD/volumes"
BKT_LOG="$BK_WORLD/docker.log"
BKT_MAP=""
BKT_RC=0
BKT_SET_E=0
STUB_DF_RC=0
STUB_VOLUME_RM_RC=0
STUB_UNREADABLE_PART=0
STUB_DROP_LINK_TARGETS=0
STUB_PROBE_RC=0
STUB_NETWORK_RM_RC=0
STUB_DETACH_RC=0
STUB_PULL_RC=0
STUB_PULL_LANDS=1
STUB_RESTORE_DIFF=0
STUB_RESTORE_VER_RC=0
STUB_DROP_VOLUME_LABELS=0
STUB_RESTORED_KEY_DIFFERS=0
STUB_TAMPER_LISTING=""
STUB_EMPTY_UNTIL_RESTORED=0
STUB_MISSING_DB=""
STUB_MISSING_ROLE=""
STUB_ORPHAN_VERIFY_DBS=""
STUB_VERIFY_DB_CONNS=0
STUB_VERIFY_DB_OLD=1
BKT_BARE_TARGET=0
BKT_FORCE_CT_NET=""

# ── pure helpers, before anything that needs a world ───────────────────────

expect_str "archive_name_is_host_and_a_sortable_utc_stamp" \
  "$(archive_name 'a-host' '20260921T143002Z')" \
  "nova-backup-a-host-20260921T143002Z.tar"
expect_str "archive_name_reduces_a_host_to_a_portable_filename" \
  "$(archive_name 'a host/with:junk' '20260921T143002Z')" \
  "nova-backup-a-host-with-junk-20260921T143002Z.tar"

# The FinishedAt comparison of §9.1 step 7 rests on this and on nothing else:
# both strings are ISO-8601 UTC to the second, so "later than" is string
# order and no host needs `date -d` (macOS has none).
bk_str_ge "2026-09-21T14:30:12" "2026-09-21T14:30:12" &&
  report 0 "str_ge_is_true_for_equal_stamps" ||
  report 1 "str_ge_is_true_for_equal_stamps" "equal stamps compared as older"
bk_str_ge "2026-09-21T14:30:13" "2026-09-21T14:30:12" &&
  report 0 "str_ge_is_true_for_a_later_stamp" ||
  report 1 "str_ge_is_true_for_a_later_stamp" "a later stamp compared as older"
bk_str_ge "2026-09-21T14:30:11" "2026-09-21T14:30:12" &&
  report 1 "str_ge_is_false_for_an_earlier_stamp" "an earlier stamp compared as later" ||
  report 0 "str_ge_is_false_for_an_earlier_stamp"

# Four copies, not two: the staging tree, inner.tgz, payload.enc, the .part
# and the round trip's streamed re-read. Integer arithmetic, both sides KB.
expect_str "free_space_arithmetic_is_integer_and_both_sides_are_kb" \
  "$(bk_need_out_kb 1000)" "4000"
expect_str "free_space_arithmetic_is_integer_and_both_sides_are_kb" \
  "$(bk_need_out_kb 3)" "12"
# The self-test restore writes a full second copy onto PGDATA's filesystem.
expect_str "the_postgres_filesystem_is_sized_separately_at_1_2x" \
  "$(bk_need_pgdata_kb 1000)" "1200"
expect_str "the_postgres_filesystem_ratio_truncates_rather_than_floating" \
  "$(bk_need_pgdata_kb 7)" "8"

# ^nova_selftest_[0-9a-f]{8}$, asserted before CREATE, before pg_restore and
# before DROP. `nova_selftest_` and not `nova_verify_`: drill's orphan sweep
# walks nova_verify_*, and a drill started during a backup would drop the live
# run's scratch database (shell-first m11).
for bad in nova_verify_a1b2c3d4 nova_selftest_A1B2C3D4 nova_selftest_a1b2c3d \
  nova_selftest_a1b2c3d45 nova_core '' 'nova_selftest_a1b2c3d4; DROP'; do
  if bk_assert_selftest_name "$bad" "drop" >/dev/null 2>&1; then
    report 1 "selftest_name_is_asserted_before_create_restore_and_drop" \
      "'$bad' was accepted as a self-test database name"
  else
    report 0 "selftest_name_is_asserted_before_create_restore_and_drop"
  fi
done
bk_assert_selftest_name nova_selftest_a1b2c3d4 "drop" >/dev/null 2>&1 &&
  report 0 "selftest_uses_its_own_prefix_not_nova_verify" ||
  report 1 "selftest_uses_its_own_prefix_not_nova_verify" "a legal name was refused"
expect_has "selftest_uses_its_own_prefix_not_nova_verify" \
  "$(bk_selftest_name)" "nova_selftest_"

# sha256_of is what §9.1 step 19 runs AS THE OPERATOR. An unreadable file is a
# stated refusal, never an empty string that reads as an answer.
printf 'abc' > "$BK_WORLD/h.txt"
expect_str "sha256_of_is_64_hex_of_the_bytes" "$(sha256_of "$BK_WORLD/h.txt")" \
  "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
out="$(sha256_of "$BK_WORLD/nothing-here" 2>&1)"
code=$?
expect_str "sha256_of_refuses_rather_than_printing_nothing" "$code" "1"
expect_has "sha256_of_names_the_file_it_could_not_read" "$out" "$BK_WORLD/nothing-here"

# ── the archive-directory mode probe, on the host ──────────────────────────
mkdir -p "$BK_WORLD/probe-ok"
bk_mode_probe "$BK_WORLD/probe-ok" >/dev/null 2>&1 &&
  report 0 "mode_probe_accepts_a_filesystem_that_holds_0600" ||
  report 1 "mode_probe_accepts_a_filesystem_that_holds_0600" "a normal directory was refused"

# A filesystem that cannot hold 0600 is simulated the only way a test can:
# by making `stat` answer something else. The probe reads the mode BACK rather
# than trusting the chmod, which is the whole point.
(
  stat() { printf '777\n'; }
  bk_mode_probe "$BK_WORLD/probe-ok" >"$BK_WORLD/o" 2>&1
) && report 1 "mode_probe_refuses_a_filesystem_that_cannot_hold_0600" \
  "a filesystem that read back 0777 was accepted" ||
  report 0 "mode_probe_refuses_a_filesystem_that_cannot_hold_0600"
expect_has "mode_probe_names_the_mode_it_read" "$(cat "$BK_WORLD/o")" "read back 0777"

(
  stat() { return 1; }
  bk_mode_probe "$BK_WORLD/probe-ok" >"$BK_WORLD/o" 2>&1
) && report 1 "mode_probe_refuses_when_neither_stat_form_answers" \
  "neither stat form answered and the probe passed anyway" ||
  report 0 "mode_probe_refuses_when_neither_stat_form_answers"
expect_has "mode_probe_says_which_two_forms_it_tried" "$(cat "$BK_WORLD/o")" "stat -f '%Lp'"

# ── the writer set (§9.1 step 7), derived from the render ──────────────────
#
# Driven against the SAME world the coverage block renders, so it reads the
# real deploy/docker-compose.yml through a real `docker compose config`
# capture rather than a hand-written six-line fixture.
#
# Every knob the blocks above left set is reset HERE rather than trusted to
# have been reset there: one of them (`disposition: exclude-ephemeral` ->
# `include`) silently reclassified searxng's anonymous volume while this was
# being written, and a world that is not the world under test is a green
# suite measuring something else.
CONTAINERS_FIXTURE="containers-v4.json"
STUB_COMPOSE_RC=0
STUB_COMPOSE_SED=""
STUB_COMPOSE_EMPTY=""
STUB_COMPOSE_STDERR=""
STUB_DATABASES="nova_core|core
nova_gateway|gateway
nova_memory|memory"
build_world
# The checkout the migration hashes are read out of. Real files, so "a
# recorded migration with no file on disk" is a case this suite can build.
# After build_world, which re-creates the tree.
mkdir -p "$WORLD/repo/services/core/migrations" \
  "$WORLD/repo/services/gateway/migrations" "$WORLD/repo/services/memory/migrations"
for s in core gateway memory; do
  printf -- '-- %s\n' "$s" > "$WORLD/repo/services/$s/migrations/001_init.sql"
done

rm -rf "$WORLD/stage"
mkdir -p "$WORLD/stage/facts"
(
  cd "$WORLD/repo" || exit 9
  bk_docker() { stub_docker "$@"; }
  bk_git() { stub_git "$@"; }
  BK_COMPOSE_FILES="$WORLD/repo/deploy/docker-compose.yml"
  BK_ENV_FILE="$WORLD/repo/deploy/.env"
  BK_ENV_EXAMPLE="$WORLD/repo/deploy/.env.example"
  export BK_COMPOSE_FILES BK_ENV_FILE BK_ENV_EXAMPLE
  render_facts "$WORLD/stage" routine
) >/dev/null 2>&1

expect_str "writers_are_the_union_of_the_two_facts_minus_postgres" \
  "$(writer_services "$WORLD/stage" routine | tr '\n' ' ')" "core gateway memory "
# shell-first M2, and it is not hypothetical: gateway mounts only v4_models
# read-write — an exclude-redownload volume — so under the mount rule alone it
# stays running while it writes nova_gateway through its DATABASE_URL.
expect_has "writers_include_gateway_because_it_holds_a_postgres_dsn" \
  "$(writer_services "$WORLD/stage" routine)" "gateway"
expect_lacks "writers_never_include_postgres_on_the_real_render" \
  "$(writer_services "$WORLD/stage" routine)" "postgres"

# ...and that case is VACUOUS on its own, which was measured rather than
# suspected: deleting the `[ "$svc" = "postgres" ] && continue` line left the
# whole suite green, because neither rule selects postgres on
# deploy/docker-compose.yml — it mounts no include-class volume read-write and
# holds no DSN of its own. This render is built so BOTH rules select it. The
# only thing that can keep postgres out of the writer set here is the removal
# BY NAME, which is what the verdict asks for.
mkdir -p "$BK_WORLD/pgstage/facts"
cat > "$BK_WORLD/pgstage/facts/config.yaml" <<'YAML'
name: novaxprobe
services:
  postgres:
    environment:
      SELF_URL: postgresql://postgres:x@postgres:5432/postgres
    volumes:
      - type: volume
        source: vol_carried
        target: /data
  other:
    depends_on:
      postgres:
        condition: service_healthy
volumes:
  vol_carried:
    name: novaxprobe_vol_carried
    x-nova-backup: include
    x-nova-backup-reason: state with no other copy
YAML
expect_str "writers_never_include_postgres" \
  "$(writer_services "$BK_WORLD/pgstage" routine | tr '\n' ' ')" "other "
# §9.5: the fourth way --move differs is that tailscale joins the writer set.
expect_lacks "a_routine_backup_leaves_the_tailnet_sidecar_alone" \
  "$(writer_services "$WORLD/stage" routine)" "tailscale"
expect_has "move_adds_the_tailnet_sidecar_because_move_only_becomes_carried" \
  "$(writer_services "$WORLD/stage" move)" "tailscale"

# The two halves of the DSN rule, each on its own.
bk_service_touches_postgres gateway < "$WORLD/stage/facts/config.yaml" &&
  report 0 "a_postgres_dsn_in_the_environment_makes_a_writer" ||
  report 1 "a_postgres_dsn_in_the_environment_makes_a_writer" "gateway's DATABASE_URL was not seen"
bk_service_touches_postgres searxng < "$WORLD/stage/facts/config.yaml" &&
  report 1 "a_service_with_no_database_is_not_a_writer" "searxng was called a writer" ||
  report 0 "a_service_with_no_database_is_not_a_writer"

expect_str "the_network_name_is_read_from_the_render_never_assembled" \
  "$(bk_cfg_network_name default < "$WORLD/stage/facts/config.yaml")" "nova_default"
expect_str "the_postgres_image_tag_is_read_from_the_render" \
  "$(bk_cfg_service_image postgres < "$WORLD/stage/facts/config.yaml")" "postgres:16"
expect_str "every_rendered_profile_is_recorded" \
  "$(bk_cfg_profiles < "$WORLD/stage/facts/config.yaml" | tr '\n' ' ')" "inference tailnet "

printf '\n── restore and drill: the parts that need no world ──────────────────\n'

# ── DRILL_RE, on the string that reaches the command (python-tool M7) ──────
#
# The shape the design first wrote — ^nova-drill-[0-9a-f]{8}$ — matches NONE
# of the names it was said to guard, so the stated three-touchpoint control
# either failed on every create or was being applied to a different string
# from the one `docker volume rm` receives. Every legal name a drill builds is
# driven here, and so is every shape that must not pass.
for good in nova-drill-a1b2c3d4-pg nova-drill-a1b2c3d4-net \
  nova-drill-a1b2c3d4_v4_memdata nova-drill-00000000_pgdata \
  nova-drill-ffffffff_content nova-drill-deadbeef_a; do
  if bk_drill_assert_name "$good" "remove" >/dev/null 2>&1; then
    report 0 "drill_re_matches_every_object_name_it_guards"
  else
    report 1 "drill_re_matches_every_object_name_it_guards" \
      "'$good' is a name a drill CREATES and the assertion refused it"
  fi
done

# Everything a drill must never touch, including the exact real objects this
# machine holds (shell-first: `nova_` belongs to another project on the
# owner's own machine, and selecting by prefix would have destroyed 75.8 MB
# of it).
for bad in nova_v4_memdata nova_v4_pgdata nova_pgdata nova_default \
  nova-backup-stage-20260921T143002Z-1 nova-drill- nova-drill-a1b2c3d \
  nova-drill-a1b2c3d45_x nova-drill-A1B2C3D4_x nova-drill-a1b2c3d4 \
  nova-drill-a1b2c3d4-pgx nova-drill-a1b2c3d4x nova-drill-a1b2c3d4_ \
  'nova-drill-a1b2c3d4_x; rm -rf /' 'nova-drill-a1b2c3d4_../../etc' \
  xnova-drill-a1b2c3d4-pg ''; do
  if bk_drill_assert_name "$bad" "remove" >/dev/null 2>&1; then
    report 1 "drill_never_touches_a_nova_underscore_object" \
      "'$bad' was accepted as a drill object name"
  else
    report 0 "drill_never_touches_a_nova_underscore_object"
  fi
done

# The drill's scratch databases keep their OWN prefix (shell-first m11): the
# sweep walks nova_verify_*, and a backup's nova_selftest_* must never be a
# thing it can drop.
bk_assert_verify_name nova_verify_a1b2c3d4 "drop" >/dev/null 2>&1 &&
  report 0 "drill_databases_use_nova_verify_and_the_selftest_prefix_is_not_theirs" ||
  report 1 "drill_databases_use_nova_verify_and_the_selftest_prefix_is_not_theirs" \
    "a legal drill database name was refused"
for bad in nova_selftest_a1b2c3d4 nova_verify_A1B2C3D4 nova_verify_a1b2c3d \
  nova_core '' 'nova_verify_a1b2c3d4; DROP'; do
  if bk_assert_verify_name "$bad" "drop" >/dev/null 2>&1; then
    report 1 "drill_databases_use_nova_verify_and_the_selftest_prefix_is_not_theirs" \
      "'$bad' was accepted as a drill database name"
  else
    report 0 "drill_databases_use_nova_verify_and_the_selftest_prefix_is_not_theirs"
  fi
done

# ── the stamp, and the age it implies (§9.4 step 3) ───────────────────────
#
# macOS has no `date -d` and there is no portable epoch-from-string form
# (map-portability.md:63), so the civil arithmetic is done by hand — which
# means it is worth measuring against values computed somewhere else.
expect_str "the_stamp_is_parsed_by_civil_arithmetic_not_by_date_d" \
  "$(bk_stamp_epoch 19700101T000000Z)" "0"
# The four expected values are python datetime's, not this implementation's
# — an independent computation, which is the only thing that makes them
# worth asserting. Two of them were WRONG when they were first typed by
# hand, and the arithmetic under test was right.
expect_str "the_stamp_is_parsed_by_civil_arithmetic_not_by_date_d" \
  "$(bk_stamp_epoch 20260921T143002Z)" "1790001002"
expect_str "the_stamp_is_parsed_by_civil_arithmetic_not_by_date_d" \
  "$(bk_stamp_epoch 20000229T000000Z)" "951782400"
expect_str "the_stamp_is_parsed_by_civil_arithmetic_not_by_date_d" \
  "$(bk_stamp_epoch 20240101T000000Z)" "1704067200"
# A leading zero is DECIMAL, not octal: 08 and 09 are where $(( )) bites.
expect_str "a_leading_zero_in_the_stamp_is_decimal_not_octal" \
  "$(bk_stamp_epoch 20260809T080908Z)" "1786262948"

for bad in 20260921 20260921T143002 2026-09-21T14:30:02Z 20261321T143002Z \
  20260921T253002Z 20260900T143002Z '' notastamp; do
  if bk_stamp_epoch "$bad" >/dev/null 2>&1; then
    report 1 "drill_fails_on_an_unparseable_stamp" "'$bad' was parsed as a stamp"
  else
    report 0 "drill_fails_on_an_unparseable_stamp"
  fi
done

expect_str "the_stamp_comes_out_of_the_name_never_the_mtime" \
  "$(bk_bundle_stamp 'nova-backup-a-host-20260921T143002Z.tar')" "20260921T143002Z"
expect_str "the_stamp_comes_out_of_the_name_never_the_mtime" \
  "$(bk_bundle_stamp 'nova-backup-a-host-20260921T143002Z-2.tar')" "20260921T143002Z"
bk_bundle_stamp 'a-file-somebody-dropped-here.tar' >/dev/null 2>&1 &&
  report 1 "drill_fails_on_an_unparseable_stamp" "a name with no stamp parsed" ||
  report 0 "drill_fails_on_an_unparseable_stamp"

# ── the shape checks a hostile manifest meets first ───────────────────────
for good in nova_core nova_gateway core memory _x; do
  bk_is_sql_name "$good" && report 0 "a_manifest_name_that_reaches_sql_is_shape_checked" ||
    report 1 "a_manifest_name_that_reaches_sql_is_shape_checked" "'$good' was refused"
done
for bad in '' '1abc' 'nova core' 'nova;DROP' 'nova-core' '"x"' "o'brien" \
  '$(whoami)' '../etc'; do
  if bk_is_sql_name "$bad"; then
    report 1 "a_manifest_name_that_reaches_sql_is_shape_checked" "'$bad' was accepted"
  else
    report 0 "a_manifest_name_that_reaches_sql_is_shape_checked"
  fi
done
for bad in '' '../x' 'a/b' 'a b' '-x' '.hidden' 'a;b'; do
  if bk_is_volume_key "$bad"; then
    report 1 "a_manifest_volume_key_that_reaches_a_path_is_shape_checked" "'$bad' was accepted"
  else
    report 0 "a_manifest_volume_key_that_reaches_a_path_is_shape_checked"
  fi
done
bk_is_volume_key v4_memdata &&
  report 0 "a_manifest_volume_key_that_reaches_a_path_is_shape_checked" ||
  report 1 "a_manifest_volume_key_that_reaches_a_path_is_shape_checked" "v4_memdata was refused"

# ── the two constants this reader holds, pinned to the WRITER's own ───────
#
# §5.3's rule is that a manifest this code does not fully understand is not a
# manifest it may restore from, and the strict loader that enforces it lives
# in a module the fallback image cannot import (novabundle needs
# `cryptography`; `python:3.12-slim` does not carry it). So backup.sh holds
# its own key set — and a set someone maintains by hand is exactly what this
# repo calls a control you have to delete the day the feature lands. These
# two cases are what keep it derived in practice: add a key to MANIFEST_SPEC
# or a member to OUTER_ORDER and they go red here first.
expect_str "the_reader_knows_every_key_the_writer_writes" \
  "$(printf '%s' "$BK_MANIFEST_KEYS" | tr ' ' '\n' | LC_ALL=C sort | tr '\n' ' ')" \
  "$(nova_py - "$SCRIPT_DIR/backup" <<'PY'
import sys
sys.path.insert(0, sys.argv[1])
from novabundle import MANIFEST_SPEC
print(" ".join(sorted(MANIFEST_SPEC)), end=" ")
PY
)"
expect_str "the_reader_knows_the_outer_member_order_the_writer_forces" \
  "$BK_OUTER_ORDER" \
  "$(nova_py - "$SCRIPT_DIR/backup" <<'PY'
import sys
sys.path.insert(0, sys.argv[1])
from novabundle import OUTER_ORDER
print(" ".join(OUTER_ORDER), end="")
PY
)"

# ── reading MANIFEST.json, whose indentation is its grammar ───────────────
#
# Driven against a manifest the REAL writer wrote, not a hand-typed one: the
# readers below are the only thing standing between §5.3 and this shell, and
# a fixture someone typed would agree with whatever they assumed.
BKT_MANIFEST_FIXTURE="$BK_WORLD/manifest-probe.json"
nova_py - "$SCRIPT_DIR/backup" "$BKT_MANIFEST_FIXTURE" <<'PY'
import json
import sys

sys.path.insert(0, sys.argv[1])
from novabundle import dump_manifest

# Every shape the readers have to survive: a nested object inside a list row
# (databases[].selftest), an empty list, a null, and a value carrying the
# characters that break a line-based reader.
manifest = {
    "format": "nova-backup/2",
    "bundle_version": 2,
    "created_at": "20260921T143002Z",
    "mode": "routine",
    "transport": "local",
    "migration_match": "content",
    "source": {"host": "a-host", "os": "Linux", "repo_sha": None, "repo_dirty": None,
               "project": "nova", "compose_files": [], "profiles": [],
               "docker_version": "29.6.1", "compose_version": "v5.3.0",
               "pack_image_id": "sha256:aa"},
    "postgres": {"server_version": "16.15", "server_version_num": 160015,
                 "pg_dump_version": "16.15", "pg_dump_major": 16,
                 "container_image": "postgres:16", "container_image_id": "sha256:bb"},
    "session": {"DateStyle": "ISO, MDY", "IntervalStyle": "postgres", "TimeZone": "UTC",
                "bytea_output": "hex", "extra_float_digits": "0", "lc_numeric": "C"},
    "databases": [
        {"name": "nova_core", "owner": "core", "dump_member": "db/nova_core.dump",
         "dump_bytes": 1, "dump_sha256": "cc",
         "counts_member": "db/nova_core.counts.tsv",
         "migrations_member": "db/nova_core.migrations.tsv",
         "tables": 3, "rows": 51,
         "selftest": {"scratch_db": "nova_selftest_a1b2c3d4", "tables_compared": 3,
                      "equal": True}},
        {"name": "nova_memory", "owner": "memory", "dump_member": "db/nova_memory.dump",
         "dump_bytes": 1, "dump_sha256": "dd",
         "counts_member": "db/nova_memory.counts.tsv",
         "migrations_member": "db/nova_memory.migrations.tsv",
         "tables": 2, "rows": 7,
         "selftest": {"scratch_db": "nova_selftest_b1b2c3d4", "tables_compared": 2,
                      "equal": True}},
    ],
    "volumes": [
        {"key": "v4_memdata", "full_name": "nova_v4_memdata", "disposition": "include",
         "prefix": "volumes/v4_memdata/", "listing_member": "listings/v4_memdata.sha256",
         "listing_sha256": "ee", "entries": 6, "files": 3, "bytes": 12,
         "restore_to": "volume:nova_v4_memdata"},
    ],
    "binds": [],
    "files": [{"member": "files/deploy/.env", "origin": "deploy/.env",
               "restore_to": "deploy/.env", "mode": 384, "bytes": 1, "sha256": "ff"}],
    "env_keys": ["POSTGRES_PASSWORD", "SEARXNG_SECRET"],
    "members": [],
    "member_count": 0,
    "excluded": [{"kind": "volume", "name": "v4_ollama",
                  "disposition": "exclude-redownload",
                  "reason": 'weights: tens of GB, "re-pulled", not carried'}],
    "coverage": {"sources": [], "services": [], "entries": 0, "refusals": []},
    "identity": {"core_signing_key_sha256": None, "tailnet_dns_name": None,
                 "tailnet_state_carried": False, "device_count": 0, "people_count": 1},
    "encryption": {"container": "NOVAENC1", "cipher": "aes-256-gcm", "kdf": "scrypt",
                   "n": 32768, "r": 8, "p": 1, "dklen": 32, "chunk": 4194304,
                   "fingerprint_kind": "scrypt-key", "passphrase_sha256_12": "aa",
                   "passphrase_source": "file"},
    "reader_sha256": "9b71",
}
with open(sys.argv[2], "w", encoding="utf-8") as fh:
    fh.write(dump_manifest(manifest))
PY

expect_str "a_top_level_scalar_is_read_at_its_own_indentation" \
  "$(bk_m_top created_at < "$BKT_MANIFEST_FIXTURE")" "20260921T143002Z"
expect_str "a_top_level_scalar_is_read_at_its_own_indentation" \
  "$(bk_m_top bundle_version < "$BKT_MANIFEST_FIXTURE")" "2"
bk_m_top not_a_key < "$BKT_MANIFEST_FIXTURE" >/dev/null 2>&1 &&
  report 1 "a_missing_key_is_a_non_zero_exit_not_an_empty_value" "a missing key read as a value" ||
  report 0 "a_missing_key_is_a_non_zero_exit_not_an_empty_value"
expect_str "a_nested_object_key_is_read_at_four_spaces" \
  "$(bk_m_sub postgres pg_dump_major < "$BKT_MANIFEST_FIXTURE")" "16"
expect_str "a_nested_object_key_is_read_at_four_spaces" \
  "$(bk_m_sub source project < "$BKT_MANIFEST_FIXTURE")" "nova"
# null is a VALUE, and it reads as the empty string with a zero exit — which
# is what makes `null == null` equality at the signing-key comparison.
bk_m_sub identity core_signing_key_sha256 < "$BKT_MANIFEST_FIXTURE" >/dev/null 2>&1 &&
  report 0 "a_null_is_a_value_and_not_a_missing_key" ||
  report 1 "a_null_is_a_value_and_not_a_missing_key" "a null read as a missing key"
expect_str "a_null_is_a_value_and_not_a_missing_key" \
  "$(bk_m_sub identity core_signing_key_sha256 < "$BKT_MANIFEST_FIXTURE")" ""
expect_str "the_session_keys_are_read_as_a_set" \
  "$(bk_m_sub_keys session < "$BKT_MANIFEST_FIXTURE" | tr '\n' ' ')" \
  "DateStyle IntervalStyle TimeZone bytea_output extra_float_digits lc_numeric "

# THE one that matters: a nested object inside a list row must not be read as
# a new row. bk_coverage_rows was written after exactly this mistake dropped
# 19 of 22 entries, and databases[].selftest is the same shape.
expect_str "a_nested_object_in_a_list_row_is_not_read_as_a_new_row" \
  "$(bk_m_rows databases "name,owner,tables" < "$BKT_MANIFEST_FIXTURE" | wc -l | tr -d ' ')" "2"
expect_str "a_list_row_reads_every_field_in_the_order_it_was_asked_for" \
  "$(bk_m_rows databases "name,owner,tables" < "$BKT_MANIFEST_FIXTURE" | head -1 | tr '\037' '|')" \
  "nova_core|core|3"
expect_str "a_list_row_reads_every_field_in_the_order_it_was_asked_for" \
  "$(bk_m_rows volumes "key,full_name,prefix" < "$BKT_MANIFEST_FIXTURE" | tr '\037' '|')" \
  "v4_memdata|nova_v4_memdata|volumes/v4_memdata/"
expect_str "a_quoted_reason_survives_the_row_reader" \
  "$(bk_m_rows excluded "name,reason" < "$BKT_MANIFEST_FIXTURE" | tr '\037' '|')" \
  'v4_ollama|weights: tens of GB, "re-pulled", not carried'
expect_str "an_empty_list_reads_as_no_rows" \
  "$(bk_m_rows binds "source,target" < "$BKT_MANIFEST_FIXTURE" | wc -l | tr -d ' ')" "0"
expect_str "a_list_of_strings_reads_one_per_line" \
  "$(bk_m_strings env_keys < "$BKT_MANIFEST_FIXTURE" | tr '\n' ' ')" \
  "POSTGRES_PASSWORD SEARXNG_SECRET "
expect_str "an_empty_list_of_strings_reads_as_nothing" \
  "$(bk_m_strings members < "$BKT_MANIFEST_FIXTURE" | wc -l | tr -d ' ')" "0"

# ── the whole verb, end to end, with no docker ─────────────────────────────

# The container scripts cmd_backup ships use GNU `find -printf` and
# `xargs -a`. They always run inside a Linux image in production, so that is
# not a portability defect in the product — but re-running them on a BSD
# userland is not something this harness can do. Stated, and counted, rather
# than silently skipped: "silence reads as coverage" is how a suite passes
# while a product refuses.
BKT_GNU=1
find "$BK_WORLD" -maxdepth 0 -printf '' >/dev/null 2>&1 || BKT_GNU=0
xargs -0 -a /dev/null true >/dev/null 2>&1 || BKT_GNU=0

# Every `docker run` mount, as "<container path>\t<host path>", so the command
# can be re-run here against the directories that stand in for the volumes.
bkt_rewrite() {
  local p="$1" c h
  while IFS='	' read -r c h; do
    [ -n "$c" ] || continue
    case "$p" in
      "$c") printf '%s' "$h"; return 0 ;;
      "$c"/*) printf '%s%s' "$h" "${p#"$c"}"; return 0 ;;
    esac
  done <<EOF
$BKT_MAP
EOF
  printf '%s' "$p"
}

bkt_rewrite_text() {
  local text="$1" c h
  while IFS='	' read -r c h; do
    [ -n "$c" ] || continue
    text="$(printf '%s' "$text" | sed "s|$c|$h|g")"
  done <<EOF
$BKT_MAP
EOF
  printf '%s' "$text"
}

bkt_docker() {
  printf '%s\n' "$*" >> "$BKT_LOG"
  case "$1" in
    compose) bkt_compose "$@" ;;
    version) printf '29.6.1\n' ;;
    ps) bkt_ps "$@" ;;
    inspect) bkt_inspect "$@" ;;
    exec) bkt_exec "$@" ;;
    volume) bkt_volume "$@" ;;
    run) bkt_run "$@" ;;
    network) bkt_network "$@" ;;
    image) [ -f "$BK_WORLD/images/$(bkt_imgkey "$3")" ] ;;
    pull)
      [ "$STUB_PULL_RC" -eq 0 ] || return "$STUB_PULL_RC"
      mkdir -p "$BK_WORLD/images"
      if [ "$STUB_PULL_LANDS" = "1" ]; then
        : > "$BK_WORLD/images/$(bkt_imgkey "$2")"
      fi
      ;;
    rm)
      shift
      for a in "$@"; do
        case "$a" in -*) ;; *) rm -f "$BK_WORLD/ct/$a" "$BK_WORLD/ctnet/$a" ;; esac
      done
      ;;
    logs) printf 'a captured log line\n' ;;
    *) return 0 ;;
  esac
}

# Networks: created with an explicit subnet, inspected, removed — and every
# one of those three is a place DRILL_RE has to hold.
# An image tag as a filename: `python:3.12-slim` and `postgres:16` carry
# characters a path cannot.
bkt_imgkey() { printf '%s' "$1" | tr '/:' '__'; }

bkt_network() {
  local a name="" prev=""
  case "$2" in
    create)
      shift 2
      for a in "$@"; do
          case "$a" in -*) ;; *) [ "$prev" = "--subnet" ] || name="$a" ;; esac
        prev="$a"
      done
      mkdir -p "$BK_WORLD/net"
      printf '%s' "$prev" > "$BK_WORLD/net/$name"
      ;;
    inspect)
      shift 2
      for a in "$@"; do
        case "$a" in -*) ;; *) name="$a" ;; esac
      done
      [ -f "$BK_WORLD/net/$name" ] || return 1
      # network_rows() reads "<name>\t<config_files label>\t<subnet>…"
      printf '%s\t\t%s\n' "$name" "$(cat "$BK_WORLD/net/$name")"
      ;;
    rm)
      shift 2
      for a in "$@"; do
        case "$a" in -*) ;; *) rm -f "$BK_WORLD/net/$a" ;; esac
      done
      [ "$STUB_NETWORK_RM_RC" -eq 0 ] || return "$STUB_NETWORK_RM_RC"
      ;;
    ls)
      [ -d "$BK_WORLD/net" ] || return 0
      find "$BK_WORLD/net" -maxdepth 1 -type f -exec basename {} \; 2>/dev/null
      ;;
  esac
  return 0
}

bkt_compose() {
  local a svcs
  case " $* " in
    *" config "*)
      stub_docker "$@"
      return $?
      ;;
    *" version "*)
      printf 'v5.3.0\n'
      return 0
      ;;
    *" stop "*)
      printf '%s\n' "$*" >> "$BK_WORLD/stop.log"
      [ "$STUB_STOP_RC" -eq 0 ] || return "$STUB_STOP_RC"
      [ "$STUB_STOP_STICKS" = "1" ] || return 0
      svcs="$(bkt_compose_services stop "$@")"
      if [ -z "$svcs" ]; then
        # `docker compose stop` with no service name stops the whole project,
        # which is what --move does.
        BKT_RUNNING=""
        return 0
      fi
      for a in $svcs; do
        BKT_RUNNING="$(printf '%s\n' "$BKT_RUNNING" | grep -vx "$a")"
      done
      return 0
      ;;
    *" up "*)
      printf '%s\n' "$*" >> "$BK_WORLD/up.log"
      [ "$STUB_UP_RC" -eq 0 ] || return "$STUB_UP_RC"
      for a in $(bkt_compose_services up "$@"); do
        BKT_RUNNING="$(printf '%s\n%s\n' "$BKT_RUNNING" "$a" | sed '/^$/d' | sort -u)"
      done
      return 0
      ;;
    *" logs "*)
      printf 'a captured log line\n'
      return 0
      ;;
  esac
  return 0
}

# The service names after `$1` in a compose command line, with every flag and
# every flag VALUE dropped.
bkt_compose_services() {
  local verb="$1" a seen=0 skip=0
  shift
  for a in "$@"; do
    if [ "$skip" -eq 1 ]; then skip=0; continue; fi
    case "$a" in
      --project-directory | -f | --file | --profile | --project-name | -p) skip=1; continue ;;
      -*) continue ;;
    esac
    if [ "$seen" -eq 0 ]; then
      [ "$a" = "$verb" ] && seen=1
      continue
    fi
    printf '%s\n' "$a"
  done
}

bkt_ps() {
  local svc="" all=0 a id
  for a in "$@"; do
    case "$a" in
      -a) all=1 ;;
      label=com.docker.compose.service=*) svc="${a#label=com.docker.compose.service=}" ;;
    esac
  done
  if [ -z "$svc" ]; then
    # §9.2 step 6 asks "is any container of this project here", exited ones
    # included. On a bare restore target the honest answer is "only what this
    # run started", which is BKT_RUNNING; everywhere else it is the captured
    # fixture. One knob, because a world that answers both is not a world.
    if [ "${BKT_BARE_TARGET:-0}" = "1" ]; then
      printf '%s\n' "$BKT_RUNNING" | sed '/^$/d'
    else
      cat "$WORLD/ids.txt"
    fi
    return 0
  fi
  [ "$svc" = "$BKT_NO_CONTAINER" ] && return 0
  id="$(cat "$BK_WORLD/svc/$svc" 2>/dev/null)"
  [ -n "$id" ] || return 0
  if [ "$all" -eq 0 ] && ! printf '%s\n' "$BKT_RUNNING" | grep -qx "$svc"; then
    return 0
  fi
  printf '%s\n' "$id"
}

bkt_inspect() {
  local id="$2" fmt="" a want="" svc
  want=0
  for a in "$@"; do
    if [ "$want" -eq 1 ]; then fmt="$a"; want=0; fi
    [ "$a" = "--format" ] && want=1
  done
  svc="$(cat "$BK_WORLD/id2svc/$id" 2>/dev/null)"
  # A container this run started with `docker run -d --name` is known by its
  # NAME, not by a fixture id.
  if [ -f "$BK_WORLD/ct/$id" ]; then
    case "$fmt" in
      *'.NetworkSettings.Networks'*)
        printf '%s \n' "$(cat "$BK_WORLD/ctnet/$id" 2>/dev/null)"
        ;;
      *) printf '{}\n' ;;
    esac
    return 0
  fi
  case "$id" in
    nova-drill-*) return 1 ;;
  esac
  case "$fmt" in
    # render_containers' own template first: it names .State.Status and
    # .Config.Labels, so a rule ordered after those would swallow it.
    '{"id":'*) cat "$WORLD/containers/$id.json" 2>/dev/null; return 0 ;;
    *'.Config.Image'*) printf 'nova-core\n' ;;
    *'.State.Running'*)
      if printf '%s\n' "$BKT_RUNNING" | grep -qx "$svc"; then printf 'true\n'; else printf 'false\n'; fi
      ;;
    *'.State.FinishedAt'*) printf '%s\n' "$STUB_FINISHED_AT" ;;
    *'.State.Health'*) printf '%s\n' "$STUB_HEALTH" ;;
    *'.State.Status'*)
      if printf '%s\n' "$BKT_RUNNING" | grep -qx "$svc"; then printf 'running\n'; else printf 'exited\n'; fi
      ;;
    *'.Image'*) printf 'sha256:1111111111111111111111111111111111111111111111111111111111111111\n' ;;
    *) cat "$WORLD/containers/$id.json" 2>/dev/null ;;
  esac
  return 0
}

bkt_volume() {
  local a name="" labels="" want=0
  case "$2" in
    create)
      # `docker volume create --label k=v --label k=v <name>`: the NAME is
      # the one argument that is neither a flag nor a flag's value, so the
      # stub has to parse rather than take $3.
      shift 2
      for a in "$@"; do
        if [ "$want" -eq 1 ]; then labels="$labels $a"; want=0; continue; fi
        case "$a" in
          --label) want=1 ;;
          -*) ;;
          *) name="$a" ;;
        esac
      done
      [ -n "$name" ] || return 1
      mkdir -p "$BKT_VOLS/$name" "$BKT_VOLS/.labels"
      # A create that SUCCEEDS and a label that does not stick. Without this
      # the read-back is 0 == 0 by construction and measures nothing — the
      # mutation sweep said so, by surviving.
      if [ "${STUB_DROP_VOLUME_LABELS:-0}" = "1" ]; then
        : > "$BKT_VOLS/.labels/$name"
      else
        printf '%s\n' "${labels# }" > "$BKT_VOLS/.labels/$name"
      fi
      printf '%s\n' "$name"
      ;;
    rm)
      [ "$STUB_VOLUME_RM_RC" -eq 0 ] || return "$STUB_VOLUME_RM_RC"
      shift 2
      for a in "$@"; do
        case "$a" in -*) ;; *) rm -rf "${BKT_VOLS:?}/$a" "$BKT_VOLS/.labels/$a" ;; esac
      done
      ;;
    inspect)
      shift 2
      for a in "$@"; do
        if [ "$want" -eq 1 ]; then want=0; continue; fi
        case "$a" in
          --format) want=1 ;;
          -*) ;;
          *) name="$a" ;;
        esac
      done
      [ -d "$BKT_VOLS/$name" ] || return 1
      # The two compose labels, in the order the verb asks for them.
      if [ -f "$BKT_VOLS/.labels/$name" ]; then
        sed 's/com.docker.compose.project=//; s/com.docker.compose.volume=//' \
          "$BKT_VOLS/.labels/$name"
      fi
      ;;
    ls)
      [ -d "$BKT_VOLS" ] || return 0
      find "$BKT_VOLS" -maxdepth 1 -mindepth 1 -type d -exec basename {} \; 2>/dev/null |
        grep -v '^\.labels$'
      ;;
  esac
  return 0
}

bkt_exec() {
  shift
  shift
  case "$1" in
    psql) bkt_psql "$@" ;;
    pg_isready) return "$STUB_PGISREADY_RC" ;;
    df)
      [ "$STUB_DF_RC" -eq 0 ] || return "$STUB_DF_RC"
      printf 'Filesystem 1024-blocks Used Available Capacity Mounted\n'
      printf '/dev/fake 100000000 1 %s 1%% /var/lib/postgresql/data\n' "$STUB_PGDATA_FREE_KB"
      ;;
    tailscale)
      [ -n "$STUB_TAILNET_JSON" ] && printf '%s\n' "$STUB_TAILNET_JSON"
      return "$STUB_TAILSCALE_RC"
      ;;
  esac
  return 0
}

# The fake server. Every answer is keyed on the SQL the verb SENT, so the
# census's generated statements are read back rather than assumed.
bkt_psql() {
  local db="postgres" sql="" prev="" t
  while [ $# -gt 0 ]; do
    case "$prev" in
      -d) db="$1" ;;
      -c) sql="$1" ;;
    esac
    prev="$1"
    shift
  done
  printf '%s\n' "$sql" >> "$BK_WORLD/sql.log"
  case "$sql" in
    *"pg_database_size"*) printf '%s\n' "$STUB_PG_TOTAL_KB" ;;
    *"FROM pg_database WHERE datallowconn"*)
      printf '%s\n' "$STUB_DATABASES"
      ;;
    *"SHOW server_version_num"*) printf '%s\n' "$STUB_SRV_NUM" ;;
    *"SHOW server_version"*) printf '%s\n' "$STUB_SRV_VER" ;;
    *"information_schema.tables"*)
      for t in $(bkt_tables_of "$db"); do printf 'public\t%s\n' "$t"; done
      ;;
    *"SET LOCAL TimeZone"*)
      # Read the table names back out of the statement the verb generated.
      printf '%s' "$sql" | tr ';' '\n' |
        sed -n "s/^ *SELECT '\\([^']*\\)',.*/\\1/p" |
        while IFS= read -r t; do
          if [ "$STUB_SELFTEST_DIFF" = "1" ] && [ "$db" != "${db#nova_selftest_}" ] &&
            [ "$t" = "public.people" ]; then
            printf '%s\t7\t999\n' "$t"
          elif [ "$STUB_RESTORE_DIFF" = "1" ] && [ -f "$BK_WORLD/scratch/$db" ] &&
            [ "$t" = "public.people" ]; then
            printf '%s\t7\t999\n' "$t"
          else
            printf '%s\t%s\t%s\n' "$t" "${#t}" "$((${#t} * 7))"
          fi
        done
      ;;
    *"FROM schema_migrations"*) printf '%s\n' "$STUB_MIGRATION_ROWS" ;;
    *"FROM pg_database WHERE datname LIKE"*) printf '%s\n' "$STUB_ORPHAN_VERIFY_DBS" ;;
    *"pg_stat_file"*) printf '%s\n' "$STUB_VERIFY_DB_OLD" ;;
    *"FROM pg_stat_activity WHERE datname"*) printf '%s\n' "$STUB_VERIFY_DB_CONNS" ;;
    *"SELECT 1 FROM pg_database WHERE datname"*)
      case "$sql" in
        *"'$STUB_MISSING_DB'"*) [ -n "$STUB_MISSING_DB" ] && return 0 ;;
      esac
      printf '1\n'
      ;;
    *"SELECT 1 FROM pg_roles WHERE rolname"*)
      case "$sql" in
        *"'$STUB_MISSING_ROLE'"*) [ -n "$STUB_MISSING_ROLE" ] && return 0 ;;
      esac
      printf '1\n'
      ;;
    *"SELECT current_database()"*) printf '%s\n' "${STUB_CURRENT_DB:-$db}" ;;
    "CREATE DATABASE"*)
      printf '%s\n' "$sql" >> "$BK_WORLD/dbops.log"
      return "$STUB_CREATEDB_RC"
      ;;
    "DROP DATABASE"*)
      printf '%s\n' "$sql" >> "$BK_WORLD/dbops.log"
      ;;
    *"to_regclass('public.core_signing_key')"* | *"to_regclass('public.devices')"* | *"to_regclass('public.people')"*)
      t="$(cat "$BK_WORLD/scratch/$db" 2>/dev/null)"
      [ -n "$t" ] || t="$db"
      if [ "$t" = "nova_core" ]; then printf 't\n'; else printf 'f\n'; fi
      ;;
    *"count(*) FROM core_signing_key"*) printf '%s\n' "$STUB_SIGNING_ROWS" ;;
    *"encode(sha256("*)
      if [ "$STUB_RESTORED_KEY_DIFFERS" = "1" ] && [ -f "$BK_WORLD/scratch/$db" ]; then
        printf '0000000000000000000000000000000000000000000000000000000000000000\n'
      else
        printf '77d1000000000000000000000000000000000000000000000000000000000000\n'
      fi
      ;;
    *"count(*) FROM devices"*) printf '3\n' ;;
    *"count(*) FROM people"*) printf '1\n' ;;
  esac
  return 0
}

# A scratch database measures the tables of the database it was restored from,
# which bkt_run records when pg_restore names both.
bkt_tables_of() {
  local db="$1" src
  # Any database something has pg_restored INTO measures the tables of the
  # database it came from — which is how both the backup's self-test and the
  # restore's re-measurement are driven by what actually ran.
  src="$(cat "$BK_WORLD/scratch/$db" 2>/dev/null)"
  if [ -n "$src" ]; then
    db="$src"
  elif [ "${STUB_EMPTY_UNTIL_RESTORED:-0}" = "1" ]; then
    # A bare restore target: postgres-init has created the database and
    # nothing has put a table in it yet. §9.2 step 11 requires exactly this
    # to be a normal answer and not a failed reading.
    return 0
  fi
  case "$db" in
    nova_core) printf 'devices people schema_migrations\n' ;;
    nova_gateway) printf 'schema_migrations spend\n' ;;
    nova_memory) printf 'notes schema_migrations\n' ;;
    *) printf 'schema_migrations\n' ;;
  esac
}

# `docker run` — re-run here, with the mounts rewritten.
bkt_run() {
  local img="" ep="" a spec src rest dst detach=0 cname="" cnet=""
  shift
  BKT_MAP="/tmp	$BK_WORLD/ctmp"
  mkdir -p "$BK_WORLD/ctmp"
  while [ $# -gt 0 ]; do
    a="$1"
    case "$a" in
      --rm | -i | -t | -it | --init) shift; continue ;;
      -d | --detach) detach=1; shift; continue ;;
      --name) cname="$2"; shift 2; continue ;;
      --network) cnet="$2"; shift 2; continue ;;
      --user | -e | -w) shift 2; continue ;;
      --entrypoint) ep="$2"; shift 2; continue ;;
      -v)
        spec="$2"
        shift 2
        src="${spec%%:*}"
        rest="${spec#*:}"
        dst="${rest%%:*}"
        case "$src" in /*) ;; *) src="$BKT_VOLS/$src" ;; esac
        BKT_MAP="$BKT_MAP
$dst	$src"
        continue
        ;;
      -*) shift; continue ;;
      *) img="$a"; shift; break ;;
    esac
  done
  [ -n "$img" ] || return 125
  # `docker run -d --name X`: nothing is executed here. The container becomes
  # a name this world knows, attached to the network it was given — which is
  # what `docker inspect`'s network assertion then reads back.
  if [ "$detach" -eq 1 ]; then
    [ "$STUB_DETACH_RC" -eq 0 ] || return "$STUB_DETACH_RC"
    mkdir -p "$BK_WORLD/ct" "$BK_WORLD/ctnet"
    : > "$BK_WORLD/ct/$cname"
    printf '%s' "${BKT_FORCE_CT_NET:-$cnet}" > "$BK_WORLD/ctnet/$cname"
    printf '%s\n' "$cname"
    return 0
  fi
  case "$ep" in
    find | chmod | cmp) bkt_bin "$ep" "$@"; return $? ;;
    pg_dump) PATH="$BK_WORLD/bin:$PATH" pg_dump "$@"; return $? ;;
    pg_restore) bkt_pg_restore "$@"; return $? ;;
    sh) bkt_sh "$@"; return $? ;;
    "") bkt_cmd "$@"; return $? ;;
    *) return 0 ;;
  esac
}

bkt_bin() {
  local cmd="$1" a args=()
  shift
  # python-tool M1, reproduced where it happened: the probe's own `find`
  # fails, writes to stderr and produces NOTHING on stdout. A verb that reads
  # emptiness instead of the exit status calls that "empty, proceed".
  if [ "$cmd" = "find" ] && [ "${STUB_PROBE_RC:-0}" != "0" ]; then
    case " $* " in
      *" /probe "*)
        printf 'find: /probe: Permission denied\n' >&2
        return "$STUB_PROBE_RC"
        ;;
    esac
  fi
  for a in "$@"; do args+=("$(bkt_rewrite "$a")"); done
  "$cmd" "${args[@]}"
}

bkt_sh() {
  local script a args=()
  shift # -ec
  script="$(bkt_rewrite_text "$1")"
  shift
  for a in "$@"; do args+=("$(bkt_rewrite "$a")"); done
  # One knob, for the cases that need a named container step to fail.
  if [ -n "$STUB_SH_FAIL" ]; then
    case "$script" in *"$STUB_SH_FAIL"*) return 9 ;; esac
  fi
  # ...and one that silences the link-target pass without touching the shipped
  # file, so the PRODUCING side's own refusal is what gets measured.
  if [ "$STUB_DROP_LINK_TARGETS" = "1" ]; then
    script="$(printf '%s' "$script" | sed 's|^\( *\)find \. -type l -printf.*$|\1true|')"
  fi
  PATH="$BK_WORLD/bin:$PATH" sh -ec "$script" "${args[@]}"
}

bkt_pg_restore() {
  local a scratch="" dump=""
  local want=""
  case " $* " in
    *" --version "*)
      [ "${STUB_RESTORE_VER_RC:-0}" = "0" ] || return "$STUB_RESTORE_VER_RC"
      printf 'pg_restore (PostgreSQL) %s\n' "${STUB_RESTORE_VER:-16.15}"
      return 0
      ;;
  esac
  for a in "$@"; do
    case "$want" in
      d) scratch="$a"; want="" ;;
      *) ;;
    esac
    case "$a" in
      -d) want=d ;;
      /stage/inner/db/*.dump | /stage/open/db/*.dump) dump="$(basename "$a" .dump)" ;;
    esac
  done
  [ -n "$scratch" ] && [ -n "$dump" ] && printf '%s\n' "$dump" > "$BK_WORLD/scratch/$scratch"
  printf 'pg_restore %s\n' "$*" >> "$BK_WORLD/dbops.log"
  return "$STUB_PGRESTORE_RC"
}

bkt_cmd() {
  local a args=() rc=0 out=""
  case " $* " in *" plan "*) bkt_capture_listing ;; esac
  [ "$1" = "python3" ] || return 0
  shift
  for a in "$@"; do args+=("$(bkt_rewrite "$a")"); done
  nova_py "${args[@]}" || rc=$?
  # python-tool C3, reproduced: a container writes the archive and the
  # operator cannot read it back. `pack` here runs AS the operator, so the
  # only way to put the verb in that state is to take the mode away the
  # moment the file exists.
  # The listing a restore diffs against lives INSIDE the bundle, so the only
  # way to measure "the tree that landed does not match what was sealed" is
  # to change one of the two after the bundle was opened. Changing the
  # LISTING is the same measurement as changing the tree and needs no root:
  # `uid` moves a column this harness cannot otherwise vary, because a test
  # that cannot chown can still prove the column is COMPARED.
  if [ "$rc" -eq 0 ] && [ -n "$STUB_TAMPER_LISTING" ]; then
    case " ${args[*]} " in
      *" --out "*)
        for a in "${args[@]}"; do
          case "$a" in
            */open)
              out="$a/listings/v4_memdata.sha256"
              [ -f "$out" ] || continue
              case "$STUB_TAMPER_LISTING" in
                uid) sed 's|^f \(0[0-7]*\) [0-9]* |f \1 4242 |' "$out" > "$out.t" ;;
                hash) sed 's|^\([0-9a-f]\{64\}\)  ./notes/one.md$|0000000000000000000000000000000000000000000000000000000000000000  ./notes/one.md|' "$out" > "$out.t" ;;
                extra) { cat "$out"; printf 'f 0644 0 0 ./ghost\n'; } > "$out.t" ;;
                *) cp "$out" "$out.t" ;;
              esac
              mv "$out.t" "$out"
              ;;
          esac
        done
        ;;
    esac
  fi
  if [ "$rc" -eq 0 ] && [ "$STUB_UNREADABLE_PART" = "1" ]; then
    case " ${args[*]} " in
      *" pack "*)
        for a in "${args[@]}"; do
          case "$a" in *.part) chmod 000 "$a" 2>/dev/null ;; esac
        done
        ;;
    esac
  fi
  return "$rc"
}

# ── the world the verb runs in ─────────────────────────────────────────────

mkdir -p "$BK_WORLD/svc" "$BK_WORLD/id2svc" "$BK_WORLD/bin" "$BK_WORLD/scratch"
python3 - "$FIXTURES/containers-v4.json" "$BK_WORLD" <<'PY'
import json, sys
fact = json.load(open(sys.argv[1], encoding="utf-8"))
for c in fact["containers"]:
    open(f"{sys.argv[2]}/svc/{c['service']}", "w").write(c["id"])
    open(f"{sys.argv[2]}/id2svc/{c['id']}", "w").write(c["service"])
PY

# Two small binaries, so the SHIPPED dump script runs for real against them.
cat > "$BK_WORLD/bin/pg_dump" <<'SH'
#!/bin/sh
out=""; db=""
while [ $# -gt 0 ]; do
  case "$1" in
    --version) printf 'pg_dump (PostgreSQL) %s\n' "${STUB_DUMP_VER:-16.15}"; exit 0 ;;
    -f) shift; out="$1" ;;
    -d) shift; db="$1" ;;
  esac
  shift
done
[ "${STUB_DUMP_RC:-0}" = "0" ] || exit "${STUB_DUMP_RC}"
[ -n "$out" ] || exit 2
if [ "${STUB_DUMP_TRUNCATED:-0}" = "1" ]; then printf 'PGDM' > "$out"; exit 0; fi
{ printf 'PGDMP'; printf 'a fake dump of %s\n' "$db"; } > "$out"
SH
cat > "$BK_WORLD/bin/pg_restore" <<'SH'
#!/bin/sh
case " $* " in
  *" -l "*)
    [ "${STUB_TOC_EMPTY:-0}" = "1" ] && { printf '; only a comment\n'; exit 0; }
    printf '; Archive created\n1; 2 3 TABLE public thing owner\n'
    exit 0 ;;
esac
exit "${STUB_PGRESTORE_RC:-0}"
SH
# port-v3 M3 needs `cp` ITSELF to fail inside the shipped script, which is
# the only way to prove the script has no `||` branch that turns a failed
# copy into a recorded empty volume.
cat > "$BK_WORLD/bin/cp" <<'SH'
#!/bin/sh
[ "${STUB_CP_FAIL:-0}" = "1" ] && exit 1
exec /bin/cp "$@"
SH
chmod 755 "$BK_WORLD/bin/pg_dump" "$BK_WORLD/bin/pg_restore" "$BK_WORLD/bin/cp"

bkt_reset() {
  rm -rf "$BK_WORLD/out" "$BKT_VOLS" "$BK_WORLD/marker" "$BK_WORLD/pw" \
    "$BK_WORLD/ctmp" "$BK_WORLD/scratch"
  mkdir -p "$BK_WORLD/out" "$BKT_VOLS" "$BK_WORLD/marker" "$BK_WORLD/pw" \
    "$BK_WORLD/ctmp" "$BK_WORLD/scratch"
  : > "$BKT_LOG"
  : > "$BK_WORLD/stop.log"
  : > "$BK_WORLD/up.log"
  : > "$BK_WORLD/dbops.log"
  : > "$BK_WORLD/sql.log"
  printf 1000000 > "$BK_WORLD/clock"
  # The two volumes the compose file classifies `include`. v4_memdata carries
  # a symlink INSIDE the tree on purpose (s41/rulings.md A); v4_workspace is
  # left EMPTY on purpose — it is the volume port-v3 M3 is about.
  mkdir -p "$BKT_VOLS/nova_v4_memdata/notes" "$BKT_VOLS/nova_v4_workspace" \
    "$BKT_VOLS/nova_v4_tailscale"
  printf 'not a real node key\n' > "$BKT_VOLS/nova_v4_tailscale/tailscaled.state"
  printf 'a note\n' > "$BKT_VOLS/nova_v4_memdata/notes/one.md"
  ln -sf one.md "$BKT_VOLS/nova_v4_memdata/notes/current"
  # MIXED MODES, and an empty directory, on purpose. A tree built with one
  # umask round-trips through any copy that keeps nothing — the listing's
  # four columns are types, MODES, uid and gid, and a fixture whose every
  # entry is 0644 cannot tell a copy that preserves them from one that does
  # not. (Ownership cannot be varied without root here, so the uid column is
  # measured the other way round: by moving it in the carried listing and
  # requiring the restore to refuse. See STUB_TAMPER_LISTING.)
  mkdir -p "$BKT_VOLS/nova_v4_memdata/.embeddings" \
    "$BKT_VOLS/nova_v4_memdata/people/empty"
  printf 'private\n' > "$BKT_VOLS/nova_v4_memdata/people/secret.md"
  printf 'read only\n' > "$BKT_VOLS/nova_v4_memdata/.embeddings/cache.jsonl"
  chmod 600 "$BKT_VOLS/nova_v4_memdata/people/secret.md"
  chmod 444 "$BKT_VOLS/nova_v4_memdata/.embeddings/cache.jsonl"
  chmod 700 "$BKT_VOLS/nova_v4_memdata/people"
  chmod 755 "$BKT_VOLS/nova_v4_memdata/people/empty"
  printf '%s' "$PW_VALUE" > "$BK_WORLD/pw/.backup-passphrase"
  chmod 600 "$BK_WORLD/pw/.backup-passphrase"
  # A restore case empties this world into a bare TARGET; the next case gets
  # the world back, or it is measuring a different world from the one it
  # thinks it is.
  [ -f "$WORLD/env.pristine" ] && cp "$WORLD/env.pristine" "$WORLD/repo/deploy/.env"
  : > "$BK_WORLD/pw/.env"
  BKT_RUNNING="$(printf 'core\ngateway\nmemory\npostgres\nsearxng\ntailscale\nweb\nollama\n')"
  STUB_STOP_RC=0
  STUB_STOP_STICKS=1
  STUB_UP_RC=0
  STUB_PGISREADY_RC=0
  STUB_PGRESTORE_RC=0
  STUB_CREATEDB_RC=0
  STUB_SRV_VER="16.15"
  STUB_SRV_NUM="160015"
  STUB_DUMP_VER="16.15"
  STUB_DUMP_RC=0
  STUB_DUMP_TRUNCATED=0
  STUB_TOC_EMPTY=0
  STUB_PG_TOTAL_KB=2048
  STUB_PGDATA_FREE_KB=90000000
  STUB_FINISHED_AT="2099-01-01T00:00:00.000000000Z"
  STUB_HEALTH="healthy"
  STUB_SELFTEST_DIFF=0
  STUB_CURRENT_DB=""
  STUB_SIGNING_ROWS=1
  STUB_MIGRATION_ROWS="001_init.sql"
  STUB_TAILNET_JSON=""
  STUB_TAILSCALE_RC=1
  STUB_SH_FAIL=""
  STUB_CP_FAIL=0
  BKT_NO_CONTAINER=""
  STUB_DF_RC=0
  STUB_VOLUME_RM_RC=0
  STUB_UNREADABLE_PART=0
  STUB_DROP_LINK_TARGETS=0
  # ── the knobs restore and drill add ──────────────────────────────────────
  STUB_PROBE_RC=0
  STUB_NETWORK_RM_RC=0
  STUB_DETACH_RC=0
  STUB_PULL_RC=0
  STUB_PULL_LANDS=1
  STUB_RESTORE_VER="16.15"
  STUB_RESTORE_VER_RC=0
  STUB_DROP_VOLUME_LABELS=0
  STUB_RESTORE_DIFF=0
  STUB_RESTORED_KEY_DIFFERS=0
  STUB_TAMPER_LISTING=""
  STUB_EMPTY_UNTIL_RESTORED=0
  STUB_MISSING_DB=""
  STUB_MISSING_ROLE=""
  STUB_ORPHAN_VERIFY_DBS=""
  STUB_VERIFY_DB_CONNS=0
  STUB_VERIFY_DB_OLD=1
  BKT_BARE_TARGET=0
  BKT_FORCE_CT_NET=""
  rm -rf "$BK_WORLD/ct" "$BK_WORLD/ctnet" "$BK_WORLD/net" "$BK_WORLD/images"
  mkdir -p "$BK_WORLD/ct" "$BK_WORLD/ctnet" "$BK_WORLD/net" "$BK_WORLD/images"
  # Both images this host already has, so the happy path pulls nothing.
  : > "$BK_WORLD/images/postgres_16"
  : > "$BK_WORLD/images/nova-core"
}

# One run of the verb, in its own subshell — which is where its EXIT trap
# fires, exactly as it would when install.sh exits.
bkt_backup() {
  (
    # BKT_SET_E drives the verb the way ./install does (deploy/install.sh:8).
    [ "${BKT_SET_E:-0}" = "1" ] && set -e
    cd "$WORLD/repo" || exit 9
    bk_docker() { bkt_docker "$@"; }
    bk_git() { git "$@"; }
    BK_COMPOSE_FILES="$WORLD/repo/deploy/docker-compose.yml"
    BK_ENV_FILE="$WORLD/repo/deploy/.env"
    BK_ENV_EXAMPLE="$WORLD/repo/deploy/.env.example"
    # Read by the sourced deploy/backup.sh in this same shell — shellcheck
    # cannot see across the `.` above.
    # shellcheck disable=SC2034
    BK_REPO_ROOT="$WORLD/repo"
    # shellcheck disable=SC2034
    BK_MOVED_MARKER="$BK_WORLD/marker/.moved"
    # shellcheck disable=SC2034
    BK_MOVED_TO_MARKER="$BK_WORLD/marker/MOVED_TO"
    NP_DIR="$BK_WORLD/pw"
    NP_ENV_FILE="$BK_WORLD/pw/.env"
    export BK_COMPOSE_FILES BK_ENV_FILE BK_ENV_EXAMPLE
    export STUB_DUMP_VER STUB_DUMP_RC STUB_DUMP_TRUNCATED STUB_TOC_EMPTY STUB_PGRESTORE_RC
    # The two poll loops are bounded by the clock, not by a sleep count
    # (install.sh:1722-1726 says why). A clock that jumps 1000s a reading
    # reaches every deadline on the first poll, so the timeout cases cost no
    # wall time and the happy path — which never polls twice — is unchanged.
    #
    # The counter lives in a FILE, not in a variable: every one of these
    # readings is `$(date +%s)`, a command substitution, and an assignment
    # made inside one happens in a subshell that then exits. A variable here
    # returned the same second for ever and the "writer will not stop" case
    # span until it was killed.
    date() {
      local now
      case "$*" in
        "+%s")
          now=$(( $(cat "$BK_WORLD/clock" 2>/dev/null || printf 1000000) + 1000 ))
          printf '%s' "$now" > "$BK_WORLD/clock"
          printf '%s\n' "$now"
          ;;
        *) command date "$@" ;;
      esac
    }
    cmd_backup --out "$BK_WORLD/out" "$@"
  ) > "$BK_WORLD/stdout" 2> "$BK_WORLD/stderr"
  BKT_RC=$?
  BKT_OUT="$(cat "$BK_WORLD/stdout")"
  BKT_ERR="$(cat "$BK_WORLD/stderr")"
}

bkt_bundle() { find "$BK_WORLD/out" -maxdepth 1 -name 'nova-backup-*.tar' | head -1; }

# The volume listing, copied out of the staging volume as it is written —
# the EXIT trap removes that volume, and the listing is the one artifact in
# it that nothing else re-derives.
bkt_capture_listing() {
  local f
  f="$(find "$BKT_VOLS" -path '*/inner/listings/v4_memdata.sha256' 2>/dev/null | head -1)"
  [ -n "$f" ] && /bin/cp "$f" "$BK_WORLD/listing-check" 2>/dev/null
  return 0
}

# The manifest out of a finished bundle, through the shipped reader's own
# library — so every assertion below is about what the BUNDLE carries and not
# about what the verb said it carried.
cat > "$BK_WORLD/read_manifest.py" <<'PY'
import json
import sys
import tempfile

sys.path.insert(0, sys.argv[1])
from novabundle import read_passphrase, verify_bundle

pw = read_passphrase()
result = verify_bundle(sys.argv[2], pw, tempfile.mkdtemp())
if result["problems"]:
    raise SystemExit("problems: " + "; ".join(result["problems"]))
json.dump(result["manifest"], sys.stdout)
PY

bkt_manifest() {
  printf '%s\n' "$PW_VALUE" |
    nova_py "$BK_WORLD/read_manifest.py" "$SCRIPT_DIR/backup" "$1"
}

if [ "$BKT_GNU" -ne 1 ]; then
  SKIP=$((SKIP + 1))
  printf 'SKIP the whole-verb cases: this userland has no `find -printf` / `xargs -a`,\n'
  printf '     so the container scripts cannot be re-run here. They always run inside a\n'
  printf '     Linux image in production; the shell that DECIDES is covered above.\n'
else

  # ── the happy path, and everything it proves ─────────────────────────────
  bkt_reset
  bkt_backup
  expect_str "the_verb_exits_0_on_a_stack_that_covers_itself" "$BKT_RC" "0"
  if [ "$BKT_RC" -ne 0 ]; then
    printf '     stdout: %s\n     stderr: %s\n' "$BKT_OUT" "$BKT_ERR"
  fi
  BUNDLE="$(bkt_bundle)"
  expect_str "a_bundle_is_published_and_no_part_file_is_left" \
    "$(find "$BK_WORLD/out" -maxdepth 1 -name '*.part' | wc -l | tr -d ' ')" "0"
  if [ -n "$BUNDLE" ]; then
    report 0 "the_happy_path_publishes_a_bundle"
  else
    report 1 "the_happy_path_publishes_a_bundle" "nothing matching nova-backup-*.tar in $BK_WORLD/out"
  fi

  # python-tool C3, a measured incident: a container writing the archive
  # produces a root-owned mode-0600 file and the host-side verification —
  # running AS THE OPERATOR — then cannot read it back. OWNERSHIP is what is
  # relaxed; the mode is not.
  expect_str "the_operator_can_read_the_file_the_container_wrote" \
    "$(bk_mode_of "$BUNDLE")" "600"
  expect_has "the_operator_can_read_the_file_the_container_wrote" \
    "$BKT_OUT" "the operator read it back: sha256 $(sha256_of "$BUNDLE")"
  expect_str "the_published_bundle_belongs_to_the_invoking_user" \
    "$(find "$BUNDLE" -user "$(id -u)" | wc -l | tr -d ' ')" "1"

  # §9.1 step 20: the reader that ships INSIDE the bundle opened it, with
  # `cryptography` forced unimportable, and it is byte-identical to the git
  # copy. Not "the format round-trips" — "this artifact is restorable".
  expect_has "the_shipped_reader_opens_the_finished_bundle" \
    "$BKT_OUT" "the reader carried inside the bundle opened it"
  expect_has "the_shipped_reader_reports_what_it_verified" "$BKT_OUT" \
    "verified: 15 members, 2 volumes, 3 databases, all matching the manifest sealed inside"
  expect_has "step_20_runs_the_ctypes_path_a_bare_machine_would_take" \
    "$(cat "$BKT_LOG")" "NOVA_FORCE_CTYPES_GCM=1"

  MANIFEST="$(bkt_manifest "$BUNDLE")"
  expect_has "the_bundle_carries_the_three_databases" "$MANIFEST" '"name": "nova_core"'
  expect_has "the_bundle_carries_the_three_databases" "$MANIFEST" '"name": "nova_gateway"'
  expect_has "the_bundle_carries_the_three_databases" "$MANIFEST" '"name": "nova_memory"'
  expect_has "the_bundle_carries_the_notes_volume" "$MANIFEST" '"key": "v4_memdata"'
  expect_has "the_bundle_carries_the_workspace_volume" "$MANIFEST" '"key": "v4_workspace"'
  expect_has "the_bundle_carries_the_one_file_nothing_regenerates" \
    "$MANIFEST" '"origin": "deploy/.env"'
  # R1: the tag pins the major only, so the exact server version travels and
  # the comparison belongs at restore time.
  expect_has "the_manifest_records_the_exact_server_version" \
    "$MANIFEST" '"server_version": "16.15"'
  expect_has "the_manifest_records_the_exact_server_version" \
    "$MANIFEST" '"server_version_num": 160015'
  expect_has "the_manifest_records_the_session_the_digests_were_measured_under" \
    "$MANIFEST" '"IntervalStyle": "postgres"'
  expect_has "the_selftest_is_recorded_as_a_number_compared_not_as_ok" \
    "$MANIFEST" '"tables_compared": 3'
  expect_has "the_manifest_names_the_scratch_database_it_used" \
    "$MANIFEST" '"scratch_db": "nova_selftest_'
  # s41/rulings.md B: the field is migrations_member, a TSV path.
  expect_has "the_manifest_names_a_migrations_member_and_not_a_migrations_array" \
    "$MANIFEST" '"migrations_member": "db/nova_core.migrations.tsv"'

  # §9.2 step 8 / python-tool M4: the carried key set is the `carry` rows and
  # nothing else. COMPOSE_FILE is `host` and INSTANCE_SECRET is `drop`.
  expect_has "env_carries_only_the_carry_disposition" "$MANIFEST" '"POSTGRES_PASSWORD"'
  expect_has "env_carries_only_the_carry_disposition" "$MANIFEST" '"SEARXNG_SECRET"'
  expect_lacks "env_host_local_keys_are_never_carried" "$MANIFEST" '"COMPOSE_FILE"'
  expect_lacks "env_host_local_keys_are_never_carried" "$MANIFEST" '"INSTANCE_SECRET"'

  # §7.5: the passphrase reaches exactly one place — the first line of the
  # pack container's stdin. `docker inspect` shows -e for a container's whole
  # lifetime and `ps` shows argv to every user on the box.
  expect_lacks "passphrase_never_reaches_argv" "$(cat "$BKT_LOG")" "$PW_VALUE"
  # A PINNED set, not a substring hunt: the one `-e` this verb passes is
  # libpq's PGPASSFILE, which names a path inside the staging volume and
  # carries no secret. Adding any other reddens this.
  expect_str "the_only_env_var_any_container_gets_is_a_path" \
    "$(grep -o -- '-e [^ ]*' "$BKT_LOG" | sort -u | tr '\n' ' ')" \
    "-e PGPASSFILE=/stage/.pgpass "
  expect_lacks "passphrase_never_reaches_an_env_var" \
    "$(grep -o -- '-e [^ ]*' "$BKT_LOG" | sort -u)" "NOVA_BACKUP_PASSPHRASE"
  expect_lacks "the_passphrase_is_in_no_field_of_the_manifest" "$MANIFEST" "$PW_VALUE"
  expect_lacks "the_report_never_prints_the_passphrase" "$BKT_OUT" "$PW_VALUE"

  # The plaintext dumps hold the signing key and every provider API key. The
  # dump container writes into a NAMED VOLUME the host never mounts.
  # The dump container's own argv: it joins the project network and mounts a
  # NAMED VOLUME at /stage. No host path, so the plaintext dump — which holds
  # the signing key and every provider API key — cannot land on this disk.
  expect_has "the_dump_is_written_into_a_volume_the_host_never_mounts" \
    "$(cat "$BKT_LOG")" "--network nova_default -v nova-backup-stage-"
  expect_has "the_dump_volume_is_mounted_at_stage" \
    "$(grep -o -- '-v nova-backup-stage-[^ ]*' "$BKT_LOG" | sort -u | head -1)" ":/stage"
  expect_str "no_plaintext_dump_is_left_behind_on_the_host" \
    "$(find "$BK_WORLD" -name '*.dump' 2>/dev/null | wc -l | tr -d ' ')" "0"
  expect_str "the_staging_volume_is_removed_when_the_run_finishes" \
    "$(find "$BKT_VOLS" -maxdepth 1 -name 'nova-backup-stage-*' | wc -l | tr -d ' ')" "0"

  # §9.1 step 9: the six GUCs are pinned in the SAME statement as the
  # measurement, because t::text renders through them.
  GUCSQL="$(grep -c "SET LOCAL TimeZone='UTC'; SET LOCAL DateStyle='ISO, MDY'; SET LOCAL IntervalStyle='postgres'; SET LOCAL extra_float_digits=0; SET LOCAL bytea_output='hex'; SET LOCAL lc_numeric='C'; SELECT " "$BK_WORLD/sql.log")"
  if [ "$GUCSQL" -ge 6 ]; then
    report 0 "the_census_pins_the_six_gucs_in_the_same_statement_as_the_measurement"
  else
    report 1 "the_census_pins_the_six_gucs_in_the_same_statement_as_the_measurement" \
      "only $GUCSQL statements carried all six SET LOCALs followed by the measurement"
  fi
  expect_lacks "the_census_never_uses_the_string_agg_form_with_its_1gb_ceiling" \
    "$(cat "$BK_WORLD/sql.log")" "string_agg"
  expect_has "the_census_digest_is_the_constant_memory_sum_form" \
    "$(cat "$BK_WORLD/sql.log")" "coalesce(sum(('x'||substr(md5(t::text),1,16))::bit(64)::bigint), 0)"

  # §5.5 / s41/rulings.md A: a link inside the tree travels, and the listing
  # covers types, modes and ownership — not just regular files.
  expect_has "the_listing_covers_types_and_modes_not_only_regular_files" \
    "$MANIFEST" '"listing_member": "listings/v4_memdata.sha256"'
  # WHERE a link points is data. The four columns of §5.5 say a link exists
  # and nothing about its target, so repointing `notes/current` from one set
  # of notes to another used to pass pack, verify and the reader alike. The
  # listing carries an `L <path> -> <target>` line per link, and
  # `novabundle.py verify` refuses a link the listing gives no target for —
  # which is how this was caught, by the whole happy path going red.
  expect_has "the_listing_records_where_each_symlink_points" \
    "$(cat "$BK_WORLD/listing-check" 2>/dev/null)" "L ./notes/current -> one.md"
  expect_has "the_step_says_how_many_links_it_recorded_a_target_for" \
    "$BKT_OUT" "1 links targeted"
  expect_has "an_empty_carried_volume_is_carried_and_says_so" "$BKT_OUT" \
    "volume v4_workspace (nova_v4_workspace): 0 entries copied"

  # §9.1 step 23: the report names every excluded row WITH its reason. A
  # restore that cannot say what it is missing invites the operator to assume
  # it is missing nothing.
  expect_has "the_report_names_every_excluded_row" "$BKT_OUT" "exclude-redownload"
  expect_has "the_report_names_every_excluded_row" "$BKT_OUT" "v4_ollama"
  # A bind and a host path carry a null `full_name`, and the row that names
  # them is where a collapsed field first shows: the report printed the
  # SERVICE where the path belongs until the separator was measured.
  expect_has "the_report_names_a_bind_it_did_not_carry_with_its_own_path" \
    "$BKT_OUT" "exclude-derived bind   $WORLD/repo/data"
  expect_has "the_report_gives_a_bind_row_its_reason" \
    "$BKT_OUT" "rewritten by detect_hardware on every install"
  expect_has "the_report_gives_the_exact_restore_line" "$BKT_OUT" "./install restore $BUNDLE"
  expect_has "the_report_gives_the_no_nova_restore_line" "$BKT_OUT" "tar -xOf $BUNDLE restore.sh"
  expect_has "the_report_names_the_passphrase_fingerprint_and_its_kind" \
    "$BKT_OUT" "scrypt-key"

  # §9.1 step 22, routine: the writers came back and each was read as healthy.
  expect_has "the_writers_are_restarted_and_each_is_read_as_healthy" \
    "$BKT_OUT" "restarted: core gateway memory, every one healthy"
  expect_has "the_restart_names_exactly_what_was_stopped" \
    "$(cat "$BK_WORLD/up.log")" "up -d core gateway memory"
  expect_str "postgres_is_never_stopped_by_a_routine_backup" \
    "$(sed -n 's/.* stop //p' "$BK_WORLD/stop.log")" "core gateway memory"

  # The self-test database is dropped either way, and its name is asserted a
  # third time before the DROP.
  expect_has "the_selftest_database_is_dropped" "$(cat "$BK_WORLD/dbops.log")" \
    "DROP DATABASE IF EXISTS"
  expect_str "exactly_one_scratch_database_per_carried_database" \
    "$(grep -c '^CREATE DATABASE' "$BK_WORLD/dbops.log")" "3"

  # ── under install.sh's own shell settings ────────────────────────────────
  #
  # deploy/install.sh:8 is `set -euo pipefail` and it sources backup.sh, so
  # this is how the verb really runs. Under a live `-e` the shell exits at the
  # first `x="$(cmd)"` whose command failed — BEFORE the `[ -z "$x" ]` that
  # would have said why — and every stated refusal in §9.1 becomes a bare
  # status. cmd_backup turns `-e` off for its own length and puts it back.
  bkt_reset
  BKT_SET_E=1
  bkt_backup
  expect_str "the_verb_runs_under_install_sh_s_own_set_euo_pipefail" "$BKT_RC" "0"
  if [ "$BKT_RC" -ne 0 ]; then printf '     stderr: %s\n' "$BKT_ERR"; fi
  expect_has "and_still_publishes_a_bundle_the_shipped_reader_opens" \
    "$BKT_OUT" "the reader carried inside the bundle opened it"

  # The case that matters: a reading that fails is a SENTENCE, not a status.
  bkt_reset
  BKT_SET_E=1
  STUB_DF_RC=1
  bkt_backup
  STUB_DF_RC=0
  BKT_SET_E=0
  expect_str "a_reading_that_fails_under_set_e_still_refuses_with_a_reason" "$BKT_RC" "1"
  expect_has "a_reading_that_fails_under_set_e_still_refuses_with_a_reason" \
    "$BKT_ERR" "answered nothing, so nothing here knows whether the self-test restore"
  expect_str "and_a_refusal_under_set_e_stops_nothing" \
    "$(wc -c < "$BK_WORLD/stop.log" | tr -d ' ')" "0"

  # The EXIT trap fires with -e live, because the verb has already put it back
  # by then. A cleanup either finishes every branch or names what it could not
  # do — under `-e` the first removal it cannot do would abort it half way,
  # and the writers would stay stopped.
  bkt_reset
  BKT_SET_E=1
  STUB_VOLUME_RM_RC=1
  STUB_SH_FAIL="nova_restore.py"
  bkt_backup
  STUB_SH_FAIL=""
  STUB_VOLUME_RM_RC=0
  BKT_SET_E=0
  expect_str "a_cleanup_under_set_e_finishes_every_branch" "$BKT_RC" "1"
  expect_has "the_cleanup_names_the_volume_it_could_not_remove" \
    "$BKT_ERR" "is still there. It holds the"
  expect_has "and_restarts_the_writers_anyway" \
    "$(cat "$BK_WORLD/up.log")" "up -d core gateway memory"
  expect_str "and_leaves_no_part_file" \
    "$(find "$BK_WORLD/out" -maxdepth 1 -name '*.part' | wc -l | tr -d ' ')" "0"

  # The flag is PUT BACK: a verb that quietly left -e off would disarm every
  # caller after it.
  (
    set -e
    bk_docker() { bkt_docker "$@"; }
    # `|| true`, because -e IS live here: a bare non-zero return would end the
    # subshell before the flag could be read back, which is the whole check.
    cmd_backup --transport nonsense >/dev/null 2>&1 || true
    case "$-" in
      *e*) exit 0 ;;
      *) exit 7 ;;
    esac
  )
  expect_str "the_verb_restores_set_e_on_the_way_out" "$?" "0"

  # ── a coverage refusal is exit 3, and it is NEVER a success ──────────────
  #
  # `rc=$?` inside `if ! cmd; then` reads the NEGATION's status, which is 0
  # whenever the command failed. The verb printed two lines and returned 0
  # having written nothing, and only a case that reads the CODE could see it.
  bkt_reset
  rm -rf "${BKT_VOLS:?}/nova_v4_memdata"
  bkt_backup
  expect_str "a_coverage_refusal_exits_3_and_is_never_reported_as_success" "$BKT_RC" "3"
  expect_has "a_coverage_refusal_names_what_it_could_not_account_for" \
    "$BKT_ERR" "R5_VOLUME_MISSING"
  expect_has "a_coverage_refusal_says_nothing_was_stopped" \
    "$BKT_ERR" "Nothing was stopped, dumped or written"
  expect_str "a_coverage_refusal_stops_nothing" \
    "$(wc -c < "$BK_WORLD/stop.log" | tr -d ' ')" "0"

  # ── §9.1 step 19, the half only the HOST can prove ───────────────────────
  #
  # python-tool C3, and it is a measured incident, not a hypothesis: a
  # container writing the archive produces a root-owned mode-0600 file and the
  # host-side verification, running as the operator, cannot read it back —
  # after which he cannot sha256sum, scp, open or delete his own backup
  # without sudo, and the DoD walk stops at the copy. Asserting that two
  # digests match does not measure this; taking the mode away does.
  bkt_reset
  STUB_UNREADABLE_PART=1
  bkt_backup
  STUB_UNREADABLE_PART=0
  chmod 600 "$BK_WORLD/out"/*.part 2>/dev/null
  expect_str "a_bundle_the_operator_cannot_read_back_is_a_refusal" "$BKT_RC" "1"
  expect_has "a_bundle_the_operator_cannot_read_back_is_a_refusal" \
    "$BKT_ERR" "this user cannot read it back"
  expect_has "the_refusal_names_the_chown_that_did_not_survive" \
    "$BKT_ERR" "The chown the"
  expect_str "and_nothing_is_published" \
    "$(find "$BK_WORLD/out" -maxdepth 1 -name 'nova-backup-*.tar' | wc -l | tr -d ' ')" "0"

  # ── the collision loop (§9.1 step 21) ────────────────────────────────────
  bkt_reset
  (
    bk_stamp() { printf '20260921T143002Z\n'; }
    bkt_backup
    bkt_backup
    printf '%s\n' "$BKT_RC" > "$BK_WORLD/rc2"
  )
  expect_str "two_bundles_in_the_same_second_do_not_clobber_each_other" \
    "$(find "$BK_WORLD/out" -maxdepth 1 -name 'nova-backup-*-20260921T143002Z*.tar' | wc -l | tr -d ' ')" "2"
  expect_str "the_collision_loop_appends_a_suffix_rather_than_replacing" \
    "$(find "$BK_WORLD/out" -maxdepth 1 -name '*-20260921T143002Z-2.tar' | wc -l | tr -d ' ')" "1"

  # ── the run lock (shell-first M11) ───────────────────────────────────────
  bkt_reset
  mkdir -p "$BK_WORLD/out/.nova-backup.lock"
  printf '20260921T143002Z\n' > "$BK_WORLD/out/.nova-backup.lock/started"
  bkt_backup
  expect_str "run_lock_refuses_a_second_backup" "$BKT_RC" "1"
  expect_has "run_lock_refuses_a_second_backup" "$BKT_ERR" "a backup is already running"
  expect_has "the_lock_refusal_says_since_when" "$BKT_ERR" "20260921T143002Z"
  expect_str "a_refused_second_run_stops_nothing" "$(wc -c < "$BK_WORLD/stop.log" | tr -d ' ')" "0"
  rm -rf "$BK_WORLD/out/.nova-backup.lock"

  # ── a parked host (§9.5) ─────────────────────────────────────────────────
  bkt_reset
  printf 'moved_at=20260921T143002Z\nbundle=nova-backup-x.tar\n' > "$BK_WORLD/marker/.moved"
  bkt_backup
  expect_str "a_moved_host_refuses_before_anything_is_read" "$BKT_RC" "1"
  expect_has "a_moved_host_refusal_prints_the_marker" "$BKT_ERR" "nova-backup-x.tar"
  expect_has "a_moved_host_refusal_names_undo_move" "$BKT_ERR" "undo-move"

  # ── step 7: a writer that will not stop, and the trap ────────────────────
  bkt_reset
  STUB_STOP_STICKS=0
  bkt_backup
  expect_str "refuses_when_a_writer_will_not_stop" "$BKT_RC" "1"
  expect_has "refuses_when_a_writer_will_not_stop" "$BKT_ERR" "could not confirm"
  expect_has "and_restarts_what_it_stopped" "$(cat "$BK_WORLD/up.log")" "up -d core gateway memory"
  expect_str "and_writes_no_bundle" "$(find "$BK_WORLD/out" -name 'nova-backup-*' | wc -l | tr -d ' ')" "0"

  # ── step 7: a writer with no container at all is a failure, not a pass ───
  bkt_reset
  BKT_NO_CONTAINER=memory
  bkt_backup
  BKT_NO_CONTAINER=""
  expect_str "a_writer_with_no_container_cannot_be_confirmed_stopped" "$BKT_RC" "1"
  expect_has "a_writer_with_no_container_cannot_be_confirmed_stopped" \
    "$BKT_ERR" 'no container of this project for the writer `memory`'

  # ── step 7: a container that was already dead is not read as "we stopped it"
  bkt_reset
  STUB_FINISHED_AT="2001-01-01T00:00:00.000000000Z"
  bkt_backup
  expect_str "refuses_when_a_writer_was_already_dead" "$BKT_RC" "1"
  expect_has "refuses_when_a_writer_was_already_dead" "$BKT_ERR" "already down for some other reason"

  # ── the EXIT trap restarts EXACTLY what step 7 stopped (port-v3 M8) ──────
  bkt_reset
  STUB_PGISREADY_RC=1
  bkt_backup
  expect_str "a_dead_server_after_the_stop_refuses" "$BKT_RC" "1"
  expect_str "the_exit_trap_restarts_exactly_what_step_7_stopped" \
    "$(sed -n 's/.*up -d //p' "$BK_WORLD/up.log" | tr -d ' \n')" "coregatewaymemory"
  # NOT the staging volume here: step 8 fails BEFORE it is created, so
  # asserting its absence would assert the absence of something that never
  # existed. That case lives at the round-trip failure below, where the volume
  # exists and holds three plaintext dumps. (Measured: flipping the trap's
  # `-n` to `-z` left the assertion that used to sit here green.)
  expect_str "the_exit_trap_releases_the_run_lock" \
    "$(find "$BK_WORLD/out" -maxdepth 1 -name '.nova-backup.lock' | wc -l | tr -d ' ')" "0"

  # ── step 8: the majors must agree ────────────────────────────────────────
  bkt_reset
  STUB_DUMP_VER="15.7"
  bkt_backup
  expect_str "refuses_when_pg_majors_differ" "$BKT_RC" "1"
  expect_has "refuses_when_pg_majors_differ" "$BKT_ERR" "major 16 against major 15"

  # ── step 10: size alone is not enough ────────────────────────────────────
  bkt_reset
  STUB_DUMP_TRUNCATED=1
  bkt_backup
  expect_str "a_dump_that_is_not_PGDMP_refuses" "$BKT_RC" "1"
  expect_has "a_dump_that_is_not_PGDMP_refuses" "$BKT_ERR" "the five bytes PGDMP"

  bkt_reset
  STUB_TOC_EMPTY=1
  bkt_backup
  expect_str "a_dump_whose_table_of_contents_is_empty_refuses" "$BKT_RC" "1"
  expect_has "a_dump_whose_table_of_contents_is_empty_refuses" "$BKT_ERR" "at least one entry"

  # ── step 11: a DSN that looks right and resolves elsewhere ───────────────
  bkt_reset
  STUB_CURRENT_DB="postgres"
  bkt_backup
  expect_str "the_selftest_refuses_when_the_connection_lands_elsewhere" "$BKT_RC" "1"
  expect_has "the_selftest_refuses_when_the_connection_lands_elsewhere" \
    "$BKT_ERR" "resolves elsewhere"
  expect_str "and_nothing_was_written_into_the_wrong_database" \
    "$(grep -c 'pg_restore' "$BK_WORLD/dbops.log")" "0"

  # ── step 11: one differing table refuses, naming it ──────────────────────
  bkt_reset
  STUB_SELFTEST_DIFF=1
  bkt_backup
  expect_str "a_selftest_that_does_not_measure_equal_refuses" "$BKT_RC" "1"
  expect_has "a_selftest_that_does_not_measure_equal_refuses" \
    "$BKT_ERR" "does not measure equal"
  expect_has "the_refusal_names_the_first_differing_table" "$BKT_ERR" "public.people"
  expect_lacks "never_prints_verified_when_a_count_differs" "$BKT_OUT" "verified"

  # ── step 12: a link the listing gives no target for is a refusal ─────────
  #
  # s41/rulings.md C3: a RETARGETED symlink was invisible to every verifier,
  # because §5.5's four columns say a link exists and nothing about where it
  # points. The `L` pass closes that — and a listing that names an `l` entry
  # with no `L` line is a refusal, not a skip, or the pass is advisory and the
  # gap reopens the day it quietly stops producing lines.
  bkt_reset
  STUB_DROP_LINK_TARGETS=1
  bkt_backup
  STUB_DROP_LINK_TARGETS=0
  expect_str "a_listing_that_names_a_link_without_its_target_refuses" "$BKT_RC" "1"
  expect_has "a_listing_that_names_a_link_without_its_target_refuses" \
    "$BKT_ERR" "holds 1 symlinks and its listing carries"
  expect_has "the_refusal_says_what_the_target_line_is_for" \
    "$BKT_ERR" "cannot notice that link being repointed"
  expect_str "and_no_bundle_is_written_without_it" \
    "$(find "$BK_WORLD/out" -name 'nova-backup-*' | wc -l | tr -d ' ')" "0"

  # ── step 12: a failed copy is NOT an empty volume (port-v3 M3) ───────────
  #
  # `cp` itself fails inside the SHIPPED script, which is the only way to
  # prove the script has no `||` branch that turns a failure into a success
  # and records the volume as carried.
  bkt_reset
  STUB_CP_FAIL=1
  export STUB_CP_FAIL
  bkt_backup
  unset STUB_CP_FAIL
  expect_str "a_failed_tar_is_not_reported_as_an_empty_volume" "$BKT_RC" "1"
  expect_has "a_failed_tar_is_not_reported_as_an_empty_volume" \
    "$BKT_ERR" "Nothing here treats"
  expect_str "and_no_bundle_is_published" \
    "$(find "$BK_WORLD/out" -name 'nova-backup-*' | wc -l | tr -d ' ')" "0"

  # ── step 9: a migration row whose file is not in this checkout ───────────
  bkt_reset
  STUB_MIGRATION_ROWS="099_not_here.sql"
  bkt_backup
  expect_str "a_migration_row_with_no_file_refuses" "$BKT_RC" "1"
  expect_has "a_migration_row_with_no_file_refuses" "$BKT_ERR" "099_not_here.sql"
  expect_has "the_refusal_says_why_the_restore_gate_needs_it" "$BKT_ERR" "by CONTENT"

  # ── step 20: a failed round trip deletes the .part ───────────────────────
  bkt_reset
  STUB_SH_FAIL="nova_restore.py"
  bkt_backup
  STUB_SH_FAIL=""
  expect_str "round_trip_failure_refuses" "$BKT_RC" "1"
  expect_str "round_trip_failure_deletes_the_part_file" \
    "$(find "$BK_WORLD/out" -maxdepth 1 -name '*.part' | wc -l | tr -d ' ')" "0"
  expect_str "round_trip_failure_publishes_nothing" \
    "$(find "$BK_WORLD/out" -maxdepth 1 -name 'nova-backup-*.tar' | wc -l | tr -d ' ')" "0"
  # The volume exists by now and holds three plaintext dumps, the carried .env
  # values and the postgres password. A run that fails this late still takes
  # them with it.
  expect_str "the_exit_trap_leaves_no_staging_volume_behind" \
    "$(find "$BKT_VOLS" -maxdepth 1 -name 'nova-backup-stage-*' | wc -l | tr -d ' ')" "0"
  expect_str "and_no_plaintext_dump_survives_a_late_failure" \
    "$(find "$BK_WORLD" -name '*.dump' 2>/dev/null | wc -l | tr -d ' ')" "0"
  expect_lacks "the_word_verified_is_never_printed_before_the_shipped_reader_ran" \
    "$BKT_OUT" "verified"

  # ── step 22: the bundle and the unhealthy restart are two separate facts ─
  bkt_reset
  STUB_HEALTH="starting"
  bkt_backup
  expect_str "reports_the_bundle_and_the_unhealthy_restart_as_two_separate_facts" \
    "$BKT_RC" "4"
  expect_has "reports_the_bundle_and_the_unhealthy_restart_as_two_separate_facts" \
    "$BKT_ERR" "the bundle IS written and verified at"
  expect_has "reports_the_bundle_and_the_unhealthy_restart_as_two_separate_facts" \
    "$BKT_ERR" "did not come back healthy"
  expect_has "the_unhealthy_report_carries_the_last_log_lines" \
    "$BKT_ERR" "a captured log line"
  expect_str "an_unhealthy_restart_still_leaves_the_bundle_published" \
    "$(find "$BK_WORLD/out" -maxdepth 1 -name 'nova-backup-*.tar' | wc -l | tr -d ' ')" "1"

  # ── free space, on both filesystems ──────────────────────────────────────
  bkt_reset
  STUB_PG_TOTAL_KB=900000000
  bkt_backup
  expect_str "refuses_when_the_archive_filesystem_is_too_small" "$BKT_RC" "1"
  expect_has "refuses_when_the_archive_filesystem_is_too_small" "$BKT_ERR" "four copies"
  expect_str "a_free_space_refusal_stops_nothing" \
    "$(wc -c < "$BK_WORLD/stop.log" | tr -d ' ')" "0"

  bkt_reset
  STUB_PGDATA_FREE_KB=16
  bkt_backup
  expect_str "free_space_checks_the_postgres_filesystem_separately" "$BKT_RC" "1"
  expect_has "free_space_checks_the_postgres_filesystem_separately" \
    "$BKT_ERR" "/var/lib/postgresql/data"
  expect_has "free_space_checks_the_postgres_filesystem_separately" \
    "$BKT_ERR" "on THAT filesystem"

  # ── --move (§9.5) ────────────────────────────────────────────────────────
  bkt_reset
  bkt_backup --move
  expect_str "a_move_leaves_the_stack_stopped_and_writes_both_markers" "$BKT_RC" "0"
  if [ "$BKT_RC" -ne 0 ]; then printf '     stderr: %s\n' "$BKT_ERR"; fi
  # §9.5: a move leaves the WHOLE stack stopped, not just the writers — web,
  # searxng and ollama would otherwise keep serving a machine whose data now
  # lives somewhere else.
  # The service list of the LAST stop, read back: `docker compose stop` with
  # no service name is what stops the whole project. Asserting the log merely
  # CONTAINS `--profile * stop` is true of `stop postgres` too, which is the
  # one thing this case exists to refuse.
  expect_str "a_move_stops_every_service_not_just_the_writers" \
    "$(tail -1 "$BK_WORLD/stop.log" | sed 's/^.* stop//' | tr -d ' ')" ""
  expect_has "a_move_reads_every_service_back_as_stopped" \
    "$BKT_OUT" "parked: every service of this project reads .State.Running false"
  expect_str "a_move_never_restarts_the_writers" "$(wc -c < "$BK_WORLD/up.log" | tr -d ' ')" "0"
  expect_has "a_move_writes_MOVED_TO_where_the_sidecar_already_reads" \
    "$(cat "$BK_WORLD/marker/MOVED_TO" 2>/dev/null)" "bundle_sha256="
  expect_has "a_move_writes_the_install_marker_too" \
    "$(cat "$BK_WORLD/marker/.moved" 2>/dev/null)" "source_host="
  expect_str "both_move_markers_are_owner_only" \
    "$(bk_mode_of "$BK_WORLD/marker/.moved")" "600"
  MANIFEST="$(bkt_manifest "$(bkt_bundle)")"
  expect_has "a_move_carries_the_node_identity" "$MANIFEST" '"key": "v4_tailscale"'
  expect_has "a_move_records_that_it_carried_it" "$MANIFEST" '"tailnet_state_carried": true'
  expect_has "a_move_is_recorded_as_a_move" "$MANIFEST" '"mode": "move"'

  # ── a marker that does not keep what was written to it ───────────────────
  #
  # §9.5: the two markers are written and READ BACK, and a failure says the
  # host is NOT parked — "nobody should believe the source host is stopped
  # when it is not". A path that accepts a write and stores nothing is the
  # class that check exists for, and a symlink to /dev/null is exactly that.
  # MOVED_TO and not `.moved`: step 1 refuses a host that already carries
  # `.moved`, so a hole there never reaches step 22 at all.
  bkt_reset
  ln -sf /dev/null "$BK_WORLD/marker/MOVED_TO"
  bkt_backup --move
  rm -f "$BK_WORLD/marker/MOVED_TO"
  expect_str "a_move_marker_that_does_not_keep_what_was_written_refuses" "$BKT_RC" "1"
  expect_has "a_move_marker_that_does_not_keep_what_was_written_refuses" \
    "$BKT_ERR" "did not read back as it was written"
  expect_has "and_says_in_words_that_the_host_is_not_parked" "$BKT_ERR" "is NOT parked"
  expect_has "and_names_the_marker_it_could_not_write" "$BKT_ERR" "MOVED_TO"

  # ── the transport is validated, and recorded ─────────────────────────────
  bkt_reset
  bkt_backup --transport removable
  expect_str "a_named_transport_is_accepted" "$BKT_RC" "0"
  expect_has "the_transport_travels_in_the_manifest" \
    "$(bkt_manifest "$(bkt_bundle)")" '"transport": "removable"'

  bkt_reset
  bkt_backup --transport carrier-pigeon
  expect_str "an_unknown_transport_refuses_before_the_lock" "$BKT_RC" "2"
  expect_has "an_unknown_transport_names_the_three_it_has" "$BKT_ERR" "local, tailnet or removable"

  # ── an absent passphrase is created once, and never overwritten ──────────
  bkt_reset
  rm -f "$BK_WORLD/pw/.backup-passphrase"
  bkt_backup
  expect_str "an_absent_passphrase_is_created_rather_than_refusing" "$BKT_RC" "0"
  if [ "$BKT_RC" -ne 0 ]; then printf '     stderr: %s\n' "$BKT_ERR"; fi
  expect_str "the_created_passphrase_file_is_owner_only" \
    "$(bk_mode_of "$BK_WORLD/pw/.backup-passphrase")" "600"
  expect_has "the_operator_is_told_it_is_the_only_copy" "$BKT_ERR" "THIS IS THE ONLY COPY"

  # ── an UNAVAILABLE store never generates a replacement ───────────────────
  bkt_reset
  chmod 000 "$BK_WORLD/pw/.backup-passphrase"
  bkt_backup
  chmod 600 "$BK_WORLD/pw/.backup-passphrase"
  expect_str "an_unreadable_passphrase_store_refuses_rather_than_creating_one" "$BKT_RC" "1"
  expect_str "and_no_bundle_is_written_under_a_new_passphrase" \
    "$(find "$BK_WORLD/out" -name 'nova-backup-*' | wc -l | tr -d ' ')" "0"

  # ── the restore verb, against a bundle this suite has just written ───────
  #
  # Same rule as the backup block, same level of seam: the bundle under test
  # is a real NOVAENC1 file this suite produced, opened by the real
  # nova_restore.py, and every container script really runs. Nothing here
  # answers `{"verified": true}`.
  #
  # `get_env_value` and `set_env_value` are install.sh's OWN bodies, lifted
  # out of the file at run time rather than re-typed here. §9.2 step 2 and
  # step 8 are specifically about how those two behave on a bare target, and
  # a second copy of them in a test would be a fixture agreeing with whatever
  # the author of the copy assumed. If either ever moves or is renamed, the
  # eval below produces nothing and every restore case dies on "command not
  # found" — which is the right kind of loud.
  BKT_INSTALL_FNS="$(sed -n '/^get_env_value()/,/^}/p;/^set_env_value()/,/^}/p' "$SCRIPT_DIR/install.sh")"
  case "$BKT_INSTALL_FNS" in
    *"get_env_value()"*"set_env_value()"*)
      report 0 "the_env_helpers_under_test_are_install_sh_s_own"
      ;;
    *)
      report 1 "the_env_helpers_under_test_are_install_sh_s_own" \
        "get_env_value/set_env_value could not be lifted out of install.sh"
      ;;
  esac

  BKT_KEEP="$BK_WORLD/keep"
  mkdir -p "$BKT_KEEP"

  # Empty this world into a RESTORE TARGET: no volumes, no .env, no container
  # of this project, and every database created-but-empty the way
  # postgres-init leaves a fresh v4_pgdata.
  bkt_bare_target() {
    rm -rf "${BKT_VOLS:?}"
    mkdir -p "$BKT_VOLS"
    rm -f "$WORLD/repo/deploy/.env"
    rm -f "$BK_WORLD/marker/.restore-in-progress" "$BK_WORLD/marker/.restored"
    rm -rf "$BK_WORLD/scratch"
    mkdir -p "$BK_WORLD/scratch"
    BKT_RUNNING=""
    BKT_BARE_TARGET=1
    STUB_EMPTY_UNTIL_RESTORED=1
  }

  bkt_restore() {
    (
      [ "${BKT_SET_E:-0}" = "1" ] && set -e
      cd "$WORLD/repo" || exit 9
      bk_docker() { bkt_docker "$@"; }
      docker() { bkt_docker "$@"; }
      bk_git() { git "$@"; }
      BK_COMPOSE_FILES="$WORLD/repo/deploy/docker-compose.yml"
      BK_ENV_FILE="$WORLD/repo/deploy/.env"
      BK_ENV_EXAMPLE="$WORLD/repo/deploy/.env.example"
      ENV_FILE="$WORLD/repo/deploy/.env"
      # shellcheck disable=SC2034
      BK_REPO_ROOT="$WORLD/repo"
      # shellcheck disable=SC2034
      BK_MOVED_MARKER="$BK_WORLD/marker/.moved"
      # shellcheck disable=SC2034
      BK_MOVED_TO_MARKER="$BK_WORLD/marker/MOVED_TO"
      # shellcheck disable=SC2034
      BK_RESTORE_MARKER="$BK_WORLD/marker/.restore-in-progress"
      # shellcheck disable=SC2034
      BK_RESTORED_MARKER="$BK_WORLD/marker/.restored"
      NP_DIR="$BK_WORLD/pw"
      NP_ENV_FILE="$BK_WORLD/pw/.env"
      export BK_COMPOSE_FILES BK_ENV_FILE BK_ENV_EXAMPLE ENV_FILE
      export STUB_PGRESTORE_RC
      eval "$BKT_INSTALL_FNS"
      # subnet.sh's own seams, so the drill's subnet choice is the REAL
      # pick_project_subnet reading a route table this case controls. 172.18
      # is deliberately taken by a route: a drill that ignores what is in use
      # would land on it.
      have_cmd() { case "$1" in ip) return 0 ;; *) command -v "$1" >/dev/null 2>&1 ;; esac; }
      ip_route_text() {
        printf 'default via 192.168.1.1 dev eth0\n'
        printf '172.18.0.0/16 dev br-something proto kernel scope link\n'
      }
      log() { printf '%s\n' "$*" >&2; }
      die() { log "ERROR: $*"; exit 1; }
      # §9.2 step 3 is install.sh's decide_subnet, which is T5's and is driven
      # by install_test.sh. What the RESTORE owes is that it runs BEFORE
      # anything creates a docker object, and that .env is already there when
      # it does — so this records both facts into the same ordered log every
      # docker call lands in, and writes the five keys the way the real one
      # does.
      decide_subnet() {
        if [ -f "$ENV_FILE" ]; then
          printf 'decide_subnet env-exists\n' >> "$BKT_LOG"
        else
          printf 'decide_subnet env-missing\n' >> "$BKT_LOG"
        fi
        set_env_value NOVA_SUBNET 172.20.0.0/16
        set_env_value NOVA_SUBNET_RANGE 172.20.0.0/17
        set_env_value NOVA_SUBNET_GATEWAY 172.20.0.1
        set_env_value NOVA_WEB_ADDR 172.20.128.10
        set_env_value NOVA_TAILSCALE_ADDR 172.20.128.20
      }
      date() {
        local now
        case "$*" in
          "+%s")
            now=$(( $(cat "$BK_WORLD/clock" 2>/dev/null || printf 1000000) + 1000 ))
            printf '%s' "$now" > "$BK_WORLD/clock"
            printf '%s\n' "$now"
            ;;
          *) command date "$@" ;;
        esac
      }
      if [ "${BKT_NO_PW:-0}" != "1" ]; then
        printf '%s\n' "$PW_VALUE" > "$BK_WORLD/pw/.backup-passphrase"
        chmod 600 "$BK_WORLD/pw/.backup-passphrase"
      fi
      "$@"
    ) > "$BK_WORLD/stdout" 2> "$BK_WORLD/stderr"
    BKT_RC=$?
    BKT_OUT="$(cat "$BK_WORLD/stdout")"
    BKT_ERR="$(cat "$BK_WORLD/stderr")"
  }

  # One bundle, written from the full world, kept where bkt_reset cannot
  # delete it. Every restore case below opens THIS file.
  bkt_reset
  bkt_backup
  if [ "$BKT_RC" -ne 0 ]; then
    report 1 "a_bundle_exists_to_restore_from" "the backup that feeds the restore block failed: $BKT_ERR"
  else
    report 0 "a_bundle_exists_to_restore_from"
  fi
  RBUNDLE="$BKT_KEEP/$(basename "$(bkt_bundle)")"
  cp "$(bkt_bundle)" "$RBUNDLE"

  # ── the happy path, and everything it proves ─────────────────────────────
  bkt_reset
  bkt_bare_target
  bkt_restore cmd_restore "$RBUNDLE"
  expect_str "the_verb_restores_a_bundle_onto_an_empty_target" "$BKT_RC" "0"
  if [ "$BKT_RC" -ne 0 ]; then
    printf '     stdout: %s\n     stderr: %s\n' "$BKT_OUT" "$BKT_ERR"
  fi

  # §9.2 step 16: the word `restored` is printed only with the three facts
  # behind it.
  expect_has "the_word_restored_carries_the_three_facts_behind_it" "$BKT_OUT" \
    "restored: 7 tables compared across 3 databases, 2 volume listings diffed,"
  expect_has "the_word_restored_carries_the_three_facts_behind_it" "$BKT_OUT" \
    "signing key fingerprint equal."
  expect_has "the_report_names_exactly_one_next_command" "$BKT_OUT" "next:
  ./install"

  # port-v3 M2 / python-tool M3: .env is created from the example BEFORE
  # decide_subnet, which rewrites that file and dies on a missing one under
  # install.sh's `set -e`.
  expect_has "creates_env_from_the_example_before_decide_subnet" \
    "$(cat "$BKT_LOG")" "decide_subnet env-exists"
  expect_lacks "creates_env_from_the_example_before_decide_subnet" \
    "$(cat "$BKT_LOG")" "decide_subnet env-missing"
  expect_str "the_env_it_created_is_owner_only" \
    "$(bk_mode_of "$WORLD/repo/deploy/.env")" "600"

  # §9.2 step 3, as an ORDER and not a presence check: every docker call and
  # decide_subnet land in one ordered log, and the line numbers are compared.
  BKT_SUBNET_LINE="$(grep -n 'decide_subnet' "$BKT_LOG" | head -1 | cut -d: -f1)"
  BKT_VOLCREATE_LINE="$(grep -n 'volume create' "$BKT_LOG" | head -1 | cut -d: -f1)"
  if [ -n "$BKT_SUBNET_LINE" ] && [ -n "$BKT_VOLCREATE_LINE" ] &&
    [ "$BKT_SUBNET_LINE" -lt "$BKT_VOLCREATE_LINE" ]; then
    report 0 "runs_decide_subnet_before_the_first_volume_create"
  else
    report 1 "runs_decide_subnet_before_the_first_volume_create" \
      "decide_subnet at line ${BKT_SUBNET_LINE:-none}, first volume create at line ${BKT_VOLCREATE_LINE:-none}"
  fi

  # §9.2 step 9: the two compose labels are READ BACK. An unlabelled volume
  # is one `docker compose up` will not adopt, so the restore would come up
  # on a fresh empty one.
  expect_str "a_restored_volume_carries_the_labels_compose_needs_to_adopt_it" \
    "$(cat "$BKT_VOLS/.labels/nova_v4_memdata" 2>/dev/null)" \
    "com.docker.compose.project=nova com.docker.compose.volume=v4_memdata"
  expect_has "every_volume_listing_is_re_derived_and_diffed" "$BKT_OUT" \
    "volume v4_memdata -> nova_v4_memdata:"
  expect_has "every_volume_listing_is_re_derived_and_diffed" "$BKT_OUT" "listing identical"
  # port-v3 M5: the EMPTY volume is restored and diffed too. v4_workspace on
  # a hub where she has written nothing yet is the volume a listing check
  # would otherwise pass vacuously on.
  expect_has "an_empty_carried_volume_is_restored_and_diffed_too" "$BKT_OUT" \
    "volume v4_workspace -> nova_v4_workspace: 0 entries"
  # The tree really landed: the notes, the symlink, and the modes.
  expect_str "the_notes_really_land_in_the_volume" \
    "$(cat "$BKT_VOLS/nova_v4_memdata/notes/one.md" 2>/dev/null)" "a note"
  expect_str "a_symlink_inside_the_tree_survives_as_a_symlink" \
    "$(readlink "$BKT_VOLS/nova_v4_memdata/notes/current" 2>/dev/null)" "one.md"
  expect_str "the_modes_inside_the_tree_survive" \
    "$(bk_mode_of "$BKT_VOLS/nova_v4_memdata/people/secret.md")" "600"
  expect_str "the_modes_inside_the_tree_survive" \
    "$(bk_mode_of "$BKT_VOLS/nova_v4_memdata/people")" "700"
  expect_str "an_empty_directory_survives" \
    "$(find "$BKT_VOLS/nova_v4_memdata/people/empty" -maxdepth 0 -type d | wc -l | tr -d ' ')" "1"

  # §9.2 step 8: the carried KEY SET, written and re-read. python-tool M4 is
  # the one that deadlocks the whole slice — NOVA_SUBNET is written by step 3
  # and must not be in the bundle at all, or step 8 finds it present and
  # different and refuses the restore this slice exists for.
  expect_str "the_carried_keys_land_in_env" \
    "$(grep -c '^POSTGRES_PASSWORD=throwaway$' "$WORLD/repo/deploy/.env")" "1"
  expect_str "env_host_local_keys_are_never_carried" \
    "$(grep -c '^NOVA_SUBNET=172.20.0.0/16$' "$WORLD/repo/deploy/.env")" "1"
  expect_lacks "env_host_local_keys_are_never_carried" \
    "$(cat "$WORLD/repo/deploy/.env")" "COMPOSE_FILE=throwaway"
  expect_lacks "env_host_local_keys_are_never_carried" \
    "$(cat "$WORLD/repo/deploy/.env")" "INSTANCE_SECRET=throwaway"

  # §9.2 step 15: the in-progress marker is GONE and .restored is there.
  expect_str "a_finished_restore_removes_its_in_progress_marker" \
    "$(find "$BK_WORLD/marker" -name '.restore-in-progress' | wc -l | tr -d ' ')" "0"
  expect_has "a_finished_restore_records_what_it_restored" \
    "$(cat "$BK_WORLD/marker/.restored" 2>/dev/null)" "bundle_sha256=$(sha256_of "$RBUNDLE")"
  expect_str "the_restored_marker_is_owner_only" \
    "$(bk_mode_of "$BK_WORLD/marker/.restored")" "600"

  # §9.2 step 7: the version comparison is STATED, which is the whole reason
  # R1's risk was deferred to restore time.
  expect_has "the_version_gate_says_what_it_found_on_both_sides" "$BKT_OUT" \
    "the bundle was written by server 16.15 (160015) / pg_dump major 16"
  expect_has "the_version_gate_says_what_it_found_on_both_sides" "$BKT_OUT" \
    "host has postgres:16 with pg_restore 16.15 (major 16)"
  expect_has "the_migration_gate_names_what_it_matched" "$BKT_OUT" \
    "migrations nova_core: 1 applied, every one found by content"

  # §7.5, on this side too: the passphrase reaches the first line of one
  # container's stdin and nothing else.
  expect_lacks "passphrase_never_reaches_argv_on_the_restore_side" \
    "$(cat "$BKT_LOG")" "$PW_VALUE"
  # `-e NAME=VALUE`, which is what docker takes: a bare `-e` inside a logged
  # `sed -e ...` script is not one, and matching it was this case measuring
  # its own harness.
  expect_str "the_only_env_var_any_restore_container_gets_is_a_path" \
    "$(grep -o -- '-e [A-Za-z_][A-Za-z0-9_]*=[^ ]*' "$BKT_LOG" | sort -u | tr '\n' ' ')" \
    "-e PGPASSFILE=/stage/.pgpass "
  expect_lacks "no_value_of_the_carried_env_is_ever_printed" "$BKT_OUT" "throwaway"
  expect_str "no_plaintext_dump_is_left_on_the_host" \
    "$(find "$BK_WORLD" "${TMPDIR:-/tmp}" -maxdepth 2 -name 'nova_core.dump' 2>/dev/null | wc -l | tr -d ' ')" "0"
  expect_str "the_decrypted_content_volume_is_removed_when_the_run_finishes" \
    "$(find "$BKT_VOLS" -maxdepth 1 -name 'nova-restore-content-*' | wc -l | tr -d ' ')" "0"

  # ── under install.sh's own shell settings ────────────────────────────────
  bkt_reset
  bkt_bare_target
  BKT_SET_E=1
  bkt_restore cmd_restore "$RBUNDLE"
  BKT_SET_E=0
  expect_str "the_verb_runs_under_install_sh_s_own_set_euo_pipefail" "$BKT_RC" "0"
  if [ "$BKT_RC" -ne 0 ]; then printf '     stderr: %s\n' "$BKT_ERR"; fi

  bkt_reset
  bkt_bare_target
  mkdir -p "$BKT_VOLS/nova_v4_pgdata"
  printf '16\n' > "$BKT_VOLS/nova_v4_pgdata/PG_VERSION"
  BKT_SET_E=1
  bkt_restore cmd_restore "$RBUNDLE"
  BKT_SET_E=0
  expect_str "a_refusal_under_set_e_is_still_a_sentence" "$BKT_RC" "1"
  expect_has "a_refusal_under_set_e_is_still_a_sentence" "$BKT_ERR" "exists and is not empty"
  (
    set -e
    bk_docker() { bkt_docker "$@"; }
    cmd_restore --nonsense >/dev/null 2>&1 || true
    case "$-" in
      *e*) exit 0 ;;
      *) exit 7 ;;
    esac
  )
  expect_str "the_verb_restores_set_e_on_the_way_out" "$?" "0"

  # ── §9.2 step 6, the single most important line in the verb ──────────────
  #
  # port-v3 M1 + shell-first M3: v4_pgdata is `dump-pg`, so it has NO
  # manifest.volumes row — a loop over the manifest never inspects the single
  # most important non-empty target on the machine, and the restore then
  # verifies every count and digest and still produces a hub that cannot
  # authenticate against its own database.
  bkt_reset
  bkt_bare_target
  mkdir -p "$BKT_VOLS/nova_v4_pgdata"
  printf '16\n' > "$BKT_VOLS/nova_v4_pgdata/PG_VERSION"
  bkt_restore cmd_restore "$RBUNDLE"
  expect_str "refuses_a_non_empty_v4_pgdata" "$BKT_RC" "1"
  expect_has "refuses_a_non_empty_v4_pgdata" "$BKT_ERR" \
    "volume nova_v4_pgdata (v4_pgdata, dump-pg) exists and is not empty"
  expect_has "the_refusal_says_a_bad_restore_cannot_be_rolled_back" "$BKT_ERR" \
    "A bad restore CANNOT be rolled back in place"
  expect_str "and_creates_no_volume_at_all" \
    "$(grep -c 'volume create' "$BKT_LOG")" "0"
  expect_str "and_writes_no_in_progress_marker" \
    "$(find "$BK_WORLD/marker" -name '.restore-in-progress' | wc -l | tr -d ' ')" "0"

  # python-tool M1, measured: a probe that reads STDOUT instead of the EXIT
  # STATUS calls every failure mode "empty, proceed".
  bkt_reset
  bkt_bare_target
  mkdir -p "$BKT_VOLS/nova_v4_pgdata"
  STUB_PROBE_RC=1
  bkt_restore cmd_restore "$RBUNDLE"
  STUB_PROBE_RC=0
  expect_str "the_emptiness_probe_reads_exit_status_not_stdout" "$BKT_RC" "1"
  expect_has "the_emptiness_probe_reads_exit_status_not_stdout" "$BKT_ERR" \
    "could not be read"
  expect_has "could_not_determine_is_a_refusal_not_a_pass" "$BKT_ERR" \
    "is a refusal here, not a pass"

  # shell-first m3: /probe is a path no image populates, so the probe cannot
  # populate the volume it is checking.
  expect_has "the_emptiness_probe_mounts_a_path_no_image_populates" \
    "$(cat "$BKT_LOG")" "-v nova_v4_pgdata:/probe:ro"
  expect_has "the_emptiness_probe_mounts_a_path_no_image_populates" \
    "$(cat "$BKT_LOG")" "/probe -mindepth 1 -maxdepth 1 -print -quit"

  bkt_reset
  bkt_bare_target
  BKT_RUNNING="core"
  bkt_restore cmd_restore "$RBUNDLE"
  expect_str "refuses_an_existing_project_container" "$BKT_RC" "1"
  expect_has "refuses_an_existing_project_container" "$BKT_ERR" \
    "container(s) of the project \`nova\` are here, exited ones included"

  # ── the three the mutation sweep said nothing was measuring ─────────────
  #
  # Each of these exists because a deliberate mutation of the shipped code
  # left the whole suite green. None was suspected; the sweep is what said so.

  # §9.2 step 9: the labels are READ BACK off `docker volume inspect`. An
  # unlabelled volume is one `docker compose up` will not adopt, so the
  # restore would fill a volume and the stack would then come up on a fresh
  # empty one. A create that succeeds and a label that does not stick is the
  # only shape that measures the read-back.
  bkt_reset
  bkt_bare_target
  STUB_DROP_VOLUME_LABELS=1
  bkt_restore cmd_restore "$RBUNDLE"
  STUB_DROP_VOLUME_LABELS=0
  expect_str "a_volume_whose_labels_did_not_stick_is_a_refusal" "$BKT_RC" "1"
  expect_has "a_volume_whose_labels_did_not_stick_is_a_refusal" "$BKT_ERR" \
    "reports its compose"
  expect_has "the_refusal_says_what_an_unlabelled_volume_costs" "$BKT_ERR" \
    "\`docker compose up\` will not adopt"
  expect_lacks "a_volume_whose_labels_did_not_stick_is_a_refusal" "$BKT_OUT" "restored:"

  # §9.2 step 11: the volumes can be empty and a DATABASE not be. On a target
  # whose v4_pgdata was removed but whose server still carries the three
  # databases with rows in them, step 6 passes and step 11 is the only thing
  # between the operator and a pg_restore interleaved into live data. Exit 3,
  # its own code, because "the target is not empty" is not the same answer as
  # "this bundle is wrong".
  bkt_reset
  bkt_bare_target
  STUB_EMPTY_UNTIL_RESTORED=0
  bkt_restore cmd_restore "$RBUNDLE"
  STUB_EMPTY_UNTIL_RESTORED=1
  expect_str "a_target_database_that_already_holds_tables_is_exit_3" "$BKT_RC" "3"
  expect_has "a_target_database_that_already_holds_tables_is_exit_3" "$BKT_ERR" \
    "already holds 3 table(s)"
  expect_has "and_says_again_that_a_bad_restore_cannot_be_undone" "$BKT_ERR" \
    "a bad restore cannot be rolled back in place"
  expect_str "and_nothing_was_restored_into_it" \
    "$(grep -c 'pg_restore' "$BK_WORLD/dbops.log")" "0"

  # T3's reading 8, measured on THIS verb rather than inherited: under a live
  # `-e` the shell exits at the first `x="$(cmd)"` whose command failed —
  # BEFORE the `[ -z "$x" ]` that would have named it. A refusal that comes
  # after a failed READING is the only shape that can tell the wrapper is
  # doing anything; a refusal reached through `if` and `case` cannot, which
  # is why the case that used to sit here measured nothing.
  bkt_reset
  bkt_bare_target
  STUB_RESTORE_VER_RC=1
  BKT_SET_E=1
  bkt_restore cmd_restore "$RBUNDLE"
  BKT_SET_E=0
  STUB_RESTORE_VER_RC=0
  expect_str "a_failed_reading_under_set_e_still_prints_its_reason" "$BKT_RC" "1"
  expect_has "a_failed_reading_under_set_e_still_prints_its_reason" "$BKT_ERR" \
    "host's major version is unreadable"
  expect_has "the_refusal_says_what_it_could_not_read" "$BKT_ERR" \
    "answered 'nothing'"

  # ── §9.2 step 7: the version gate, both directions ───────────────────────
  bkt_reset
  bkt_bare_target
  STUB_RESTORE_VER="15.7"
  bkt_restore cmd_restore "$RBUNDLE"
  STUB_RESTORE_VER="16.15"
  expect_str "refuses_an_older_pg_restore" "$BKT_RC" "1"
  expect_has "refuses_an_older_pg_restore" "$BKT_ERR" \
    "written by pg_dump major 16 and this host's"
  expect_has "refuses_an_older_pg_restore_and_names_both_numbers" "$BKT_ERR" \
    "pg_restore 15.7 (major 15)"

  bkt_reset
  bkt_bare_target
  STUB_RESTORE_VER="17.2"
  bkt_restore cmd_restore "$RBUNDLE"
  STUB_RESTORE_VER="16.15"
  expect_str "accepts_a_newer_pg_restore" "$BKT_RC" "0"
  if [ "$BKT_RC" -ne 0 ]; then printf '     stderr: %s\n' "$BKT_ERR"; fi

  # ── §9.2 step 7: the migration gate matches by CONTENT ───────────────────
  #
  # shell-first M12: a filename-only gate false-refuses a RENUMBERED
  # migration — a correct bundle refused, with the operator's only copy of
  # his Nova and nowhere to go. There is no override flag; the fix is asking
  # the question correctly.
  bkt_reset
  bkt_bare_target
  mv "$WORLD/repo/services/core/migrations/001_init.sql" \
    "$WORLD/repo/services/core/migrations/007_init.sql"
  bkt_restore cmd_restore "$RBUNDLE"
  mv "$WORLD/repo/services/core/migrations/007_init.sql" \
    "$WORLD/repo/services/core/migrations/001_init.sql"
  expect_str "migration_gate_matches_a_renumbered_migration_by_content" "$BKT_RC" "0"
  if [ "$BKT_RC" -ne 0 ]; then printf '     stderr: %s\n' "$BKT_ERR"; fi

  bkt_reset
  bkt_bare_target
  printf -- '-- core, but different\n' > "$WORLD/repo/services/core/migrations/001_init.sql"
  bkt_restore cmd_restore "$RBUNDLE"
  printf -- '-- core\n' > "$WORLD/repo/services/core/migrations/001_init.sql"
  expect_str "migration_gate_refuses_a_changed_migration" "$BKT_RC" "1"
  expect_has "migration_gate_refuses_a_changed_migration_and_names_the_file" \
    "$BKT_ERR" "nova_core was migrated by '001_init.sql'"
  expect_has "migration_gate_refuses_a_changed_migration_and_names_the_source_sha" \
    "$BKT_ERR" "check
       out $(git -C "$WORLD/repo" rev-parse HEAD | cut -c1-7) and restore"
  expect_has "the_migration_refusal_says_the_match_is_by_content" "$BKT_ERR" \
    "The match is by CONTENT"

  # ── §9.2 step 8: a replacement prints NAMES, never values ────────────────
  bkt_reset
  bkt_bare_target
  printf 'POSTGRES_PASSWORD=a-different-one\n' > "$WORLD/repo/deploy/.env"
  chmod 600 "$WORLD/repo/deploy/.env"
  bkt_restore cmd_restore "$RBUNDLE"
  expect_str "env_replacement_is_not_a_refusal" "$BKT_RC" "0"
  if [ "$BKT_RC" -ne 0 ]; then printf '     stderr: %s\n' "$BKT_ERR"; fi
  expect_has "env_replacement_prints_key_names" "$BKT_OUT" "replaced: POSTGRES_PASSWORD"
  expect_lacks "env_replacement_never_prints_values" "$BKT_OUT" "a-different-one"
  expect_lacks "env_replacement_never_prints_values" "$BKT_OUT" "throwaway"
  expect_str "the_replacement_really_replaced" \
    "$(grep -c '^POSTGRES_PASSWORD=throwaway$' "$WORLD/repo/deploy/.env")" "1"

  # ── §9.2 step 10: the marker, and the re-run that quotes it ──────────────
  #
  # shell-first M4, the one genuinely new gap: without the marker a restore
  # that fails at step 12 leaves labelled half-populated volumes, and the
  # re-run refuses ON STATE IT CREATED ITSELF with no verb that clears it —
  # so the operator's only route is hand-run `docker volume rm` on his only
  # copy of the data, unguided, at the worst possible moment.
  bkt_reset
  bkt_bare_target
  STUB_PGRESTORE_RC=1
  bkt_restore cmd_restore "$RBUNDLE"
  STUB_PGRESTORE_RC=0
  expect_str "a_failed_restore_refuses" "$BKT_RC" "1"
  expect_has "a_failed_pg_restore_says_the_transaction_rolled_back" "$BKT_ERR" \
    "--single-transaction, so the whole transaction rolled back"
  expect_has "a_failed_restore_writes_the_in_progress_marker" \
    "$(cat "$BK_WORLD/marker/.restore-in-progress" 2>/dev/null)" \
    "volumes=nova_v4_memdata nova_v4_workspace"
  expect_str "the_in_progress_marker_is_owner_only" \
    "$(bk_mode_of "$BK_WORLD/marker/.restore-in-progress")" "600"
  # ...and the re-run, on a target the first run half filled.
  BKT_RUNNING=""
  bkt_restore cmd_restore "$RBUNDLE"
  expect_str "the_rerun_refuses_on_the_state_the_first_run_created" "$BKT_RC" "1"
  expect_has "the_rerun_quotes_the_marker" "$BKT_ERR" \
    "A previous restore did not finish. It recorded exactly what it created"
  expect_has "the_rerun_quotes_the_marker" "$BKT_ERR" "volumes=nova_v4_memdata"
  expect_has "nothing_is_discovered_the_marker_is_the_bound" "$BKT_ERR" \
    "that list is the bound"

  # ── §9.2 steps 13 and 14: what must never print `restored` ───────────────
  bkt_reset
  bkt_bare_target
  STUB_RESTORE_DIFF=1
  bkt_restore cmd_restore "$RBUNDLE"
  STUB_RESTORE_DIFF=0
  expect_str "never_prints_restored_when_a_count_differs" "$BKT_RC" "1"
  expect_lacks "never_prints_restored_when_a_count_differs" "$BKT_OUT" "restored:"
  expect_has "a_count_difference_names_the_table_and_both_sides" "$BKT_ERR" \
    "public.people: bundle"
  expect_has "a_count_difference_says_it_is_the_data_not_the_frame" "$BKT_ERR" \
    "the same six pinned GUCs, so this is the data, not the frame"

  bkt_reset
  bkt_bare_target
  STUB_RESTORED_KEY_DIFFERS=1
  bkt_restore cmd_restore "$RBUNDLE"
  STUB_RESTORED_KEY_DIFFERS=0
  expect_str "never_prints_restored_when_the_key_fingerprint_differs" "$BKT_RC" "1"
  expect_lacks "never_prints_restored_when_the_key_fingerprint_differs" "$BKT_OUT" "restored:"
  expect_has "a_lost_signing_key_is_loud_and_says_what_it_costs" "$BKT_ERR" \
    "THE SIGNING KEY DID NOT SURVIVE"
  expect_has "a_lost_signing_key_is_loud_and_says_what_it_costs" "$BKT_ERR" \
    "un-paired every device it had"

  # §9.2 step 9: the listing is what a restore diffs against, and it covers
  # TYPES, MODES, UID and GID — not just the file bytes. The uid column
  # cannot be varied here without root, so it is measured from the other
  # side: move it in the carried listing and require the restore to refuse.
  # `extra` refuses one step earlier and more precisely — the listing names an
  # entry that did not land, which is caught while the recorded metadata is
  # being applied. Both are refusals of the same fact; each is asserted where
  # it happens rather than blurred into one substring that would pass on
  # either.
  for tamper in uid extra hash; do
    bkt_reset
    bkt_bare_target
    STUB_TAMPER_LISTING="$tamper"
    bkt_restore cmd_restore "$RBUNDLE"
    STUB_TAMPER_LISTING=""
    expect_str "never_prints_restored_when_a_listing_differs" "$BKT_RC" "1"
    expect_lacks "never_prints_restored_when_a_listing_differs" "$BKT_OUT" "restored:"
    expect_str "a_listing_difference_stops_before_the_database" \
      "$(grep -c 'pg_restore' "$BK_WORLD/dbops.log")" "0"
    case "$tamper" in
      extra)
        expect_has "a_listing_entry_that_did_not_land_refuses_by_name" "$BKT_ERR" \
          "the listing names ./ghost and it did not land"
        ;;
      *)
        expect_has "never_prints_restored_when_a_listing_differs" "$BKT_ERR" \
          "does not match the listing sealed in"
        ;;
    esac
  done
  expect_has "a_listing_difference_names_the_entries_that_differ" "$BKT_ERR" \
    "changed ./notes/one.md"
  expect_has "a_listing_difference_leaves_the_volume_for_inspection" "$BKT_ERR" \
    "left in place for inspection and this run stops before"

  # §9.2 step 5: a hash mismatch prints NO next steps at all, so a failed
  # verify can never read as a partial success.
  bkt_reset
  bkt_bare_target
  cp "$RBUNDLE" "$BK_WORLD/corrupt.tar"
  # One byte of the payload, flipped. The outer tar still lists correctly and
  # the KAT still passes — this is the case the AEAD is for.
  python3 - "$BK_WORLD/corrupt.tar" <<'PY'
import sys
import tarfile

with tarfile.open(sys.argv[1], "r:") as tar:
    member = tar.getmember("payload.enc")
at = member.offset_data + member.size // 2
with open(sys.argv[1], "r+b") as fh:
    fh.seek(at)
    b = fh.read(1)
    fh.seek(at)
    fh.write(bytes([b[0] ^ 0xFF]))
PY
  bkt_restore cmd_restore "$BK_WORLD/corrupt.tar"
  expect_str "a_corrupt_payload_refuses" "$BKT_RC" "1"
  expect_has "a_corrupt_payload_refuses" "$BKT_ERR" \
    "opened and what came out of it is not a bundle this tool can"
  # The AEAD is what notices, and the refusal says what it cannot tell apart
  # rather than guessing which of the three it was.
  expect_has "a_corrupt_payload_refuses_with_a_sentence_not_a_traceback" "$BKT_ERR" \
    "GCM cannot tell these apart"
  expect_lacks "a_corrupt_payload_refuses_with_a_sentence_not_a_traceback" "$BKT_ERR" \
    "Traceback (most recent call last)"
  expect_lacks "prints_no_next_steps_on_a_hash_mismatch" "$BKT_OUT" "./install"
  expect_lacks "prints_no_next_steps_on_a_hash_mismatch" "$BKT_OUT" "restored:"

  # §9.2 step 4: the wrong passphrase is refused BEFORE a payload byte is
  # read, and the refusal names the fingerprint meta.json recorded so a
  # rotation is stated when it is known and never guessed.
  bkt_reset
  bkt_bare_target
  printf 'not-the-right-passphrase\n' > "$BK_WORLD/pw/wrong"
  chmod 600 "$BK_WORLD/pw/wrong"
  bkt_restore cmd_restore "$RBUNDLE" --passphrase-file "$BK_WORLD/pw/wrong"
  expect_str "a_wrong_passphrase_refuses_before_a_payload_byte_is_read" "$BKT_RC" "1"
  expect_has "a_wrong_passphrase_refuses_before_a_payload_byte_is_read" "$BKT_ERR" \
    "Nothing was read past the
       known-answer test"
  expect_has "the_wrong_passphrase_refusal_names_the_recorded_fingerprint" "$BKT_ERR" \
    "meta.json records passphrase fingerprint"
  expect_str "and_creates_no_volume" "$(grep -c 'volume create' "$BKT_LOG")" "0"

  # A passphrase file other users can read is not read at all.
  bkt_reset
  bkt_bare_target
  printf 'not-the-right-passphrase\n' > "$BK_WORLD/pw/wrong"
  chmod 644 "$BK_WORLD/pw/wrong"
  bkt_restore cmd_restore "$RBUNDLE" --passphrase-file "$BK_WORLD/pw/wrong"
  expect_str "a_passphrase_file_other_users_can_read_refuses" "$BKT_RC" "1"
  expect_has "a_passphrase_file_other_users_can_read_refuses" "$BKT_ERR" "mode 644, not 600"

  # A restore NEVER generates a passphrase: the bundle is already sealed.
  bkt_reset
  bkt_bare_target
  rm -f "$BK_WORLD/pw/.backup-passphrase"
  BKT_NO_PW=1
  bkt_restore cmd_restore "$RBUNDLE"
  BKT_NO_PW=0
  expect_str "a_restore_never_generates_a_passphrase" "$BKT_RC" "1"
  expect_has "a_restore_never_generates_a_passphrase" "$BKT_ERR" \
    "a restore never generates one"
  expect_str "and_no_passphrase_file_appears" \
    "$(find "$BK_WORLD/pw" -name '.backup-passphrase' | wc -l | tr -d ' ')" "0"

  # ── a moved host refuses first ───────────────────────────────────────────
  bkt_reset
  bkt_bare_target
  printf 'moved_at=20260921T143002Z\nbundle=nova-backup-x.tar\n' > "$BK_WORLD/marker/.moved"
  bkt_restore cmd_restore "$RBUNDLE"
  rm -f "$BK_WORLD/marker/.moved"
  expect_str "a_moved_host_refuses_a_restore_too" "$BKT_RC" "1"
  expect_has "a_moved_host_refuses_a_restore_too" "$BKT_ERR" "undo-move"

  # ── a bundle that is not one ─────────────────────────────────────────────
  bkt_reset
  bkt_bare_target
  tar -cf "$BK_WORLD/not-a-bundle.tar" -C "$WORLD/repo" .gitignore
  bkt_restore cmd_restore "$BK_WORLD/not-a-bundle.tar"
  expect_str "a_tar_that_is_not_a_bundle_refuses_by_shape" "$BKT_RC" "1"
  expect_has "a_tar_that_is_not_a_bundle_refuses_by_shape" "$BKT_ERR" \
    "is not a Nova bundle: its members are"
  bkt_restore cmd_restore "$BK_WORLD/no-such-file.tar"
  expect_str "a_bundle_that_is_not_there_is_bad_arguments" "$BKT_RC" "2"

  # ── the cleartext half of the bundle is UNAUTHENTICATED ──────────────────
  #
  # meta.json rides OUTSIDE payload.enc, so anybody who can touch the file can
  # rewrite it. §5.4's rule is that nothing surviving a failed decrypt is
  # decided by it, and every value it duplicates is re-read from the
  # authenticated manifest and compared. These four cases edit exactly one
  # cleartext member of a real bundle and require the restore to refuse —
  # which is the only way to show that the comparison is real and not a
  # sentence in a design document.
  bkt_retar() {
    python3 - "$1" "$2" "$3" "$4" <<'RETAR'
import sys
import tarfile

src, dst, member, replacement = sys.argv[1:5]
with open(replacement, "rb") as fh:
    body = fh.read()
with tarfile.open(src, "r:") as old:
    infos = old.getmembers()
    with tarfile.open(dst, "w:") as new:
        for info in infos:
            if info.name == member:
                info.size = len(body)
                new.addfile(info, __import__("io").BytesIO(body))
            else:
                new.addfile(info, old.extractfile(info))
RETAR
  }

  for field in created_at outer_version bundle_version; do
    bkt_reset
    bkt_bare_target
    tar -xOf "$RBUNDLE" meta.json > "$BK_WORLD/meta.json"
    case "$field" in
      created_at) sed 's/"created_at": "[^"]*"/"created_at": "19990101T000000Z"/' \
        "$BK_WORLD/meta.json" > "$BK_WORLD/meta.new" ;;
      outer_version) sed 's/"outer_version": 1/"outer_version": 99/' \
        "$BK_WORLD/meta.json" > "$BK_WORLD/meta.new" ;;
      bundle_version) sed 's/"bundle_version": 2/"bundle_version": 1/' \
        "$BK_WORLD/meta.json" > "$BK_WORLD/meta.new" ;;
    esac
    bkt_retar "$RBUNDLE" "$BK_WORLD/tampered.tar" meta.json "$BK_WORLD/meta.new"
    bkt_restore cmd_restore "$BK_WORLD/tampered.tar"
    expect_str "a_tampered_cleartext_meta_is_a_refusal" "$BKT_RC" "1"
    expect_lacks "a_tampered_cleartext_meta_is_a_refusal" "$BKT_OUT" "restored:"
    case "$field" in
      created_at)
        expect_has "a_meta_field_the_manifest_contradicts_is_named_on_both_sides" \
          "$BKT_ERR" "disagrees with itself: its cleartext meta.json says"
        expect_has "a_meta_field_the_manifest_contradicts_is_named_on_both_sides" \
          "$BKT_ERR" "19990101T000000Z"
        ;;
      outer_version)
        expect_has "an_outer_version_this_tool_does_not_know_refuses" "$BKT_ERR" \
          "records outer_version '99', and this tool knows 1"
        ;;
      bundle_version)
        expect_has "a_v3_shaped_bundle_is_refused_BY_NAME" "$BKT_ERR" \
          "is a bundle_version 1 bundle"
        ;;
    esac
    expect_str "a_tampered_bundle_creates_no_volume" \
      "$(grep -c 'volume create' "$BKT_LOG")" "0"
  done

  # And the reader that ships inside it: manifest.reader_sha256 is sealed, the
  # file is not. One published digest covers every bundle for a commit (§7.6),
  # and this is what makes that true of the file rather than of the record.
  bkt_reset
  bkt_bare_target
  printf '#!/usr/bin/env python3\nprint("not the reader")\n' > "$BK_WORLD/other-reader.py"
  bkt_retar "$RBUNDLE" "$BK_WORLD/tampered.tar" nova_restore.py "$BK_WORLD/other-reader.py"
  bkt_restore cmd_restore "$BK_WORLD/tampered.tar"
  expect_str "a_swapped_in_bundle_reader_is_a_refusal" "$BKT_RC" "1"
  expect_has "a_swapped_in_bundle_reader_is_a_refusal" "$BKT_ERR" \
    "inside tampered.tar hashes to"
  expect_lacks "a_swapped_in_bundle_reader_is_never_the_one_that_runs" \
    "$(cat "$BKT_LOG")" "other-reader.py"

  # ── the in-progress marker is WRITTEN, not attempted ─────────────────────
  #
  # A path that accepts a write and stores nothing is the class this catches;
  # a symlink to /dev/null is exactly that. Without the read-back the restore
  # would go on to create six labelled volumes with nothing recording that it
  # had.
  bkt_reset
  bkt_bare_target
  ln -sf /dev/null "$BK_WORLD/marker/.restore-in-progress"
  bkt_restore cmd_restore "$RBUNDLE"
  rm -f "$BK_WORLD/marker/.restore-in-progress"
  expect_str "a_marker_that_does_not_keep_what_was_written_refuses" "$BKT_RC" "1"
  expect_has "a_marker_that_does_not_keep_what_was_written_refuses" "$BKT_ERR" \
    "did not read back as it was written"
  # The LABELLED creates, which are the project's own volumes; the throwaway
  # content volume is created before this and carries no compose label.
  expect_str "and_no_volume_is_created_without_a_record_of_it" \
    "$(grep -c 'volume create --label' "$BKT_LOG")" "0"

  # ── §9.3: the drill ──────────────────────────────────────────────────────
  bkt_reset
  bkt_bare_target
  bkt_restore cmd_restore "$RBUNDLE" --drill
  expect_str "the_drill_exits_0_on_a_bundle_that_restores" "$BKT_RC" "0"
  if [ "$BKT_RC" -ne 0 ]; then
    printf '     stdout: %s\n     stderr: %s\n' "$BKT_OUT" "$BKT_ERR"
  fi
  # port-v3 M5: the drill runs step 9 too. Its §8.3 omitted it, so the drill
  # proved the three dumps restore and proved NOTHING about v4_memdata (the
  # notes, which exist nowhere else) or v4_workspace.
  expect_has "drill_restores_and_diffs_every_volume_listing" "$BKT_OUT" \
    "volume v4_memdata -> nova-drill-"
  expect_has "drill_restores_and_diffs_every_volume_listing" "$BKT_OUT" \
    "volume v4_workspace -> nova-drill-"
  expect_has "drill_restores_and_diffs_every_volume_listing" "$BKT_OUT" "listing identical"
  expect_has "the_drill_compares_every_table_and_the_key" "$BKT_OUT" \
    "7 tables compared across 3 databases, 2 volume listings diffed"
  expect_has "the_drill_restores_into_its_own_nova_verify_databases" \
    "$(cat "$BK_WORLD/dbops.log")" "CREATE DATABASE \"nova_verify_"
  # shell-first m11: the drill's databases are NOT the backup's self-test
  # prefix, so a drill can never drop a running backup's scratch database.
  expect_lacks "drill_uses_nova_verify_and_never_the_backups_selftest_prefix" \
    "$(grep 'CREATE DATABASE' "$BK_WORLD/dbops.log")" "nova_selftest_"

  # §9.3 step 3: an EXPLICIT subnet, chosen against what is actually in use.
  # 172.18 is taken by a route in this world (shell-first m9 — a drill
  # network with no IPAM takes whatever block docker hands it, which can be
  # the very block a subsequent real restore was about to pick).
  expect_has "drill_gives_its_network_an_explicit_subnet" \
    "$(cat "$BKT_LOG")" "network create --subnet 172.19.0.0/16 nova-drill-"
  expect_has "the_drill_server_is_attached_to_exactly_that_network" "$BKT_OUT" \
    "isolated from every live network"

  # §9.3: nothing live is touched. NOT a substring hunt — the recorded argv
  # of every destructive docker call is read back, and no `nova_` object may
  # appear in one.
  expect_str "drill_never_touches_a_nova_underscore_object" \
    "$(grep -E 'volume (create|rm)' "$BKT_LOG" | grep -c 'nova_')" "0"
  expect_str "drill_creates_no_live_volume" \
    "$(find "$BKT_VOLS" -maxdepth 1 -name 'nova_v4_*' | wc -l | tr -d ' ')" "0"
  expect_str "drill_never_writes_env" \
    "$(find "$WORLD/repo/deploy" -maxdepth 1 -name '.env' | wc -l | tr -d ' ')" "0"
  expect_lacks "drill_never_runs_decide_subnet" "$(cat "$BKT_LOG")" "decide_subnet"
  expect_str "drill_never_brings_the_project_stack_up" \
    "$(grep -c 'compose .* up ' "$BKT_LOG")" "0"

  # §9.3 step 5: the teardown removes every object it created and VERIFIES
  # each removal.
  expect_str "no_nova_drill_object_survives_a_passing_drill" \
    "$(find "$BKT_VOLS" "$BK_WORLD/net" "$BK_WORLD/ct" -maxdepth 1 -name 'nova-drill-*' 2>/dev/null | wc -l | tr -d ' ')" "0"
  expect_has "the_teardown_says_what_it_removed" "$BKT_OUT" "drill: removed the network nova-drill-"

  # ...including after a failure partway through, which is the case that
  # matters: a drill that dies at step 12 must still take its wreckage.
  bkt_reset
  bkt_bare_target
  STUB_PGRESTORE_RC=1
  bkt_restore cmd_restore "$RBUNDLE" --drill
  STUB_PGRESTORE_RC=0
  expect_str "a_drill_that_fails_partway_through_still_fails" "$BKT_RC" "1"
  expect_str "no_nova_drill_object_survives_a_FAILED_drill" \
    "$(find "$BKT_VOLS" "$BK_WORLD/net" "$BK_WORLD/ct" -maxdepth 1 -name 'nova-drill-*' 2>/dev/null | wc -l | tr -d ' ')" "0"

  # §9.3 step 5: a removal that cannot be VERIFIED makes the drill FAIL,
  # naming the leftover — never a silent rm -f, never ignore_errors.
  bkt_reset
  bkt_bare_target
  STUB_VOLUME_RM_RC=1
  bkt_restore cmd_restore "$RBUNDLE" --drill
  STUB_VOLUME_RM_RC=0
  expect_str "drill_fails_when_a_removal_cannot_be_verified" "$BKT_RC" "1"
  expect_has "drill_fails_when_a_removal_cannot_be_verified" "$BKT_ERR" \
    "is still there after \`docker volume rm -f\`"
  expect_has "a_teardown_that_cannot_be_verified_is_a_FAILED_drill" "$BKT_ERR" \
    "A drill whose teardown cannot be verified is a FAILED drill"

  # §9.3 step 3: the throwaway server is attached to EXACTLY the network the
  # drill created. A drill that can reach the live project network is not a
  # drill, and `docker inspect` is asked rather than assumed.
  bkt_reset
  bkt_bare_target
  BKT_FORCE_CT_NET="nova_default"
  bkt_restore cmd_restore "$RBUNDLE" --drill
  BKT_FORCE_CT_NET=""
  expect_str "a_drill_server_on_another_network_fails" "$BKT_RC" "1"
  expect_has "a_drill_server_on_another_network_fails" "$BKT_ERR" \
    "A drill that can reach the live project network is not a"
  expect_str "and_leaves_no_drill_object_behind_either" \
    "$(find "$BKT_VOLS" "$BK_WORLD/net" "$BK_WORLD/ct" -maxdepth 1 -name 'nova-drill-*' 2>/dev/null | wc -l | tr -d ' ')" "0"

  # shell-first C3: a drill needs DOCKER, not a completed install. This
  # compose file carries no `image:` for core, so `nova-core` does not exist
  # until ./install has built it — which is exactly the mini PC, and exactly
  # what makes the move rehearsal executable there.
  bkt_reset
  bkt_bare_target
  BKT_NO_CONTAINER=core
  bkt_restore cmd_restore "$RBUNDLE" --drill
  BKT_NO_CONTAINER=""
  expect_str "drill_needs_no_installed_pack_image" "$BKT_RC" "0"
  if [ "$BKT_RC" -ne 0 ]; then printf '     stderr: %s\n' "$BKT_ERR"; fi
  expect_has "drill_falls_back_to_the_constant_image_and_pulls_it" \
    "$(cat "$BKT_LOG")" "pull python:3.12-slim"
  # s41/rulings.md, 2026-09-21: the decryptor image is a CONSTANT, never a
  # value read out of the file being opened. meta.json in this very bundle
  # names `crypto_image`, and no docker call may carry it.
  expect_str "the_decryptor_image_is_never_read_out_of_the_bundle" \
    "$(tar -xOf "$RBUNDLE" meta.json | bk_json_field fallback_image)" "python:3.12-slim"
  expect_lacks "the_decryptor_image_is_never_read_out_of_the_bundle" \
    "$(cat "$BKT_LOG")" "attacker"

  # A pull that exits 0 and leaves nothing behind is not a pull.
  bkt_reset
  bkt_bare_target
  BKT_NO_CONTAINER=core
  STUB_PULL_LANDS=0
  bkt_restore cmd_restore "$RBUNDLE" --drill
  STUB_PULL_LANDS=1
  BKT_NO_CONTAINER=""
  expect_str "a_pull_that_leaves_no_image_behind_refuses" "$BKT_RC" "1"
  expect_has "a_pull_that_leaves_no_image_behind_refuses" "$BKT_ERR" \
    "exited 0 and \`docker image inspect"

  # ── §9.4: the drill verb ─────────────────────────────────────────────────
  bkt_reset
  bkt_bare_target
  rm -rf "$BK_WORLD/archive"
  mkdir -p "$BK_WORLD/archive"
  bkt_restore cmd_drill --out "$BK_WORLD/archive"
  expect_str "drill_with_no_bundles_fails" "$BKT_RC" "1"
  expect_has "drill_with_no_bundles_fails" "$BKT_ERR" \
    "with nothing to recover from the answer
       is NO"
  expect_has "zero_bundles_is_a_failed_drill_not_a_vacuous_pass" "$BKT_ERR" \
    "That is a FAILED drill, not a drill with nothing to do"

  bkt_reset
  bkt_bare_target
  cp "$RBUNDLE" "$BK_WORLD/archive/"
  bkt_restore cmd_drill --out "$BK_WORLD/archive"
  expect_str "the_drill_verb_passes_on_a_good_bundle" "$BKT_RC" "0"
  if [ "$BKT_RC" -ne 0 ]; then
    printf '     stdout: %s\n     stderr: %s\n' "$BKT_OUT" "$BKT_ERR"
  fi
  expect_has "the_drill_verb_names_the_bundle_it_chose_and_its_age" "$BKT_OUT" \
    "the newest is $(basename "$RBUNDLE")"
  expect_has "the_drill_verb_names_the_bundle_it_chose_and_its_age" "$BKT_OUT" "day(s) old"
  expect_has "the_exit_code_is_the_verdict_and_so_is_the_last_line" "$BKT_OUT" \
    "drill PASSED: $(basename "$RBUNDLE")"
  expect_has "the_sweep_reports_what_it_left_alone" "$BKT_OUT" "sweep:"

  bkt_reset
  bkt_bare_target
  cp "$RBUNDLE" "$BK_WORLD/archive/a-bundle-with-no-stamp.tar"
  bkt_restore cmd_drill --out "$BK_WORLD/archive"
  rm -f "$BK_WORLD/archive/a-bundle-with-no-stamp.tar"
  expect_str "drill_fails_on_an_unparseable_stamp" "$BKT_RC" "1"
  expect_has "drill_fails_on_an_unparseable_stamp" "$BKT_ERR" \
    "a-bundle-with-no-stamp.tar carries no YYYYMMDDTHHMMSSZ stamp"
  expect_has "the_drill_never_orders_by_mtime" "$BKT_ERR" "never picks by mtime"

  # ── §9.4 step 5: the cross-check a drill alone cannot surface ────────────
  #
  # An OLDER bundle sealed with the PREVIOUS passphrase still verifies as a
  # bundle and cannot be opened with what is configured here. Nothing but
  # this comparison says so, and the operator should know before he needs it.
  PW_VALUE="a-second-passphrase-entirely"
  bkt_reset
  bkt_backup
  if [ "$BKT_RC" -ne 0 ]; then printf '     stderr: %s\n' "$BKT_ERR"; fi
  PW_VALUE="$BKT_PW_ORIGINAL"
  ROTATED="$(bkt_bundle)"
  if [ -n "$ROTATED" ]; then
    report 0 "a_second_bundle_exists_under_another_passphrase"
    # The rotated one must sort NEWER, so the drill restores it and the
    # ORIGINAL becomes the older bundle whose fingerprint no longer matches.
    cp "$ROTATED" "$BK_WORLD/archive/nova-backup-a-host-20990101T000000Z.tar"
  else
    report 1 "a_second_bundle_exists_under_another_passphrase" "no second bundle was written"
  fi
  bkt_reset
  bkt_bare_target
  printf '%s\n' "a-second-passphrase-entirely" > "$BK_WORLD/pw/.backup-passphrase"
  chmod 600 "$BK_WORLD/pw/.backup-passphrase"
  PW_VALUE="a-second-passphrase-entirely"
  bkt_restore cmd_drill --out "$BK_WORLD/archive"
  PW_VALUE="$BKT_PW_ORIGINAL"
  expect_str "drill_names_bundles_sealed_with_an_older_passphrase" "$BKT_RC" "1"
  expect_has "drill_names_bundles_sealed_with_an_older_passphrase" "$BKT_ERR" \
    "$(basename "$RBUNDLE") (records"
  expect_has "the_stale_passphrase_report_says_what_to_do" "$BKT_ERR" \
    "They need the PREVIOUS passphrase"
  rm -f "$BK_WORLD/archive/nova-backup-a-host-20990101T000000Z.tar"

  # ── §9.4 step 1: the sweep ───────────────────────────────────────────────
  #
  # port-v3 m4: an unconditional sweep deletes a CONCURRENT drill's volumes
  # out from under it — not reachable with one operator today, reachable the
  # day a scheduled handler lands.
  bkt_reset
  bkt_bare_target
  mkdir -p "$BKT_VOLS/nova-drill-deadbeef_v4_memdata" \
    "$BKT_VOLS/nova-drill-feedface_v4_memdata" \
    "$BKT_VOLS/nova_v4_memdata" "$BKT_VOLS/nova-backup-stage-keepme"
  : > "$BK_WORLD/net/nova-drill-deadbeef-net"
  : > "$BK_WORLD/ct/nova-drill-feedface-pg"
  BKT_RUNNING="nova-drill-feedface-pg"
  bkt_restore cmd_drill --out "$BK_WORLD/archive"
  expect_str "drill_sweep_removes_an_orphaned_run" \
    "$(find "$BKT_VOLS" -maxdepth 1 -name 'nova-drill-deadbeef_*' | wc -l | tr -d ' ')" "0"
  expect_str "drill_sweep_removes_an_orphaned_network" \
    "$(find "$BK_WORLD/net" -maxdepth 1 -name 'nova-drill-deadbeef-net' | wc -l | tr -d ' ')" "0"
  expect_str "drill_sweep_skips_a_live_run" \
    "$(find "$BKT_VOLS" -maxdepth 1 -name 'nova-drill-feedface_*' | wc -l | tr -d ' ')" "1"
  expect_str "drill_sweep_never_touches_a_nova_underscore_object" \
    "$(find "$BKT_VOLS" -maxdepth 1 -name 'nova_v4_memdata' | wc -l | tr -d ' ')" "1"
  expect_str "drill_sweep_never_touches_a_backups_staging_volume" \
    "$(find "$BKT_VOLS" -maxdepth 1 -name 'nova-backup-stage-keepme' | wc -l | tr -d ' ')" "1"
  BKT_RUNNING=""
  rm -rf "$BKT_VOLS/nova-drill-feedface_v4_memdata" "$BK_WORLD/ct/nova-drill-feedface-pg"

  # An orphaned nova_verify_* database on the LIVE server, with no open
  # connection and older than an hour.
  bkt_reset
  bkt_bare_target
  BKT_RUNNING="postgres"
  BKT_BARE_TARGET=0
  STUB_ORPHAN_VERIFY_DBS="nova_verify_a1b2c3d4"
  bkt_restore cmd_drill --out "$BK_WORLD/archive"
  STUB_ORPHAN_VERIFY_DBS=""
  expect_has "drill_sweep_drops_an_orphaned_verify_database" \
    "$(cat "$BK_WORLD/dbops.log")" 'DROP DATABASE IF EXISTS "nova_verify_a1b2c3d4"'

  bkt_reset
  bkt_bare_target
  BKT_RUNNING="postgres"
  BKT_BARE_TARGET=0
  STUB_ORPHAN_VERIFY_DBS="nova_verify_a1b2c3d4"
  STUB_VERIFY_DB_CONNS=1
  bkt_restore cmd_drill --out "$BK_WORLD/archive"
  STUB_VERIFY_DB_CONNS=0
  STUB_ORPHAN_VERIFY_DBS=""
  expect_str "drill_sweep_leaves_a_verify_database_something_is_connected_to" \
    "$(grep -c 'DROP DATABASE IF EXISTS \"nova_verify_a1b2c3d4\"' "$BK_WORLD/dbops.log")" "0"

  bkt_reset
  bkt_bare_target
  BKT_RUNNING="postgres"
  BKT_BARE_TARGET=0
  STUB_ORPHAN_VERIFY_DBS="nova_verify_a1b2c3d4"
  STUB_VERIFY_DB_OLD=0
  bkt_restore cmd_drill --out "$BK_WORLD/archive"
  STUB_VERIFY_DB_OLD=1
  STUB_ORPHAN_VERIFY_DBS=""
  expect_str "drill_sweep_leaves_a_verify_database_younger_than_an_hour" \
    "$(grep -c 'DROP DATABASE IF EXISTS \"nova_verify_a1b2c3d4\"' "$BK_WORLD/dbops.log")" "0"

  # The container filter is ANCHORED, because `docker ps --filter name=` is an
  # unanchored substring match. The recorded argv is read back.
  expect_has "the_sweeps_container_filter_is_anchored" "$(cat "$BKT_LOG")" \
    "ps --filter name=^nova-drill-"

fi

[ "$SKIP" -eq 0 ] || printf '\n%d block(s) SKIPPED — see the SKIP lines above\n' "$SKIP"
printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
