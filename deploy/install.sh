#!/usr/bin/env bash
# Nova v4 installer. Idempotent: safe to re-run.
# ./install.sh          preflight -> hardware detect -> secrets -> compose
#                        up -d --build -> wait for health -> status table
#                        -> ollama's own word on the GPU -> this machine's
#                        own agent (built, checked, paired by environment)
# ./install.sh update   pull the newest commit on the branch and reinstall
# bash 3.2 compatible (no associative arrays, no ${var,,}, no mapfile).

# Bash, or nothing. Everything below is bash's, and the entry guard at the
# foot of this file reads BASH_SOURCE, which only bash sets: under any other
# shell it reads "executed" even when the file was sourced, and main runs.
# Measured 2026-10-06 (S42b Task 27): sourced from zsh, this file ran
# cmd_install's preflight against the live docker. So before anything else
# runs, a shell that is not bash is told so in one line on stderr and goes no
# further — `return` when it sourced the file (that shell lives on), `exit`
# when it ran it. The one block in this file written for any POSIX shell.
if [ -z "${BASH_VERSION:-}" ]; then
  if [ -n "${ZSH_VERSION:-}" ]; then _nova_shell="zsh"
  elif [ -n "${KSH_VERSION:-}" ]; then _nova_shell="ksh"
  else _nova_shell="sh"; fi
  printf '%s\n' "install.sh: cannot run under $_nova_shell — run ./install, or bash deploy/install.sh" >&2
  unset _nova_shell
  # In a file that was run, not sourced, `return` either ends it (dash,
  # busybox, zsh) or fails, and then `exit` does: status 1 either way.
  # shellcheck disable=SC2317
  return 1 2>/dev/null || exit 1
fi
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEPLOY_DIR="$SCRIPT_DIR"
ENV_FILE="$DEPLOY_DIR/.env"
ENV_EXAMPLE="$DEPLOY_DIR/.env.example"
DATA_DIR="$REPO_ROOT/data"
HARDWARE_JSON="$DATA_DIR/hardware.json"
COMPOSE_FILE="$DEPLOY_DIR/docker-compose.yml"
GPU_COMPOSE_FILE="$DEPLOY_DIR/docker-compose.gpu.yml"

# INSTANCE_SECRET used to be generated here too. It is dead config — nothing
# in any service reads it, sessions are DB-hashed random tokens — so it was
# dropped (S2 seam-hygiene). A real operator's existing .env may still carry
# a stale value from before this change; that line is left exactly where it
# is rather than edited out, since touching a file this script did not need
# to touch is its own kind of bug.
# SEARXNG_SECRET signs SearXNG's own result URLs; it has a compose default so a
# bare `docker compose up` works, but a real install generates a random one here
# like every other secret rather than shipping the shared default.
SECRET_KEYS="POSTGRES_PASSWORD CORE_TOKEN CORE_GATEWAY_TOKEN CORE_MEMORY_TOKEN SEARXNG_SECRET"
# The bundled ollama joins this list only when it is actually being started —
# see decide_inference. searxng comes up with the base stack (no profile), so it
# is always waited on: web search is a first-class capability, not an add-on.
# browser (S38) comes up with the base stack too: her browser is a capability,
# not an add-on, and an install whose engine never answered is not a success.
HEALTH_CHECKED_SERVICES="postgres core gateway memory web searxng browser"
# Ports we WARN about: the services below are ours, so a busy port here is
# almost always our own previous install, and a warning is the honest level.
# 8380 is searxng's published loopback port (docker-compose.yml).
REQUIRED_PORTS="3000 8000 8001 8002 8380"
# The bundled ollama's port is NOT in that list, because a warning is the
# wrong level for it: the container publishes it, so a busy port is a hard
# failure a few seconds later. decide_inference refuses up front instead.
OLLAMA_PORT=11434
BUNDLED_INFERENCE=1

# Every `docker compose` call in this script goes through this array, so the
# GPU override and the inference profile can never be applied to `up` and then
# forgotten on `ps` — which would leave the health table reading a container
# set that is not the one running. (Indexed arrays are bash 3.2; only
# ASSOCIATIVE arrays are 4.0+, and there are none here.)
COMPOSE_ARGS=(-f "$COMPOSE_FILE")
# Profiles an explicit off-switch turned off this run (NOVA_SKIP_INFERENCE=1,
# NOVA_TAILNET=0), space-separated. record_compose_profiles takes each out of
# COMPOSE_PROFILES in .env, so a later plain `docker compose up -d` does not
# bring back an engine this run was told to leave off. Mere absence is not a
# switch: only the explicit "off" un-writes.
PROFILES_SWITCHED_OFF=""

# Written by `./install backup --move` when this host hands Nova over, and
# removed by `./install undo-move`. Its sibling, deploy/tailscale/MOVED_TO,
# lives inside the read-only /config bind the sidecar already has, so the
# refusal exists at both layers (design-verdict.md §9.5).
MOVED_MARKER="$DEPLOY_DIR/.moved"

# The tailnet sidecar's scripts (start.sh, serve_check.sh), bind-mounted
# read-only at /config. start.sh runs ONCE, at container start, so a change
# to it in git reaches nothing until the container is recreated — and compose
# recreates only when the service's config changes, which a script edit does
# not. record_tailscale_scripts puts their hash into the config (a label fed
# from .env) and verify_tailscale_scripts reads it back off the running
# container. Measured 2026-10-07 deploying PR #111: the sidecar kept running
# a two-day-old start.sh behind "Nova is up".
TAILSCALE_DIR="$DEPLOY_DIR/tailscale"
TAILSCALE_SCRIPTS_LABEL="nova.tailscale-scripts"

log() { printf '%s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

# The subnet decision and its CIDR arithmetic. A separate file because it is
# the one part of the installer that has to work under BSD userland — macOS
# has no `ip` — and because deploy/backup.sh needs the same functions when it
# restores onto a machine whose networks are somebody else's.
# shellcheck source=subnet.sh
. "$SCRIPT_DIR/subnet.sh"

# ---- preflight ----------------------------------------------------------

check_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    die "docker not found on PATH — install Docker first"
  fi
  if ! docker info >/dev/null 2>&1; then
    die "docker is installed but not running (or not reachable)"
  fi
  log "docker: present and running"
}

check_compose() {
  if ! docker compose version >/dev/null 2>&1; then
    die "docker compose v2 not found — install the compose plugin"
  fi
  log "compose: present"
}

# Separated from check_openssl so a test can stub the seam without hiding the
# real binary from PATH (same pattern as port_holder/ollama_answers_on_host).
have_openssl() {
  command -v openssl >/dev/null 2>&1
}

check_openssl() {
  if ! have_openssl; then
    die "openssl not found on PATH — install it (e.g. 'apt install openssl' on Debian/Ubuntu, 'brew install openssl' on macOS) — generate_secrets needs it to create this instance's tokens"
  fi
  log "openssl: present"
}

# The same seam split as have_openssl. Checked in preflight, before anything
# is pulled or started: install_hub_agent needs git only after the stack is
# up, and finding it missing there would be a failure that could have been
# said first.
have_git() {
  command -v git >/dev/null 2>&1
}

check_git() {
  if ! have_git; then
    die "git is needed: ./install builds Nova's agent from this checkout's committed tree"
  fi
  log "git: present"
}

detect_disk_free_gb() {
  df -Pk "$1" | awk 'NR==2 {printf "%d", $4/1024/1024}'
}

check_disk() {
  local free_gb
  free_gb="$(detect_disk_free_gb "$REPO_ROOT")"
  if [ "$free_gb" -lt 10 ]; then
    die "only ${free_gb} GB free at $REPO_ROOT — need at least 10 GB"
  fi
  log "disk: ${free_gb} GB free at $REPO_ROOT (>= 10 GB required)"
}

port_holder() {
  local port="$1" result=""
  # lsof/ss exit non-zero on "nothing found" (expected for a free port —
  # `|| true` stops that tripping set -e/pipefail). Unprivileged lsof also
  # can't see sockets owned by another user (e.g. root's docker-proxy), so
  # fall back to `ss -ltn`, which shows a listener without needing root.
  if command -v lsof >/dev/null 2>&1; then
    result="$(lsof -n -P -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | awk 'NR==2 {print $1"("$2")"}' || true)"
  fi
  if [ -z "$result" ] && command -v ss >/dev/null 2>&1; then
    result="$(ss -ltn 2>/dev/null | awk -v p=":$port" '$4 ~ p"$" {print "listener (name unknown, need root)"; exit}' || true)"
  fi
  printf '%s' "$result"
}

check_ports() {
  local port holder
  for port in $REQUIRED_PORTS; do
    holder="$(port_holder "$port")"
    if [ -n "$holder" ]; then
      log "WARNING: port $port is already in use ($holder)"
    else
      log "port $port: free"
    fi
  done
}

canonical_path() {
  # Absolute, symlink-resolved path — for a file that may not exist on this
  # filesystem at all. A compose config_files label can name a path from
  # inside some other container (the v3 stack has containers labelled
  # /compose/docker-compose.yml), and those must compare as themselves rather
  # than blow up. Only the directory is resolved, and only when it exists.
  local path="$1" dir base
  dir="$(dirname "$path")"
  base="$(basename "$path")"
  if [ -d "$dir" ]; then
    printf '%s/%s' "$(cd "$dir" && pwd -P)" "$base"
  else
    printf '%s' "$path"
  fi
}

# THE SEAM. Prints the `com.docker.compose.project.config_files` label of
# whatever container currently occupies this project's ollama service slot.
#   exit 0 — a container is there; stdout is its label (possibly empty)
#   exit 1 — no container occupies the slot
#   exit 2 — docker could not be asked
# Separated from the judgement below so the judgement can be tested against
# fixture labels without a docker daemon.
ollama_slot_config_files() {
  local cid
  cid="$(docker compose -f "$COMPOSE_FILE" --profile inference ps -q ollama 2>/dev/null)" || return 2
  [ -n "$cid" ] || return 1
  docker inspect --format \
    '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$cid" 2>/dev/null \
    || return 2
}

# Why the answer is what it is — set by bundled_ollama_running, printed by
# decide_inference. An unexplained classification is not much better than a
# wrong one.
BUNDLED_OLLAMA_REASON=""

# Is the container on the ollama slot OURS?
#
# "Project name plus service name" is not enough, by construction. The legacy
# v3 stack at ~/workspace/nova ALSO declares `name: nova` and ALSO defines a
# service called `ollama` behind `profiles: ["inference"]`, so
# `compose ps -q ollama` matches either of them and cannot tell them apart.
# That is not a hypothetical collision: `docker compose down` does not reach
# a profiled service, so a v3 ollama surviving a v3 teardown and sitting on
# :11434 is the documented normal case — and calling it "ours" would make
# `up` silently recreate the v3 container, which is the exact opposite of the
# refusal this whole path exists to produce.
#
# So the identity check is the config files the container was created from,
# compared by resolved path against THIS repo's compose file.
#   0 — ours
#   1 — not ours (foreign, unlabelled, or nothing there)
#   2 — could not be determined
bundled_ollama_running() {
  local labels rc entry want
  labels="$(ollama_slot_config_files)" && rc=0 || rc=$?
  case "$rc" in
    1)
      BUNDLED_OLLAMA_REASON="no container occupies this project's ollama slot"
      return 1
      ;;
    2)
      BUNDLED_OLLAMA_REASON="docker could not be asked which container holds the ollama slot"
      return 2
      ;;
  esac
  if [ -z "$labels" ]; then
    BUNDLED_OLLAMA_REASON="the container on the ollama slot carries no compose config-files label"
    return 1
  fi

  want="$(canonical_path "$COMPOSE_FILE")"
  local OLDIFS="$IFS"
  IFS=','
  for entry in $labels; do
    IFS="$OLDIFS"
    if [ "$(canonical_path "$entry")" = "$want" ]; then
      BUNDLED_OLLAMA_REASON="created from $want"
      return 0
    fi
    IFS=','
  done
  IFS="$OLDIFS"
  BUNDLED_OLLAMA_REASON="the container on the ollama slot was created from [$labels], not from $want"
  return 1
}

# Was a container, volume or network created from THIS checkout's compose
# file? $1 is a com.docker.compose.project.config_files label: compose writes
# every -f it was given, comma-separated, and a match on any one of them is a
# match. Compared by canonical path, so a label naming a path that does not
# exist on this filesystem (the v3 stack has containers labelled
# /compose/docker-compose.yml) compares as itself rather than blowing up.
#
# bundled_ollama_running above walks the same list by hand and is left alone
# on purpose: its BUNDLED_OLLAMA_REASON strings are what its own cases assert,
# and folding them into a boolean would lose them.
config_files_are_ours() {
  local labels="$1" want entry OLDIFS="$IFS"
  [ -n "$labels" ] || return 1
  want="$(canonical_path "$COMPOSE_FILE")"
  IFS=','
  for entry in $labels; do
    IFS="$OLDIFS"
    if [ "$(canonical_path "$entry")" = "$want" ]; then
      return 0
    fi
    IFS=','
  done
  IFS="$OLDIFS"
  return 1
}

ollama_answers_on_host() {
  # Is the thing holding the port an ollama, or something else entirely? The
  # remedy differs, so the message must not guess. No HTTP client available
  # means "cannot tell", which is a different answer again.
  local url="http://127.0.0.1:${OLLAMA_PORT}/api/version"
  if command -v curl >/dev/null 2>&1; then
    curl -fsS -m 3 "$url" >/dev/null 2>&1
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O /dev/null -T 3 "$url" >/dev/null 2>&1
  else
    return 2
  fi
}

