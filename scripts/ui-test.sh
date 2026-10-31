#!/usr/bin/env bash
# Runs the M3 UI gate (tests/ui) where Chromium can start: inside the Playwright image, with this
# machine's Node mounted in, and the server, browser and tests all in the one container (a host
# network does not reach WSL from Docker Desktop). Evidence screenshots go to docs/screenshots/m3.
#   scripts/ui-test.sh            the whole UI gate
#   scripts/ui-test.sh <file>…    some of it
# --test-force-exit: a test file ends when its tests have, even if one left a server or a browser
# open (a failed assertion before its cleanup); --test-timeout bounds a test that never ends. Both
# keep a failure from hanging the gate (PR #236's 90-minute UI-gate run).
# It runs under the no-Kubernetes tripwire (scripts/tripwire.sh), as npm test does.
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
  "$IMAGE" bash -c 'export PATH=/opt/node/bin:$PATH CHROMIUM=$(ls -d /ms-playwright/chromium-*/chrome-linux/chrome | head -1); sh scripts/tripwire.sh node --test --test-concurrency=1 --test-force-exit --test-timeout=900000 '"${FILES[*]}"
