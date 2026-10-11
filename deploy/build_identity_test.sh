#!/usr/bin/env bash
# Pins S32.1's build identity as BAKED into the images, not as written in the
# Dockerfiles: builds services/{core,gateway,memory} from their real
# Dockerfiles, once with known NOVA_BUILD_SHA / NOVA_CONTENT_HASH build args
# and once with none, and reads each image back: its labels (nova.build-sha,
# nova.content-hash, what ./install's verify step reads off the running
# container) and the environment a container of it starts with (what /status
# reads). Built with no args, both are present and EMPTY: never a made-up
# value.
#
# No stack needs to be running. Leaves nothing behind: every image this script
# creates is removed on exit, success or failure (containers run --rm). Names
# carry BUILD_IDENTITY_TEST_PREFIX (default nova-build-identity-test), never a
# live nova-<svc> tag.
#
#     deploy/build_identity_test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PREFIX="${BUILD_IDENTITY_TEST_PREFIX:-nova-build-identity-test}"
SERVICES="core gateway memory"
# Known values of both shapes a hash can take (a sha1 commit, a sha256 tree),
# so neither length is truncated on the way in.
SHA="0123456789abcdef0123456789abcdef01234567"
CONTENT="fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210"
IMAGES=""
PASS=0
FAIL=0

report() {
  if [ "$1" -eq 0 ]; then
    PASS=$((PASS + 1))
    printf 'ok   %s\n' "$2"
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL %s\n     %s\n' "$2" "${3:-}"
  fi
}

cleanup() {
  local image
  for image in $IMAGES; do
    docker rmi -f "$image" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT

expect_eq() {
  if [ "$2" = "$3" ]; then
    report 0 "$1"
  else
    report 1 "$1" "want [$3] got [$2]"
  fi
}

# pick <name>: from KEY=value lines on stdin, the value of <name>, or <absent>
# when no line sets it (an empty value prints nothing).
pick() {
  awk -v k="$1" '
    index($0, k "=") == 1 { printf "%s", substr($0, length(k) + 2); found = 1; exit }
    END { if (!found) printf "<absent>" }'
}

# label <image> <key>: the image's label value, or <absent>.
label() {
  local out
  out="$(docker image inspect -f '{{range $k, $v := .Config.Labels}}{{$k}}={{$v}}{{println}}{{end}}' "$1" 2>/dev/null)" \
    || { printf '<no image>'; return; }
  printf '%s\n' "$out" | pick "$2"
}

# env_of <image> <name>: the variable's value as a container of the image
# starts with, or <absent> when it is not set at all.
env_of() {
  local out
  out="$(docker run --rm --entrypoint env "$1" 2>/dev/null)" || { printf '<no container>'; return; }
  printf '%s\n' "$out" | pick "$2"
}

build() {
  local tag="$1" dir="$2"
  shift 2
  IMAGES="$IMAGES $tag"
  if ! docker build -q -t "$tag" "$@" "$dir" >/dev/null; then
    report 1 "build $tag" "docker build failed: docker build -t $tag $* $dir"
    return 1
  fi
}

for svc in $SERVICES; do
  dir="$REPO_ROOT/services/$svc"
  with="$PREFIX-$svc-args-$$"
  without="$PREFIX-$svc-noargs-$$"

  if build "$with" "$dir" --build-arg "NOVA_BUILD_SHA=$SHA" --build-arg "NOVA_CONTENT_HASH=$CONTENT"; then
    expect_eq "$svc: label nova.build-sha is the arg" "$(label "$with" nova.build-sha)" "$SHA"
    expect_eq "$svc: label nova.content-hash is the arg" "$(label "$with" nova.content-hash)" "$CONTENT"
    expect_eq "$svc: env NOVA_BUILD_SHA is the arg" "$(env_of "$with" NOVA_BUILD_SHA)" "$SHA"
    expect_eq "$svc: env NOVA_CONTENT_HASH is the arg" "$(env_of "$with" NOVA_CONTENT_HASH)" "$CONTENT"
  fi

  if build "$without" "$dir"; then
    expect_eq "$svc: no args -> label nova.build-sha present and empty" "$(label "$without" nova.build-sha)" ""
    expect_eq "$svc: no args -> label nova.content-hash present and empty" "$(label "$without" nova.content-hash)" ""
    expect_eq "$svc: no args -> env NOVA_BUILD_SHA present and empty" "$(env_of "$without" NOVA_BUILD_SHA)" ""
    expect_eq "$svc: no args -> env NOVA_CONTENT_HASH present and empty" "$(env_of "$without" NOVA_CONTENT_HASH)" ""
  fi
done

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