# The bundled ollama publishes 127.0.0.1:11434, so a host that already runs
# its own ollama — Nova's PRIMARY user, per the product principles — cannot
# start it. Before this, the installer logged "WARNING: port 11434 is already
# in use" and then `docker compose up` died a few seconds later with a raw
# "port is already allocated". A warning that is really a fatal is a lie about
# severity, and the remedy was nowhere.
#
# So: refuse here, name what is holding the port, and give the two real ways
# out. NOT "silently reuse the host ollama" — that would make the wizard's
# "Bundled Ollama" card, which says in as many words "in the container that
# shipped with Nova", describe something else. Nova already has an honest
# route to a host engine: the wizard's Remote endpoint option.
decide_inference() {
  if [ "${NOVA_SKIP_INFERENCE:-}" = "1" ]; then
    BUNDLED_INFERENCE=0
    log "inference: bundled ollama skipped (NOVA_SKIP_INFERENCE=1)"
    log "           choose 'Remote endpoint' in the wizard and point it at your own engine"
    return 0
  fi

  local holder rc
  holder="$(port_holder "$OLLAMA_PORT")"
  if [ -z "$holder" ]; then
    BUNDLED_INFERENCE=1
    log "port $OLLAMA_PORT: free (bundled ollama will publish it)"
    return 0
  fi

  # The commonest reason that port is busy is that WE are on it. This script
  # is documented as idempotent, and refusing to re-run because the container
  # from the last run is still up would be a worse bug than the one this
  # function exists to fix. "We" is decided by which compose file the
  # container was built from — see bundled_ollama_running.
  local ours
  bundled_ollama_running && ours=0 || ours=$?
  if [ "$ours" -eq 0 ]; then
    BUNDLED_INFERENCE=1
    log "port $OLLAMA_PORT: held by this stack's own ollama — re-using it"
    log "                  ($BUNDLED_OLLAMA_REASON)"
    return 0
  fi
  if [ "$ours" -eq 2 ]; then
    # Distinct from "there is nothing of ours there": we do not know. Refusing
    # is the safe direction, but the message must not claim more than it has.
    log "ERROR: $BUNDLED_OLLAMA_REASON, so whether the listener on port"
    log "       $OLLAMA_PORT belongs to this stack could not be established."
    log "       Refusing rather than guessing — fix docker, or re-run with"
    log "       NOVA_SKIP_INFERENCE=1 and use the wizard's Remote endpoint."
    exit 1
  fi

  ollama_answers_on_host && rc=0 || rc=$?
  if [ "$rc" -eq 0 ]; then
    log "ERROR: an ollama is already serving on 127.0.0.1:$OLLAMA_PORT ($holder), and the"
    log "       bundled one publishes that same port, so it cannot start."
  elif [ "$rc" -eq 2 ]; then
    log "ERROR: port $OLLAMA_PORT is held by $holder, and the bundled ollama publishes it."
    log "       (No curl or wget here, so whether that is an ollama could not be checked.)"
  else
    log "ERROR: port $OLLAMA_PORT is held by $holder — which did not answer as an ollama —"
    log "       and the bundled ollama publishes that port, so it cannot start."
  fi
  # When a CONTAINER holds the slot but was built from someone else's compose
  # file, say so and name it. The likeliest someone else is the legacy v3
  # stack, which shares this project name and this service name, and whose
  # ollama survives a plain `docker compose down` because down does not reach
  # a profiled service.
  if [ -n "$BUNDLED_OLLAMA_REASON" ] && [ "$BUNDLED_OLLAMA_REASON" != \
       "no container occupies this project's ollama slot" ]; then
    log "       The container on the ollama slot is not this stack's:"
    log "       $BUNDLED_OLLAMA_REASON"
  fi
  log ""
  log "       Ways forward:"
  log "         1. If that is the OLD v3 stack's ollama (it shares this project name and"
  log "            survives a plain 'docker compose down', which does not reach a profiled"
  log "            service):"
  log "              docker stop nova-ollama-1"
  log "            or, from the v3 tree:  docker compose --profile inference down"
  log "         2. If it is a host ollama, stop it — e.g. 'systemctl --user stop ollama' —"
  log "            or kill the process named above. Then re-run ./install."
  log "         3. Keep whatever is there and skip the bundled engine:"
  log "              NOVA_SKIP_INFERENCE=1 ./install"
  log "            then pick 'Remote endpoint' in the wizard, pointing at"
  log "            http://host.docker.internal:$OLLAMA_PORT (or this host's LAN address)."
  exit 1
}

# `backup --move` parks this machine: Nova's tailnet node identity left in the
# bundle, and both markers were written here. Starting the stack again would
# put a SECOND tailscaled on that one identity, and two nodes sharing a node
# key flap — which is not a thing a health check notices.
#
# So this runs FIRST in cmd_install, before anything is read, pulled or
# started. It is a CANNOT, not a MAY NOT: it does not decide that this host
# may not run Nova, it reports the fact that the identity is somewhere else
# and names the one command that clears it. `undo-move` then takes the
# owner's typed word and proceeds either way (design-verdict.md §9.5).
refuse_if_moved() {
  [ -f "$MOVED_MARKER" ] || return 0
  log "REFUSED: this machine was parked by \`./install backup --move\`."
  log ""
  log "  $MOVED_MARKER says:"
  # Printed verbatim, not parsed: whatever the marker holds, the operator
  # sees. A marker this script cannot read is still a marker.
  sed 's/^/    /' < "$MOVED_MARKER" >&2 || true
  log ""
  log "Nova runs on the host named above. Starting it here as well would put a"
  log "second tailscaled on the same tailnet node identity, and the two flap."
  log ""
  log "If this machine is the one that should run Nova again:"
  log "    ./install undo-move     # prints the marker, then asks you to type: undo"
  die "moved host: $MOVED_MARKER is present"
}

# ---- the foreign `nova` compose project (#29, owner ruling 1) --------------
#
# v4's compose project is named `nova`, and so were the platform-line stack
# and the v3 stack before it. `docker compose up` in a project whose name
# already has containers ADOPTS and recreates them. Owner ruling 1
# (docs/plans/rebuild/s41/rulings.md): name every container and volume found,
# then offer to delete exactly that, defaulting to doing nothing.
#
# THREE CONSTRAINTS, ALL MEASURED, ALL BINDING (map-minipc-measured.md):
#
#  1. SELECT BY LABEL, NEVER BY NAME, and print the label beside every object.
#     On the mini PC `nova_pgdata` (75.77 MB) and `nova_redis_data` carried
#     `com.docker.compose.project=docker` — a DIFFERENT project of his — while
#     the old Nova owned `nova_postgres-data` and `nova_redis-data`. Two of
#     his containers were likewise NAMED `nova-postgres`/`nova-redis` under
#     project `docker`. The obvious `nova_` prefix rule destroys 75.8 MB of
#     someone else's data. That near-miss is the reason every candidate here
#     comes out of a `--filter label=…` and carries its own label back.
#
#  2. ASK DOCKER, NOT COMPOSE. That project's compose file on that machine is
#     a root-owned empty DIRECTORY (the single-file bind-mount failure mode),
#     so `docker compose -p nova down -v` cannot read its config at all.
#     Nothing here shells out to compose for the foreign side.
#
#  3. AN EMPTY PROJECT NAME MUST BE IMPOSSIBLE TO PASS. `--filter
#     label=com.docker.compose.project=` with an empty value matches EVERY
#     container on the host. The two seams that take the project name refuse
#     an empty one themselves, so the property does not depend on a caller
#     having checked.
#
# All three old projects on that machine were archived and removed on
# 2026-09-21, so this refusal and its deletion loop can no longer be walked
# against a real foreign project on any machine we have. Every case is
# fixture-backed (deploy/install_test.sh), built from the recorded
# pre-cleanup reading; #29's refusal branch has never run on hardware and the
# slice record says so rather than implying coverage.

# THE SEAM. compose's own render with EVERY profile on. Unlike
# compose_config_text above, stderr is CAPTURED into the file $1 rather than
# discarded: a render that fails must be reported in compose's own words, not
# as "no volumes found" (port-v3 m5).
compose_config_text_all_profiles() {
  docker compose "${COMPOSE_ARGS[@]}" --profile '*' config 2>"$1"
}

# THE SEAMS. Everything below asks docker, never compose, and every one that
# takes the project name refuses an empty one.
project_containers() {
  [ -n "$1" ] || { log "docker: refusing to list containers for an EMPTY compose project — that filter matches every container on this host"; return 2; }
  # --no-trunc so .ID is the full 64-hex id `docker inspect -f {{.Id}}` also
  # returns; the deletion loop compares the two and a truncated capture would
  # never match, so every container would be skipped.
  docker ps -a --no-trunc \
    --filter "label=com.docker.compose.project=$1" \
    --format '{{.ID}}	{{.Names}}	{{.Label "com.docker.compose.service"}}	{{.State}}' 2>/dev/null
}
container_config_files() {
  docker inspect --format \
    '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$1" 2>/dev/null
}
container_exists() { docker inspect --type container "$1" >/dev/null 2>&1; }
container_id_of() { docker inspect --format '{{.Id}}' "$1" 2>/dev/null; }
container_mounted_volumes() {
  docker inspect --format \
    '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}}
{{end}}{{end}}' "$1" 2>/dev/null
}
containers_using_volume() {
  docker ps -a -q --no-trunc --filter "volume=$1" 2>/dev/null
}
project_labelled_volumes() {
  [ -n "$1" ] || { log "docker: refusing to list volumes for an EMPTY compose project — that filter matches every volume on this host"; return 2; }
  docker volume ls -q --filter "label=com.docker.compose.project=$1" 2>/dev/null
}
all_volume_names() { docker volume ls -q 2>/dev/null; }
volume_exists() { docker volume inspect "$1" >/dev/null 2>&1; }
volume_label() {
  # The {{if .Labels}} guard matters: a volume made by hand (`docker volume
  # create`, or `docker run -v <name>:/x`) has a NIL label map, and a bare
  # `index` on one renders the literal string "<no value>", which would then
  # be printed to the operator as this volume's project.
  docker volume inspect --format "{{if .Labels}}{{index .Labels \"$2\"}}{{end}}" "$1" 2>/dev/null
}
docker_volume_rm() { docker volume rm "$1" >/dev/null 2>&1; }
docker_container_rm() { docker rm "$1" >/dev/null 2>&1; }

# The operator's typed answer. A seam so the prompt can be driven without a
# terminal; `read` returning non-zero (EOF) is an answer too, and it is "no".
prompt_delete_answer() {
  local answer
  read -r answer || answer=""
  printf '%s' "$answer"
}

# Is every whitespace-separated word of $1 present in $2?
list_has() {
  local item
  for item in $1; do
    if [ "$item" = "$2" ]; then return 0; fi
  done
  return 1
}
keys_subset() {
  local k
  for k in $1; do
    if ! list_has "$2" "$k"; then return 1; fi
  done
  return 0
}
# Does the tab-separated capture file $1 have $2 in its first column?
capture_has() {
  awk -F'\t' -v v="$2" '$1 == v { f = 1 } END { exit !f }' "$1"
}

# The KEYS of a top-level block mapping (stdin), e.g. `volumes:` or
# `services:`. Anchored at column 0 for the section and two spaces for the
# keys, so a service's own nested `volumes:` (four spaces in) can never be
# read as the document's.
#
# This is deliberately NOT the YAML reader s41/rulings.md moved into PyYAML.
# That ruling is about the MOUNT grammar — short syntax, flow mappings,
# line-spanning flow mappings, ${MOUNTSPEC} — where six real binds were
# silently skipped in four fix rounds. A top-level block mapping's own keys
# are the one shape that does not vary, they are identical in the raw file
# and in compose's render, and this reader is the same idiom as
# config_volume_name above. It reads no mount and no disposition.
config_block_keys() {
  awk -v sec="$1" '
    $0 == sec ":" { f = 1; next }
    /^[^ \t]/ { f = 0 }
    f && /^  [A-Za-z0-9._-]+:/ {
      line = $0
      sub(/^  /, "", line)
      sub(/:.*$/, "", line)
      print line
    }
  '
}

# The same, over the TEXT of every file this run passes with -f. The declared
# set can only come from the raw text: compose PRUNES a declared volume no
# rendered service mounts, out of `config`, `config --format json` and
# `config --volumes` alike (design-verdict.md §3, measured twice on v5.3.0).
compose_files_block_keys() {
  local section="$1" i=0 n="${#COMPOSE_ARGS[@]}" f
  while [ "$i" -lt "$n" ]; do
    if [ "${COMPOSE_ARGS[$i]}" = "-f" ]; then
      i=$((i + 1))
      f="${COMPOSE_ARGS[$i]}"
      [ -r "$f" ] || die "compose file $f cannot be read, so this stack's own declared set cannot be derived — refusing to classify anything as foreign"
      config_block_keys "$section" < "$f"
    fi
    i=$((i + 1))
  done
}

# The ours-set: what this checkout declares, from BOTH sources unioned.
# Set as globals because every consumer needs all four.
NOVA_OURS_PROJECT=""
NOVA_OURS_VOLK=""
NOVA_OURS_VOLN=""
NOVA_OURS_SVC=""
# The render this set was read from, kept so nothing below renders twice.
NOVA_OURS_RENDER=""
read_ours_set() {
  local errf render rc msg raw_volk raw_svc ren_volk ren_svc k n
  errf="$(mktemp "${TMPDIR:-/tmp}/nova-render.XXXXXX")"
  render="$(compose_config_text_all_profiles "$errf")" && rc=0 || rc=$?
  msg="$(tr '\n' ' ' < "$errf" 2>/dev/null || true)"
  rm -f "$errf"
  [ "$rc" -eq 0 ] || die "docker compose --profile '*' config failed: ${msg:-no output}"
  [ -n "$render" ] || die "docker compose --profile '*' config produced no output${msg:+ (stderr: $msg)}"

  NOVA_OURS_RENDER="$render"
  NOVA_OURS_PROJECT="$(printf '%s\n' "$render" | config_project_name)"
  [ -n "$NOVA_OURS_PROJECT" ] || die "compose reported no project name. Refusing to ask docker for everything labelled with an EMPTY project — that filter matches every container and volume on this machine."

  raw_volk="$(compose_files_block_keys volumes)"
  raw_svc="$(compose_files_block_keys services)"
  ren_volk="$(printf '%s\n' "$render" | config_block_keys volumes)"
  ren_svc="$(printf '%s\n' "$render" | config_block_keys services)"
  NOVA_OURS_VOLK="$(printf '%s\n%s\n' "$raw_volk" "$ren_volk" | awk 'NF && !seen[$0]++')"
  NOVA_OURS_SVC="$(printf '%s\n%s\n' "$raw_svc" "$ren_svc" | awk 'NF && !seen[$0]++')"
  [ -n "$NOVA_OURS_VOLK" ] || die "no volumes are declared by this checkout's compose file(s). Refusing to classify anything as foreign against an empty ours-set."

  NOVA_OURS_VOLN=""
  for k in $NOVA_OURS_VOLK; do
    n="$(printf '%s\n' "$render" | config_volume_name "$k")"
    if [ -z "$n" ]; then
      # Declared but mounted by no rendered service, so compose pruned it and
      # the render cannot name it. It is still ours, and the one thing that
      # must never happen here is a v4 volume in the deletion set — so it is
      # protected by the name compose would give it, said out loud because
      # this is the one name that was assembled rather than read.
      n="${NOVA_OURS_PROJECT}_${k}"
      log "compose: volume \`$k\` is declared and mounted by no service, so the render does not name it; protecting $n by the name compose would give it"
    fi
    NOVA_OURS_VOLN="${NOVA_OURS_VOLN}${NOVA_OURS_VOLN:+ }$n"
  done
}

# Recomputed next to the destructive command, never taken from the capture.
project_own_volumes() {
  read_ours_set
  printf '%s' "$NOVA_OURS_VOLN"
}

# ours | sibling | foreign, for a container's config_files label.
#
# `sibling` is port-v3's class and it is measured-real: the live v4 stack was
# created from a DIFFERENT checkout's compose file than this worktree's. A
# classifier that tests only "config files equal mine" calls the entire
# running stack foreign and offers to delete it on the first run from any
# worktree — the single most dangerous bug this feature can have.
classify_container() {
  local labels="$1" entry pname vkeys OLDIFS="$IFS"
  if config_files_are_ours "$labels"; then
    printf 'ours'
    return 0
  fi
  if [ -z "$labels" ]; then
    printf 'foreign'
    return 0
  fi
  IFS=','
  for entry in $labels; do
    IFS="$OLDIFS"
    if [ -f "$entry" ] && [ -r "$entry" ]; then
      pname="$(config_project_name < "$entry")"
      if [ "$pname" = "$NOVA_OURS_PROJECT" ]; then
        vkeys="$(config_block_keys volumes < "$entry")"
        if keys_subset "$vkeys" "$NOVA_OURS_VOLK"; then
          printf 'sibling'
          return 0
        fi
      fi
    fi
    IFS=','
  done
  IFS="$OLDIFS"
  printf 'foreign'
}

