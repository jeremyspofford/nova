#!/usr/bin/env bash
# Every shape a household actually owns, against the DEPLOYED build.
#   apps/web/e2e/responsive.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOKEN="${NOVA_TOKEN:-$(docker exec nova-core-1 printenv SERVICE_TOKEN 2>/dev/null || true)}"
docker run --rm --network "${NOVA_E2E_NETWORK:-nova_default}" -v "$HERE:/e2e" -w /e2e \
  -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright -e PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
  -e NOVA_PLAYWRIGHT=/e2e/node_modules/playwright/index.mjs \
  -e "NOVA_E2E_URL=${NOVA_E2E_URL:-http://web}" -e "NOVA_TOKEN=$TOKEN" \
  mcr.microsoft.com/playwright:v1.50.0-noble node responsive.mjs
