#!/usr/bin/env bash
# Run the phone-layout checks against the DEPLOYED web service:
# phone-layout.mjs (the shell is the viewport, the document cannot scroll)
# and short-view.mjs (an installed app whose web view iOS made too short).
#
# Deliberately not a devDependency: playwright drags several hundred MB of
# browser binaries behind it, and this runs against the baked nginx image
# rather than the dev server anyway — the artefact that actually ships, which
# is the difference that has bitten this repo before.
#
#   apps/web/e2e/phone-layout.sh              # against the running stack
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
  '[ -d node_modules/playwright ] || npm i --no-save --silent playwright@1.50.0 >/dev/null 2>&1
   node phone-layout.mjs && node short-view.mjs'
