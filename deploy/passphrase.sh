#!/usr/bin/env bash
# Where the backup passphrase comes from — the resolver seam (verdict §8).
#
# Sourced by deploy/install.sh and deploy/backup.sh; entry-guarded nowhere
# because it defines functions and runs nothing.
#
# bash 3.2: no associative arrays, no ${var,,}, no mapfile, no process
# substitution. See docs/plans/rebuild/s41/map-portability.md.
#
# THE INTERFACE, and it is the point of the file:
#
#   Every resolver is a function named  nova_pass_<name>.
#     stdin  : nothing
#     stdout : the passphrase, exactly, no newline appended
#     stderr : a reason, on failure only
#     exit 0 : resolved
#     exit 3 : genuinely ABSENT — the caller MAY create one
#     exit * : UNAVAILABLE — the caller REFUSES and never creates one
#
# The 3-vs-other split is v3's hardest-won lesson
# (backend/app/backup_passphrase.py:55-73): a store that EXISTS and cannot be
# read must never read as "absent", or the next backup generates a
# replacement over the passphrase that still seals every existing bundle, and
# backups keep reporting green with nothing restorable behind them.
#
# The passphrase itself never reaches argv, an environment variable this
# script sets, or a log. The only thing logged anywhere is the 12-hex
# fingerprint, which identifies WHICH passphrase without carrying it.

NP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"

# The four sources this build has. `resolvers_are_exactly_the_documented_set`
# in deploy/backup_test.sh asserts these are the same four the `case` in
# resolve_passphrase dispatches over AND the same four deploy/.env.example
# documents — so adding a source without offering it, or offering one that
# does not exist, is a red suite rather than a silent divergence.
NOVA_PASSPHRASE_SOURCES="file env prompt cmd"

# Overridable so the suite never reads the operator's own .env or writes his
# own passphrase file.
np_env_file() { printf '%s\n' "${NP_ENV_FILE:-$NP_DIR/.env}"; }

np_fail() {
  printf 'Error: %s\n' "$1" >&2
  return "${2:-1}"
}

# One KEY=VALUE out of deploy/.env, without sourcing it: a .env is data, and
# sourcing data executes it.
np_env_value() {
  local key="$1" file line
  file="$(np_env_file)"
  [ -f "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      "$key"=*) printf '%s\n' "${line#*=}" ;;
    esac
  done < "$file" | tail -1
}

# The mode of a file, GNU or BSD. Both forms, because neither is portable
# alone (deploy/install_test.sh:266,317 already carries this pair).
np_mode_of() {
  stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null
}

np_passphrase_file() {
  local configured
  configured="$(np_env_value NOVA_PASSPHRASE_FILE)"
  if [ -n "$configured" ]; then
    printf '%s\n' "$configured"
  else
    printf '%s\n' "$NP_DIR/.backup-passphrase"
  fi
}

# ── the four resolvers ──────────────────────────────────────────────────────

# A file, mode-checked 0600. Absent is exit 3 — the ONE case that permits a
# create. A file that exists and cannot be read at the mode it should have is
# exit 1, not exit 3: see the header.
nova_pass_file() {
  local path mode value
  path="$(np_passphrase_file)"
  if [ ! -e "$path" ]; then
    printf 'no passphrase file at %s\n' "$path" >&2
    return 3
  fi
  if [ ! -f "$path" ]; then
    np_fail "$path exists and is not a regular file, so it is not a passphrase store"
    return 1
  fi
  mode="$(np_mode_of "$path")"
  if [ -z "$mode" ]; then
    np_fail "neither \`stat -c\` nor \`stat -f\` could read the mode of $path — refusing
  rather than assuming it is 0600"
    return 1
  fi
  if [ "$mode" != "600" ]; then
    np_fail "$path is mode $mode, not 600. The passphrase opens every bundle this
  machine has ever written; it is not read from a file other users can read."
    return 1
  fi
  if [ ! -r "$path" ]; then
    np_fail "$path exists and cannot be read. A store that exists and cannot be read is
  NOT absent — generating a replacement would orphan every existing bundle."
    return 1
  fi
  value="$(cat "$path")"
  if [ -z "$value" ]; then
    np_fail "$path exists and is empty. An empty passphrase is not a passphrase, and an
  empty store is not an absent one."
    return 1
  fi
  printf '%s' "$value"
  return 0
}

# An environment variable. Unset or empty is genuinely absent.
nova_pass_env() {
  if [ -z "${NOVA_BACKUP_PASSPHRASE:-}" ]; then
    printf 'NOVA_BACKUP_PASSPHRASE is unset or empty\n' >&2
    return 3
  fi
  printf '%s' "$NOVA_BACKUP_PASSPHRASE"
  return 0
}

# A terminal. Never exit 3: a prompt cannot report that no passphrase exists,
# only that it could not ask. Without a TTY that is a stated CANNOT.
nova_pass_prompt() {
  local first second
  if [ ! -t 0 ] || [ ! -t 1 ]; then
    np_fail "cannot prompt without a terminal"
    return 1
  fi
  printf 'Backup passphrase: ' >&2
  IFS= read -r -s first
  printf '\n' >&2
  if [ -z "$first" ]; then
    np_fail "an empty passphrase is not a passphrase"
    return 1
  fi
  if [ "${NOVA_PASSPHRASE_CONFIRM:-0}" = "1" ]; then
    printf 'Again: ' >&2
    IFS= read -r -s second
    printf '\n' >&2
    if [ "$first" != "$second" ]; then
      # A transcription check, mechanical. Not a sentence asking the operator
      # to be careful.
      np_fail "the two entries do not match"
      return 1
    fi
  fi
  printf '%s' "$first"
  return 0
}

# Any command — which is how a secrets manager plugs in today with zero code:
#   NOVA_PASSPHRASE_SOURCE=cmd
#   NOVA_PASSPHRASE_CMD='op read op://nova/backup/passphrase'
# A non-zero exit is UNAVAILABLE, never absent: `op` being logged out must
# not generate a second passphrase over the one that seals every bundle.
nova_pass_cmd() {
  local command value status
  command="$(np_env_value NOVA_PASSPHRASE_CMD)"
  if [ -z "$command" ]; then
    np_fail "NOVA_PASSPHRASE_SOURCE is 'cmd' and NOVA_PASSPHRASE_CMD is not set in
  $(np_env_file)"
    return 1
  fi
  value="$(eval "$command" 2>/dev/null)"
  status=$?
  if [ "$status" -ne 0 ]; then
    np_fail "the passphrase command exited $status. That is UNAVAILABLE, not absent — no
  bundle is written, and no replacement passphrase is generated."
    return 1
  fi
  if [ -z "$value" ]; then
    np_fail "the passphrase command succeeded and printed nothing"
    return 1
  fi
  printf '%s' "$value"
  return 0
}

# ── the seam ────────────────────────────────────────────────────────────────

nova_passphrase_source() {
  local configured
  configured="$(np_env_value NOVA_PASSPHRASE_SOURCE)"
  [ -n "$configured" ] || configured="file"
  printf '%s\n' "$configured"
}

# stdout: the passphrase. Exit 0 resolved, 3 absent, anything else refuses.
resolve_passphrase() {
  local source
  source="$(nova_passphrase_source)"
  case "$source" in
    file) nova_pass_file ;;
    env) nova_pass_env ;;
    prompt) nova_pass_prompt ;;
    cmd) nova_pass_cmd ;;
    *)
      np_fail "NOVA_PASSPHRASE_SOURCE is '$source', which this build does not provide.
  Available: $NOVA_PASSPHRASE_SOURCES"
      return 1
      ;;
  esac
}