# Classify every container carrying this project's label, and write the
# capture. $2 is the capture directory; two files come out of it:
#   foreign_containers.tsv   id  name  service  state  config_files
#   ours_container_ids.txt   the ids that are ours or a sibling's
# 2 — docker could not be asked. Never an empty set.
foreign_containers() {
  local project="$1" dir="$2" rows row id name svc state cfgs cls
  rows="$(project_containers "$project")" || return 2
  : > "$dir/foreign_containers.tsv"
  : > "$dir/ours_container_ids.txt"
  while IFS= read -r row; do
    [ -n "$row" ] || continue
    id="$(printf '%s' "$row" | cut -f1)"
    name="$(printf '%s' "$row" | cut -f2)"
    svc="$(printf '%s' "$row" | cut -f3)"
    state="$(printf '%s' "$row" | cut -f4)"
    cfgs="$(container_config_files "$id")" || return 2
    cls="$(classify_container "$cfgs")"
    if [ "$cls" = "foreign" ]; then
      printf '%s\t%s\t%s\t%s\t%s\n' "$id" "$name" "$svc" "$state" "$cfgs" \
        >> "$dir/foreign_containers.tsv"
    else
      printf '%s\n' "$id" >> "$dir/ours_container_ids.txt"
    fi
  done <<EOF
$rows
EOF
}

# Every volume this project's label selects. TWO independent derivations are
# SEARCHED — the label filter AND the mounts of the foreign containers
# (python-tool M8: `docker compose down` without -v leaves volumes whose
# containers are gone, and ruling 1 says name every volume) — but only ONE
# thing SELECTS, in both halves: the com.docker.compose.project label. Writes:
#   foreign_volumes.tsv   name  project label  volume key label
#                         label reads exactly <project>; the removal set
#   decoy_volumes.tsv     name  project label  why it was looked at
#                         here, seen by one of the two searches, and NOT
#                         labelled for this project — the measured near-miss
#                         and anything the mounts half dragged in, printed so
#                         the operator sees it was spared and why it appeared
#   own_volumes.txt       this stack's own that exist
#   notours_volumes.txt   what a search reached and the label declined; the
#                         raw input to decoy_volumes.tsv, left in the capture
#                         so the refusal can be audited from the files alone
#   all_volumes.txt       the whole live listing, for the post-check
# 2 — docker could not be asked.
foreign_volumes() {
  local project="$1" dir="$2" labelled mounted id v vproj vkey ours_ids all why
  labelled="$(project_labelled_volumes "$project")" || return 2
  all="$(all_volume_names)" || return 2
  printf '%s\n' "$all" | awk 'NF' > "$dir/all_volumes.txt"
  mounted=""
  while IFS= read -r id; do
    [ -n "$id" ] || continue
    v="$(container_mounted_volumes "$id")" || return 2
    mounted="$mounted $v"
  done < "$dir/foreign_containers.tsv.ids"
  # The mounts of OUR OWN and our sibling's containers are ours by
  # derivation, which is what keeps an anonymous volume of the running stack
  # (searxng declares two) out of the set: it carries this project's label
  # and is in no `volumes:` block anywhere.
  ours_ids=""
  while IFS= read -r id; do
    [ -n "$id" ] || continue
    v="$(container_mounted_volumes "$id")" || return 2
    ours_ids="$ours_ids $v"
  done < "$dir/ours_container_ids.txt"

  : > "$dir/foreign_volumes.tsv"
  : > "$dir/own_volumes.txt"
  : > "$dir/notours_volumes.txt"
  for v in $(printf '%s\n%s\n' "$labelled" "$mounted" | tr ' ' '\n' | awk 'NF && !seen[$0]++'); do
    vkey="$(volume_label "$v" com.docker.compose.volume)" || return 2
    if list_has "$NOVA_OURS_VOLN" "$v" || list_has "$NOVA_OURS_VOLK" "$vkey" \
       || list_has "$ours_ids" "$v"; then
      printf '%s\n' "$v" >> "$dir/own_volumes.txt"
      continue
    fi
    vproj="$(volume_label "$v" com.docker.compose.project)" || return 2
    # Ruling 1's Global Constraint, applied HERE, at classification, to BOTH
    # halves of the union. The label filter's half arrives already filtered by
    # docker; the mounts half does not and cannot — `docker inspect .Mounts`
    # returns whatever that container happens to mount, and an old `nova`
    # container is perfectly free to mount a volume of another project of his
    # (the measured near-miss: nova_pgdata is NAMED nova_* and labelled
    # `docker`) or one with no project label at all. Being SEEN by a search is
    # not being SELECTED: the label is the only thing that selects, and if it
    # does not read this project the volume never enters the removal set,
    # however it was discovered.
    #
    # This cannot be deferred to delete_foreign_project. The re-check there
    # re-reads the label and compares it to the project — but a check that
    # runs after a wrong row is already in the capture, and in front of an
    # operator who has read that row as "the old Nova", is a second chance,
    # not the control. The control is that the row is never written.
    if [ "$vproj" != "$project" ]; then
      printf '%s\n' "$v" >> "$dir/notours_volumes.txt"
      continue
    fi
    printf '%s\t%s\t%s\n' "$v" "$vproj" "$vkey" >> "$dir/foreign_volumes.tsv"
  done

  # The spared set: everything either search reached that a rule reading NAMES
  # or MOUNTS would have taken and the label did not. Derived, not listed — the
  # name half is what a `${project}_*` prefix rule would have destroyed, the
  # mount half is what the union above just declined. Both are printed, with
  # the reason each one was looked at, because "absent from the delete list" is
  # not something an operator can read off a page.
  : > "$dir/decoy_volumes.tsv"
  for v in $(awk 'NF && !seen[$0]++' "$dir/all_volumes.txt" "$dir/notours_volumes.txt"); do
    why=""
    case "$v" in "${project}_"*) why="named ${project}_*" ;; esac
    if capture_has "$dir/notours_volumes.txt" "$v"; then
      why="${why}${why:+, }mounted by a foreign container"
    fi
    [ -n "$why" ] || continue
    if capture_has "$dir/foreign_volumes.tsv" "$v"; then continue; fi
    vproj="$(volume_label "$v" com.docker.compose.project)" || return 2
    [ "$vproj" != "$project" ] || continue
    printf '%s\t%s\t%s\n' "$v" "${vproj:-none}" "$why" >> "$dir/decoy_volumes.tsv"
  done
}

# The refusal, the capture, and the offer. The capture directory is PRINTED
# and deliberately left behind on every path that does not complete a
# deletion: after a refusal, every fact this classifier saw is a file on disk.
check_foreign_project() {
  local project dir nc nv collide svc line id name state cfgs v vproj vkey rc image

  read_ours_set
  project="$NOVA_OURS_PROJECT"

  dir="$(mktemp -d "${TMPDIR:-/tmp}/nova-foreign.XXXXXX")"
  printf '%s\n' "$project" > "$dir/project.txt"
  foreign_containers "$project" "$dir" || die "docker could not be asked which containers carry com.docker.compose.project=$project. Refusing to guess."
  awk -F'\t' 'NF { print $1 }' "$dir/foreign_containers.tsv" > "$dir/foreign_containers.tsv.ids"
  foreign_volumes "$project" "$dir" || die "docker could not be asked which volumes carry com.docker.compose.project=$project. Refusing to guess."

  nc="$(awk 'NF' "$dir/foreign_containers.tsv" | wc -l | tr -d ' ')"
  nv="$(awk 'NF' "$dir/foreign_volumes.tsv" | wc -l | tr -d ' ')"
  if [ "$nc" -eq 0 ] && [ "$nv" -eq 0 ]; then
    log "compose project \`$project\`: nothing on this machine belongs to another project of that name"
    rm -rf "$dir"
    return 0
  fi

  # Which of the foreign containers `docker compose up` here would actually
  # ADOPT: the ones whose service name this compose file also declares. This
  # is the hazard, computed rather than assumed, and it is what the non-TTY
  # exit code keys off.
  collide=""
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    svc="$(printf '%s' "$line" | cut -f3)"
    [ -n "$svc" ] || continue
    if list_has "$NOVA_OURS_SVC" "$svc" && ! list_has "$collide" "$svc"; then
      collide="${collide}${collide:+ }$svc"
    fi
  done < "$dir/foreign_containers.tsv"

  log "REFUSED: a compose project named \`$project\` is on this machine and it is not this one."
  log "\`docker compose up\` here would ADOPT and recreate its containers."
  log ""
  log "  project:       $project   (from $COMPOSE_FILE)"
  log "  this checkout: $COMPOSE_FILE"
  log ""
  log "  Foreign containers ($nc)"
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    id="$(printf '%s' "$line" | cut -f1)"
    name="$(printf '%s' "$line" | cut -f2)"
    svc="$(printf '%s' "$line" | cut -f3)"
    state="$(printf '%s' "$line" | cut -f4)"
    cfgs="$(printf '%s' "$line" | cut -f5)"
    log "    $id  $name  service=${svc:-none}  ${state:-unknown}"
    log "                  label com.docker.compose.project=$project"
    if [ -n "$cfgs" ]; then
      log "                  created from $cfgs"
    else
      log "                  carries no compose config-files label"
    fi
  done < "$dir/foreign_containers.tsv"
  log ""
  log "  Foreign volumes ($nv)"
  image="$(compose_tailscale_image)"
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    v="$(printf '%s' "$line" | cut -f1)"
    vproj="$(printf '%s' "$line" | cut -f2)"
    vkey="$(printf '%s' "$line" | cut -f3)"
    log "    $v   label project=${vproj:-none}   key=${vkey:-none}"
    if [ -n "$image" ]; then
      state_file_on_volume "$v" "$image" && rc=0 || rc=$?
      case "$rc" in
        0)
          log "        >> HOLDS A TAILSCALE NODE IDENTITY (tailscaled.state). Deleting it means"
          log "           this node must be re-authenticated under a new key."
          log "           deploy/README.md has the migration."
          ;;
        1) ;;
        *) log "        (could not be read to see whether it holds a tailscaled.state)" ;;
      esac
    fi
  done < "$dir/foreign_volumes.tsv"
  if [ -s "$dir/decoy_volumes.tsv" ]; then
    log ""
    log "  Left alone — here, but not labelled com.docker.compose.project=$project ($(awk 'NF' "$dir/decoy_volumes.tsv" | wc -l | tr -d ' '))"
    log "  Nothing above is selected by its name, and nothing by which container"
    log "  mounts it. These are NOT removed. The bracket says why each was looked at."
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      log "    $(printf '%s' "$line" | cut -f1)   label project=$(printf '%s' "$line" | cut -f2)   ($(printf '%s' "$line" | cut -f3))"
    done < "$dir/decoy_volumes.tsv"
    if awk -F'\t' '$2 == "none" { f = 1 } END { exit !f }' "$dir/decoy_volumes.tsv"; then
      log "    project=none names no project, so nothing here can show such a volume"
      log "    is this one's. It is left exactly as it is, like the rest of this list."
    fi
  fi
  if [ -s "$dir/own_volumes.txt" ]; then
    log ""
    log "  Left alone — this stack's own ($(awk 'NF' "$dir/own_volumes.txt" | wc -l | tr -d ' '))"
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      log "    $line"
    done < "$dir/own_volumes.txt"
  fi
  log ""
  log "  (sizes: \`docker system df -v\` lists them; this refusal does not guess)"
  if [ -n "$collide" ]; then
    log ""
    log "  \`docker compose up\` here would adopt the foreign containers whose service"
    log "  name this file also declares: $collide"
  fi
  log ""
  log "  The full capture this run made is in $dir"
  log ""

  if have_tty; then
    log "Deleting the $nc container(s) and $nv volume(s) above is IRREVERSIBLE and destroys"
    log "whatever data they hold. Nothing else is touched."
    log "Type exactly:  delete     to remove them"
    log "anything else, including Enter, leaves everything as it is."
    printf '> ' >&2
    local answer
    answer="$(prompt_delete_answer)"
    if [ "$answer" = "delete" ]; then
      delete_foreign_project "$dir"
      log "continuing with the install."
      return 0
    fi
    log "nothing was deleted."
  else
    log "No terminal, so nothing is offered and nothing is deleted."
    log "To remove exactly what is named above, and nothing else, run:"
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      log "    docker volume rm $(printf '%s' "$line" | cut -f1)"
    done < "$dir/foreign_volumes.tsv"
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      log "    docker rm $(printf '%s' "$line" | cut -f1)   # $(printf '%s' "$line" | cut -f2)"
    done < "$dir/foreign_containers.tsv"
    log "…or re-run \`./install\` from a terminal, where it offers exactly that."
  fi

  # The CANNOT is the ADOPTION, and nothing else. A foreign container whose
  # service name this file also declares would be recreated by `up`, so the
  # install cannot proceed past it. One that shares no service name is a
  # printed warning: ./install is documented idempotent and an agent or a CI
  # step runs it with no terminal, so an unconditional exit 1 here breaks
  # every non-interactive run (port-v3 M9c). There is no --yes and no
  # NOVA_ASSUME_DELETE: an unattended run must never destroy data.
  if [ -n "$collide" ]; then
    die "a foreign \`$project\` project holds container(s) for service(s) this compose file also declares: $collide"
  fi
  log "WARNING: none of the foreign containers share a service name with this file,"
  log "         so \`docker compose up\` cannot adopt any of them. Continuing."
  return 0
}

# The image state_file_on_volume looks through — the tailscale sidecar's own,
# read from the render read_ours_set already took, never typed and never
# rendered a second time. Empty when the render names none, in which case no
# volume is annotated and none is claimed to be clean either.
compose_tailscale_image() {
  [ -n "$NOVA_OURS_RENDER" ] || return 0
  printf '%s\n' "$NOVA_OURS_RENDER" | config_service_image tailscale
}

