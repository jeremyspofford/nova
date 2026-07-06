#!/usr/bin/env bash
# Nova Platform install script (non-interactive backend)
# Called by ./install wizard or directly. Reads .env for configuration.
# Nova bundles no inference server — local inference is external (user-run).
set -euo pipefail

usage() {
  cat <<USAGE
Nova Platform Install (non-interactive backend)

Backend script invoked by ./install (the user-facing wizard) or directly
for non-interactive setup. Reads .env for configuration, then brings up
every Nova service. Inference servers are external and user-managed.

Most users should run ./install instead — this script assumes .env is
already configured.

Usage:
  ./scripts/install.sh
  ./scripts/install.sh --derive-mode-only

Options:
  --derive-mode-only   Run only the NOVA_INFERENCE_MODE → LLM_ROUTING_STRATEGY
                       derivation, write the result to \$ENV_FILE, and exit.
                       Used by the test suite.
  --help, -h           Show this help message and exit

Environment:
  ENV_FILE             Path to .env (default: <repo>/.env). Overridable for
                       test isolation.
  NOVA_INFERENCE_MODE  hybrid | local-only | cloud-only. If unset and
                       interactive, the script prompts the user.
USAGE
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
# ENV_FILE is overridable so tests can point at an isolated .env without
# touching the user's real configuration.
ENV_FILE="${ENV_FILE:-${PROJECT_ROOT}/.env}"

# ── Argument parsing ─────────────────────────────────────────────────────────
# --derive-mode-only: tests/test_inference_modes.py uses this fast path to
# verify mode→env derivation without pulling models or hitting Docker.
DERIVE_MODE_ONLY=false
for arg in "$@"; do
  case "$arg" in
    --derive-mode-only) DERIVE_MODE_ONLY=true ;;
    --help|-h|-help)    usage; exit 0 ;;
  esac
done

# ── Helpers ──────────────────────────────────────────────────────────────────
# Idempotent: replace the line setting KEY=... in $ENV_FILE, or append it if
# absent. Comments and other lines are preserved. Treats keys atomically (no
# partial-match collisions).
upsert_env() {
  local key="$1"
  local value="$2"
  local file="${ENV_FILE}"
  if [ ! -f "${file}" ]; then
    printf '%s=%s\n' "${key}" "${value}" > "${file}"
    return
  fi
  if grep -q "^${key}=" "${file}" 2>/dev/null; then
    local tmp
    tmp=$(mktemp)
    awk -v k="${key}" -v v="${value}" 'BEGIN{FS=OFS="="} $1==k{print k"="v; next} {print}' "${file}" > "${tmp}"
    mv "${tmp}" "${file}"
  else
    printf '%s=%s\n' "${key}" "${value}" >> "${file}"
  fi
}

# Add or remove a single token from a comma-separated list in COMPOSE_PROFILES.
# Preserves any other tokens already present (e.g. knowledge, voice).
compose_profiles_set() {
  local action="$1"   # add | remove
  local token="$2"
  local current=""
  if [ -f "${ENV_FILE}" ]; then
    current=$(grep -m1 '^COMPOSE_PROFILES=' "${ENV_FILE}" 2>/dev/null | cut -d= -f2- || true)
  fi
  local IFS=','
  local -a parts=()
  for p in ${current}; do
    p=$(echo "${p}" | xargs)
    [ -n "${p}" ] && parts+=("${p}")
  done
  local -a out=()
  local found=false
  for p in "${parts[@]}"; do
    if [ "${p}" = "${token}" ]; then
      found=true
      [ "${action}" = "remove" ] && continue
    fi
    out+=("${p}")
  done
  if [ "${action}" = "add" ] && [ "${found}" = false ]; then
    out+=("${token}")
  fi
  upsert_env COMPOSE_PROFILES "$(IFS=,; echo "${out[*]}")"
}

