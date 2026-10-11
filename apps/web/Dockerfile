FROM node:22 AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM nginx:alpine

# Only substitute env vars whose name starts with NOVA_ when rendering
# templates below (nginx:alpine's own /docker-entrypoint.d/
# 20-envsubst-on-templates.sh reads this at container start). Without it,
# envsubst is handed every env var name in the container and would mangle
# any nginx `$var` (host, scheme, remote_addr, ...) that happens to collide
# with one — see apps/web/nginx.conf.template for the one var this actually
# substitutes.
ENV NGINX_ENVSUBST_FILTER=^NOVA_

# A baked-in empty default, deliberately: envsubst only substitutes vars it
# finds in the container's actual environment (see the entrypoint script),
# so a `docker run` with no -e for this at all — not just docker-compose's
# `${NOVA_PUBLIC_GATE_TOKEN:-}`, which always passes an empty string through
# — would otherwise leave the literal `${NOVA_PUBLIC_GATE_TOKEN}` in the
# rendered conf and nginx would refuse to start ("unknown ... variable").
# This ENV guarantees the var is always present, so "unset" and "set to
# empty" are the same gate-off case everywhere this image runs.
ENV NOVA_PUBLIC_GATE_TOKEN=

# Same reason, same shape. This is the ONE source address nginx believes a
# Tailscale-User-* identity header from (nginx.conf.template, $from_sidecar
# — the tailnet sidecar's fixed address, set by deploy/docker-compose.yml).
# Unset has to mean "trust nobody", and with this baked default it does: the
# map key renders as the empty string, which no $remote_addr ever equals —
# rather than a literal `${NOVA_TAILSCALE_ADDR}` left in the rendered conf.
# Pinned by gate_test.sh (a web run without it refuses the trusted address).
ENV NOVA_TAILSCALE_ADDR=

# Rendered to /etc/nginx/conf.d/default.conf by the entrypoint above, every
# container start — NOT copied to conf.d directly like a plain conf would be.
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
# The gate's shared `if ($gate_block) return 401;` snippet, `include`d by
# every location in the template. Lives outside conf.d/ on purpose — see the
# comment in the file itself.
COPY gate/gate_check.conf /etc/nginx/gate/gate_check.conf

COPY --from=build /app/dist /usr/share/nginx/html
# After the build output, deliberately: the gate page must win if a future
# dist build ever produced a same-named file.
COPY gate-page.html /usr/share/nginx/html/gate-page.html

# Build identity (S32): the commit this image was built from and the content
# hash of apps/web, passed by deploy/docker-compose.yml from ./install's
# NOVA_COMMIT / NOVA_HASH_WEB. Declared LAST, after every COPY: a new commit
# then reruns only the one cheap RUN below, never the npm stage or the dist
# layer. Read back on /build.json (nginx.conf.template, behind the gate) and
# by ./install from the labels.
#
# build.json carries a value only when it is a full lowercase git object id
# (40 or 64 hex), else null — never a string that reads as an identity
# (unset, empty, "unknown", a short SHA). Same rule as the Python services'
# app/build_identity.py. Pure sh, no grep: grep matches line by line, so a
# value with a newline in it would pass.
ARG NOVA_BUILD_SHA=
ARG NOVA_CONTENT_HASH=
RUN set -eu; \
    json_id() { \
      case "$1" in ''|*[!0-9a-f]*) echo null; return ;; esac; \
      case "${#1}" in 40|64) printf '"%s"' "$1" ;; *) echo null ;; esac; \
    }; \
    printf '{"build_sha":%s,"content_hash":%s}\n' \
      "$(json_id "$NOVA_BUILD_SHA")" "$(json_id "$NOVA_CONTENT_HASH")" \
      > /usr/share/nginx/html/build.json
LABEL nova.build-sha="$NOVA_BUILD_SHA" nova.content-hash="$NOVA_CONTENT_HASH"

EXPOSE 80
