#!/usr/bin/env bash
# Nova Hardware Detection Script
# Detects GPU, CPU, RAM, and disk and writes to a JSON file.
set -euo pipefail

usage() {
  cat <<USAGE
Nova Hardware Detection

Detects GPU vendor (NVIDIA / AMD ROCm), GPU model and VRAM per device,
Docker GPU runtime availability, CPU cores, total RAM, and free disk
space. Writes the result as JSON for the recovery service to consume.

Usage:
  ./scripts/detect_hardware.sh [output_path]

Arguments:
  output_path    Where to write hardware.json (default: <repo>/data/hardware.json)

Options:
  --help, -h     Show this help message and exit
USAGE
}

for arg in "$@"; do
  case "$arg" in
    --help|-h|-help) usage; exit 0 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

OUTPUT_PATH="${1:-${PROJECT_ROOT}/data/hardware.json}"
OUTPUT_DIR="$(dirname "${OUTPUT_PATH}")"

# Create parent directory if it doesn't exist
mkdir -p "${OUTPUT_DIR}"

# ── GPU Detection ─────────────────────────────────────────────────────────────

GPUS_JSON="[]"

# NVIDIA via nvidia-smi
if command -v nvidia-smi &>/dev/null && nvidia-smi &>/dev/null 2>&1; then
  # Query: index, name, memory.total (in MiB)
  GPU_ENTRIES=""
  while IFS=',' read -r idx name vram_mib; do
    # Trim whitespace
    idx="${idx// /}"
    name="${name#"${name%%[![:space:]]*}"}"
    name="${name%"${name##*[![:space:]]}"}"
    vram_mib="${vram_mib// /}"
    # Convert MiB → GB (integer division)
    vram_gb=$(( (${vram_mib%.*} + 512) / 1024 ))
    entry="{\"vendor\":\"nvidia\",\"model\":\"${name}\",\"vram_gb\":${vram_gb},\"index\":${idx}}"
    if [ -z "${GPU_ENTRIES}" ]; then
      GPU_ENTRIES="${entry}"
    else
      GPU_ENTRIES="${GPU_ENTRIES},${entry}"
    fi
  done < <(nvidia-smi --query-gpu=index,name,memory.total --format=csv,noheader,nounits 2>/dev/null)

  if [ -n "${GPU_ENTRIES}" ]; then
    GPUS_JSON="[${GPU_ENTRIES}]"
  fi
fi

# AMD via rocm-smi (only if no NVIDIA GPUs found)
if [ "${GPUS_JSON}" = "[]" ] && command -v rocm-smi &>/dev/null 2>&1; then
  GPU_ENTRIES=""
  IDX=0
  # rocm-smi --showproductname prints lines like: "GPU[0]    : Card series: ..."
  # rocm-smi --showmeminfo vram prints VRAM info
  while IFS= read -r line; do
    # Match lines like: GPU[0]		: Card series:		Radeon RX 6800 XT
    if [[ "${line}" =~ GPU\[([0-9]+)\].*Card\ series:[[:space:]]*(.*) ]]; then
      IDX="${BASH_REMATCH[1]}"
      model="${BASH_REMATCH[2]}"
      model="${model#"${model%%[![:space:]]*}"}"
      model="${model%"${model##*[![:space:]]}"}"

      # Try to get VRAM for this GPU index
      vram_gb=0
      vram_raw=$(rocm-smi --showmeminfo vram --json 2>/dev/null || true)
      if [ -n "${vram_raw}" ]; then
        # Parse "VRAM Total Memory (B)" from JSON output for this GPU
        vram_bytes=$(echo "${vram_raw}" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    key = 'card${IDX}'
    for k, v in data.items():
        if k.lower() == key:
            total = v.get('VRAM Total Memory (B)', v.get('vram_total', 0))
            print(int(total))
            sys.exit(0)
    print(0)
except Exception:
    print(0)
" 2>/dev/null || echo "0")
        if [ "${vram_bytes}" -gt 0 ] 2>/dev/null; then
          vram_gb=$(( (vram_bytes + 536870912) / 1073741824 ))
        fi
      fi

      entry="{\"vendor\":\"amd\",\"model\":\"${model}\",\"vram_gb\":${vram_gb},\"index\":${IDX}}"
      if [ -z "${GPU_ENTRIES}" ]; then
        GPU_ENTRIES="${entry}"
      else
        GPU_ENTRIES="${GPU_ENTRIES},${entry}"
      fi
    fi
  done < <(rocm-smi --showproductname 2>/dev/null || true)

  if [ -n "${GPU_ENTRIES}" ]; then
    GPUS_JSON="[${GPU_ENTRIES}]"
  fi
fi

# ── Docker GPU Runtime ────────────────────────────────────────────────────────

DOCKER_GPU_RUNTIME="none"
if command -v docker &>/dev/null; then
  DOCKER_INFO=$(docker info 2>/dev/null || true)
  if echo "${DOCKER_INFO}" | grep -qi "nvidia"; then
    DOCKER_GPU_RUNTIME="nvidia"
  elif echo "${DOCKER_INFO}" | grep -qi "rocm\|amdgpu"; then
    DOCKER_GPU_RUNTIME="rocm"
  fi
fi

# ── CPU Cores ─────────────────────────────────────────────────────────────────

CPU_CORES=1
if command -v nproc &>/dev/null; then
  CPU_CORES=$(nproc)
fi

# ── RAM ───────────────────────────────────────────────────────────────────────

RAM_GB=0
if [ -f /proc/meminfo ]; then
  MEM_KB=$(grep '^MemTotal:' /proc/meminfo | awk '{print $2}')
  RAM_GB=$(( (MEM_KB + 524288) / 1048576 ))
elif command -v free &>/dev/null; then
  RAM_GB=$(free -g | awk '/^Mem:/{print $2}')
fi

# ── Disk Free ─────────────────────────────────────────────────────────────────

DISK_FREE_GB=0
if command -v df &>/dev/null; then
  # Get free space (in 1K blocks) for the project root's filesystem
  DISK_FREE_KB=$(df -k "${PROJECT_ROOT}" 2>/dev/null | awk 'NR==2{print $4}')
  if [ -n "${DISK_FREE_KB}" ]; then
    DISK_FREE_GB=$(( (DISK_FREE_KB + 524288) / 1048576 ))
  fi
fi

# ── Timestamp ─────────────────────────────────────────────────────────────────

DETECTED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# ── Assemble JSON ─────────────────────────────────────────────────────────────

JSON=$(cat <<EOF
{
  "gpus": ${GPUS_JSON},
  "docker_gpu_runtime": "${DOCKER_GPU_RUNTIME}",
  "cpu_cores": ${CPU_CORES},
  "ram_gb": ${RAM_GB},
  "disk_free_gb": ${DISK_FREE_GB},
  "detected_at": "${DETECTED_AT}"
}
EOF
)

# Write to file
echo "${JSON}" > "${OUTPUT_PATH}"

# Also print to stdout
echo "${JSON}"

echo "" >&2
echo "Hardware detection complete. Written to: ${OUTPUT_PATH}" >&2
