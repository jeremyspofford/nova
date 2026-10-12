#!/usr/bin/env bash
# The box's seal, measured against real docker (S32.2 T12, spec §4.2).
#
# Builds the devbox image with install.sh's own build_devbox in a THROWAWAY
# checkout (this repo's deploy/devbox + lockfiles + manifests, committed on
# main, plus planted secrets: <checkout>/.env, deploy/.env), opens two change
# worktrees the way start_change does, and runs the Go harness
# apps/novad/internal/client/seal_docker_test.go (`go test -tags docker`),
# which brings both boxes up through the agent's own newBoxManager() and
# caps.Dispatch("box.exec") — the shipped argv, never a hand-written run —
# and checks every row of §4.2 from inside and from docker inspect:
#
#   change A: its branch commits an edited deploy/devbox/Dockerfile (and
#             leaves another edit uncommitted): its box must still run main's
#             image. A tiny Go package (apps/novad/sealprobe) is `go test`ed,
#             and core's suite command `uv run pytest` runs one test.
#   change B: its go.mod/go.sum add a module the image never cached: the fetch
#             step must put it in B's cache volume, not A's.
#   box job (S30c T5, row C13): a job.start with box args runs in A's box
#             through the real `novad job-exec` wrapper; killing only its
#             host docker client leaves the process in the box running (the
#             control), and job.stop kills it INSIDE the box — pid and child
#             gone from the box's /proc.
#
# Run it under the CPU lock (an image build + two boxes):
#
#     flock -w 3600 <lock> bash deploy/devbox/seal_test.sh
#
# Leaves nothing behind, success or failure: every container, network and
# volume labelled with this run's two change ids, the throwaway image (its
# deploy/devbox carries a SEAL_TEST file, so its tag is never one a hub's
# main can hold) and the temp checkout. It touches nothing else — no live
# stack container, network or image.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../.." && pwd)"
NOVAD="$REPO/apps/novad"
# The checkout lives under $HOME like the real one (~/workspace/nova), so the
# harness can check the box sees nothing of $HOME but the path to its mounts.
BASE="${SEAL_TMPDIR:-$HOME/.cache}"
FETCHED_MOD="github.com/google/uuid@v1.6.0"
TMP=""
TAG=""
A=""
B=""

say() { printf 'seal: %s\n' "$*"; }
die() { printf 'seal: FAIL %s\n' "$*" >&2; exit 1; }

cleanup() {
  local id kind
  for id in $A $B; do
    # shellcheck disable=SC2046 # ids are docker's
    docker rm -f $(docker ps -aq --filter "label=nova.box=$id") >/dev/null 2>&1 || true
    for kind in network volume; do
      # shellcheck disable=SC2046
      docker "$kind" rm $(docker "$kind" ls -q --filter "label=nova.box=$id") >/dev/null 2>&1 || true
    done
  done
  [ -n "$TAG" ] && docker rmi -f "$TAG" >/dev/null 2>&1
  [ -n "$TMP" ] && rm -rf "$TMP"
  return 0
}
trap cleanup EXIT

command -v docker >/dev/null || die "docker is not on PATH"
command -v go >/dev/null || PATH="$HOME/.local/share/mise/installs/go/latest/bin:$PATH"
command -v go >/dev/null || die "go is not on PATH"

# Two change ids no box on this machine holds.
fresh_id() {
  local id
  while :; do
    id="$(od -An -tx1 -N3 /dev/urandom | tr -d ' \n')"
    [ -z "$(docker ps -aq --filter "label=nova.box=$id")" ] \
      && [ -z "$(docker network ls -q --filter "name=nova-box-$id")" ] \
      && [ -z "$(docker volume ls -q --filter "name=nova-box-$id")" ] \
      && { printf '%s' "$id"; return; }
  done
}
A="$(fresh_id)"
B="$(fresh_id)"
[ "$A" != "$B" ] || die "two equal change ids"

mkdir -p "$BASE"
TMP="$(mktemp -d "$BASE/nova-seal.XXXXXX")" || die "no temp dir under $BASE"
CHECKOUT="$TMP/repo"
g() { git -c user.name=seal -c user.email=seal@seal -c init.defaultBranch=main "$@"; }

