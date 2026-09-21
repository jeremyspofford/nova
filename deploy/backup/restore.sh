#!/bin/sh
# Open a Nova backup bundle on a machine that has only python3, or only
# docker, and prove the decryptor before it reads a byte of the payload.
#
#     tar -xOf <bundle> restore.sh | sh -s -- <bundle> [outdir]
#     ./restore.sh <bundle> --verify-only
#
# POSIX sh on purpose: this runs on a machine that has nothing, and bash is
# not a given. No `local`, no arrays, no [[ ]], no process substitution.
#
# It probes four decryptor backends IN ORDER and accepts one only after it
# passes a KNOWN-ANSWER TEST: decrypt kat.enc — 64 known bytes under the real
# passphrase, with their own fresh salt — and compare the sha256 to the
# cleartext kat.sha256. That is what makes this a check rather than a hope: a
# wrong passphrase or a broken libcrypto fails at candidate-selection time,
# before any payload byte is read, instead of half-decrypting.
#
#   1. host python3 with `import cryptography`
#   2. host python3 with a usable libcrypto through ctypes
#   3. docker run <meta.crypto_image>          (the image this hub already has)
#   4. docker run <meta.fallback_image>        (python:3.12-slim, pulled)
#
# If no candidate passes it prints exactly what to install and the docker
# pull lines, and exits non-zero. It NEVER falls back to "try anyway".
#
# This file travels inside every bundle BYTE-IDENTICAL to its copy in the
# Nova repository at deploy/backup/restore.sh.

set -u

BUNDLE=""
OUT=""
PASSFILE=""
VERIFY_ONLY=0

# nova_restore.py's exit codes, which is how this script tells "this machine
# cannot decrypt" (try the next backend) from "this passphrase or this file
# is wrong" (stop, and say so).
EX_OK=0
EX_BAD=1        # the KAT failed: wrong passphrase, or a corrupt bundle
EX_ARGS=2       # no such file, or a non-empty output directory
EX_NOBACKEND=4  # no usable AES-256-GCM here

die() {
  printf 'Error: %s\n' "$1" >&2
  exit "${2:-1}"
}

usage() {
  cat >&2 <<'USAGE'
usage: restore.sh <bundle.tar> [outdir] [--verify-only] [--passphrase-file FILE]

  <bundle.tar>             the nova-backup-*.tar to open
  outdir                   where to put the decrypted content
                           (default: ./nova-restored-<stamp>)
  --verify-only            check every member against the sealed manifest and
                           write nothing
  --passphrase-file FILE   else $NOVA_BACKUP_PASSPHRASE, else a prompt
USAGE
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --verify-only) VERIFY_ONLY=1 ;;
    --passphrase-file)
      [ $# -ge 2 ] || usage
      PASSFILE="$2"
      shift
      ;;
    -h|--help) usage ;;
    -*) die "unknown option $1 (see --help)" 2 ;;
    *)
      if [ -z "$BUNDLE" ]; then
        BUNDLE="$1"
      elif [ -z "$OUT" ]; then
        OUT="$1"
      else
        die "too many arguments (see --help)" 2
      fi
      ;;
  esac
  shift
done

[ -n "$BUNDLE" ] || usage
[ -f "$BUNDLE" ] || die "no such file: $BUNDLE" 2

# Absolute, without readlink -f (which stock macOS does not have).
BUNDLE_DIR=$(cd "$(dirname "$BUNDLE")" && pwd) || die "cannot reach $(dirname "$BUNDLE")" 2
BUNDLE_BASE=$(basename "$BUNDLE")
BUNDLE_ABS="$BUNDLE_DIR/$BUNDLE_BASE"

WORK=$(mktemp -d "${TMPDIR:-/tmp}/nova-restore.XXXXXX") || die "could not make a work directory"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT INT TERM
chmod 700 "$WORK"

# The cleartext members, and only those: members 1-6 of §5.1 are under 60 KB
# together and sit before the payload, so this reads none of the big member.
tar -xf "$BUNDLE_ABS" -C "$WORK" \
  README.txt nova_restore.py restore.sh kat.sha256 kat.enc meta.json \
  || die "$BUNDLE_BASE does not carry the cleartext members a Nova bundle has
  (README.txt, nova_restore.py, restore.sh, kat.sha256, kat.enc, meta.json)"

