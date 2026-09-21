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

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
