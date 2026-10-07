#!/usr/bin/env bash
# Tests for deploy/agent-dist/build.sh against a fake `go` (real git, real
# tar): the version it refuses, the layout core reads, the rebuild it skips,
# the corrupt build it redoes, the builds it keeps, the version it will not
# accept over the wrong tree, and the pipe it always drains. No docker, no
# Go, no network:
#     deploy/agent-dist/build_test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
PASS=0
FAIL=0
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

report() {
  if [ "$1" -eq 0 ]; then PASS=$((PASS + 1)); printf 'ok   %s\n' "$2"
  else FAIL=$((FAIL + 1)); printf 'FAIL %s\n     %s\n' "$2" "${3:-}"; fi
}

mkdir -p "$T/bin"
cat > "$T/bin/go" <<'EOF'
#!/bin/sh
echo "$*" >> "$GO_LOG"
case "$1" in
  version) echo "go version go1.27.1 linux/amd64" ;;
  build)
    out=""
    while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2 ;; *) shift ;; esac; done
    printf 'novad for %s/%s\n' "$GOOS" "$GOARCH" > "$out" ;;
esac
EOF
chmod +x "$T/bin/go"

build() { # $1 dist dir, $2 version; stdin: a tar
  DIST_DIR="$1" GO_LOG="$T/go.log" PATH="$T/bin:$PATH" sh "$SCRIPT_DIR/build.sh" "$2"
}

# A tar of apps/novad/go.mod (content varies by $2, so each "version slot"
# below is genuinely distinct tree content) plus, when $3 is given, an extra
# padding file of that many bytes — real git, real tar: no fake.
make_tar() { # $1 output tar path, $2 content tag, $3 padding bytes (optional)
  rm -rf "$T/mk"; mkdir -p "$T/mk/apps/novad"
  printf 'module novad\n// %s\n' "$2" > "$T/mk/apps/novad/go.mod"
  if [ -n "${3:-}" ]; then
    head -c "$3" /dev/zero | tr '\0' 'x' > "$T/mk/apps/novad/PADDING"
  fi
  ( cd "$T/mk" && tar -cf "$1" apps )
}

# The 12-hex version build.sh itself will recompute for a tar's content: the
# identical recipe (a throwaway bare git-dir, an explicit work-tree, `add -A
# -f` the one subtree, `write-tree --prefix`), run independently here so the
# test is not just "build.sh agrees with build.sh".
tree_version_of() { # $1 tar path -> prints 12 lowercase hex chars
  local tmp
  tmp="$(mktemp -d "$T/tv.XXXXXX")"
  mkdir -p "$tmp/src"
  tar -x -C "$tmp/src" -f "$1"
  (
    cd "$tmp/src" || exit 1
    git init --quiet --bare "$tmp/git" || exit 1
    export GIT_DIR="$tmp/git" GIT_WORK_TREE="$tmp/src" GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
    git add -A -f apps/novad && git write-tree --prefix=apps/novad/
  ) | cut -c1-12
  rm -rf "$tmp"
}

D="$T/dist"; mkdir -p "$D"

make_tar "$T/tree1.tar" fixture-1
V1="$(tree_version_of "$T/tree1.tar")"

out="$(build "$D" NOT-A-VERSION < "$T/tree1.tar" 2>&1)"; rc=$?
[ "$rc" -eq 2 ] && [ -z "$(ls -A "$D")" ] && report 0 "a malformed version is refused and nothing is written" \
  || report 1 "a malformed version is refused and nothing is written" "rc=$rc $out"

case "$V1" in
  f*) WRONG_V="0${V1#?}" ;;
  *) WRONG_V="f${V1#?}" ;;
esac
out="$(build "$D" "$WRONG_V" < "$T/tree1.tar" 2>&1)"; rc=$?
[ "$rc" -eq 1 ] && printf '%s' "$out" | grep -q 'does not start with the stamped version' && [ ! -e "$D/$WRONG_V" ] \
  && report 0 "a version that does not match the tree's own hash is refused" \
  || report 1 "a version that does not match the tree's own hash is refused" "rc=$rc $out"

out="$(build "$D" "$V1" < "$T/tree1.tar" 2>&1)"; rc=$?
if [ "$rc" -eq 0 ] && [ "$(cat "$D/current")" = "$V1" ] \
  && (cd "$D/$V1" && sha256sum -c --status SHA256SUMS) \
  && python3 - "$D/$V1" "$V1" <<'PY'
