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
# THIS FILE IS HALF-BUILT BY DESIGN: T1 is the fact renderers below. The verbs
# (`cmd_backup`, `cmd_restore`, `cmd_drill`, `cmd_undo_move`), the run lock,
# the mode probe and the EXIT traps land beside them and consume these facts.

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

# raw.json — THE DECLARED SET, from the raw text of every compose file.
# Never from a render: compose prunes a volume no rendered service mounts out
# of `config`, `config --format json` and `config --volumes` alike (measured
# on v5.3.0 and v5.5.1), and a declared volume nothing mounts is the exact
# case coverage exists to catch.
render_raw() {
  local stage="$1"
  local out="$stage/facts/raw.json" text="" f first files
  files="$(bk_compose_files)"
  if [ -z "$files" ]; then
    bk_fail "COMPOSE_FILE names no compose file, so there is no declared set to read."
    return 1
  fi
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    if [ ! -r "$f" ]; then
      bk_fail "COMPOSE_FILE names $f and this host cannot read it."
      return 1
    fi
    text="$text
$(cat "$f")"
  done <<EOF
$files
EOF

  {
    printf '{\n  "project": "%s",\n  "compose_files": [' "$(bk_j "$(printf '%s' "$text" | raw_project_name)")"
    first=1
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      [ "$first" -eq 1 ] || printf ','
      first=0
      printf '\n    "%s"' "$(bk_j "$f")"
    done <<EOF
$files
EOF
    printf '\n  ],\n  "services": ['
    first=1
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      [ "$first" -eq 1 ] || printf ','
      first=0
      printf '\n    "%s"' "$(bk_j "$f")"
    done <<EOF
$(printf '%s' "$text" | raw_service_keys | sort -u)
EOF
    printf '\n  ],\n  "volumes": ['
    first=1
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      [ "$first" -eq 1 ] || printf ','
      first=0
      printf '\n    "%s"' "$(bk_j "$f")"
    done <<EOF
$(printf '%s' "$text" | raw_volume_keys | sort -u)
EOF
    printf '\n  ]\n}\n'
  } > "$out"
  bk_verify_fact "$out" "reading the raw text of COMPOSE_FILE" /dev/null
}

# config.yaml + dispositions.json — THE DISPOSITIONS, and only from here.
# `config --format json` keeps only a TOP-LEVEL `x-` key and strips every
# nested one (a volume's, a service's, a long-syntax mount's), and every
# disposition is nested. dispositions.json is what crosses into the container,
# so the container needs no YAML parser.
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

if [ "${BASH_SOURCE[0]:-$0}" = "${0}" ]; then
  printf 'deploy/backup.sh is sourced by deploy/install.sh; it has no verbs yet.\n' >&2
  exit 1
fi