# The bounded deletion. It reads ONLY the two capture files written at naming
# time, so it cannot discover a new target, and every destructive command has
# a check re-derived immediately before it and a re-inspect immediately after.
delete_foreign_project() {
  local dir="$1"
  local cfile="$dir/foreign_containers.tsv" vfile="$dir/foreign_volumes.tsv"
  local project ours_now line vol vproj id name holders h bad now cur failed=0
  local attempted_v="" attempted_c="" survived="" vanished=""

  project="$(cat "$dir/project.txt")"
  [ -n "$project" ] || die "the capture in $dir names no project; nothing was deleted"

  # port-v3 M9(a): `docker volume rm` fails on a volume a container still
  # holds, so a containers-first order destroys every foreign container
  # irreversibly, then fails on the volumes, leaving an operator who
  # consented to a SET with a partial and no rollback. So: before ANYTHING is
  # removed, refuse the whole operation if a captured volume is held by a
  # container that was not in the list he was shown.
  bad=""
  while IFS= read -r line; do
    vol="$(printf '%s' "$line" | cut -f1)"
    [ -n "$vol" ] || continue
    holders="$(containers_using_volume "$vol")" || die "docker could not be asked which containers hold $vol; nothing was deleted"
    for h in $holders; do
      if ! capture_has "$cfile" "$h"; then
        bad="${bad}${bad:+;}volume $vol is held by container $h, which was not in the list above"
      fi
    done
  done < "$vfile"
  if [ -n "$bad" ]; then
    log "REFUSED: nothing was deleted."
    printf '%s\n' "$bad" | tr ';' '\n' | sed 's/^/  /' >&2
    die "the set that was named is no longer the set that is here"
  fi

  # Recomputed HERE, from compose, next to the destructive command.
  ours_now="$(project_own_volumes)" || die "this stack's own volume set could not be recomputed; nothing was deleted"

  # Volumes first: they are the irrecoverable half.
  while IFS= read -r line; do
    vol="$(printf '%s' "$line" | cut -f1)"
    [ -n "$vol" ] || continue
    vproj="$(printf '%s' "$line" | cut -f2)"
    now="$(volume_label "$vol" com.docker.compose.project)" || {
      log "skipping volume $vol: its labels could not be re-read"
      continue
    }
    # Both halves, and BOTH against $project — never one recorded value
    # against the other. Comparing the freshly-read label to the label the
    # capture wrote only proves the capture is self-consistent, which it is by
    # construction, so it passes on a row that should never have been written;
    # that is what let a volume labelled for another project through. The
    # classifier is the control (foreign_volumes: the label is the arbiter at
    # the point of classification); these two are the re-derivation standing
    # next to the destructive command.
    if [ "$vproj" != "$project" ]; then
      log "skipping volume $vol: the capture names it under project '${vproj:-none}', and this run removes '$project'"
      continue
    fi
    if [ "$now" != "$project" ]; then
      log "skipping volume $vol: its project label now reads '${now:-none}', not the '$project' it was named under"
      continue
    fi
    if list_has "$ours_now" "$vol"; then
      log "skipping volume $vol: compose now says it is this stack's own"
      continue
    fi
    attempted_v="${attempted_v}${attempted_v:+ }$vol"
    if ! docker_volume_rm "$vol"; then
      log "docker volume rm $vol FAILED"
      failed=1
      continue
    fi
    if volume_exists "$vol"; then
      die "docker volume rm $vol reported success and $vol is still here"
    fi
    log "removed volume $vol"
  done < "$vfile"

  # Containers second. The id is re-read BY NAME, which is the only lookup
  # whose answer can differ from the capture: a container recreated in
  # between carries the same name and a new id.
  while IFS= read -r line; do
    id="$(printf '%s' "$line" | cut -f1)"
    [ -n "$id" ] || continue
    name="$(printf '%s' "$line" | cut -f2)"
    cur="$(container_id_of "$name")" || {
      log "skipping container $name: it could not be re-inspected"
      continue
    }
    if [ "$cur" != "$id" ]; then
      log "skipping container $name: the container on that name is now $cur, not the $id that was named"
      continue
    fi
    attempted_c="${attempted_c}${attempted_c:+ }$id"
    if ! docker_container_rm "$id"; then
      log "docker rm $id FAILED"
      failed=1
      continue
    fi
    if container_exists "$id"; then
      die "docker rm $id reported success and $name is still here"
    fi
    log "removed container $name ($id)"
  done < "$cfile"

  # The post-check, both halves. Nothing above printed "removed" without its
  # own re-inspect; this is the whole-operation version.
  for vol in $attempted_v; do
    if volume_exists "$vol"; then survived="${survived} volume:$vol"; fi
  done
  for id in $attempted_c; do
    if container_exists "$id"; then survived="${survived} container:$id"; fi
  done
  # port-v3 C1's second half: computed from the LIVE listing captured at
  # naming time, never from ours_volk — "every key in ours_volk still exists"
  # is vacuous exactly when the ours-set is wrong, which is the one case it
  # needed to catch.
  while IFS= read -r vol; do
    [ -n "$vol" ] || continue
    if capture_has "$vfile" "$vol"; then continue; fi
    if ! volume_exists "$vol"; then vanished="${vanished} $vol"; fi
  done < "$dir/all_volumes.txt"

  if [ -n "$survived" ]; then
    die "removal reported success but these are still here:$survived"
  fi
  if [ -n "$vanished" ]; then
    die "these volumes are gone and this run never named them, so it cannot say what removed them:$vanished — the capture is in $dir"
  fi
  [ "$failed" -eq 0 ] || die "one or more removals failed (see above); the capture is in $dir"
  rm -rf "$dir"
}

preflight() {
  check_docker
  check_compose
  check_foreign_project
  check_openssl
  check_git
  check_disk
  check_ports
  decide_inference
}

# ---- tailnet ----------------------------------------------------------------

# The `tailnet` profile (docker-compose.yml, service `tailscale`) puts Nova on
# the owner's tailnet as its own node. Opt-in — `NOVA_TAILNET=1 ./install` —
# and it needs the one input only the owner holds: a Tailscale auth key, or a
# state volume that already carries a logged-in node (a re-install, or the
# old node's state migrated in; deploy/README.md). Without either the
# container would sit at NeedsLogin behind `restart: unless-stopped` and the
# health table would count down to "unhealthy" on a service that was never
# going to come up. An engine you cannot start is not an engine: refuse here,
# before anything is pulled or built, and say what would make it start.
#
# Once on, the profile reaches COMPOSE_PROFILES in .env (record_compose_profiles,
# derived from the --profile args) so a later bare `docker compose up -d`
# converges the service too — and this script keeps passing it explicitly,
# because a `--profile` flag on the command line REPLACES the .env list rather
# than adding to it (measured, compose v5.3.0).
TAILNET_ENABLED=0
# The compose volume KEY that holds the node's identity (docker-compose.yml,
# `volumes:`). Compose prefixes it with the project name; the real volume is
# found by its compose labels below, never by assembling that name here.
TAILSCALE_STATE_VOLUME_KEY="v4_tailscale"
# Why the state-volume answer is what it is — printed with the decision.
TAILNET_STATE_REASON=""

# Is $1 in the comma-separated profile list $2?
profile_listed() {
  case ",$2," in
    *",$1,"*) return 0 ;;
  esac
  return 1
}

# The list $2 with $1 added once (order kept) / removed.
add_profile() {
  if profile_listed "$1" "$2"; then
    printf '%s' "$2"
  elif [ -z "$2" ]; then
    printf '%s' "$1"
  else
    printf '%s,%s' "$2" "$1"
  fi
}

remove_profile() {
  local out="" p OLDIFS="$IFS"
  IFS=','
  for p in $2; do
    IFS="$OLDIFS"
    if [ -n "$p" ] && [ "$p" != "$1" ]; then
      out="${out:+$out,}$p"
    fi
    IFS=','
  done
  IFS="$OLDIFS"
  printf '%s' "$out"
}

# THE SEAM (tailnet). What compose resolves this project to, with the
# tailnet profile on — the ONE text the project name, the state volume's
# full name and the sidecar's image are all read from (never assembled).
# Captured whole rather than piped into an early-exiting reader, so nothing
# upstream ever takes a SIGPIPE under pipefail.
compose_config_text() {
  docker compose "${COMPOSE_ARGS[@]}" --profile tailnet config 2>/dev/null
}

# Pure readers of that text (stdin), testable on fixtures.
config_project_name() {
  awk '!done && /^name: / { print $2; done = 1 }'
}

# The full volume name compose gives the key $1 (`name:` under that key in
# the `volumes:` section — <project>_<key> unless the file says otherwise).
config_volume_name() {
  awk -v key="$1" '
    /^volumes:/ { f = 1; next }
    f && index($0, "  " key ":") == 1 { g = 1; next }
    g && /^  [a-z]/ { g = 0 }
    g && !done && /^ *name:/ { print $2; done = 1 }
  '
}

# The image the service $1 runs.
config_service_image() {
  awk -v svc="$1" '
    index($0, "  " svc ":") == 1 { f = 1; next }
    f && /^  [a-z]/ { f = 0 }
    f && !done && /^    image:/ { print $2; done = 1 }
  '
}

# THE SEAM (tailnet). The volume compose created for this project and key,
# found by the labels compose stamps on it. Empty when there is none.
state_volume_by_label() {
  docker volume ls -q \
    --filter "label=com.docker.compose.project=$1" \
    --filter "label=com.docker.compose.volume=$TAILSCALE_STATE_VOLUME_KEY" 2>/dev/null
}

# THE SEAM (tailnet). Does a volume of this exact name exist?
state_volume_exists() {
  docker volume inspect "$1" >/dev/null 2>&1
}

# THE SEAM (tailnet). Is tailscaled.state on the volume $1? Looked at through
# a throwaway container of the sidecar's own image $2 (already needed, so
# nothing extra is pulled). 0 yes, 1 no, anything else: docker itself failed.
state_file_on_volume() {
  docker run --rm -v "$1:/s:ro" --entrypoint sh "$2" -c 'test -f /s/tailscaled.state' \
    >/dev/null 2>&1
}

compose_project_name() {
  local cfg
  cfg="$(compose_config_text)" || return 1
  printf '%s\n' "$cfg" | config_project_name
}

# Does the node-state volume already hold a logged-in node? Read from the
# volume itself, never from a name we remember.
#   0 — yes; TAILNET_STATE_REASON says which volume
#   1 — no (no volume yet, or no state file on it)
#   2 — docker could not be asked
tailscale_state_present() {
  local cfg project vol image rc
  if ! cfg="$(compose_config_text)" || [ -z "$cfg" ]; then
    TAILNET_STATE_REASON="docker compose config could not be read"
    return 2
  fi
  project="$(printf '%s\n' "$cfg" | config_project_name)"
  if [ -z "$project" ]; then
    TAILNET_STATE_REASON="compose reported no project name"
    return 2
  fi
  vol="$(state_volume_by_label "$project")" || {
    TAILNET_STATE_REASON="docker volume ls failed"
    return 2
  }
  if [ -z "$vol" ]; then
    # A volume made by hand — `docker volume create`, or `docker run -v
    # <name>:/to` — carries NO compose labels, so the label lookup says
    # "nothing" about a node someone just migrated in. Fall back to the NAME
    # compose resolves for the key and look for that.
    vol="$(printf '%s\n' "$cfg" | config_volume_name "$TAILSCALE_STATE_VOLUME_KEY")"
    if [ -z "$vol" ]; then
      TAILNET_STATE_REASON="compose names no $TAILSCALE_STATE_VOLUME_KEY volume"
      return 2
    fi
    if ! state_volume_exists "$vol"; then
      TAILNET_STATE_REASON="no $vol volume exists yet"
      return 1
    fi
  fi
  image="$(printf '%s\n' "$cfg" | config_service_image tailscale)"
  if [ -z "$image" ]; then
    TAILNET_STATE_REASON="compose names no image for the tailscale service"
    return 2
  fi
  state_file_on_volume "$vol" "$image" && rc=0 || rc=$?
  case "$rc" in
    0) TAILNET_STATE_REASON="volume $vol already holds a node (tailscaled.state)"; return 0 ;;
    1) TAILNET_STATE_REASON="volume $vol exists but holds no tailscaled.state"; return 1 ;;
    *) TAILNET_STATE_REASON="volume $vol could not be read (docker run exit $rc)"; return 2 ;;
  esac
}

# Separated so a test can drive the no-terminal path without closing its own
# stdin.
have_tty() {
  [ -t 0 ]
}

# Ask on the terminal. Prints the answer, or $2 when the answer is blank; a
# third argument means "secret" (not echoed).
prompt_value() {
  local label="$1" default="$2" answer
  if [ -n "$default" ]; then
    label="$label [$default]"
  fi
  if [ -n "${3:-}" ]; then
    read -r -s -p "$label: " answer
    printf '\n' >&2
  else
    read -r -p "$label: " answer
  fi
  printf '%s' "${answer:-$default}"
}

refuse_tailnet() {
  log "ERROR: the tailnet profile was requested, but the node has no way to log in:"
  log "       TS_AUTHKEY is blank in $ENV_FILE, and $TAILNET_STATE_REASON."
  log ""
  log "       Ways forward:"
  log "         1. Mint an auth key at https://login.tailscale.com/admin/settings/keys"
  log "            (it is used ONCE, on the first login; a NON-reusable key is the"
  log "            recommendation, since it lingers in .env), put it in $ENV_FILE as"
  log "              TS_AUTHKEY=tskey-auth-..."
  log "            and re-run:  NOVA_TAILNET=1 ./install"
  log "         2. Moving an existing node here instead: copy its state into the"
  log "            volume first (deploy/README.md, \"Migrating an existing node\"),"
  log "            then re-run."
  log "         3. Leave the tailnet off:  ./install   (without NOVA_TAILNET)."
  exit 1
}

decide_tailnet() {
  local existing key hostname want=0 rc
  existing="$(get_env_value COMPOSE_PROFILES)"
  case "${NOVA_TAILNET:-}" in
    1) want=1 ;;
    0) want=0 ;;
    "") if profile_listed tailnet "$existing"; then want=1; fi ;;
    *) die "NOVA_TAILNET must be 1 or 0 (got '${NOVA_TAILNET}')" ;;
  esac

  if [ "$want" -eq 0 ]; then
    if [ "${NOVA_TAILNET:-}" = "0" ] && profile_listed tailnet "$existing"; then
      PROFILES_SWITCHED_OFF="$PROFILES_SWITCHED_OFF tailnet"
      log "tailnet: the profile comes out of COMPOSE_PROFILES (NOVA_TAILNET=0). A running"
      log "         tailscale container is left alone; stop it with:"
      log "           docker compose --project-directory $DEPLOY_DIR --profile tailnet stop tailscale"
    else
      log "tailnet: off (NOVA_TAILNET=1 ./install puts Nova on your tailnet — deploy/README.md)"
    fi
    return 0
  fi

  hostname="$(get_env_value TAILNET_HOSTNAME)"
  if [ -z "$hostname" ]; then
    if have_tty; then
      hostname="$(prompt_value "Node name on the tailnet (the URL's first label)" nova)"
    else
      hostname=nova
    fi
  fi
  # A DNS label, because it becomes one: lowercase letters, digits, hyphens.
  case "$hostname" in
    "" | *[!a-z0-9-]*)
      die "TAILNET_HOSTNAME must be a DNS label (lowercase letters, digits and hyphens only), got '$hostname'"
      ;;
  esac
  if [ "$hostname" != "$(get_env_value TAILNET_HOSTNAME)" ]; then
    set_env_value TAILNET_HOSTNAME "$hostname"
  fi

  key="$(get_env_value TS_AUTHKEY)"
  if [ -n "$key" ]; then
    log "tailnet: TS_AUTHKEY is set (used once, on the node's first login)"
  else
    tailscale_state_present && rc=0 || rc=$?
    case "$rc" in
      0)
        log "tailnet: no auth key needed — $TAILNET_STATE_REASON"
        ;;
      2)
        log "ERROR: it could not be established whether the tailnet state volume already"
        log "       holds a node: $TAILNET_STATE_REASON"
        log "       Refusing rather than guessing — fix docker, or set TS_AUTHKEY in $ENV_FILE."
        exit 1
        ;;
      *)
        if have_tty; then
          log "tailnet: $TAILNET_STATE_REASON, so an auth key is needed to join."
          log "         Mint one at https://login.tailscale.com/admin/settings/keys — used once;"
          log "         a NON-reusable key is recommended, since it lingers in $ENV_FILE."
          key="$(prompt_value "TS_AUTHKEY (blank to abort)" "" secret)"
          if [ -n "$key" ]; then
            set_env_value TS_AUTHKEY "$key"
            log "tailnet: TS_AUTHKEY saved to $ENV_FILE"
          fi
        fi
        [ -n "$key" ] || refuse_tailnet
        ;;
    esac
  fi

  TAILNET_ENABLED=1
  COMPOSE_ARGS=("${COMPOSE_ARGS[@]}" --profile tailnet)
  HEALTH_CHECKED_SERVICES="$HEALTH_CHECKED_SERVICES tailscale"
  # COMPOSE_PROFILES in .env is written by record_compose_profiles, from the
  # --profile args every decision left in COMPOSE_ARGS — one writer.
  log "tailnet: on — node '$hostname'"
}

