#!/usr/bin/env bash
# Nova v4 installer. Idempotent: safe to re-run.
# ./install.sh          preflight -> hardware detect -> secrets -> compose
#                        up -d --build -> wait for health -> status table
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

log() { printf '%s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

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

preflight() {
  check_docker
  check_compose
  check_openssl
  check_disk
  check_ports
  decide_inference
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

detect_hardware() {
  mkdir -p "$DATA_DIR"
  local gpus_json ram_mb disk_free_gb gpu_runtime
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
    log "gpu: NVIDIA container runtime present — bundled ollama gets the GPU"
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
  preflight
  detect_hardware
  generate_secrets
  compose_up
  wait_for_health || true
  print_status
  local unhealthy
  unhealthy="$(unhealthy_services)"
  if [ -n "$unhealthy" ]; then
    die "unhealthy service(s):$unhealthy"
  fi
  log "Nova is up. Open http://127.0.0.1:3000 to finish setup."
  if [ "$BUNDLED_INFERENCE" -eq 0 ]; then
    log "No bundled engine is running — pick 'Remote endpoint' at the engine step."
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
    *) die "unknown subcommand: $cmd (expected: install, update)" ;;
  esac
}

if [ "${BASH_SOURCE[0]:-$0}" = "${0}" ]; then
  main "$@"
fi
