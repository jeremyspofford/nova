#!/usr/bin/env bash
# Regenerate every fixture in this directory from the machine it is run on.
#
#     deploy/backup/fixtures/refresh.sh
#
# WHY THIS IS A SCRIPT AND NOT A PARAGRAPH IN A README: the fixtures pin what
# compose, docker and git actually do, and `test_coverage_v4_real.py` asserts
# the dispositions in deploy/docker-compose.yml cover the REAL stack. A fixture
# transcribed by hand stamps what the product does not do — which is the exact
# failure mode port-v3's drift alarm had, passing while the product refused.
#
# RUN IT whenever:
#   - deploy/docker-compose.yml's volumes, binds or x-nova-backup rows change
#     (in the SAME commit, or test_coverage_v4_real.py pins a stale render);
#   - the searxng image starts declaring another VOLUME (the image is
#     deliberately unpinned, so this is expected to happen);
#   - a compose or docker version changes under the stack.
#
# It is READ-ONLY against the stack: `docker compose config`, `docker ps`,
# `docker inspect`, `docker volume inspect`, one `psql -c SELECT` through
# `docker exec`, and one throwaway `docker run --rm` per carried volume with
# the volume mounted `:ro`. It starts nothing, stops nothing and writes
# nothing outside this directory.
#
# PATHS ARE NORMALISED. Every absolute path inside the capturing checkout, and
# inside the checkout the live stack was created from (they are often not the
# same — see the `sibling` class in design-verdict.md §10.1), is rewritten to
# `/repo`, so the compose fixture and the container fixture agree and neither
# carries a machine-specific path into a public repo.
set -uo pipefail

FIX_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
DEPLOY_DIR="$(cd "$FIX_DIR/../.." && pwd)"
REPO_ROOT="$(cd "$DEPLOY_DIR/.." && pwd)"
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/nova-fixtures.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT

die() { printf 'refresh: %s\n' "$1" >&2; exit 1; }

# shellcheck source=/dev/null
. "$DEPLOY_DIR/backup.sh"

COMPOSE_VERSION="$(docker compose version --short 2>/dev/null)"
[ -n "$COMPOSE_VERSION" ] || die "docker compose did not report a version"
case "$COMPOSE_VERSION" in v*) ;; *) COMPOSE_VERSION="v$COMPOSE_VERSION" ;; esac
printf 'compose %s\n' "$COMPOSE_VERSION"

PROJECT="$(bk_project)"
[ -n "$PROJECT" ] || die "could not read the project name out of the compose render"

# The checkout the LIVE stack was created from, read off its own containers'
# compose label — not assumed to be this one.
LIVE_ROOT=""
LIVE_COMPOSE="$(docker ps -a --filter "label=com.docker.compose.project=$PROJECT" \
  --format '{{.ID}}' | while IFS= read -r id; do
    docker inspect "$id" --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}'
  done | tr ',' '\n' | grep '/deploy/docker-compose\.yml$' | sort -u | head -1)"
if [ -n "$LIVE_COMPOSE" ]; then
  LIVE_ROOT="$(dirname "$(dirname "$LIVE_COMPOSE")")"
  printf 'live stack was created from %s\n' "$LIVE_ROOT"
fi

normalise() {
  if [ -n "$LIVE_ROOT" ] && [ "$LIVE_ROOT" != "$REPO_ROOT" ]; then
    sed -e "s|$LIVE_ROOT|/repo|g" -e "s|$REPO_ROOT|/repo|g"
  else
    sed -e "s|$REPO_ROOT|/repo|g"
  fi
}

# ── the probe fixtures (design-verdict.md §3) ───────────────────────────────
# Two renders of one source file, which is what pins "dispositions come out of
# the YAML" and "the declared set comes out of the raw text".
docker compose --project-directory "$FIX_DIR" \
  -f "$FIX_DIR/probe-compose.yml" -f "$FIX_DIR/probe-compose.overlay.yml" \
  --profile '*' config 2>/dev/null | sed "s|$FIX_DIR|/repo|g" \
  > "$FIX_DIR/probe-$COMPOSE_VERSION.yaml" || die "probe YAML render failed"