# THE SEAM (tailnet). The node's MagicDNS name, read from the running
# sidecar (trailing dot stripped). Empty when it cannot be read.
tailnet_dns_name() {
  local status
  # Captured first: a reader that exits after the first match would hand the
  # writer a SIGPIPE, and under pipefail that reads as "could not be read".
  status="$(docker compose "${COMPOSE_ARGS[@]}" exec -T tailscale tailscale status --json 2>/dev/null)" \
    || return 1
  printf '%s\n' "$status" | grep -o -m1 '"DNSName": *"[^"]*"' | sed 's/^[^:]*: *"//; s/\.\{0,1\}"$//'
}

# ---- the hub machine's own agent (S42b P23) ---------------------------------
#
# ./install always installs Nova's agent on the machine it runs on (owner
# decision 6): built here from the committed apps/novad tree (agent-dist),
# fetched through the hub's own loopback door — so its tile says Hub — and
# checked against the manifest before it runs. A running agent is left alone:
# updating it is Nova's job, one idle machine at a time, this one first.
#
# The pairing code minted for it is a credential. It reaches the agent in
# NOVA_PAIRING_CODE, in that one process's environment, and nowhere else:
# never a command line (ps shows those to every user), never a line of this
# script's output, and never a trace line — tracing is off from the mint
# until the code is gone, even when this script runs traced
# (`bash -x deploy/install.sh`, or SHELLOPTS=xtrace in its environment).
HUB_LOOPBACK="http://127.0.0.1:3000"
# Core limits its agent paths per client and answers 429 with a Retry-After
# (Task 18). That is waited out and the path asked again, within these
# bounds, never forever. Since Task 26 a visitor through a relay is counted
# apart from this door, so a 429 here means this machine's own door spent
# its minute.
HUB_ASK_TRIES=4
HUB_WAIT_MAX_S=150
# The download directory while install_hub_agent runs; hub_fail removes it.
HUB_TMP=""

# Seams, each one thing the tests stub.
agent_version_of() { bash "$DEPLOY_DIR/agent_version.sh" "$REPO_ROOT"; }
build_agent_dist() {
  git -C "$REPO_ROOT" archive --format=tar HEAD apps/novad \
    | docker compose "${COMPOSE_ARGS[@]}" --profile build run --rm -T agent-dist "$1"
}
# One GET of $1 through the loopback door: the body to the file $2, the
# response's headers to the file $3, at most $4 seconds; prints the HTTP
# status, non-zero only when no whole response arrived. No -f, so a 429 is
# read as one. No header of its own and no proxy, so the request reaches the
# door as this machine and nothing else: core counts a request that carries
# a relay's mark apart from the loopback's own (Task 26).
hub_request() {
  curl -sS --noproxy '*' --max-time "$4" -o "$2" -D "$3" -w '%{http_code}' "$HUB_LOOPBACK$1"
}
hub_sleep() { sleep "$1"; }
# The JSON parser: core's own Python, in the container this run has just
# brought up healthy — the interpreter hub_mint runs in too. Input on stdin.
hub_python() { docker compose "${COMPOSE_ARGS[@]}" exec -T core python "$@"; }
hub_mint() { docker compose "${COMPOSE_ARGS[@]}" exec -T core python -m app.devices_cli mint --name "$1"; }
# WSL's kernels name themselves (microsoft-standard-WSL2; WSL1's Microsoft).
WSL_OSRELEASE=/proc/sys/kernel/osrelease
running_in_wsl() { grep -qi microsoft "$WSL_OSRELEASE" 2>/dev/null; }
hub_hostname() { hostname -s 2>/dev/null || hostname; }
# The sha256 of the file $1: sha256sum's, else shasum's (macOS). Non-zero,
# printing nothing, when neither can run — a checksum never computed is
# never compared, so it can never read as "not the manifest's".
sha256_of() {
  local out
  out="$(sha256sum "$1" 2>/dev/null)" || out="$(shasum -a 256 "$1" 2>/dev/null)" || return 1
  printf '%s' "${out%% *}"
}
# Can a program run from the folder $1? A two-line script is put there and
# run: a folder on a noexec mount refuses it with 126, as it refused the agent.
hub_dir_runs() {
  printf '#!/bin/sh\nexit 0\n' > "$1/runs-here" 2>/dev/null \
    && chmod 0755 "$1/runs-here" 2>/dev/null \
    && "$1/runs-here" >/dev/null 2>&1
}
hub_os_arch() {
  local os arch
  case "$(uname -s)" in Linux) os=linux ;; Darwin) os=darwin ;; *) return 1 ;; esac
  case "$(uname -m)" in x86_64|amd64) arch=amd64 ;; aarch64|arm64) arch=arm64 ;; *) return 1 ;; esac
  printf '%s %s' "$os" "$arch"
}

# What hub_python runs over the served manifest. Core re-serializes what
# agent-dist wrote, so no pattern over the text is trusted to find an entry:
# this reads the keys. A field that is missing, or not the shape it must
# have, is a stated cannot on stderr — never an empty answer.
#   version               the signed manifest's version
#   sha256 <key> <name>   files[<key>].sha256, when that entry is <name>
#   windows               commands.windows: the card's Windows line
manifest_reader() {
  cat <<'PY'
import json, re, sys

def cannot(why):
    sys.stderr.write("the agent manifest core served " + why + "\n")
    sys.exit(1)

try:
    doc = json.loads(sys.stdin.read())
except ValueError:
    cannot("is not JSON")
man = doc.get("manifest") if isinstance(doc, dict) else None
if not isinstance(man, dict):
    cannot("carries no signed manifest")
ask = sys.argv[1:]
if ask == ["version"]:
    v = man.get("version")
    if not (isinstance(v, str) and re.fullmatch("[0-9a-f]{12}", v)):
        cannot("names no version")
    print(v)
elif len(ask) == 3 and ask[0] == "sha256":
    key, name = ask[1], ask[2]
    files = man.get("files")
    entry = files.get(key) if isinstance(files, dict) else None
    if not isinstance(entry, dict):
        cannot("has no " + key + " entry")
    if entry.get("name") != name:
        cannot("has a " + key + " entry that is not " + name)
    s = entry.get("sha256")
    if not (isinstance(s, str) and re.fullmatch("[0-9a-f]{64}", s)):
        cannot("gives " + name + " no sha256")
    print(s)
elif ask == ["windows"]:
    cmds = doc.get("commands")
    line = cmds.get("windows") if isinstance(cmds, dict) else None
    if not (isinstance(line, str) and line.strip() and line.isprintable()):
        why = doc.get("commands_reason")
        cannot("carries no Windows line" + (" (" + why + ")" if isinstance(why, str) and why else ""))
    print(line)
else:
    cannot("was asked for what this reader does not read: " + " ".join(ask))
PY
}

# $@ as manifest_reader takes them, the manifest on stdin. When it cannot
# answer, the reason is on stderr: the reader's own, or docker's when core's
# Python could not be reached.
manifest_field() { hub_python -c "$(manifest_reader)" "$@"; }

# What the reader said on stderr, as one line.
hub_why() {
  local why
  why="$(tr '\n' ' ' 2>/dev/null < "$HUB_TMP/why" | sed 's/[[:space:]]*$//')"
  printf '%s' "${why:-the manifest reader stopped without saying why}"
}

# The seconds a response's Retry-After asks for, from the header file $1, in
# the delta-seconds form core sends (Task 18): one to six digits, read in
# base 10 — "08" is 8, never octal, and "010" is 10 wherever it is counted.
# Exit 1, printing nothing, when there is no Retry-After. Exit 2 when there
# is one this cannot read (an HTTP-date, a sign, an empty value), printing
# it as it came: trimmed, printable ASCII only, cut at 64.
retry_after_of() {
  tr -d '\r' 2>/dev/null < "$1" | awk '
    tolower(substr($0, 1, 12)) == "retry-after:" {
      found = 1
      v = substr($0, 13); gsub(/^[ \t]+|[ \t]+$/, "", v)
      if (v ~ /^[0-9]+$/ && length(v) <= 6) { print v + 0; readable = 1 }
      else { gsub(/[^ -~]/, "", v); print substr(v, 1, 64) }
      exit
    }
    END { exit (found ? (readable ? 0 : 2) : 1) }'
}

# A body that was not the 200 asked for, fit for one line of output: core's
# own words ({"error": …}) or whatever answered in its place, cut at 200
# bytes, every byte outside printable ASCII a space. A range, not
# [:print:]: busybox's tr reads a class there as its letters.
hub_body_excerpt() {
  head -c 200 "$1" 2>/dev/null | LC_ALL=C tr -c ' -~' ' '
}

# Every failure once the download directory exists: it goes, and ./install
# fails with the reason — the stack up (cmd_install runs this after health).
hub_fail() {
  if [ -n "$HUB_TMP" ]; then rm -rf "$HUB_TMP"; HUB_TMP=""; fi
  die "$@"
}

# One path through the loopback door into the file $2 — $3 seconds an ask,
# $4 what it is, in words — or ./install fails saying what answered. A 429
# is said as a 429: its Retry-After is waited and the path asked again, at
# most HUB_ASK_TRIES asks and HUB_WAIT_MAX_S seconds of waiting in all, and
# one past either bound, or with no Retry-After to wait for, stops here as
# what it is — never as a failed checksum, never as unreachable.
hub_fetch() {
  local path="$1" out="$2" max="$3" what="$4" status rc after ask=1 waited=0
  while :; do
    rc=0
    status="$(hub_request "$path" "$out" "$out.headers" "$max")" || rc=$?
    if [ "$rc" -ne 0 ]; then
      hub_fail "the hub's agent: $what did not arrive from $HUB_LOOPBACK$path (curl exit $rc; its words are above)"
    fi
    case "$status" in
      200) return 0 ;;
      429) ;;
      *) hub_fail "the hub's agent: core answered HTTP $status for $what at $HUB_LOOPBACK$path: $(hub_body_excerpt "$out")" ;;
    esac
    rc=0; after="$(retry_after_of "$out.headers")" || rc=$?
    case "$rc" in
      0) ;;
      1) hub_fail "the hub's agent: core answered 429 Too Many Requests for $what, with no Retry-After to wait for — run ./install again in a minute" ;;
      *) hub_fail "the hub's agent: core answered 429 Too Many Requests for $what, with a Retry-After it could not read (${after:-empty}) — run ./install again in a minute" ;;
    esac
    if [ "$ask" -ge "$HUB_ASK_TRIES" ] || [ $((waited + after)) -gt "$HUB_WAIT_MAX_S" ]; then
      hub_fail "the hub's agent: core still answers 429 Too Many Requests for $what after $ask ask(s) and ${waited} s of waiting, and its Retry-After asks ${after} s more (./install asks at most $HUB_ASK_TRIES times and waits at most $HUB_WAIT_MAX_S s) — run ./install again in a minute"
    fi
    log "the hub's agent: core answered 429 Too Many Requests for $what — requests through this machine's loopback door used up their minute; waiting the ${after} s its Retry-After asks, then asking again"
    hub_sleep "$after"
    waited=$((waited + after))
    ask=$((ask + 1))
  done
}

# The name this machine's agent pairs under: NOVA_HUB_AGENT_NAME when set
# (read from this run's environment, never written to .env: it matters only
# the first time), else the hostname — lowercased and trimmed, as core folds
# a name to see whether it is `hub`.
hub_agent_name() {
  local name="${NOVA_HUB_AGENT_NAME:-}"
  [ -n "$name" ] || name="$(hub_hostname)" || name=""
  lowercase "$name" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//'
}

# The download folder goes however the run ends: hub_fail removes it on every
# stated failure, and this, set as the EXIT trap, on anything unforeseen — so
# no run leaves an agent binary behind in $TMPDIR.
hub_cleanup() {
  if [ -n "$HUB_TMP" ]; then rm -rf "$HUB_TMP"; HUB_TMP=""; fi
}

