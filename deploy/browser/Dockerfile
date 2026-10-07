# Her browser's engine (S38): Microsoft's Playwright MCP server, pinned by
# digest, with the two folders its named volumes mount over created as `node`.
#
# Docker initialises an EMPTY named volume from the image path it is mounted
# over, ownership included. The stock image has neither /profile nor /output,
# so a fresh volume arrived root-owned and the engine (uid 1000, `node`) could
# not write its profile — measured 2026-09-30: `touch: cannot touch
# '/profile/x': Permission denied`. The same trap core's Dockerfile records
# for /data/workspace.
#
# Pinned 2026-09-30: v0.0.82 was the newest tag on MCR (npm's 0.0.83 of
# 2026-09-28 was not published there yet). Re-pinning re-runs
# services/core/tests/fixtures/browser_engine/capture.py, and the tests that
# read its captures say what moved.
FROM mcr.microsoft.com/playwright/mcp:v0.0.82@sha256:77dccc5ce9e94cb8ae7ebea87ddbb6cd54b05760c4d63c54e16accf2726b8734
USER root
RUN mkdir -p /profile /output && chown node:node /profile /output
USER node
