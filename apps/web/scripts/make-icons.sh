#!/usr/bin/env bash
# Rasterise the home-screen icons from the app's own marks.
#
# Run after changing app-icon.ts, the palettes it draws from, or the set of
# presets/accents (a new one widens the touch set and app-icon.test.ts goes
# red until this has been re-run). The output is committed — a phone reads
# the built files, not this script.
#
# Needs apps/web/node_modules (npm ci) for esbuild. The browser comes from
# the playwright image; the matching playwright-core package is installed
# ONCE into node_modules/.cache (no browser download, no network in the
# container run), because this package deliberately does not depend on it.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PW_VERSION=1.50.0
PW_DIR="$HERE/node_modules/.cache/nova-icons-playwright"
if [ ! -f "$PW_DIR/node_modules/playwright-core/index.mjs" ]; then
  mkdir -p "$PW_DIR"
  (cd "$PW_DIR" && npm init -y >/dev/null && npm i --no-audit --no-fund --silent "playwright-core@$PW_VERSION")
fi
# As the invoking user, or the output comes back root-owned and the next
# run (and git) cannot touch it. HOME must be writable for chromium.
docker run --rm --network none -v "$HERE:/app" -w /app \
  --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
  -e PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
  -e NOVA_PLAYWRIGHT=/app/node_modules/.cache/nova-icons-playwright/node_modules/playwright-core/index.mjs \
  "mcr.microsoft.com/playwright:v$PW_VERSION-noble" node scripts/make-icons.mjs
