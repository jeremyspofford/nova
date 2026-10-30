#!/usr/bin/env bash
# Runs the M3 UI gate (tests/ui) where Chromium can start: inside the Playwright image, with this
# machine's Node mounted in, and the server, browser and tests all in the one container (a host
# network does not reach WSL from Docker Desktop). Evidence screenshots go to docs/screenshots/m3.
#   scripts/ui-test.sh            the whole UI gate
#   scripts/ui-test.sh <file>…    some of it
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="mcr.microsoft.com/playwright:v$(node -p "require('$ROOT/node_modules/playwright-core/package.json').version")-noble"
NODE_DIR="$(dirname "$(dirname "$(command -v node)")")"
FILES=("$@")
[ ${#FILES[@]} -eq 0 ] && FILES=('tests/ui/*.test.ts')
exec docker run --rm --init --ipc=host \
  -v "$ROOT:/work" -w /work \
  -v "$NODE_DIR:/opt/node:ro" \
  -e NOVA_UI_SHOTS="${NOVA_UI_SHOTS:-docs/screenshots/m3}" \
  ${NOVA_VITALS_RUNS:+-e NOVA_VITALS_RUNS="$NOVA_VITALS_RUNS"} \
  --user "$(id -u):$(id -g)" -e HOME=/tmp \
  "$IMAGE" bash -c 'export PATH=/opt/node/bin:$PATH CHROMIUM=$(ls -d /ms-playwright/chromium-*/chrome-linux/chrome | head -1); node --test --test-concurrency=1 '"${FILES[*]}"
