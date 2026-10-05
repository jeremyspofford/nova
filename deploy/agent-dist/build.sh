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
set -eu

DIST=${DIST_DIR:-/dist}
V=${1:-}
case "$V" in
  [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
  *) echo "agent-dist: cannot: the version must be 12 lowercase hex characters (deploy/agent_version.sh), got '$V'" >&2; exit 2 ;;
esac
TARGETS="linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64 windows/arm64"

name_of() { if [ "$1" = windows ]; then echo "novad-$1-$2.exe"; else echo "novad-$1-$2"; fi; }

verified() {
  [ -f "$DIST/$V/manifest.json" ] && [ -f "$DIST/$V/SHA256SUMS" ] || return 1
  (cd "$DIST/$V" && sha256sum -c --status SHA256SUMS)
}

if verified; then
  echo "agent-dist: $V is already built and verified"
else
  WORK=$(mktemp -d "$DIST/.build-$V.XXXXXX")
  trap 'rm -rf "$WORK"' EXIT
  mkdir "$WORK/src" "$WORK/out"
  tar -x -C "$WORK/src"
  if [ ! -f "$WORK/src/apps/novad/go.mod" ]; then
    echo "agent-dist: cannot: the input held no apps/novad tree — pipe in git archive HEAD apps/novad" >&2
    exit 1
  fi
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