install_hub_agent() {
  # The code, and the mint's answer that holds it, live in `code` and
  # `minted`, and neither may reach a child's environment. A name the
  # environment exported stays exported under `local`, and the copy it
  # shadows is still handed to children (measured under bash 5.2.21 and
  # 3.2.57): so both names stop being exported here — the inherited ones
  # before `local`, the locals after it — and `set -a` is off while they
  # hold anything. Neither name is exported again by this run.
  export -n code minted
  local version served os_arch os arch file want got line dns rc name minted code xtrace=0 allexport=0 hub_dir
  export -n code minted
  # Only a code this run mints ever reaches the agent: one already in
  # ./install's own environment is not this run's to pass on.
  unset NOVA_PAIRING_CODE
  version="$(agent_version_of)" || die "the hub's agent: its version could not be read (above) — nothing was built"
  log "Building Nova's agent $version for six systems (agent-dist)..."
  build_agent_dist "$version" >&2 || die "the hub's agent: agent-dist did not build $version (its words are above)"
  hub_dir="${TMPDIR:-/tmp}"
  HUB_TMP="$(mktemp -d "$hub_dir/nova-agent.XXXXXX")" \
    || die "the hub's agent: cannot make a folder to download it into under $hub_dir (mktemp failed; its words are above) — nothing was downloaded"
  trap hub_cleanup EXIT
  # One manifest, read as the machine running the stack (?origin=loopback,
  # F9): for the build it names and, on a WSL hub, the Windows line.
  hub_fetch "/api/v1/agent/manifest?origin=loopback" "$HUB_TMP/manifest.json" 30 "the agent manifest"
  served="$(manifest_field version < "$HUB_TMP/manifest.json" 2> "$HUB_TMP/why")" \
    || hub_fail "the hub's agent: $(hub_why)"
  [ "$served" = "$version" ] \
    || hub_fail "the hub's agent: core serves a build other than $version, the one agent-dist just built (it serves $served) — nothing was installed"
  if running_in_wsl; then
    # The agent for a Windows PC is the Windows one (D1): nothing installs
    # here, and the Windows line is said where it is run, with its code.
    line="$(manifest_field windows < "$HUB_TMP/manifest.json" 2> "$HUB_TMP/why")" \
      || hub_fail "the hub's agent: $(hub_why)"
    rm -rf "$HUB_TMP"; HUB_TMP=""
    log "This hub runs inside WSL, so this PC's agent is the Windows one (D1); nothing was installed here."
    log "In Nova, get a code: Settings → Devices → Pair a device. Then run this Windows line in"
    log "PowerShell on this PC, with that code in place of {CODE}:"
    log ""
    log "$line"
    log ""
    return 0
  fi
  os_arch="$(hub_os_arch)" \
    || hub_fail "the hub's agent: Nova has no build for this machine ($(uname -s) $(uname -m))"
  os="${os_arch% *}"; arch="${os_arch#* }"
  file="novad-$os-$arch"
  want="$(manifest_field sha256 "$os-$arch" "$file" < "$HUB_TMP/manifest.json" 2> "$HUB_TMP/why")" \
    || hub_fail "the hub's agent: $(hub_why)"
  hub_fetch "/api/v1/agent/dist/$file" "$HUB_TMP/novad" 300 "$file"
  # A mismatch is a claim about the bytes, so it is made only of a sha256
  # that was computed: 64 hex characters, or no claim at all.
  got="$(sha256_of "$HUB_TMP/novad")" || got=""
  case "$got" in
    "" | *[!0123456789abcdef]*) got="" ;;
  esac
  [ "${#got}" -eq 64 ] \
    || hub_fail "the hub's agent: cannot check the download: neither sha256sum nor shasum could compute its sha256 here — nothing was run"
  [ "$got" = "$want" ] \
    || hub_fail "the hub's agent: the download's sha256 is not the manifest's — nothing was run"
  chmod 0755 "$HUB_TMP/novad" \
    || hub_fail "the hub's agent: cannot make the download runnable (chmod failed; its words are above) — nothing was run"
  # Its hubs in order: this machine's loopback door first — so its tile says
  # Hub — then the tailnet name, when the tailnet is on.
  set -- --hub "$HUB_LOOPBACK"
  if [ "$TAILNET_ENABLED" -eq 1 ]; then
    dns="$(tailnet_dns_name)" || dns=""
    [ -z "$dns" ] || set -- "$@" --hub "https://$dns"
  fi
  rc=0; "$HUB_TMP/novad" install --if-missing "$@" >&2 || rc=$?
  if [ "$rc" -eq 3 ]; then
    # Not paired: a code, named after the machine — never `hub` (D8).
    name="$(hub_agent_name)"
    [ -n "$name" ] \
      || hub_fail "the hub's agent: this machine's name could not be read — run NOVA_HUB_AGENT_NAME=<a name> ./install"
    if [ "$name" = hub ]; then
      hub_fail "this machine's agent cannot be named 'hub' — that is the bundled engine's name (hub decision D8); name it after the machine: NOVA_HUB_AGENT_NAME=<a name> ./install"
    fi
    log "Pairing this machine's agent as '$name' (a code minted for it, handed over in its environment)..."
    # No trace and no export from the mint until the code is gone: `bash -x`
    # would print the mint's answer and the line that hands the code over,
    # and `set -a` would export both to every child.
    case "$-" in *x*) xtrace=1; { set +x; } 2>/dev/null ;; esac
    case "$-" in *a*) allexport=1; set +a ;; esac
    minted="$(hub_mint "$name")" \
      || hub_fail "the hub's agent: a pairing code could not be minted (devices_cli's words are above)"
    code="$(printf '%s\n' "$minted" | sed -n 's/.*"code": *"\([^"]*\)".*/\1/p' | head -n 1)"
    minted=""
    case "$code" in
      "" | *[![:alnum:]-]*) hub_fail "the hub's agent: the mint returned no code it could hand over — nothing was paired" ;;
    esac
    # By environment only: never a command line and never a log line. novad
    # unsets it before anything it starts could inherit it.
    rc=0; NOVA_PAIRING_CODE="$code" "$HUB_TMP/novad" install "$@" >&2 || rc=$?
    code=""
    if [ "$allexport" -eq 1 ]; then set -a; fi
    if [ "$xtrace" -eq 1 ]; then set -x; fi
  fi
  # 126: the shell found the download and could not run it. That is said as
  # a folder that does not allow running programs only when it is one — a
  # script put in the same folder is refused too. A binary that is not this
  # machine's gives 126 as well, and is not the folder's fault.
  if [ "$rc" -eq 126 ]; then
    if hub_dir_runs "$HUB_TMP"; then
      hub_fail "the hub's agent: the download could not be run (novad install exited 126; the shell's words are above), though $hub_dir does run programs — a test script there ran — the stack is up"
    fi
    hub_fail "the hub's agent: $hub_dir does not allow running programs (novad install exited 126, and a test script there was refused too, as on a noexec mount) — run ./install again with TMPDIR set to a folder that does, e.g. mkdir -p ~/.cache && TMPDIR=~/.cache ./install — the stack is up"
  fi
  rm -rf "$HUB_TMP"; HUB_TMP=""
  [ "$rc" -eq 0 ] \
    || die "the hub's agent was not installed (novad install exited $rc; its words are above) — the stack is up"
  log "Nova's agent on this machine is installed and running (novad status says how)."
}

# ---- hardware detect ------------------------------------------------------

detect_ram_mb() {
  if [ -r /proc/meminfo ]; then
    awk '/^MemTotal:/ {printf "%d", $2/1024}' /proc/meminfo
  elif command -v sysctl >/dev/null 2>&1; then
    local bytes
    bytes="$(sysctl -n hw.memsize 2>/dev/null || echo 0)"
    awk -v b="$bytes" 'BEGIN{printf "%d", b/1024/1024}'
  else
    echo 0
  fi
}

detect_gpus_json() {
  if ! command -v nvidia-smi >/dev/null 2>&1; then
    echo "[]"
    return 0
  fi
  local lines
  lines="$(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits 2>/dev/null || true)"
  if [ -z "$lines" ]; then
    echo "[]"
    return 0
  fi
  # `nvidia-smi` output is one line per GPU. A previous version of this
  # loop set IFS from `$(printf '\n')`, but command substitution strips
  # the trailing newline, leaving IFS empty — with IFS empty, `for line in
  # $lines` does not split at all, so a multi-GPU host produced one
  # malformed JSON entry instead of one-per-GPU. `while read` line-at-a-
  # time avoids IFS gymnastics entirely and handles any number of GPUs.
  local entries="" name vram esc_name
  while IFS=',' read -r name vram; do
    [ -n "$name" ] || continue
    name="$(printf '%s' "$name" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    vram="$(printf '%s' "$vram" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    esc_name="$(printf '%s' "$name" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')"
    if [ -n "$entries" ]; then entries="$entries,"; fi
    entries="${entries}{\"name\":\"${esc_name}\",\"vram_mb\":${vram}}"
  done <<< "$lines"
  echo "[${entries}]"
}

detect_gpu_runtime() {
  if docker info 2>/dev/null | grep -qi "nvidia"; then
    echo "true"
  else
    echo "false"
  fi
}

# ---- the GPU, as ollama itself reports it ---------------------------------
#
# Within seconds of starting, ollama logs one line per compute device:
#   msg="inference compute" id=GPU-… library=CUDA … description="NVIDIA …"
# or, when it found no usable GPU, exactly one:
#   msg="inference compute" id=cpu library=cpu …
# That line is the ONLY fact that says whether the GPU overlay reached the
# container. Every healthcheck is green either way — ollama's own is
# `ollama list`, which passes on the CPU. Measured 2026-09-04: the stack had
# been brought up with a bare `docker compose -f docker-compose.yml up -d`,
# the overlay was never merged, ollama logged library=cpu, loaded a 27B model
# onto the CPU, and the owner's next chat turn hit the 300 s gateway timeout
# with every row of the status table reading healthy. A green install that
# has silently lost the GPU is the fallback-that-reads-as-success this script
# exists to refuse — so after health, ollama's line is read and CUDA is
# REQUIRED; a line that cannot be read is a refusal too, never a pass.

# The device driver the overlay reserves (`driver: nvidia`), read from the
# overlay rather than restated here.
overlay_gpu_driver() {
  awk '/^[[:space:]]*-[[:space:]]*driver:/ { sub(/.*driver:[[:space:]]*/, ""); print; exit }' \
    "$GPU_COMPOSE_FILE"
}

# ONE place for "this device driver means ollama must log this library".
# ollama calls its nvidia backend CUDA. A second vendor gets a second row here
# and a second overlay; a driver with no row makes detect_hardware die rather
# than check nothing.
inference_library_for_driver() {
  case "$1" in
    nvidia) printf 'CUDA' ;;
    *) return 1 ;;
  esac
}

# What ollama's log must say — set by detect_hardware when the overlay is
# merged. Empty means no GPU reached compose and the check is skipped, aloud.
EXPECTED_INFERENCE_LIBRARY=""
# How long after the health table to wait for the line. It normally appears
# before the healthcheck ever goes green; device discovery can lag by seconds.
INFERENCE_COMPUTE_TIMEOUT=60

# THE SEAM (gpu). ollama's log as compose has it. Non-zero when docker could
# not be asked.
ollama_log_text() {
  docker compose "${COMPOSE_ARGS[@]}" logs --no-log-prefix ollama 2>/dev/null
}

# Pure reader (stdin: that log). The LAST `inference compute` line — the one
# from the most recent start: a GPU start logs only GPU lines and a CPU start
# logs only the cpu line, so the last line is the current fact. Empty when
# there is none.
last_inference_compute_line() {
  awk '/msg="inference compute"/ { line = $0 } END { if (line != "") print line }'
}

# Pure reader (stdin: one such line). Its library= value, quotes stripped.
inference_compute_library() {
  awk '{ for (i = 1; i <= NF; i++) if (index($i, "library=") == 1) { v = substr($i, 9); gsub(/"/, "", v); print v; exit } }'
}

lowercase() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

# Runs after every service is healthy. Reads ollama's own compute line and
# refuses unless it names the library the overlay implies. An unreadable log
# is NOT a pass: an absent line, or docker unable to answer, dies too.
check_inference_compute() {
  if [ "$BUNDLED_INFERENCE" -ne 1 ]; then
    return 0
  fi
  if [ -z "$EXPECTED_INFERENCE_LIBRARY" ]; then
    log "gpu: no GPU overlay was merged, so ollama's compute library is not checked —"
    log "     it runs on the CPU, as stated above"
    return 0
  fi
  local started now text line lib reason=""
  started="$(date +%s)"
  while :; do
    if text="$(ollama_log_text)"; then
      line="$(printf '%s\n' "$text" | last_inference_compute_line)"
      if [ -n "$line" ]; then
        break
      fi
      reason="no 'inference compute' line in ollama's log yet"
    else
      reason="docker compose logs ollama failed"
    fi
    now="$(date +%s)"
    if [ "$((now - started))" -ge "$INFERENCE_COMPUTE_TIMEOUT" ]; then
      log "ERROR: could not read ollama's inference compute line within ${INFERENCE_COMPUTE_TIMEOUT}s"
      log "       ($reason), so whether the GPU reached the container could not be"
      log "       established. Refusing rather than guessing. Look yourself with:"
      log "         docker compose ${COMPOSE_ARGS[*]} logs --no-log-prefix ollama | grep 'inference compute'"
      exit 1
    fi
    sleep 2
  done
  lib="$(printf '%s\n' "$line" | inference_compute_library)"
  if [ "$(lowercase "$lib")" = "$(lowercase "$EXPECTED_INFERENCE_LIBRARY")" ]; then
    log "gpu: ollama reports library=$lib — the overlay reached the container"
    log "     ($line)"
    return 0
  fi
  log "ERROR: the bundled ollama came up WITHOUT the GPU. Its own log says:"
  log "         $line"
  log "       Expected library=$EXPECTED_INFERENCE_LIBRARY, read library=${lib:-<none>}. The GPU overlay"
  log "         $GPU_COMPOSE_FILE"
  log "       reserves the $(overlay_gpu_driver) device for this container, and it did not arrive."
  log "       Every healthcheck is green either way ('ollama list' passes on the CPU), so"
  log "       nothing else says so until a local model loads onto the CPU and the next"
  log "       chat turn times out."
  log ""
  log "       Ways forward:"
  log "         1. The container was created without the overlay (a bare"
  log "            'docker compose -f docker-compose.yml up' drops it) and compose kept it."
  log "            Recreate it with the overlay merged:"
  log "              docker compose --project-directory $DEPLOY_DIR --profile inference up -d --force-recreate ollama"
  log "            COMPOSE_FILE in $ENV_FILE lists both files, so no -f is needed — and"
  log "            any -f REPLACES that list. Or simply re-run ./install."
  log "         2. The runtime lost the card (driver update, WSL restart, toolkit removed):"
  log "              nvidia-smi                      (does the host still see it?)"
  log "              docker info | grep -i nvidia    (is the runtime still registered?)"
  log "            Fix that, then re-run ./install."
  log "         3. Meant to run without the bundled engine:  NOVA_SKIP_INFERENCE=1 ./install"
  log "            and point the wizard's Remote endpoint at your own."
  exit 1
}

detect_hardware() {
  mkdir -p "$DATA_DIR"
  local gpus_json ram_mb disk_free_gb gpu_runtime driver
  gpus_json="$(detect_gpus_json)"
  ram_mb="$(detect_ram_mb)"
  disk_free_gb="$(detect_disk_free_gb "$REPO_ROOT")"
  gpu_runtime="$(detect_gpu_runtime)"

  cat > "$HARDWARE_JSON" <<JSON
{
  "gpus": $gpus_json,
  "ram_mb": $ram_mb,
  "disk_free_gb": $disk_free_gb,
  "docker_gpu_runtime": $gpu_runtime
}
JSON
  log "wrote $HARDWARE_JSON"

  # The bundled ollama gets the cards only when the container runtime can
  # actually hand them over. On a host with a GPU but no toolkit, say so
  # rather than silently running a "local model" on the CPU.
  if [ "$gpu_runtime" = "true" ]; then
    COMPOSE_ARGS=("${COMPOSE_ARGS[@]}" -f "$GPU_COMPOSE_FILE")
    driver="$(overlay_gpu_driver)"
    EXPECTED_INFERENCE_LIBRARY="$(inference_library_for_driver "$driver")" \
      || die "$GPU_COMPOSE_FILE reserves driver '${driver:-<none found>}', which inference_library_for_driver does not map to an ollama library — add the row"
    log "gpu: NVIDIA container runtime present — bundled ollama gets the GPU"
    log "     (checked after start: ollama's own log must say library=$EXPECTED_INFERENCE_LIBRARY)"
  elif [ "$gpus_json" != "[]" ]; then
    log "WARNING: a GPU was detected but docker has no NVIDIA runtime, so the bundled"
    log "         ollama will run on the CPU. Install the NVIDIA Container Toolkit"
    log "         (https://docs.nvidia.com/datacenter/cloud-native/) and re-run this."
  else
    log "gpu: none detected — bundled ollama will run on the CPU"
  fi

  # The wizard's default engine is the bundled ollama, and an engine that is
  # not running is filtered out of the wizard as dead. Starting it is part of
  # installing, not a separate step the operator has to know about — unless
  # decide_inference established that this host is serving its own.
  if [ "$BUNDLED_INFERENCE" -eq 1 ]; then
    COMPOSE_ARGS=("${COMPOSE_ARGS[@]}" --profile inference)
    HEALTH_CHECKED_SERVICES="$HEALTH_CHECKED_SERVICES ollama"
  else
    # BUNDLED_INFERENCE is 0 only by NOVA_SKIP_INFERENCE=1 (decide_inference
    # exits on every other busy-port answer), so this is the explicit
    # off-switch — mirrored on NOVA_TAILNET=0: the profile comes out of
    # COMPOSE_PROFILES, the container is left alone, and the stop is named.
    PROFILES_SWITCHED_OFF="$PROFILES_SWITCHED_OFF inference"
    if profile_listed inference "$(get_env_value COMPOSE_PROFILES)"; then
      log "inference: the profile comes out of COMPOSE_PROFILES (NOVA_SKIP_INFERENCE=1). A running"
      log "           ollama container is left alone; stop it with:"
      log "             docker compose --project-directory $DEPLOY_DIR --profile inference stop ollama"
    fi
  fi
}