# Creation happens ONLY on exit 3 and ONLY for `file`. Two concurrent backups
# cannot each generate one: the create is guarded by a mkdir lock (atomic on
# every filesystem) and the loser re-reads inside the lock and becomes a
# reader, never a second writer.
#
# The generator is passed in as a command, because this file holds no crypto:
# `novabundle.py genpass` runs in the pack container, where the 160 bits come
# from secrets.token_bytes and not from `openssl rand` through a command
# substitution that would drop NUL bytes (§7.2).
#
#   create_passphrase <runner...>      # the runner prints a passphrase
create_passphrase() {
  local generator="$*" path lock value mode
  path="$(np_passphrase_file)"
  lock="$path.lock"
  if [ "$(nova_passphrase_source)" != "file" ]; then
    np_fail "only the 'file' source creates a passphrase; this one is
  '$(nova_passphrase_source)', and a source that cannot create must not be
  silently replaced by one that can"
    return 1
  fi
  if ! mkdir "$lock" 2>/dev/null; then
    np_fail "another run is creating the passphrase (lock held at $lock)"
    return 1
  fi
  # Inside the lock: re-read first. The loser of the outer race becomes a
  # READER here rather than a second writer.
  if value="$(nova_pass_file 2>/dev/null)"; then
    rmdir "$lock"
    printf '%s' "$value"
    return 0
  fi
  value="$("$@" 2>/dev/null)" || value=""
  if [ -z "$value" ]; then
    rmdir "$lock"
    np_fail "'$generator' produced no passphrase, so none was written"
    return 1
  fi
  (
    umask 077
    printf '%s' "$value" > "$path"
  ) || { rmdir "$lock"; np_fail "could not write $path"; return 1; }
  chmod 600 "$path" 2>/dev/null
  mode="$(np_mode_of "$path")"
  if [ "$mode" != "600" ]; then
    rm -f "$path"
    rmdir "$lock"
    np_fail "$path came back mode ${mode:-unreadable}, not 600. This filesystem cannot
  protect the passphrase, so the file was deleted and no bundle is written."
    return 1
  fi
  rmdir "$lock"
  printf 'A new backup passphrase was generated and written to %s\n' "$path" >&2
  printf 'THIS IS THE ONLY COPY. Nothing else can open the bundles it seals.\n' >&2
  printf 'Write it down somewhere that is not this machine:\n\n    %s\n\n' "$value" >&2
  printf '%s' "$value"
  return 0
}

# stdin: the passphrase. stdout: 12 hex.
#
#   passphrase_fingerprint <32-hex salt> <runner...>
#
# The CLEARTEXT fingerprint is derived from the scrypt KEY under one file's
# own salt (§7.4), never from the passphrase: sha256(passphrase)[:12] in
# cleartext lets an attacker holding the bundle test candidates at one
# unsalted hash each and pay scrypt once for the confirmed hit, annulling the
# whole work factor. The derivation runs in the container, because this file
# holds no crypto — the runner is whatever the caller uses to reach
# novabundle.py, and the passphrase reaches it on the stdin this function
# passes straight through.
passphrase_fingerprint() {
  local salt="$1"
  shift
  if [ -z "$salt" ] || [ "${#salt}" -ne 32 ]; then
    np_fail "a fingerprint salt is 16 bytes of hex; got '${salt}'"
    return 1
  fi
  if [ $# -eq 0 ]; then
    np_fail "passphrase_fingerprint needs the command that reaches novabundle.py"
    return 1
  fi
  "$@" fingerprint --salt "$salt"
}