# ---- the throwaway checkout: main = deploy/devbox + lockfiles + manifests ---
mkdir -p "$CHECKOUT"
(
  cd "$REPO" || exit 1
  for f in deploy/devbox/* services/*/uv.lock apps/web/package.json apps/web/package-lock.json \
           apps/novad/go.mod apps/novad/go.sum; do
    [ -f "$f" ] || continue
    mkdir -p "$CHECKOUT/$(dirname "$f")"
    command cp -f "$f" "$CHECKOUT/$f"
    case "$f" in
      services/*/uv.lock) command cp -f "$(dirname "$f")/pyproject.toml" "$CHECKOUT/$(dirname "$f")/" ;;
    esac
  done
) || die "could not copy the recipe and lockfiles"
printf 'seal test image — never a hub main tree\n' > "$CHECKOUT/deploy/devbox/SEAL_TEST"
printf 'SEAL_CHECKOUT_SECRET=1\n' > "$CHECKOUT/.env"
printf 'POSTGRES_PASSWORD=seal-secret\n' > "$CHECKOUT/deploy/.env"
# One core test, so the core suite's exact command (`uv run pytest`, from
# suites.toml) runs in the box against core's real lockfile.
mkdir -p "$CHECKOUT/services/core/tests"
printf 'def test_runs():\n    assert True\n' > "$CHECKOUT/services/core/tests/test_seal.py"
mkdir -p "$CHECKOUT/apps/novad/sealprobe"
printf 'package sealprobe\n' > "$CHECKOUT/apps/novad/sealprobe/p.go"
printf 'package sealprobe\n\nimport "testing"\n\nfunc TestRuns(t *testing.T) {}\n' \
  > "$CHECKOUT/apps/novad/sealprobe/p_test.go"
printf '.env\ndeploy/.env\n.worktrees/\n' > "$CHECKOUT/.gitignore"
g init -q "$CHECKOUT" && g -C "$CHECKOUT" add -A && g -C "$CHECKOUT" commit -q -m seal \
  || die "could not commit the throwaway checkout"

# ---- the image, by install.sh's own build_devbox -------------------------
(
  # shellcheck source=/dev/null
  . "$REPO/deploy/install.sh"
  # shellcheck disable=SC2034 # read by build_devbox / devbox_tag
  REPO_ROOT="$CHECKOUT"
  cd "$CHECKOUT" || exit 1
  TAG_="$(devbox_tag)" || exit 1
  printf '%s\n' "$TAG_" > "$TMP/tag"
  build_devbox
) || die "build_devbox failed"
TAG="$(cat "$TMP/tag")"
[ -n "$TAG" ] && docker image inspect "$TAG" >/dev/null 2>&1 || die "build_devbox left no $TAG"
say "built $TAG"

# ---- two changes, the way start_change opens them -------------------------
g -C "$CHECKOUT" worktree add -q -b "nova/$A-seal" ".worktrees/nova-$A" main || die "worktree A"
g -C "$CHECKOUT" worktree add -q -b "nova/$B-seal" ".worktrees/nova-$B" main || die "worktree B"
WA="$CHECKOUT/.worktrees/nova-$A"
WB="$CHECKOUT/.worktrees/nova-$B"
printf 'USER root\n# --privileged\n' >> "$WA/deploy/devbox/Dockerfile"
g -C "$WA" commit -q -am "seal: a change edits its own recipe" || die "commit A"
printf 'RUN echo uncommitted\n' >> "$WA/deploy/devbox/Dockerfile"
CHANGE_TAG="nova-devbox:t-$(git -C "$CHECKOUT" rev-parse "nova/$A-seal:deploy/devbox")"
(cd "$WB/apps/novad" && GOFLAGS=-mod=mod GOTOOLCHAIN=local go get "$FETCHED_MOD" >/dev/null 2>&1) \
  || die "could not add $FETCHED_MOD to B's go.mod on the host"
git -C "$WB" diff --quiet -- apps/novad/go.sum && die "B's go.sum did not change"

# ---- the harness: the shipped box path against real docker ---------------
cd "$NOVAD" || die "no $NOVAD"
# The job wrapper (`novad job-exec`, S30c) the C13 box-job row runs, built
# from this tree.
go build -o "$TMP/novad" . || die "could not build novad for the box-job row"
SEAL_CHECKOUT="$CHECKOUT" SEAL_BRANCH=main SEAL_A="$A" SEAL_B="$B" SEAL_TAG="$TAG" \
  SEAL_CHANGE_TAG="$CHANGE_TAG" SEAL_FETCHED_MOD="$FETCHED_MOD" SEAL_NOVAD="$TMP/novad" \
  go test -tags docker -count=1 -run '^TestSeal$' -v ./internal/client
rc=$?
[ "$rc" -eq 0 ] && say "sealed: every check passed" || say "FAIL: the seal test failed (exit $rc)"
exit "$rc"