# ---- secrets --------------------------------------------------------------

get_env_value() {
  local key="$1"
  [ -f "$ENV_FILE" ] || return 0
  # `|| true`: a key that is ABSENT is a normal case (a newly-added secret like
  # SEARXNG_SECRET on an existing .env), not an error. Without it, grep's exit 1
  # on a miss rides `set -o pipefail` out through `existing="$(get_env_value …)"`
  # in ensure_secret — a `var=$(cmd)` simple command whose non-zero status trips
  # `set -e`, aborting the whole install right before it would have generated the
  # missing secret. The empty stdout is the answer ("not set"); the exit code is
  # not.
  grep -m1 "^${key}=" "$ENV_FILE" 2>/dev/null | cut -d'=' -f2- || true
}

set_env_value() {
  local key="$1" value="$2" line tmp replaced
  # The file is READ below to be rewritten, so it has to exist first. On a
  # bare target it does not: `./install restore` writes keys into an empty
  # machine and decide_subnet writes five of them before generate_secrets has
  # copied .env.example anywhere. Without this line the redirect fails, and
  # under install.sh's `set -e` that failure is fatal — the install dies with
  # "No such file or directory" instead of writing the key (design-verdict.md
  # §9.2 step 2; port-v3 M2, python-tool M3). The mktemp+mv below then gives
  # the new file mktemp's own 0600, so nothing is ever created world-readable.
  [ -f "$ENV_FILE" ] || : > "$ENV_FILE"
  tmp="$(mktemp "${ENV_FILE}.XXXXXX")"
  replaced=0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      "${key}="*)
        printf '%s=%s\n' "$key" "$value" >> "$tmp"
        replaced=1
        ;;
      *)
        printf '%s\n' "$line" >> "$tmp"
        ;;
    esac
  done < "$ENV_FILE"
  if [ "$replaced" -eq 0 ]; then
    printf '%s=%s\n' "$key" "$value" >> "$tmp"
  fi
  mv "$tmp" "$ENV_FILE"
}

ensure_secret() {
  local key="$1" existing value
  existing="$(get_env_value "$key")"
  if [ -n "$existing" ]; then
    return 0
  fi
  value="$(openssl rand -hex 32)"
  set_env_value "$key" "$value"
  log "generated $key"
}

generate_secrets() {
  if [ ! -f "$ENV_FILE" ]; then
    cp "$ENV_EXAMPLE" "$ENV_FILE"
    log "created $ENV_FILE from $ENV_EXAMPLE"
  fi
  local key
  for key in $SECRET_KEYS; do
    ensure_secret "$key"
  done
  # Explicit, not incidental: set_env_value's mktemp+mv happens to leave 600
  # behind whenever it actually rewrites the file, but an idempotent re-run
  # where every key is already set never calls it at all — this is the one
  # line that makes owner-only permissions true on every run, not just the
  # ones that happened to generate something.
  chmod 600 "$ENV_FILE"
}

# ---- the compose file set, made durable ------------------------------------
#
# Every `docker compose` call in THIS script passes its files with -f, so the
# GPU overlay cannot be dropped here. A hand-run command afterwards can drop
# it — and did (2026-09-04): a bare `-f docker-compose.yml up -d` recreated
# ollama with no device request, and nothing turned red. So the same set is
# written to COMPOSE_FILE in .env, where compose reads it whenever no -f is
# given (a -f REPLACES the list, the same way --profile replaces
# COMPOSE_PROFILES). ABSOLUTE paths: compose resolves a relative COMPOSE_FILE
# entry from the shell's working directory, not from .env's — measured, from
# the repo root a relative entry loaded the v3 docker-compose.yml.

# The files this run passes with -f, in order, joined with compose's path
# separator. Derived from COMPOSE_ARGS so the written list can never differ
# from the one this script itself uses.
compose_file_set() {
  local out="" i=0 n="${#COMPOSE_ARGS[@]}"
  while [ "$i" -lt "$n" ]; do
    if [ "${COMPOSE_ARGS[$i]}" = "-f" ]; then
      i=$((i + 1))
      out="${out:+$out:}${COMPOSE_ARGS[$i]}"
    fi
    i=$((i + 1))
  done
  printf '%s' "$out"
}

record_compose_files() {
  local files
  files="$(compose_file_set)"
  if [ "$(get_env_value COMPOSE_FILE)" = "$files" ]; then
    log "compose: COMPOSE_FILE in $ENV_FILE already lists $files"
  else
    set_env_value COMPOSE_FILE "$files"
    log "compose: COMPOSE_FILE in $ENV_FILE now lists $files"
  fi
  log "         (run compose from $DEPLOY_DIR, or with --project-directory $DEPLOY_DIR, and no -f)"
}

# The same for profiles: the property is that a plain `docker compose
# --project-directory deploy up -d` after ANY install converges every service
# the install started. So COMPOSE_PROFILES is derived from the --profile args
# this run passes (the same way COMPOSE_FILE is from -f), merged into the
# existing list with the tailnet helpers — order kept, never duplicated,
# profiles this script does not manage left alone — minus whatever an
# explicit off-switch turned off (PROFILES_SWITCHED_OFF).

# The profiles this run passes with --profile, in order, comma-joined — the
# shape COMPOSE_PROFILES takes.
compose_profile_set() {
  local out="" i=0 n="${#COMPOSE_ARGS[@]}"
  while [ "$i" -lt "$n" ]; do
    if [ "${COMPOSE_ARGS[$i]}" = "--profile" ]; then
      i=$((i + 1))
      out="$(add_profile "${COMPOSE_ARGS[$i]}" "$out")"
    fi
    i=$((i + 1))
  done
  printf '%s' "$out"
}

record_compose_profiles() {
  local existing wanted p removed=""
  existing="$(get_env_value COMPOSE_PROFILES)"
  wanted="$existing"
  for p in $PROFILES_SWITCHED_OFF; do
    if profile_listed "$p" "$wanted"; then
      wanted="$(remove_profile "$p" "$wanted")"
      removed="$removed $p"
    fi
  done
  for p in $(compose_profile_set | tr ',' ' '); do
    wanted="$(add_profile "$p" "$wanted")"
  done
  if [ "$wanted" = "$existing" ]; then
    log "compose: COMPOSE_PROFILES in $ENV_FILE already lists ${existing:-nothing}"
  else
    set_env_value COMPOSE_PROFILES "$wanted"
    log "compose: COMPOSE_PROFILES in $ENV_FILE now lists ${wanted:-nothing}${removed:+ (removed:$removed)}"
  fi
}

# ---- her own repository ----------------------------------------------------
#
# Walk finding (turn 641f312e): asked "why is CI red on main?" with GitHub's
# MCP server connected, she spent every tool round hunting for WHICH
# repository is hers and never asked GitHub. The installer runs from the
# checkout, so the checkout's own `origin` IS the answer — derived here,
# never typed in, and handed to core (NOVA_REPO, NOVA_REPO_BRANCH), which
# states it in her prompt.

# owner/repo from a github.com remote URL, or exit 1. https, ssh:// and the
# scp-like git@github.com:o/r form, with or without .git. The host must be
# exactly github.com (a look-alike such as github.com.example is not), and
# both halves must be GitHub's own characters — core shape-checks again,
# since the value ends up in a prompt.
github_repo_from_url() {
  local url="$1" path
  case "$url" in
    https://github.com/*) path="${url#https://github.com/}" ;;
    https://*@github.com/*) path="${url#https://*@github.com/}" ;;
    ssh://git@github.com/*) path="${url#ssh://git@github.com/}" ;;
    git@github.com:*) path="${url#git@github.com:}" ;;
    *) return 1 ;;
  esac
  path="${path%/}"
  path="${path%.git}"
  printf '%s' "$path" | grep -Eq '^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$' || return 1
  case "${path#*/}" in . | ..) return 1 ;; esac
  printf '%s' "$path"
}

# Writes NOVA_REPO, and NOVA_REPO_BRANCH when origin/HEAD names one. No
# origin, or one that is not GitHub: nothing written, one line saying so —
# and a value an earlier install wrote is blanked, because once the remote
# no longer answers for it, keeping it would be a guess.
record_repository() {
  local url repo="" branch="" why=""
  url="$(git -C "$REPO_ROOT" remote get-url origin 2>/dev/null)" || url=""
  if [ -z "$url" ]; then
    why="no git remote named origin in $REPO_ROOT"
  elif ! repo="$(github_repo_from_url "$url")"; then
    repo=""
    why="origin ($url) is not a GitHub repository"
  fi
  if [ -z "$repo" ]; then
    log "repository: $why — NOVA_REPO not written; Nova is not told which repository is hers"
    local key
    for key in NOVA_REPO NOVA_REPO_BRANCH; do
      if [ -n "$(get_env_value "$key")" ]; then
        set_env_value "$key" ""
        log "            (cleared the $key an earlier install wrote)"
      fi
    done
    return 0
  fi
  branch="$(git -C "$REPO_ROOT" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null)" || branch=""
  branch="${branch#origin/}"
  if ! printf '%s' "$branch" | grep -Eq '^[A-Za-z0-9._/-]+$'; then
    branch=""
  fi
  [ "$(get_env_value NOVA_REPO)" = "$repo" ] || set_env_value NOVA_REPO "$repo"
  if [ -n "$branch" ]; then
    [ "$(get_env_value NOVA_REPO_BRANCH)" = "$branch" ] || set_env_value NOVA_REPO_BRANCH "$branch"
    log "repository: NOVA_REPO=$repo, NOVA_REPO_BRANCH=$branch (from this checkout's origin)"
  else
    if [ -n "$(get_env_value NOVA_REPO_BRANCH)" ]; then
      set_env_value NOVA_REPO_BRANCH ""
    fi
    log "repository: NOVA_REPO=$repo (from this checkout's origin); origin/HEAD names no default branch, so none is written"
  fi
}

# ---- which machine holds her checkout (her code work) ----------------------
#
# Core already knows WHERE the checkout is (record_build's NOVA_CHECKOUT); it
# did not know WHICH paired machine holds it, so no tool could put her code
# work in a worktree of it. The installer runs ON that machine, so the answer
# is this machine's `hostname` — the value novad reports as the device row's
# hostname (os.Hostname), which core matches. The door a device came in
# through is not identity. Any checkout counts, whatever its remote (or none).
# Not a checkout, or a hostname that is not DNS-ish (letters, digits, dots,
# hyphens): blanked with one line saying why — a stale value would name a
# machine that does not hold her code.
record_repo_host() {
  local host="" why=""
  if ! git -C "$REPO_ROOT" rev-parse --show-toplevel >/dev/null 2>&1; then
    why="$REPO_ROOT is not a git checkout"
  else
    host="$(hostname 2>/dev/null)" || host=""
    if ! printf '%s' "$host" | grep -Eq '^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$' \
      || [ "$(printf '%s' "$host" | wc -l)" -ne 0 ]; then
      why="this machine's hostname ('$host') is not a DNS-style name"
      host=""
    fi
  fi
  if [ -z "$host" ]; then
    [ -z "$(get_env_value NOVA_REPO_HOST)" ] || set_env_value NOVA_REPO_HOST ""
    log "repo host: $why — NOVA_REPO_HOST left blank; Nova is not told which machine holds her checkout"
    return 0
  fi
  [ "$(get_env_value NOVA_REPO_HOST)" = "$host" ] || set_env_value NOVA_REPO_HOST "$host"
  log "repo host: NOVA_REPO_HOST=$host (the machine holding $REPO_ROOT)"
}

# ---- the build this stack is brought up from (the About page) --------------
#
# Nothing said which commit a running hub was built from: the owner could not
# tell which version he was on, and nothing could ask GitHub whether there was
# anything newer. The checkout ./install runs from IS the build, so its HEAD
# is the answer — derived here, never typed in — and compose hands it to core
# (app/about.py), which shows it on the About page and in nova_about.
#
#   NOVA_COMMIT        HEAD, 40 hex
#   NOVA_VERSION       `git describe --tags --always --dirty`
#   NOVA_COMMIT_DATE   HEAD's committer date, ISO 8601
#   NOVA_DIRTY         1 when tracked files differ from HEAD, else 0
#   NOVA_INSTALLED_AT  when THIS stamp was first written (UTC)
#   NOVA_CHECKOUT      this checkout's path on the host (for ./install update)
#
# NOVA_INSTALLED_AT moves only when the stamp itself does: a re-run on the same
# commit changes nothing in .env, so compose has no new config to recreate
# core for. Not a checkout: every key blanked and one line saying so — a stamp
# left over from an earlier install would name a build that is not this one.
BUILD_KEYS="NOVA_COMMIT NOVA_VERSION NOVA_COMMIT_DATE NOVA_DIRTY NOVA_INSTALLED_AT NOVA_CHECKOUT"

record_build() {
  local commit version date dirty=0 key
  if ! commit="$(git -C "$REPO_ROOT" rev-parse --verify -q HEAD 2>/dev/null)" \
    || ! printf '%s' "$commit" | grep -Eq '^[0-9a-f]{40}$'; then
    log "build: $REPO_ROOT has no git commit to read — no build stamp; the About page says the build is unknown"
    for key in $BUILD_KEYS; do
      [ -z "$(get_env_value "$key")" ] || set_env_value "$key" ""
    done
    return 0
  fi
  version="$(git -C "$REPO_ROOT" describe --tags --always --dirty 2>/dev/null)" || version=""
  date="$(git -C "$REPO_ROOT" show -s --format=%cI HEAD 2>/dev/null)" || date=""
  if [ -n "$(git -C "$REPO_ROOT" status --porcelain --untracked-files=no 2>/dev/null)" ]; then
    dirty=1
  fi
  if [ "$(get_env_value NOVA_COMMIT)" != "$commit" ] || [ "$(get_env_value NOVA_DIRTY)" != "$dirty" ]; then
    set_env_value NOVA_INSTALLED_AT "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  fi
  [ "$(get_env_value NOVA_COMMIT)" = "$commit" ] || set_env_value NOVA_COMMIT "$commit"
  [ "$(get_env_value NOVA_VERSION)" = "$version" ] || set_env_value NOVA_VERSION "$version"
  [ "$(get_env_value NOVA_COMMIT_DATE)" = "$date" ] || set_env_value NOVA_COMMIT_DATE "$date"
  [ "$(get_env_value NOVA_DIRTY)" = "$dirty" ] || set_env_value NOVA_DIRTY "$dirty"
  # Where this checkout is on the host: what Nova's update tells the hub's own
  # agent to run ./install update in (app/nova_updates.py).
  [ "$(get_env_value NOVA_CHECKOUT)" = "$REPO_ROOT" ] || set_env_value NOVA_CHECKOUT "$REPO_ROOT"
  if [ "$dirty" -eq 1 ]; then
    log "build: ${commit:0:12} (${version:-no describe}) plus uncommitted changes — the About page says so"
  else
    log "build: ${commit:0:12} (${version:-no describe})"
  fi
}

