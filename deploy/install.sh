#!/usr/bin/env bash
# Nova v4 installer. Idempotent: safe to re-run.
# ./install.sh          preflight -> hardware detect -> secrets -> compose
#                        up -d --build -> wait for health -> status table
#                        -> ollama's own word on the GPU
# ./install.sh update   stub — arrives in a later slice
# bash 3.2 compatible (no associative arrays, no ${var,,}, no mapfile).
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
HEALTH_CHECKED_SERVICES="postgres core gateway memory web searxng"
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
  compose_up
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

cmd_update() {
  log "update: arrives in a later slice"
  exit 1
}

main() {
  local cmd="${1:-install}"
  case "$cmd" in
    install) cmd_install ;;
    update) cmd_update ;;
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
