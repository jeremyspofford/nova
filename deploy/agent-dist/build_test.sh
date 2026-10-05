#!/usr/bin/env bash
# Tests for deploy/agent-dist/build.sh against a fake `go`: the version it
# refuses, the layout core reads, the rebuild it skips, the corrupt build it
# redoes, and the builds it keeps. No docker, no Go, no network:
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

mkdir -p "$T/bin" "$T/src/apps/novad"
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
printf 'module novad\n' > "$T/src/apps/novad/go.mod"
( cd "$T/src" && tar -cf "$T/tree.tar" apps )

build() { # $1 dist dir, $2 version; stdin: a tar
  DIST_DIR="$1" GO_LOG="$T/go.log" PATH="$T/bin:$PATH" sh "$SCRIPT_DIR/build.sh" "$2"
}

D="$T/dist"; mkdir -p "$D"
out="$(build "$D" NOT-A-VERSION < "$T/tree.tar" 2>&1)"; rc=$?
[ "$rc" -eq 2 ] && [ -z "$(ls -A "$D")" ] && report 0 "a malformed version is refused and nothing is written" \
  || report 1 "a malformed version is refused and nothing is written" "rc=$rc $out"

V1=aaaaaaaaaaaa
out="$(build "$D" "$V1" < "$T/tree.tar" 2>&1)"; rc=$?
# shellcheck disable=SC2010 # fixed, known filenames only; no exotic names occur
n="$(ls "$D/$V1" | grep -c '^novad-')"
if [ "$rc" -eq 0 ] && [ "$n" -eq 6 ] && [ "$(cat "$D/current")" = "$V1" ] \
  && (cd "$D/$V1" && sha256sum -c --status SHA256SUMS) \
  && grep -q '"version":"aaaaaaaaaaaa"' "$D/$V1/manifest.json" \
  && grep -q '"windows-arm64":{"name":"novad-windows-arm64.exe","sha256":"[0-9a-f]\{64\}","size":[0-9]*}' "$D/$V1/manifest.json" \
  && python3 -c "import json,sys; m=json.load(open(sys.argv[1])); assert m['v']==1 and len(m['files'])==6" "$D/$V1/manifest.json"; then
  report 0 "a build writes six binaries, SHA256SUMS and the manifest, then points current at it"
else
  report 1 "a build writes six binaries, SHA256SUMS and the manifest, then points current at it" "rc=$rc n=$n $out"
fi

: > "$T/go.log"
out="$(build "$D" "$V1" < "$T/tree.tar" 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && ! grep -q '^build' "$T/go.log" && printf '%s' "$out" | grep -q 'already built and verified' \
  && report 0 "a verified build is kept, not rebuilt" || report 1 "a verified build is kept, not rebuilt" "rc=$rc $(cat "$T/go.log")"

printf 'tampered\n' > "$D/$V1/novad-linux-amd64"
: > "$T/go.log"
out="$(build "$D" "$V1" < "$T/tree.tar" 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && grep -q '^build' "$T/go.log" && (cd "$D/$V1" && sha256sum -c --status SHA256SUMS) \
  && report 0 "a build that no longer matches its sums is built again" || report 1 "a build that no longer matches its sums is built again" "rc=$rc"

V2=bbbbbbbbbbbb; V3=cccccccccccc
build "$D" "$V2" < "$T/tree.tar" >/dev/null 2>&1; sleep 1
build "$D" "$V3" < "$T/tree.tar" >/dev/null 2>&1
# shellcheck disable=SC2010 # version dirs only match a fixed 12-hex pattern
kept="$(ls "$D" | grep -E '^[0-9a-f]{12}$' | sort | tr '\n' ' ')"
[ "$kept" = "$V2 $V3 " ] && [ "$(cat "$D/current")" = "$V3" ] && report 0 "the current build and the one before it are kept" \
  || report 1 "the current build and the one before it are kept" "kept: $kept"

build "$D" "$V2" < "$T/tree.tar" >/dev/null 2>&1
# shellcheck disable=SC2010 # version dirs only match a fixed 12-hex pattern
kept="$(ls "$D" | grep -E '^[0-9a-f]{12}$' | sort | tr '\n' ' ')"
[ "$kept" = "$V2 $V3 " ] && [ "$(cat "$D/current")" = "$V2" ] && report 0 "going back to a kept build never deletes it" \
  || report 1 "going back to a kept build never deletes it" "kept: $kept current: $(cat "$D/current")"

( cd "$T" && mkdir -p empty && tar -cf "$T/empty.tar" -C "$T" empty )
out="$(build "$D" dddddddddddd < "$T/empty.tar" 2>&1)"; rc=$?
[ "$rc" -eq 1 ] && printf '%s' "$out" | grep -q 'no apps/novad tree' && [ "$(cat "$D/current")" = "$V2" ] \
  && report 0 "input with no apps/novad is refused and current is untouched" \
  || report 1 "input with no apps/novad is refused and current is untouched" "rc=$rc $out"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