# ---- the tailnet sidecar's scripts, made part of its config ----------------
#
# The sidecar's scripts are files on a bind mount, not config: compose cannot
# see them change, so `up` leaves a container running the old start.sh while
# the new one sits unread in /config. The scripts' hash goes into .env
# (NOVA_TAILSCALE_SCRIPTS), compose interpolates it into a label on the
# service, and a changed hash is a changed config — compose recreates the
# sidecar on that `up`, and on no other. Restarting it drops the tailnet URL
# for a few seconds, so it happens exactly when a script changed, never on
# every install.

# sha256 of stdin, 64 hex. GNU has sha256sum, macOS has `shasum -a 256`.
sha256_stdin() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | cut -d' ' -f1
  else
    return 1
  fi
}

# One hash over every script the container can run: each *.sh in
# TAILSCALE_DIR (a new one counts the day it is added), by name and content,
# minus the *_test.sh files that only run here. Exit 1 when there is nothing
# to hash or no way to hash it — never an empty answer that reads as a value.
tailscale_scripts_hash() {
  local f h manifest=""
  for f in "$TAILSCALE_DIR"/*.sh; do
    [ -f "$f" ] || continue
    case "$f" in *_test.sh) continue ;; esac
    h="$(sha256_stdin < "$f")" || return 1
    [ -n "$h" ] || return 1
    manifest="${manifest}${f##*/} $h
"
  done
  [ -n "$manifest" ] || return 1
  h="$(printf '%s' "$manifest" | sha256_stdin)" || return 1
  [ -n "$h" ] || return 1
  printf '%s' "$h"
}

record_tailscale_scripts() {
  [ "$TAILNET_ENABLED" -eq 1 ] || return 0
  local want have
  want="$(tailscale_scripts_hash)" \
    || die "could not hash the tailnet sidecar's scripts ($TAILSCALE_DIR/*.sh; needs sha256sum or shasum), so a change to them could not reach the running sidecar"
  have="$(get_env_value NOVA_TAILSCALE_SCRIPTS)"
  if [ "$have" = "$want" ]; then
    log "tailnet: sidecar scripts unchanged (${want:0:12}) — the tailscale container is left running"
    return 0
  fi
  set_env_value NOVA_TAILSCALE_SCRIPTS "$want"
  log "tailnet: sidecar scripts changed (${have:0:12}${have:+ -> }${want:0:12}) — compose recreates the tailscale container so the new start.sh runs; the tailnet URL drops while it restarts"
}

# THE SEAM. The scripts hash on the running sidecar's label; exit 1 when
# there is no sidecar to read it from.
running_tailscale_scripts() {
  local cid
  cid="$(docker compose "${COMPOSE_ARGS[@]}" ps -q tailscale 2>/dev/null)" || return 1
  [ -n "$cid" ] || return 1
  docker inspect --format "{{index .Config.Labels \"$TAILSCALE_SCRIPTS_LABEL\"}}" "$cid" 2>/dev/null
}

# After `up`: the sidecar that is running must have been created from the
# scripts in this checkout. Recomputed from the files, not read back from
# .env, so the comparison is running-vs-repo, whatever wrote .env.
verify_tailscale_scripts() {
  [ "$TAILNET_ENABLED" -eq 1 ] || return 0
  local want have
  want="$(tailscale_scripts_hash)" \
    || die "could not hash the tailnet sidecar's scripts ($TAILSCALE_DIR/*.sh) to check the running sidecar against them"
  have="$(running_tailscale_scripts)" || have=""
  [ "$have" = "$want" ] && return 0
  die "the tailscale sidecar was created from scripts ${have:-(unknown: no running container, or no $TAILSCALE_SCRIPTS_LABEL label)}, but $TAILSCALE_DIR holds ${want} — it is not running this checkout's start.sh. Recreate it: docker compose --project-directory $DEPLOY_DIR up -d --force-recreate tailscale"
}

# ---- bring-up + status ----------------------------------------------------

compose_up() {
  log "starting services (docker compose ${COMPOSE_ARGS[*]} up -d --build)…"
  docker compose "${COMPOSE_ARGS[@]}" up -d --build
}

container_health() {
  local svc="$1" cid
  cid="$(docker compose "${COMPOSE_ARGS[@]}" ps -q "$svc" 2>/dev/null)"
  [ -n "$cid" ] || { echo "missing"; return 0; }
  docker inspect --format '{{.State.Health.Status}}' "$cid" 2>/dev/null || echo "unknown"
}

wait_for_health() {
  # Pulling four base images and building three of them is the slow part and
  # happens before this; what is waited on here is startup, migrations, and
  # ollama opening its socket.
  #
  # Measured against the clock, not by counting sleeps: each poll also runs
  # one `docker compose ps` per service, so a loop that added 2 per iteration
  # took closer to eight minutes to reach a "240s" timeout. A stated timeout
  # that is not the timeout is the same defect as a stated success that was
  # never checked.
  local timeout=240 started now svc all_healthy
  started="$(date +%s)"
  log "waiting for services to become healthy (timeout ${timeout}s)…"
  while :; do
    all_healthy=1
    for svc in $HEALTH_CHECKED_SERVICES; do
      if [ "$(container_health "$svc")" != "healthy" ]; then
        all_healthy=0
      fi
    done
    if [ "$all_healthy" -eq 1 ]; then
      return 0
    fi
    now="$(date +%s)"
    if [ "$((now - started))" -ge "$timeout" ]; then
      return 1
    fi
    sleep 2
  done
}

unhealthy_services() {
  local svc out=""
  for svc in $HEALTH_CHECKED_SERVICES; do
    if [ "$(container_health "$svc")" != "healthy" ]; then
      out="$out $svc"
    fi
  done
  printf '%s' "${out# }"
}

print_status() {
  echo ""
  printf '%-10s %s\n' "SERVICE" "STATUS"
  local svc
  for svc in $HEALTH_CHECKED_SERVICES; do
    printf '%-10s %s\n' "$svc" "$(container_health "$svc")"
  done
  echo ""
}

# ---- subcommands ------------------------------------------------------

cmd_install() {
  # First, before anything is read, pulled or started.
  refuse_if_moved
  preflight
  detect_hardware
  generate_secrets
  # After generate_secrets: it reads and writes .env. Still before anything is
  # pulled, built or started.
  # After generate_secrets, which is what guarantees .env exists to be
  # written into, and before record_compose_files, which is the first thing
  # that makes this run's compose invocation durable.
  decide_subnet
  decide_tailnet
  # Every -f and --profile is decided now. Write both to .env before anything
  # is pulled, built or started, so a later hand-run compose command inherits
  # exactly this run's set — and a refusal above leaves .env as it was.
  record_compose_files
  record_compose_profiles
  # Before compose_up, so the core container this run creates reads it.
  record_repository
  # Before compose_up, for the same reason: core matches this against the
  # paired devices' hostnames to find the machine that holds her checkout.
  record_repo_host
  # Before compose_up, for the same reason: the core this run creates is the
  # one whose About page names this commit.
  record_build
  # Before compose_up: the hash it writes is what makes compose recreate the
  # sidecar when, and only when, one of its scripts changed.
  record_tailscale_scripts
  compose_up
  verify_tailscale_scripts
  wait_for_health || true
  print_status
  local unhealthy
  unhealthy="$(unhealthy_services)"
  if [ -n "$unhealthy" ]; then
    # The reason is in the container's log (the tailnet wrapper prints its
    # login URL / why the mapping is missing there), so show it rather than
    # send the operator to find it.
    local svc
    for svc in $unhealthy; do
      log "---- last 20 log lines of $svc:"
      docker compose "${COMPOSE_ARGS[@]}" logs --tail=20 --no-log-prefix "$svc" 2>&1 | sed 's/^/  /' >&2 || true
    done
    die "unhealthy service(s):$unhealthy"
  fi
  # Healthy is not the same as on the GPU. Read ollama's own word for it.
  check_inference_compute
  # This machine's own agent (S42b P23), once the stack is healthy: a
  # failure here fails ./install and leaves the stack up.
  install_hub_agent
  log "Nova is up. Open http://127.0.0.1:3000 to finish setup."
  if [ "$BUNDLED_INFERENCE" -eq 0 ]; then
    log "No bundled engine is running — pick 'Remote endpoint' at the engine step."
  fi
  if [ "$TAILNET_ENABLED" -eq 1 ]; then
    local dns
    dns="$(tailnet_dns_name)" || dns=""
    if [ -n "$dns" ]; then
      log "On your tailnet: https://${dns}/ (tailnet peers skip the gate)."
    else
      # The service is healthy, so the name exists; only the read failed.
      log "On your tailnet: the node's name could not be read just now — see"
      log "  docker compose ${COMPOSE_ARGS[*]} exec tailscale tailscale status"
    fi
  fi
}

# ---- ./install update (the About page, part 2) ------------------------------
#
# Moves this hub to the newest commit on its branch. Run by hand, or started
# by Nova (nova_update) through the hub's own agent with --attempt <id>, the
# row core opened before sending. Fast-forward only, backup first, and a
# reinstall that fails is rolled back to the commit that was running.
#
# Every ending is REPORTED to core (python -m app.updates_cli finish) — the
# installer's own words about what happened. "installed" is confirmed by core
# only when the core this run brought up runs the target commit
# (app/nova_updates.finish), so a report cannot confirm what is not running.
# A report core cannot take is said here and does not change the exit code:
# the update's own outcome is the exit code.
#
# THE SEAMS, one line each, so the suite can run every path without a network,
# a docker daemon or a real reinstall.
update_git() { git -C "$REPO_ROOT" "$@"; }
update_report() { docker compose "${COMPOSE_ARGS[@]}" exec -T core python -m app.updates_cli finish "$@"; }
update_backup() { ( . "$DEPLOY_DIR/backup.sh"; cmd_backup ) </dev/null; }
update_install() { ( cmd_install ); }

UPDATE_ATTEMPT=""

# report_update <outcome> <from> <to> <reason>
report_update() {
  local out
  if out="$(update_report --attempt "$UPDATE_ATTEMPT" --outcome "$1" --from "$2" \
    --to "$3" --reason "$4" 2>&1)"; then
    log "update: reported to core: $out"
  else
    log "update: core did not record the outcome ($out) — the About page will say this update was not confirmed"
  fi
}

cmd_update() {
  local from="" to="" branch head_branch reason dirty n named
  while [ $# -gt 0 ]; do
    case "$1" in
      --attempt)
        [ $# -ge 2 ] || die "update: --attempt needs an attempt id"
        printf '%s' "$2" | grep -Eq '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' \
          || die "update: --attempt $2 is not an attempt id"
        UPDATE_ATTEMPT="$2"
        shift 2
        ;;
      *) die "update: unknown argument $1 (expected: --attempt <id>)" ;;
    esac
  done
  refuse_if_moved
  from="$(update_git rev-parse --verify -q HEAD)" \
    || die "update: $REPO_ROOT has no commit to update from"
  # A refusal before anything changed: said, reported, exit 1.
  update_refuse() {
    report_update refused "$from" "$to" "$1"
    die "update: $1"
  }
  branch="$(get_env_value NOVA_REPO_BRANCH)"
  [ -n "$branch" ] || update_refuse "no NOVA_REPO_BRANCH in .env — run ./install once first; it records the branch from origin"
  head_branch="$(update_git symbolic-ref --short -q HEAD)" || head_branch=""
  [ "$head_branch" = "$branch" ] \
    || update_refuse "the checkout is on ${head_branch:-a detached HEAD}, not $branch — an update only moves $branch"
  # Named, so the page says WHICH files instead of sending someone to the hub
  # to find out: the first few, then a count.
  dirty="$(update_git status --porcelain --untracked-files=no | sed 's/^...//')"
  if [ -n "$dirty" ]; then
    n="$(printf '%s\n' "$dirty" | wc -l | tr -d ' ')"
    named="$(printf '%s\n' "$dirty" | head -n 5 | paste -sd ',' - | sed 's/,/, /g')"
    [ "$n" -le 5 ] || named="$named and $((n - 5)) more"
    update_refuse "the checkout on the hub has uncommitted changes to tracked files ($named) — commit or stash them on the hub, then update again; an update never overwrites them"
  fi
  log "update: fetching $branch from origin…"
  update_git fetch --quiet origin "$branch" \
    || update_refuse "git fetch origin $branch failed (above) — nothing was changed"
  to="$(update_git rev-parse --verify -q "refs/remotes/origin/$branch")" \
    || update_refuse "origin/$branch could not be read after the fetch"
  if [ "$from" = "$to" ]; then
    log "update: already at origin/$branch (${from:0:12}) — nothing to install"
    report_update up_to_date "$from" "$to" ""
    return 0
  fi
  update_git merge-base --is-ancestor "$from" "$to" \
    || update_refuse "this checkout and origin/$branch have diverged — an update only fast-forwards; merge on the hub by hand"
  log "update: ${from:0:12} -> ${to:0:12}; backing up first…"
  update_backup \
    || update_refuse "the backup before the update failed (above) — nothing was changed; ./install backup shows why"
  update_git merge --ff-only --quiet "$to" \
    || update_refuse "git merge --ff-only $to failed (above) — the checkout is unchanged"
  log "update: checkout at ${to:0:12}; reinstalling…"
  if update_install; then
    report_update installed "$from" "$to" ""
    log "update: installed ${to:0:12}"
    return 0
  fi
  log "update: the install of ${to:0:12} failed (above) — rolling back to ${from:0:12}…"
  if ! update_git reset --keep "$from"; then
    reason="the install of ${to:0:12} failed, and the checkout could not be moved back to ${from:0:12} — the hub needs a person"
    report_update failed "$from" "$to" "$reason"
    die "update: $reason"
  fi
  if update_install; then
    reason="the install of ${to:0:12} failed; rolled back to ${from:0:12}, which is running again"
  else
    reason="the install of ${to:0:12} failed, and reinstalling ${from:0:12} failed too — the hub needs a person"
  fi
  report_update failed "$from" "$to" "$reason"
  die "update: $reason"
}

main() {
  local cmd="${1:-install}"
  case "$cmd" in
    install) cmd_install ;;
    update) shift; cmd_update "$@" ;;
    backup|restore|drill|undo-move)
      # S41's verbs live in deploy/backup.sh, which states in its own header
      # that it is sourced from here and run as `./install backup`. That
      # sentence was true of the intent and false of the code until now:
      # `./install backup` answered "unknown subcommand", while the slice's
      # definition of done is written entirely in those terms.
      #
      # Sourced only when one of them is asked for, so `./install` does not
      # pay for it and a fault in backup.sh cannot stop someone installing.
      #
      # `undo-move` is here too since the owner's decision of 2026-09-21: it
      # was a stated CANNOT pointing at by-hand steps, which is not good
      # enough for the one night it is needed — every step of a move sits
      # downstream of it. `cmd_undo-move` is not a legal function name, so
      # the dash is translated to the underscore the definition uses.
      shift
      . "$DEPLOY_DIR/backup.sh"
      "cmd_$(printf '%s' "$cmd" | tr '-' '_')" "$@"
      ;;
    *) die "unknown subcommand: $cmd (expected: install, update, backup, restore, drill, undo-move)" ;;
  esac
}

if [ "${BASH_SOURCE[0]:-$0}" = "${0}" ]; then
  main "$@"
fi