if [ "${DERIVE_MODE_ONLY}" != "true" ]; then
  echo "═══════════════════════════════════════════════════════"
  echo "  Nova AI Platform — Setup"
  echo "═══════════════════════════════════════════════════════"
fi

# ── Copy .env if missing ──────────────────────────────────────────────────────
if [ ! -f "${ENV_FILE}" ]; then
  if [ -f "${PROJECT_ROOT}/.env.example" ]; then
    cp "${PROJECT_ROOT}/.env.example" "${ENV_FILE}"
    echo "✓ Created ${ENV_FILE} from .env.example"
    echo "  → Run ./install to configure interactively, or edit ${ENV_FILE} manually"
  else
    echo "✗ No ${ENV_FILE} or .env.example found. Run ./install to generate one."
    exit 1
  fi
fi

# Capture explicit NOVA_INFERENCE_MODE override BEFORE sourcing ENV_FILE.
# This lets a user (or test) re-run setup.sh with NOVA_INFERENCE_MODE=<new>
# to switch modes without first hand-editing .env.
_NOVA_INFERENCE_MODE_OVERRIDE="${NOVA_INFERENCE_MODE:-}"

# ── Source .env for config choices ────────────────────────────────────────────
set -a
# shellcheck disable=SC1091
. "${ENV_FILE}"
set +a

# Apply override (if any) AFTER sourcing, so an explicit shell-env value wins
# over the persisted .env value.
if [ -n "${_NOVA_INFERENCE_MODE_OVERRIDE}" ]; then
  NOVA_INFERENCE_MODE="${_NOVA_INFERENCE_MODE_OVERRIDE}"
fi

# ── Generate credential master key if not set ─────────────────────────────────
if grep -q "^CREDENTIAL_MASTER_KEY=$" "${PROJECT_ROOT}/.env" 2>/dev/null; then
  CREDENTIAL_MASTER_KEY=$(openssl rand -hex 32)
  sed -i "s/^CREDENTIAL_MASTER_KEY=$/CREDENTIAL_MASTER_KEY=${CREDENTIAL_MASTER_KEY}/" "${PROJECT_ROOT}/.env"
  echo "  Generated CREDENTIAL_MASTER_KEY"
fi

# ── Generate Postgres password if not set ──────────────────────────────────────
if grep -q "^POSTGRES_PASSWORD=$" "${PROJECT_ROOT}/.env" 2>/dev/null; then
  POSTGRES_PASSWORD=$(openssl rand -hex 24)
  sed -i "s|^POSTGRES_PASSWORD=$|POSTGRES_PASSWORD=${POSTGRES_PASSWORD}|" "${PROJECT_ROOT}/.env"
  echo "  Generated POSTGRES_PASSWORD"
fi

# ── Rotate admin secret if missing, empty, or still the shipped placeholder ────
GENERATED_ADMIN_SECRET=""
if grep -qE '^NOVA_ADMIN_SECRET=(nova-admin-secret-change-me|)$' "${PROJECT_ROOT}/.env" 2>/dev/null \
   || ! grep -q '^NOVA_ADMIN_SECRET=' "${PROJECT_ROOT}/.env" 2>/dev/null; then
  NOVA_ADMIN_SECRET=$(openssl rand -hex 32)
  upsert_env NOVA_ADMIN_SECRET "${NOVA_ADMIN_SECRET}"
  GENERATED_ADMIN_SECRET="${NOVA_ADMIN_SECRET}"
  echo "  Generated NOVA_ADMIN_SECRET"
fi

# ── Create workspace directory ────────────────────────────────────────────────
# Resolve ~ manually since Docker Compose doesn't expand it in all contexts
NOVA_WORKSPACE="${NOVA_WORKSPACE:-${HOME}/.nova/workspace}"
NOVA_WORKSPACE="${NOVA_WORKSPACE/#\~/$HOME}"
if [ ! -d "${NOVA_WORKSPACE}" ]; then
  mkdir -p "${NOVA_WORKSPACE}"
  echo "✓ Created workspace at ${NOVA_WORKSPACE}"
