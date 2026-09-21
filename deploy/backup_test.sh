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
    *) return 0 ;;
  esac
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
    cat "$WORLD/ids.txt"
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
  case "$2" in
    create) mkdir -p "$BKT_VOLS/$3"; printf '%s\n' "$3" ;;
    rm)
      [ "$STUB_VOLUME_RM_RC" -eq 0 ] || return "$STUB_VOLUME_RM_RC"
      shift 2
      for a in "$@"; do
        case "$a" in -*) ;; *) rm -rf "${BKT_VOLS:?}/$a" ;; esac
      done
      ;;
    inspect) [ -d "$BKT_VOLS/$3" ] || return 1 ;;
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
          else
            printf '%s\t%s\t%s\n' "$t" "${#t}" "$((${#t} * 7))"
          fi
        done
      ;;
    *"FROM schema_migrations"*) printf '%s\n' "$STUB_MIGRATION_ROWS" ;;
    *"SELECT current_database()"*) printf '%s\n' "${STUB_CURRENT_DB:-$db}" ;;
    "CREATE DATABASE"*)
      printf '%s\n' "$sql" >> "$BK_WORLD/dbops.log"
      return "$STUB_CREATEDB_RC"
      ;;
    "DROP DATABASE"*)
      printf '%s\n' "$sql" >> "$BK_WORLD/dbops.log"
      ;;
    *"to_regclass('public.core_signing_key')"* | *"to_regclass('public.devices')"* | *"to_regclass('public.people')"*)
      if [ "$db" = "nova_core" ]; then printf 't\n'; else printf 'f\n'; fi
      ;;
    *"count(*) FROM core_signing_key"*) printf '%s\n' "$STUB_SIGNING_ROWS" ;;
    *"encode(sha256("*)
      printf '77d1000000000000000000000000000000000000000000000000000000000000\n'
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
  case "$db" in
    nova_selftest_*)
      src="$(cat "$BK_WORLD/scratch/$db" 2>/dev/null)"
      [ -n "$src" ] && db="$src"
      ;;
  esac
  case "$db" in
    nova_core) printf 'devices people schema_migrations\n' ;;
    nova_gateway) printf 'schema_migrations spend\n' ;;
    nova_memory) printf 'notes schema_migrations\n' ;;
    *) printf 'schema_migrations\n' ;;
  esac
}

# `docker run` — re-run here, with the mounts rewritten.
bkt_run() {
  local img="" ep="" a spec src rest dst
  shift
  BKT_MAP="/tmp	$BK_WORLD/ctmp"
  mkdir -p "$BK_WORLD/ctmp"
  while [ $# -gt 0 ]; do
    a="$1"
    case "$a" in
      --rm | -i | -t | -it | --init) shift; continue ;;
      --network | --user | -e | -w | --name) shift 2; continue ;;
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
  for a in "$@"; do
    case "$want" in
      d) scratch="$a"; want="" ;;
      *) ;;
    esac
    case "$a" in
      -d) want=d ;;
      /stage/inner/db/*.dump) dump="$(basename "$a" .dump)" ;;
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
  printf '%s' "$PW_VALUE" > "$BK_WORLD/pw/.backup-passphrase"
  chmod 600 "$BK_WORLD/pw/.backup-passphrase"
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
fi

[ "$SKIP" -eq 0 ] || printf '\n%d block(s) SKIPPED — see the SKIP lines above\n' "$SKIP"
printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