import hashlib, json, os, sys
d, v = sys.argv[1], sys.argv[2]
m = json.load(open(os.path.join(d, "manifest.json")))
assert m["v"] == 1, m
assert m["version"] == v, (m["version"], v)
expected = {"linux-amd64", "linux-arm64", "darwin-amd64", "darwin-arm64", "windows-amd64", "windows-arm64"}
assert set(m["files"]) == expected, set(m["files"])
raw = open(os.path.join(d, "manifest.json")).read()
assert ": " not in raw and ", " not in raw, "manifest.json is not compact"
for key, entry in m["files"].items():
    assert list(entry.keys()) == ["name", "sha256", "size"], (key, list(entry.keys()))
    goos, arch = key.split("-", 1)
    expected_name = f"novad-{goos}-{arch}" + (".exe" if goos == "windows" else "")
    assert entry["name"] == expected_name, (key, entry)
    data = open(os.path.join(d, entry["name"]), "rb").read()
    assert entry["size"] == len(data), (key, entry["size"], len(data))
    assert entry["sha256"] == hashlib.sha256(data).hexdigest(), key
PY
then
  report 0 "a build writes six binaries, SHA256SUMS and the manifest (exact keys, name-before-sha256, each sha256/size checked against its file), then points current at it"
else
  report 1 "a build writes six binaries, SHA256SUMS and the manifest (exact keys, name-before-sha256, each sha256/size checked against its file), then points current at it" "rc=$rc $out"
fi

: > "$T/go.log"
out="$(build "$D" "$V1" < "$T/tree1.tar" 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && ! grep -q '^build' "$T/go.log" && printf '%s' "$out" | grep -q 'already built and verified' \
  && report 0 "a verified build is kept, not rebuilt" || report 1 "a verified build is kept, not rebuilt" "rc=$rc $(cat "$T/go.log")"

printf 'tampered\n' > "$D/$V1/novad-linux-amd64"
: > "$T/go.log"
out="$(build "$D" "$V1" < "$T/tree1.tar" 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && grep -q '^build' "$T/go.log" && (cd "$D/$V1" && sha256sum -c --status SHA256SUMS) \
  && report 0 "a build that no longer matches its sums is built again" || report 1 "a build that no longer matches its sums is built again" "rc=$rc"

# L541 part 2 (Task 32): verified() must also check manifest.json's SHAPE,
# not just that the six binaries match SHA256SUMS. Dropping one target's
# entry here leaves SHA256SUMS (a different file, listing the six binaries
# only) completely untouched, so this is exactly the gap the ledger named:
# a corrupt manifest that still passes `sha256sum -c`. No -i (BSD sed on
# the macOS leg takes no bare -i argument): write to a new file, then
# `command cp -f` over it, same as the shell rule for this worktree.
sed 's/,"windows-arm64":{[^}]*}//' "$D/$V1/manifest.json" > "$T/manifest.trimmed"
command cp -f "$T/manifest.trimmed" "$D/$V1/manifest.json"
(cd "$D/$V1" && sha256sum -c --status SHA256SUMS) \
  || report 1 "a manifest missing one target's entry still passes sha256sum -c (the fixture, not the fix, is wrong)" "SHA256SUMS does not name manifest.json"
: > "$T/go.log"
out="$(build "$D" "$V1" < "$T/tree1.tar" 2>&1)"; rc=$?
if [ "$rc" -eq 0 ] && grep -q '^build' "$T/go.log" \
  && ! printf '%s' "$out" | grep -q 'already built and verified' \
  && grep -q '"windows-arm64"' "$D/$V1/manifest.json"
then
  report 0 "a manifest missing one target's entry is rebuilt, never trusted as already built and verified"
else
  report 1 "a manifest missing one target's entry is rebuilt, never trusted as already built and verified" "rc=$rc go.log=$(cat "$T/go.log") out=$out"
fi

make_tar "$T/tree2.tar" fixture-2
V2="$(tree_version_of "$T/tree2.tar")"
make_tar "$T/tree3.tar" fixture-3
V3="$(tree_version_of "$T/tree3.tar")"

