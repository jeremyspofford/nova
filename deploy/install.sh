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

SECRET_KEYS="POSTGRES_PASSWORD CORE_TOKEN CORE_GATEWAY_TOKEN CORE_MEMORY_TOKEN INSTANCE_SECRET"
HEALTH_CHECKED_SERVICES="postgres core gateway memory web"
REQUIRED_PORTS="3000 8000 8001 8002"

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

preflight() {
  check_docker
  check_compose
  check_disk
  check_ports
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
}

# ---- secrets --------------------------------------------------------------

get_env_value() {
  local key="$1"
  [ -f "$ENV_FILE" ] || return 0
  grep -m1 "^${key}=" "$ENV_FILE" 2>/dev/null | cut -d'=' -f2-
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
}

# ---- bring-up + status ----------------------------------------------------

compose_up() {
  log "starting services (docker compose up -d --build)…"
  docker compose -f "$COMPOSE_FILE" up -d --build
}

container_health() {
  local svc="$1" cid
  cid="$(docker compose -f "$COMPOSE_FILE" ps -q "$svc" 2>/dev/null)"
  [ -n "$cid" ] || { echo "missing"; return 0; }
  docker inspect --format '{{.State.Health.Status}}' "$cid" 2>/dev/null || echo "unknown"
}

wait_for_health() {
  local timeout=120 waited=0 svc all_healthy
  log "waiting for services to become healthy (timeout ${timeout}s)…"
  while [ "$waited" -lt "$timeout" ]; do
    all_healthy=1
    for svc in $HEALTH_CHECKED_SERVICES; do
      if [ "$(container_health "$svc")" != "healthy" ]; then
        all_healthy=0
      fi
    done
    if [ "$all_healthy" -eq 1 ]; then
      return 0
    fi
    sleep 2
    waited=$((waited + 2))
  done
  return 1
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