META="$WORK/meta.json"
[ -f "$META" ] || die "$BUNDLE_BASE has no meta.json"

# One flat string field out of meta.json, without a JSON parser. meta.json is
# written by novabundle.py with json.dumps(indent=2), so every scalar is on
# its own line — and nothing here DECIDES anything: meta.json only chooses
# which images to try, and a wrong choice fails the KAT and refuses.
meta_str() {
  sed -n 's/^[[:space:]]*"'"$1"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*$/\1/p' "$META" | head -1
}

# The string items of one flat JSON array, space separated.
meta_list() {
  sed -n '/^[[:space:]]*"'"$1"'"[[:space:]]*:[[:space:]]*\[/,/\]/p' "$META" \
    | sed -n 's/^[[:space:]]*"\([^"]*\)".*$/\1/p' \
    | tr '\n' ' '
}

CRYPTO_IMAGE=$(meta_str crypto_image)
FALLBACK_IMAGE=$(meta_str fallback_image)
NEEDS_IMAGES=$(meta_list needs_images)
[ -n "$FALLBACK_IMAGE" ] || FALLBACK_IMAGE="python:3.12-slim"

# ── the passphrase: read once, never in argv, never in an environment the
#    container can be inspected for ──────────────────────────────────────────
if [ -n "$PASSFILE" ]; then
  [ -f "$PASSFILE" ] || die "no such passphrase file: $PASSFILE" 2
  PASS=$(cat "$PASSFILE")
  # nova_restore.py reads the FIRST LINE of stdin, so a multi-line file would
  # be silently cut rather than refused.
  if [ "$(printf '%s' "$PASS" | wc -l | tr -d ' ')" != "0" ]; then
    die "$PASSFILE holds more than one line. The passphrase is one line; a file like
  this would be silently cut at the first newline." 2
  fi
elif [ -n "${NOVA_BACKUP_PASSPHRASE:-}" ]; then
  PASS="$NOVA_BACKUP_PASSPHRASE"
elif [ -t 0 ]; then
  printf 'Backup passphrase: ' >&2
  stty -echo 2>/dev/null
  IFS= read -r PASS
  stty echo 2>/dev/null
  printf '\n' >&2
else
  die "no passphrase: set NOVA_BACKUP_PASSPHRASE or pass --passphrase-file
  (this script cannot prompt without a terminal)" 2
fi
[ -n "$PASS" ] || die "an empty passphrase is not a passphrase" 2

have() { command -v "$1" >/dev/null 2>&1; }

# python3 >= 3.9, which is what nova_restore.py needs.
python_ok() {
  have python3 || return 1
  python3 -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)' 2>/dev/null
}

# Every backend is run through ONE function, so the KAT probe and the real
# run cannot diverge into two different command lines.
#   $1 = backend id (1..4), rest = nova_restore.py arguments
run_backend() {
  _b="$1"
  shift
  case "$_b" in
    1)
      printf '%s\n' "$PASS" | python3 "$WORK/nova_restore.py" "$@"
      ;;
    2)
      printf '%s\n' "$PASS" \
        | NOVA_FORCE_CTYPES_GCM=1 python3 "$WORK/nova_restore.py" "$@"
      ;;
    3|4)
      if [ "$_b" = 3 ]; then _img="$CRYPTO_IMAGE"; else _img="$FALLBACK_IMAGE"; fi
      # The passphrase goes on STDIN. Never `-e`, which docker inspect would
      # show for the container's lifetime, and never an argument.
      if [ -n "${OUT_ABS:-}" ]; then
        printf '%s\n' "$PASS" | docker run --rm -i --network none \
          -v "$WORK":/w -v "$BUNDLE_DIR":/b:ro -v "$OUT_ABS":/out \
          "$_img" python3 /w/nova_restore.py "$@"
      else
        printf '%s\n' "$PASS" | docker run --rm -i --network none \
          -v "$WORK":/w -v "$BUNDLE_DIR":/b:ro \
          "$_img" python3 /w/nova_restore.py "$@"
      fi
      ;;
  esac
}