else
  echo "✓ Workspace: ${NOVA_WORKSPACE}"
fi
export NOVA_WORKSPACE

# ── Create persistent data directories ──────────────────────────────────
POSTGRES_DATA_DIR="${POSTGRES_DATA_DIR:-${PROJECT_ROOT}/data/postgres}"
REDIS_DATA_DIR="${REDIS_DATA_DIR:-${PROJECT_ROOT}/data/redis}"
for dir in "${POSTGRES_DATA_DIR}" "${REDIS_DATA_DIR}"; do
  if [ ! -d "${dir}" ]; then
    mkdir -p "${dir}"
    echo "✓ Created data directory: ${dir}"
  fi
done

# ── Inference mode selection ─────────────────────────────────────────────────
# NOVA_INFERENCE_MODE is the user-facing knob: hybrid | local-only | cloud-only.
# It derives LLM_ROUTING_STRATEGY (how the gateway picks between your external
# local inference server and cloud providers). Local inference is always
# external/user-run — Nova ships no inference container. Settings UI can
# change this later; setup.sh asks once if it's not already set.
if [ -z "${NOVA_INFERENCE_MODE:-}" ] && [ -t 0 ] && [ "${DERIVE_MODE_ONLY}" != "true" ]; then
  echo ""
  echo "Nova is a client of your own inference server (Ollama, LM Studio, vLLM,"
  echo "SGLang, or any OpenAI-compatible endpoint) and/or cloud providers."
  echo "Nova does not bundle or run a model server for you."
  echo ""
  echo "  [1] hybrid     — prefer your local server, fall back to cloud (recommended)"
  echo "  [2] local-only — only your local server (privacy/offline)"
  echo "  [3] cloud-only — only cloud APIs (no local server)"
  echo ""
  echo "You can change this anytime in Settings → AI & Models."
  printf "Choice [1/2/3] (default 1): "
  read -r choice
  case "${choice:-1}" in
    2) NOVA_INFERENCE_MODE=local-only ;;
    3) NOVA_INFERENCE_MODE=cloud-only ;;
    *) NOVA_INFERENCE_MODE=hybrid ;;
  esac
elif [ -z "${NOVA_INFERENCE_MODE:-}" ]; then
  NOVA_INFERENCE_MODE=hybrid
fi

case "${NOVA_INFERENCE_MODE}" in
  hybrid|local-only|cloud-only) ;;
  *)
    echo "ERROR: invalid NOVA_INFERENCE_MODE='${NOVA_INFERENCE_MODE}'." >&2
    echo "  Must be one of: hybrid, local-only, cloud-only." >&2
    exit 2
    ;;
esac

# Map the coarse mode to the gateway routing strategy. No compose profiles —
# there is no bundled inference service to activate; local inference is external.
case "${NOVA_INFERENCE_MODE}" in
  hybrid)     upsert_env LLM_ROUTING_STRATEGY local-first ;;
  local-only) upsert_env LLM_ROUTING_STRATEGY local-only ;;
  cloud-only) upsert_env LLM_ROUTING_STRATEGY cloud-only ;;
esac
upsert_env NOVA_INFERENCE_MODE "${NOVA_INFERENCE_MODE}"

# Re-source ENV_FILE so subsequent steps see the just-written values.
set -a
# shellcheck disable=SC1091
. "${ENV_FILE}"
set +a

if [ "${DERIVE_MODE_ONLY}" != "true" ]; then
  echo "  Inference mode: ${NOVA_INFERENCE_MODE} (routing: ${LLM_ROUTING_STRATEGY:-local-first})"
fi

# Test fast-path exit. Comes AFTER all upsert_env calls so the test can
# observe the derived values, but BEFORE Docker/model work below.
if [ "${DERIVE_MODE_ONLY}" = "true" ]; then
  exit 0
fi