docker compose --project-directory "$FIX_DIR" \
  -f "$FIX_DIR/probe-compose.yml" -f "$FIX_DIR/probe-compose.overlay.yml" \
  --profile '*' config --format json 2>/dev/null | sed "s|$FIX_DIR|/repo|g" \
  > "$FIX_DIR/probe-$COMPOSE_VERSION.json" || die "probe JSON render failed"
printf 'wrote probe-%s.{yaml,json}\n' "$COMPOSE_VERSION"

# ── the real stack ──────────────────────────────────────────────────────────
mkdir -p "$STAGE/facts"
render_raw "$STAGE" || die "render_raw failed"
render_dispositions "$STAGE" || die "render_dispositions failed"
render_config "$STAGE" || die "render_config failed"
render_containers "$STAGE" || die "render_containers failed"
render_git "$STAGE" || die "render_git failed"
render_databases "$STAGE" || die "render_databases failed"
render_reachable "$STAGE" routine || die "render_reachable failed"

normalise < "$STAGE/facts/config.yaml" > "$FIX_DIR/compose-$COMPOSE_VERSION.yaml"
normalise < "$STAGE/facts/config.json" > "$FIX_DIR/compose-$COMPOSE_VERSION.json"
normalise < "$STAGE/facts/raw.json" > "$FIX_DIR/raw-v4.json"
normalise < "$STAGE/facts/git.json" > "$FIX_DIR/git-v4.json"
normalise < "$STAGE/facts/databases.json" > "$FIX_DIR/databases-v4.json"
normalise < "$STAGE/facts/reachable.json" > "$FIX_DIR/reachable-v4.json"

# containers.json is split in two, by the ONE mechanical rule, stated:
# a container belongs to this stack when a normalised entry of its own
# com.docker.compose.project.config_files label is one of this checkout's
# compose files. Everything else carries this project's NAME and was created
# from something else — on this machine, v3's stopped containers, which the
# compose same-project-name trap left labelled `nova`.
#
# Both halves are kept. containers-v4.json is what test_coverage_v4_real.py
# proves the dispositions cover; containers-foreign-v4.json is what proves
# R4_UNDECLARED_LIVE_MOUNT fires on real data rather than only on a fixture
# somebody wrote to make it fire.
normalise < "$STAGE/facts/containers.json" > "$STAGE/containers-normalised.json"
python3 - "$STAGE/containers-normalised.json" "$FIX_DIR" <<'PY' || die "splitting containers failed"
import json, sys

src, out_dir = sys.argv[1], sys.argv[2]
with open(src, encoding="utf-8") as fh:
    fact = json.load(fh)

OURS = {"/repo/deploy/docker-compose.yml", "/repo/deploy/docker-compose.gpu.yml"}
ours, foreign = [], []
for c in fact.get("containers", []):
    files = {p for p in (c.get("config_files") or "").split(",") if p}
    (ours if files & OURS else foreign).append(c)

for name, rows in (("containers-v4.json", ours), ("containers-foreign-v4.json", foreign)):
    with open(f"{out_dir}/{name}", "w", encoding="utf-8") as fh:
        json.dump({"project": fact.get("project"), "containers": rows}, fh, indent=2)
        fh.write("\n")
    print(f"wrote {name}: {len(rows)} container(s)")
PY

# The raw evidence behind the host-path half: the real command's output, never
# a hand-written list (design-verdict.md §4's `ignored-paths.txt`).
( cd "$REPO_ROOT" && git status --porcelain --ignored=matching ) |
  awk '/^!! /{ print substr($0, 4) }' | normalise > "$FIX_DIR/ignored-paths.txt"

printf 'wrote compose-%s.{yaml,json}, raw-v4.json, git-v4.json, databases-v4.json, reachable-v4.json, ignored-paths.txt\n' \
  "$COMPOSE_VERSION"
printf '\nNow run the suites: deploy/backup_test.sh and (cd deploy/backup && pytest)\n'