backend_available() {
  case "$1" in
    1) python_ok && python3 -c 'import cryptography' 2>/dev/null ;;
    2) python_ok ;;
    3) have docker && [ -n "$CRYPTO_IMAGE" ] \
         && docker image inspect "$CRYPTO_IMAGE" >/dev/null 2>&1 ;;
    4) have docker ;;
  esac
}

backend_name() {
  case "$1" in
    1) printf 'host python3 with the cryptography package' ;;
    2) printf 'host python3 with system libcrypto through ctypes' ;;
    3) printf 'docker run %s' "$CRYPTO_IMAGE" ;;
    4) printf 'docker run %s' "$FALLBACK_IMAGE" ;;
  esac
}

# The bundle path as the chosen backend sees it.
backend_bundle() {
  case "$1" in
    1|2) printf '%s' "$BUNDLE_ABS" ;;
    3|4) printf '/b/%s' "$BUNDLE_BASE" ;;
  esac
}

# ── the probe ───────────────────────────────────────────────────────────────
CHOSEN=""
for B in 1 2 3 4; do
  backend_available "$B" || continue
  if [ "$B" = 4 ] && ! docker image inspect "$FALLBACK_IMAGE" >/dev/null 2>&1; then
    printf 'pulling %s ...\n' "$FALLBACK_IMAGE" >&2
    docker pull "$FALLBACK_IMAGE" >&2 || continue
  fi
  printf 'probing: %s\n' "$(backend_name "$B")" >&2
  run_backend "$B" --kat "$(backend_bundle "$B")"
  rc=$?
  case "$rc" in
    "$EX_OK")
      CHOSEN="$B"
      break
      ;;
    "$EX_BAD")
      # This backend WORKED and the known-answer test still failed, so the
      # passphrase or the file is wrong and every other backend will fail
      # identically. Stop here — before any payload byte is read.
      die "the known-answer test failed with a working decryptor, so this is the
  passphrase or the bundle, not this machine. Nothing was read from the payload."
      ;;
    "$EX_ARGS")
      die "$BUNDLE_BASE could not be opened (see the message above)" 2
      ;;
    "$EX_NOBACKEND")
      printf '  no decryptor in that backend; trying the next\n' >&2
      ;;
    *)
      printf '  that backend exited %s; trying the next\n' "$rc" >&2
      ;;
  esac
done

if [ -z "$CHOSEN" ]; then
  cat >&2 <<ADVICE
Error: no way to decrypt this bundle on this machine.

  This bundle is AES-256-GCM with an scrypt-derived key. Opening it needs one
  of a python3 that can do AES-256-GCM, or docker.

  Install ONE of these and re-run the same command:

    python3 -m pip install cryptography       (any OS, needs python3)
    apt-get install -y python3 openssl        (Debian/Ubuntu)
    dnf install -y python3 openssl-libs       (Fedora/RHEL)
    brew install python@3.12 openssl@3        (macOS)

  Or, with docker and a registry it can reach:

ADVICE
  for image in $NEEDS_IMAGES $FALLBACK_IMAGE; do
    printf '    docker pull %s\n' "$image" >&2
  done
  cat >&2 <<'ADVICE2'

  If a real OpenSSL is installed somewhere this script did not look, point at
  it directly:  NOVA_LIBCRYPTO=/path/to/libcrypto.so restore.sh <bundle>

  This script does not try anyway. A half-decrypted bundle that looks finished
  is worse than one that refused.
ADVICE2
  exit 1
fi

printf 'decryptor: %s — known-answer test passed\n' "$(backend_name "$CHOSEN")" >&2

# ── the run ─────────────────────────────────────────────────────────────────
if [ "$VERIFY_ONLY" = 1 ]; then
  run_backend "$CHOSEN" --verify-only "$(backend_bundle "$CHOSEN")"
  exit $?
fi

[ -n "$OUT" ] || OUT="nova-restored-$(date -u +%Y%m%d%H%M%S)"
mkdir -p "$OUT" || die "could not create $OUT"
OUT_ABS=$(cd "$OUT" && pwd) || die "could not reach $OUT"

case "$CHOSEN" in
  3|4) run_backend "$CHOSEN" "$(backend_bundle "$CHOSEN")" --out /out ;;
  *) run_backend "$CHOSEN" "$(backend_bundle "$CHOSEN")" --out "$OUT_ABS" ;;
esac