# Compose file list. COMPOSE_FILE in .env activates overlays (the wizard writes
# docker-compose.yml:docker-compose.gpu.yml after positive NVIDIA detection).
COMPOSE_FILES="-f docker-compose.yml"
if [ -n "${COMPOSE_FILE:-}" ]; then
  COMPOSE_FILES=""
  IFS=':' read -ra _cf_parts <<< "${COMPOSE_FILE}"
  for _cf in "${_cf_parts[@]}"; do
    [ -n "${_cf}" ] && COMPOSE_FILES="${COMPOSE_FILES} -f ${_cf}"
  done
fi

if [ "${LLM_ROUTING_STRATEGY:-local-first}" = "cloud-only" ]; then
  echo "  Cloud-only — no local inference server configured."
elif echo "${COMPOSE_PROFILES:-}" | grep -q "inference-"; then
  echo "  Bundled inference: ${COMPOSE_PROFILES}"
else
  echo "  Local inference target: ${OLLAMA_BASE_URL:-configure in Settings → Local Inference}"
  echo "  (Run your own Ollama / LM Studio / vLLM / SGLang server, or enable a"
  echo "   bundled container in Settings → Local Inference.)"
fi

# ── Host hardware ─────────────────────────────────────────────────────────────
# Writes data/hardware.json — used by the dashboard as an advisory and by the
# recovery service to gate GPU-only bundled backends (vLLM/SGLang).
echo ""
echo "Detecting host hardware..."
"${SCRIPT_DIR}/detect_hardware.sh" "${PROJECT_ROOT}/data/hardware.json" || true
echo ""

# ── Start infrastructure services ────────────────────────────────────────────
echo ""
echo "→ Starting infrastructure (postgres, redis)..."
cd "${PROJECT_ROOT}"
docker compose ${COMPOSE_FILES} up -d postgres redis

# ── Start all Nova platform services ─────────────────────────────────────────
# COMPOSE_PROFILES (from .env) activates any bundled inference containers.
echo ""
echo "→ Starting all Nova services..."
docker compose ${COMPOSE_FILES} up -d

echo ""
echo "→ Waiting for all services to be healthy (up to 2 minutes)..."
docker compose ${COMPOSE_FILES} up -d --wait 2>/dev/null || sleep 20

# ── Pull the default model into the bundled Ollama (best-effort) ─────────────
if echo "${COMPOSE_PROFILES:-}" | grep -q "inference-ollama"; then
  _model="${DEFAULT_CHAT_MODEL:-qwen2.5:7b}"
  _model="${_model#ollama/}"
  echo ""
  echo "→ Pulling default model into bundled Ollama: ${_model} (this can take a while)..."
  docker compose ${COMPOSE_FILES} exec -T ollama ollama pull "${_model}" || \
    echo "  ! Model pull failed — pull later with: docker compose exec ollama ollama pull ${_model}"
fi

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  Nova is running!"
echo "═══════════════════════════════════════════════════════"
echo ""
echo "  Dashboard:      http://localhost:3001"
echo "  Chat UI:        http://localhost:8080"
echo ""
echo "  API docs:       http://localhost:8000/docs  (orchestrator)"
echo "                  http://localhost:8001/docs  (llm-gateway)"
echo "                  http://localhost:8002/docs  (memory-service)"
echo ""
echo "  Logs: docker compose logs -f"
echo "  Stop: docker compose down"
echo ""
echo "  To reconfigure: ./install"
echo "  Local inference: point Nova at your server in Settings → Local Inference"

if [ -n "${GENERATED_ADMIN_SECRET}" ]; then
  echo ""
  echo "═══════════════════════════════════════════════════════"
  echo "  ✓ Generated admin secret"
  echo "═══════════════════════════════════════════════════════"
  echo ""
  echo "  NOVA_ADMIN_SECRET=${GENERATED_ADMIN_SECRET}"
  echo ""
  echo "  Save this to your password manager."
  echo "  It is also stored in .env as NOVA_ADMIN_SECRET."
  echo "  This is the only time it will be displayed."
  echo ""
fi
