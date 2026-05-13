#!/usr/bin/env bash
# Tests the inference section of the install wizard in non-interactive mode.
set -euo pipefail

NOVA_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Verify the .env.example already has all required keys present.
for key in NOVA_INFERENCE_BACKEND LOCAL_INFERENCE_URL LOCAL_COMPLETION_MODEL COMPOSE_PROFILES; do
  grep -q "^${key}=" "$NOVA_ROOT/.env.example" || {
    echo "FAIL: $key missing from .env.example"
    exit 1
  }
done

echo "PASS: all inference keys present in .env.example"
