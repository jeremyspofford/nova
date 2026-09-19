#!/usr/bin/env bash
# Settings → Models → Machines at phone widths: runs machines-layout.mjs
# (the Machines tile at 393px and at a folded 280px: nothing in a tile past
# the tile, no tile past what clips it, nothing wider than the screen, a
# switch big enough to hit, the section first on the tab, and each of those
# layout checks shown to fire on a cut it must see: `cuts 3/3`) against the
# DEPLOYED web service, with every API call intercepted.
#
# Deliberately not a devDependency: playwright drags several hundred MB of
# browser binaries behind it, and this runs against the baked nginx image
# rather than the dev server anyway — the artefact that actually ships, which
# is the difference that has bitten this repo before.
#
#   apps/web/e2e/machines-layout.sh           # against the running stack
#   NOVA_E2E_SHOTS=/tmp/shots ...             # also save the two screenshots
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE="mcr.microsoft.com/playwright:v1.50.0-noble"
NETWORK="${NOVA_E2E_NETWORK:-nova_default}"
SHOTS="${NOVA_E2E_SHOTS:-}"

args=(--rm --network "$NETWORK" -v "$HERE:/e2e" -w /e2e
      -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
      -e PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
      -e "NOVA_E2E_URL=${NOVA_E2E_URL:-http://web}")
if [ -n "$SHOTS" ]; then
  mkdir -p "$SHOTS"
  args+=(-v "$SHOTS:/shots" -e NOVA_E2E_SHOTS=/shots)
fi

# The image ships the browsers but not the npm package; install it into the
# mounted directory so repeat runs are instant.
docker run "${args[@]}" "$IMAGE" sh -c \
  '[ -d node_modules/playwright ] || npm i --no-save --silent playwright@1.50.0 >/dev/null 2>&1; node machines-layout.mjs'
