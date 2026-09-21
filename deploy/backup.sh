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
# THIS FILE IS STILL HALF-BUILT: T1 is the fact renderers and T3 is
# `cmd_backup` below it — the run lock, the mode probe, the census, the
# staging and the EXIT trap. `cmd_restore`, `cmd_drill` and `cmd_undo_move`
# land beside them and consume the same facts and the same staging layout.

BK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
BK_REPO_ROOT="$(cd "$BK_DIR/.." && pwd)"

# shellcheck source=/dev/null
. "$BK_DIR/compose_read.sh"

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
    while IFS='	' read -r anon_svc anon_dest anon_name; do
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
      while IFS='	' read -r line src _tgt _ro disp _reason; do
        [ "$line" = "bind" ] || continue
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
  local stage="$1" mode="${2:-routine}" yaml key disp carried svc hit
  local mtype msrc _mtgt mro _mdisp _mreason
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
    while IFS='	' read -r mtype msrc _mtgt mro _mdisp _mreason; do
      [ "$mtype" = "volume" ] || continue
      [ "$mro" = "true" ] && continue
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
BK_RUN_CLEANED=0
BK_RUN_LOCK=""
BK_RUN_STAGE=""
BK_RUN_STAGE_VOL=""
BK_RUN_PART=""
BK_RUN_STOPPED=""
BK_RUN_SCRATCH=""
BK_RUN_PG_ID=""
BK_RUN_MODE="routine"

bk_backup_cleanup() {
  local failures=0 db svc left
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

  if [ -n "$BK_RUN_STOPPED" ] && [ "$BK_RUN_MODE" != "move" ]; then
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
        printf 'cleanup: restarted%s\n' "$left"
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
  local vol="$1" image="$2" key="$3" full="$4" line src_n out_n src_f hash_n bytes
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

  devices=0
  people=0
  f="$(bk_db_with_table "$pg_id" devices "$facts")"
  if [ -n "$f" ]; then
    devices="$(bk_psql "$pg_id" "$f" "SELECT count(*) FROM devices" 2>/dev/null | tr -dc '0-9')"
    [ -n "$devices" ] || devices=0
  fi
  f="$(bk_db_with_table "$pg_id" people "$facts")"
  if [ -n "$f" ]; then
    people="$(bk_psql "$pg_id" "$f" "SELECT count(*) FROM people" 2>/dev/null | tr -dc '0-9')"
    [ -n "$people" ] || people=0
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
  if ! bk_docker compose "${BK_COMPOSE_ARGS[@]}" --profile '*' stop >/dev/null 2>&1; then
    bk_fail "the bundle IS written at $final.
       Separately: \`docker compose stop\` did not exit 0, so this host is NOT
       parked. Do not start Nova on the destination until it is."
    return 1
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
       Separately:$still would not stop, so this host is NOT parked. Two live
       Novas sharing one identity is the failure a move exists to avoid."
    return 1
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
      bk_fail "could not write the move marker $path, so this host is NOT parked."
      return 1
    }
    chmod 600 "$path" 2>/dev/null
    if [ "$(cat "$path" 2>/dev/null)" != "$body" ]; then
      bk_fail "the move marker $path did not read back as it was written, so this host
       is NOT parked. Nobody should believe the source host is stopped when it is
       not."
      return 1
    fi
  done
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
  local cov entries_n writers writers_list issued
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
  while IFS=$'\037' read -r key name disp full svc _target why; do
    [ "$disp" = "include" ] || continue
    case "$key" in
      volume | anon)
        line="$(bk_volume_du_kb "${full:-$name}" "$pg_image_id" 2>/dev/null | tr -dc '0-9')"
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

  pg_kb="$(bk_psql "$pg_id" postgres "SELECT coalesce(sum(pg_database_size(datname)), 0) / 1024 FROM pg_database WHERE datallowconn AND datname NOT IN ('postgres', 'template0', 'template1')" 2>/dev/null | tr -dc '0-9')"
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
    bk_stage_put "$vol" "$pg_image_id" "inner/db/$db.counts.tsv" < "$census_src" || return 1
    bk_migrations_tsv "$pg_id" "$db" > "$stage/$db.migrations.tsv" || return 1
    bk_stage_put "$vol" "$pg_image_id" "inner/db/$db.migrations.tsv" < "$stage/$db.migrations.tsv" || return 1

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
    bk_tar_volume "$vol" "$pg_image_id" "$name" "${full:-$name}" || return 1
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
    printf '%s' "$env_body" | bk_stage_put "$vol" "$pg_image_id" "inner/env/carried.env" || return 1
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
    bk_park "$stamp" "$final" "$sha" "$host" "$(bk_tailnet_dns_name)" || return 1
    BK_RUN_STOPPED=""
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

if [ "${BASH_SOURCE[0]:-$0}" = "${0}" ]; then
  printf 'deploy/backup.sh is sourced by deploy/install.sh; run `./install backup`.\n' >&2
  exit 1
fi
