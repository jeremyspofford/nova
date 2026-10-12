# The devbox: the image every change box (nova-box-<id>) runs (S32.2, spec
# §4.1). Built by ./install (deploy/install.sh build_devbox) from main's
# COMMITTED deploy/devbox plus the lockfiles and manifests only, tagged
# nova-devbox:t-<git rev-parse HEAD:deploy/devbox>. Nothing a change edits
# here reaches her box until it lands on main and ./install runs.
#
# The box has no route out, so the image carries the dependency caches for
# the lockfiles it was built from at /deps/{uv,npm,go}, owned by the owner's
# uid/gid: a change's empty cache volume mounted at /deps is filled from
# them (docker's copy-up keeps the ownership), novad's fetch step (internal/
# box/fetch.go) writes a changed lockfile's packages into it, and the box
# mounts it read-only. The image's nova.lock.<rel> labels (sha256 of each
# lockfile) are passed by build_devbox; the fetch step compares against them.
#
# Every base is pinned by digest: the same three ./install already runs
# (python for core/gateway/memory, node for web, golang for agent-dist).
FROM node:22@sha256:363e1587494626837fa7f9a23bdb453d13b0ff3c67c705c2805cfc69c2d2fad7 AS node
FROM golang:1.27.1@sha256:3680233e3204827fbdc66088528ae6d4b3d034f51d03a99d454f6de034888244 AS go
FROM python:3.12-slim@sha256:2f17fc044b579bab302c2e8054d3a686e2cb9a83de48e70534b94cd8ebbe06a9

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates libstdc++6 \
 && rm -rf /var/lib/apt/lists/*

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
COPY --from=go /usr/local/go /usr/local/go

# uv (core's runner) and ruff (core's pin), by exact version.
RUN pip install --no-cache-dir uv==0.10.2 ruff==0.15.21

# Where the caches live, for the prefetch below, the fetch step and the box.
# No toolchain or interpreter is ever downloaded at run time.
ENV PATH=/usr/local/go/bin:$PATH \
    UV_CACHE_DIR=/deps/uv \
    UV_LINK_MODE=copy \
    UV_PYTHON=/usr/local/bin/python3 \
    UV_PYTHON_DOWNLOADS=never \
    npm_config_cache=/deps/npm \
    npm_config_update_notifier=false \
    npm_config_fund=false \
    npm_config_audit=false \
    GOMODCACHE=/deps/go \
    GOTOOLCHAIN=local \
    GOFLAGS=-mod=mod

# The owner's uid/gid (build_devbox passes `id -u` / `id -g`): the caches
# must be his, or the fetch step (run as him) cannot add to a copied-up
# volume. Not UID/GID: bash makes UID readonly.
ARG OWNER_UID=1000
ARG OWNER_GID=1000

# The context holds only lockfiles + manifests (and this directory): each
# tool fills its cache with the same command the fetch step runs, then the
# sources are dropped. A missing lockfile is skipped, never guessed.
COPY . /src
RUN set -eu; \
    mkdir -p /deps/uv /deps/npm /deps/go; \
    for d in /src/services/*/; do \
      [ -f "${d}uv.lock" ] || continue; \
      (cd "$d" && uv sync --frozen --no-install-project); \
    done; \
    if [ -f /src/apps/web/package-lock.json ]; then \
      (cd /src/apps/web && npm ci --ignore-scripts); \
    fi; \
    if [ -f /src/apps/novad/go.sum ]; then \
      (cd /src/apps/novad && go mod download); \
    fi; \
    rm -rf /src /root/.npm /root/.cache; \
    chown -R "${OWNER_UID}:${OWNER_GID}" /deps

# The box's run-time view: offline, from /deps (S32.2 D5). This is image ENV,
# so the box's own -e stays exactly TEST_DATABASE_URL + HOME (spec §4.2); the
# fetch step overrides the offline words for its own egress run.
ENV UV_OFFLINE=1 \
    npm_config_offline=true \
    npm_config_logs_dir=/tmp/npm-logs \
    GOPROXY=off \
    GOCACHE=/tmp/gocache