build "$D" "$V2" < "$T/tree2.tar" >/dev/null 2>&1; sleep 1
build "$D" "$V3" < "$T/tree3.tar" >/dev/null 2>&1
# shellcheck disable=SC2010 # version dirs only match a fixed 12-hex pattern
kept="$(ls "$D" | grep -E '^[0-9a-f]{12}$' | sort | tr '\n' ' ')"
[ "$kept" = "$(printf '%s %s ' "$V2" "$V3" | tr ' ' '\n' | sort | tr '\n' ' ')" ] && [ "$(cat "$D/current")" = "$V3" ] \
  && report 0 "the current build and the one before it are kept" \
  || report 1 "the current build and the one before it are kept" "kept: $kept"

build "$D" "$V2" < "$T/tree2.tar" >/dev/null 2>&1
# shellcheck disable=SC2010 # version dirs only match a fixed 12-hex pattern
kept="$(ls "$D" | grep -E '^[0-9a-f]{12}$' | sort | tr '\n' ' ')"
[ "$kept" = "$(printf '%s %s ' "$V2" "$V3" | tr ' ' '\n' | sort | tr '\n' ' ')" ] && [ "$(cat "$D/current")" = "$V2" ] \
  && report 0 "going back to a kept build never deletes it" \
  || report 1 "going back to a kept build never deletes it" "kept: $kept current: $(cat "$D/current")"

( cd "$T" && mkdir -p empty && tar -cf "$T/empty.tar" -C "$T" empty )
out="$(build "$D" dddddddddddd < "$T/empty.tar" 2>&1)"; rc=$?
[ "$rc" -eq 1 ] && printf '%s' "$out" | grep -q 'no apps/novad tree' && [ "$(cat "$D/current")" = "$V2" ] \
  && report 0 "input with no apps/novad is refused and current is untouched" \
  || report 1 "input with no apps/novad is refused and current is untouched" "rc=$rc $out"

out="$(printf 'this is not a tar archive at all\n' | build "$D" ffffffffffff 2>&1)"; rc=$?
[ "$rc" -eq 1 ] && printf '%s' "$out" | grep -q 'not a tar archive' \
  && report 0 "non-tar input is refused with the build-failure code, never tar's own exit code" \
  || report 1 "non-tar input is refused with the build-failure code, never tar's own exit code" "rc=$rc $out"

# The keep path touches $DIST/$V (current is still V2 here, from "going back
# to a kept build", dist still {V2, V3}). Without the touch, V2's mtime is
# stale from its ORIGINAL build, older than V3's — so building a brand new
# V4 now would read V3, not V2, as "the one before" and keep that instead,
# dropping V2: the exact build that was current just before.
make_tar "$T/tree4.tar" fixture-4
V4="$(tree_version_of "$T/tree4.tar")"
build "$D" "$V4" < "$T/tree4.tar" >/dev/null 2>&1
# shellcheck disable=SC2010 # version dirs only match a fixed 12-hex pattern
kept="$(ls "$D" | grep -E '^[0-9a-f]{12}$' | sort | tr '\n' ' ')"
expected="$(printf '%s\n%s\n' "$V2" "$V4" | sort | tr '\n' ' ')"
[ "$kept" = "$expected" ] && [ "$(cat "$D/current")" = "$V4" ] \
  && report 0 "returning to a build touches it, so a later new build keeps it, not a longer-stale sibling" \
  || report 1 "returning to a build touches it, so a later new build keeps it, not a longer-stale sibling" "kept: $kept expected: $expected"

# I1: on a real PIPE (not a file redirect — a pipe is where the SIGPIPE bug
# lives), a large tar piped into the already-built-and-verified (keep) path
# must still have its writer's end fully drained, so the pipeline exits 0
# under pipefail instead of 141 (the writer SIGPIPE'd because build.sh never
# read it). 70000 bytes is comfortably past a 64 KiB pipe buffer.
make_tar "$T/tree_large.tar" fixture-large 70000
[ "$(stat -c%s "$T/tree_large.tar" 2>/dev/null || stat -f%z "$T/tree_large.tar")" -gt 65536 ] \
  || report 1 "the large tar fixture is actually larger than a pipe buffer" "too small"
VL="$(tree_version_of "$T/tree_large.tar")"
build "$D" "$VL" < "$T/tree_large.tar" >/dev/null 2>&1
out="$( (set -o pipefail; cat "$T/tree_large.tar" | build "$D" "$VL") 2>&1 )"; rc=$?
[ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q 'already built and verified' \
  && report 0 "a tar larger than 64 KB piped into the keep path drains stdin and exits 0 under pipefail" \
  || report 1 "a tar larger than 64 KB piped into the keep path drains stdin and exits 0 under pipefail" "rc=$rc $out"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
