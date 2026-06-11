#!/usr/bin/env bash
# Detect GPU/CPU/RAM/disk on THIS machine and write the inference host profile.
# Runs on the host at install time — GPU tooling doesn't exist inside containers
# (the v1 two-phase approach). If your inference host is a different machine,
# run this script there and copy the JSON, or declare specs in the dashboard.
set -euo pipefail

OUT="${1:-data/llm-gateway/hardware.json}"
mkdir -p "$(dirname "$OUT")"

GPUS_JSON="[]"
if command -v nvidia-smi >/dev/null 2>&1; then
  GPUS_JSON=$(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits 2>/dev/null \
    | python3 -c '
import json, sys
gpus = []
for line in sys.stdin:
    parts = [p.strip() for p in line.split(",")]
    if len(parts) >= 2 and parts[1].isdigit():
        gpus.append({"name": parts[0], "vram_gb": round(int(parts[1]) / 1024, 1)})
print(json.dumps(gpus))' 2>/dev/null) || GPUS_JSON="[]"
elif command -v rocm-smi >/dev/null 2>&1; then
  VRAM_MB=$(rocm-smi --showmeminfo vram --csv 2>/dev/null | awk -F, 'NR==2 {print int($2/1048576)}') || VRAM_MB=""
  if [ -n "$VRAM_MB" ] && [ "$VRAM_MB" -gt 0 ]; then
    GPUS_JSON="[{\"name\": \"AMD GPU\", \"vram_gb\": $((VRAM_MB / 1024))}]"
  fi
fi

RAM_GB=$(awk '/MemTotal/ {printf "%.0f", $2/1048576}' /proc/meminfo 2>/dev/null || echo "null")
CORES=$(nproc 2>/dev/null || echo "null")
DISK_GB=$(df -BG --output=avail . 2>/dev/null | tail -1 | tr -dc '0-9' || echo "null")

python3 - "$OUT" "$GPUS_JSON" "$RAM_GB" "$CORES" "$DISK_GB" <<'PYEOF'
import json, sys, time
out, gpus, ram, cores, disk = sys.argv[1:6]
def num(v):
    try: return int(v)
    except ValueError: return None
profile = {
    "source": "detected",
    "gpus": json.loads(gpus),
    "ram_gb": num(ram),
    "cpu_cores": num(cores),
    "disk_free_gb": num(disk),
    "detected_at": time.time(),
}
with open(out, "w") as f:
    json.dump(profile, f, indent=2)
vram = sum(g.get("vram_gb", 0) for g in profile["gpus"])
print(f"GPU: {vram or 'none'} GB VRAM · RAM: {profile['ram_gb']} GB · cores: {profile['cpu_cores']}")
PYEOF
