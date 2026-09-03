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

EXPOSE 80
