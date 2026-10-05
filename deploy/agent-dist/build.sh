#!/bin/sh
# agent-dist (S42b, D13): build Nova's agent for the six targets from the
# committed apps/novad tree on stdin (`git archive HEAD apps/novad`), stamped
# with that tree's version (deploy/agent_version.sh), into $DIST_DIR/<version>/
# — then point $DIST_DIR/current at it, last.
#
# Core serves only a build whose every file matches its manifest
# (services/core/app/agent_dist.py), and this never leaves a half-written one
# where core looks: the files are built in a temp dir that is moved into place
# whole, and `current` moves after that. Flags are CI's exactly
# (.github/workflows/rebuild-ci.yml), so one tree builds one sha256 anywhere.
#
# Review fix round 1 (S42b Task 25), two bugs inherited from the brief, one
# fix for both:
#
# I1. stdin is a PIPE in production (install.sh's `git archive ... | docker
#     compose ... run ... agent-dist`, under pipefail). The "already built"
#     path used to return without ever reading stdin; once the archive (tens
#     to hundreds of KB) filled the pipe buffer with nobody draining it,
#     `git archive` got SIGPIPE and the whole install pipeline failed (141)
#     — on every run after the first, since the first run is the only one
#     that is not yet "already built". Stdin is now extracted FIRST, on
#     every path, before anything looks at $V.
# I2. nothing tied the STAMPED version to the BYTES piped in: a caller could
#     stamp any version over any tree. The version is now the tree's own
#     git hash, recomputed from exactly what was extracted — with a
#     throwaway git-dir this image's own git populates, no network and no
#     dependency on the caller's repository — and a build REFUSES unless
#     that recomputed hash starts with $V. Only after that does the script
#     decide between keep and build.
set -eu

DIST=${DIST_DIR:-/dist}
V=${1:-}

WORK=$(mktemp -d "$DIST/.build.XXXXXX")
# EXIT always; INT/TERM/HUP too, so an interrupted build does not leave
# .build.* behind for good — dash (this script's real interpreter in the
# golang image) does not run an EXIT trap for a fatal signal on its own.
trap 'rm -rf "$WORK"' EXIT INT TERM HUP
mkdir "$WORK/src"
if ! tar -x -C "$WORK/src"; then
  echo "agent-dist: cannot: stdin is not a tar archive — pipe in git archive HEAD apps/novad" >&2
  exit 1
fi

case "$V" in
  [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
  *) echo "agent-dist: cannot: the version must be 12 lowercase hex characters (deploy/agent_version.sh), got '$V'" >&2; exit 2 ;;
esac

if [ ! -f "$WORK/src/apps/novad/go.mod" ]; then
  echo "agent-dist: cannot: the input held no apps/novad tree — pipe in git archive HEAD apps/novad" >&2
  exit 1
fi

# I2: the version is a hash of the TREE, never trusted from the caller alone.
# A throwaway, bare git-dir plus an explicit work-tree recomputes the exact
# same tree object `git rev-parse <commit>:apps/novad` would name, entirely
# from the bytes just extracted — isolated from this host's own git config
# (GIT_CONFIG_GLOBAL/SYSTEM=/dev/null) so the hash depends on nothing but
# those bytes, matching this file's own "one tree builds one sha256
# anywhere". `-f` forces past any .gitignore apps/novad might ever carry:
# this recomputes what was extracted, in full, never a filtered subset of it.
if ! (
  cd "$WORK/src" || exit 1
  git init --quiet --bare "$WORK/.git" || exit 1
  export GIT_DIR="$WORK/.git" GIT_WORK_TREE="$WORK/src" GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
  git add -A -f apps/novad && git write-tree --prefix=apps/novad/
) > "$WORK/tree.sha"; then
  echo "agent-dist: cannot: could not recompute the apps/novad tree hash" >&2
  exit 1
fi
TREE=$(cat "$WORK/tree.sha")
case "$TREE" in
  "$V"*) ;;
  *)
    echo "agent-dist: cannot: the tree extracted from stdin hashes to $TREE, which does not start with the stamped version '$V' — the tar and the version name different trees" >&2
    exit 1
    ;;
esac

TARGETS="linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64 windows/arm64"

name_of() { if [ "$1" = windows ]; then echo "novad-$1-$2.exe"; else echo "novad-$1-$2"; fi; }

verified() {
  [ -f "$DIST/$V/manifest.json" ] && [ -f "$DIST/$V/SHA256SUMS" ] || return 1
  (cd "$DIST/$V" && sha256sum -c --status SHA256SUMS)
}

if verified; then
  echo "agent-dist: $V is already built and verified"
  # So the mtime prune below never reads "current" as "oldest": a kept
  # build that was current a moment ago must not look older than a sibling
  # nothing has touched since.
  touch "$DIST/$V"
else
  mkdir "$WORK/out"
  cd "$WORK/src/apps/novad"
  for t in $TARGETS; do
    os=${t%/*}; arch=${t#*/}
    GOOS=$os GOARCH=$arch go build -trimpath -buildvcs=false \
      -ldflags "-s -w -buildid= -X main.version=$V" -o "$WORK/out/$(name_of "$os" "$arch")" .
  done
  cd "$WORK/out"
  sha256sum novad-* > SHA256SUMS
  GOV=$(go version | awk '{print $3}')
  NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  {
    printf '{"v":1,"version":"%s","built_at":"%s","go":"%s","files":{' "$V" "$NOW" "$GOV"
    sep=""
    for t in $TARGETS; do
      os=${t%/*}; arch=${t#*/}; n=$(name_of "$os" "$arch")
      sum=$(sha256sum "$n" | cut -d' ' -f1)
      size=$(wc -c < "$n" | tr -d ' ')
      printf '%s"%s-%s":{"name":"%s","sha256":"%s","size":%s}' "$sep" "$os" "$arch" "$n" "$sum" "$size"
      sep=","
    done
    printf '}}\n'
  } > manifest.json
  cd /
  rm -rf "${DIST:?}/$V"
  mv "$WORK/out" "$DIST/$V"
  echo "agent-dist: built $V"
fi
printf '%s\n' "$V" > "$DIST/.current.tmp"
mv "$DIST/.current.tmp" "$DIST/current"
# Keep this build and the newest other one; the rest go. `ls -t` is what
# gives mtime order (a glob cannot); every name it lists here is already
# constrained to the 12-hex pattern below, so SC2010's unsafe-filename cases
# (globs, newlines, a leading dash) cannot occur.
# shellcheck disable=SC2010
ls -1t "$DIST" | grep -E '^[0-9a-f]{12}$' | grep -vx "$V" | tail -n +2 | while read -r old; do
  rm -rf "${DIST:?}/$old"
done
echo "agent-dist: current is $V"
