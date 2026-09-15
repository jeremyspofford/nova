#!/usr/bin/env bash
# Rasterise the home-screen icons from the app's own orb.
#
# Run after changing orbDataUri, or the palette it draws from. The output is
# committed — a phone's home screen reads the built files, not this script.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
docker run --rm --network none -v "$HERE:/app" -w /app \
  -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
  -e PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
  -e NOVA_PLAYWRIGHT=/app/e2e/node_modules/playwright/index.mjs \
  mcr.microsoft.com/playwright:v1.50.0-noble node scripts/make-icons.mjs
