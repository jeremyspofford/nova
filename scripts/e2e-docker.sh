#!/usr/bin/env bash
# Run the Playwright suite inside the official Playwright image, for hosts without the system
# libraries Chromium needs (for example WSL without sudo). Usage: scripts/e2e-docker.sh [args]
set -euo pipefail
cd "$(dirname "$0")/.."
image="mcr.microsoft.com/playwright:v1.64.1-noble"
exec docker run --rm --network host --ipc=host \
  --user "$(id -u):$(id -g)" -e HOME=/tmp -e CI="${CI:-}" \
  -v "$PWD:/work" -w /work "$image" npx playwright test "$@"
