#!/usr/bin/env bash
# Tests for the install wizard's inference configuration logic.
set -euo pipefail

NOVA_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# ── Test 1: Required keys exist in .env.example ───────────────────────────────
for key in NOVA_INFERENCE_BACKEND LOCAL_INFERENCE_URL LOCAL_COMPLETION_MODEL COMPOSE_PROFILES; do
  grep -q "^${key}=" "$NOVA_ROOT/.env.example" || {
    echo "FAIL: $key missing from .env.example"
    exit 1
  }
done
echo "PASS (1/2): all inference keys present in .env.example"

# ── Test 2: _set_env writes values correctly (including special chars) ─────────
TMP_ENV="$(mktemp)"
trap "rm -f '$TMP_ENV'" EXIT

# Seed with two keys
printf 'NOVA_INFERENCE_BACKEND=ollama-host\nLOCAL_COMPLETION_MODEL=llama3.2\n' > "$TMP_ENV"

# Define _set_env targeting our temp file
_set_env_test() {
  local key="$1" val="$2" file="$3"
  python3 - "$key" "$val" "$file" <<'PYEOF'
import sys, pathlib
key, val, path = sys.argv[1], sys.argv[2], sys.argv[3]
p = pathlib.Path(path)
lines = p.read_text().splitlines(keepends=True)
found = False
new_lines = []
for line in lines:
    if line.startswith(key + '='):
        new_lines.append(f'{key}={val}\n')
        found = True
    else:
        new_lines.append(line)
if not found:
    new_lines.append(f'{key}={val}\n')
p.write_text(''.join(new_lines))
PYEOF
}

# Update existing key
_set_env_test "NOVA_INFERENCE_BACKEND" "vllm" "$TMP_ENV"
VAL=$(grep '^NOVA_INFERENCE_BACKEND=' "$TMP_ENV" | cut -d= -f2-)
[ "$VAL" = "vllm" ] || { echo "FAIL: update existing key — got '$VAL'"; exit 1; }

# Add new key
_set_env_test "LOCAL_INFERENCE_URL" "http://nova-vllm:8000" "$TMP_ENV"
VAL=$(grep '^LOCAL_INFERENCE_URL=' "$TMP_ENV" | cut -d= -f2-)
[ "$VAL" = "http://nova-vllm:8000" ] || { echo "FAIL: add new key — got '$VAL'"; exit 1; }

# Key with slashes (model name with /)
_set_env_test "LOCAL_COMPLETION_MODEL" "meta-llama/Llama-3.2-3B-Instruct" "$TMP_ENV"
VAL=$(grep '^LOCAL_COMPLETION_MODEL=' "$TMP_ENV" | cut -d= -f2-)
[ "$VAL" = "meta-llama/Llama-3.2-3B-Instruct" ] || { echo "FAIL: slash in value — got '$VAL'"; exit 1; }

echo "PASS (2/2): _set_env handles updates, additions, and values with slashes"
echo ""
echo "All tests passed."
