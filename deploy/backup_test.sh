#!/usr/bin/env bash
# Tests for deploy/backup.sh and deploy/compose_read.sh.
#
# Same shape as deploy/install_test.sh: source the real scripts (both guard
# their entry points), stub ONLY the seams that touch the outside world
# (docker, git), hand-rolled PASS/FAIL counters, no framework.
#
# No docker, no network, no live stack, no writes outside a temp dir:
#     deploy/backup_test.sh
#
# `set -e` is deliberately OFF (install_test.sh:13 says why): a case that
# fails must not take the harness with it.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
FIXTURES="$SCRIPT_DIR/backup/fixtures"
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

# Exact string equality.
expect_str() {
  local name="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then
    report 0 "$name"
  else
    report 1 "$name" "got '$got', wanted '$want'"
  fi
}

# Substring present / absent.
expect_has() {
  local name="$1" got="$2" want="$3"
  case "$got" in
    *"$want"*) report 0 "$name" ;;
    *) report 1 "$name" "output did not contain '$want' — output: $(printf '%s' "$got" | tr '\n' ' ')" ;;
  esac
}

expect_lacks() {
  local name="$1" got="$2" want="$3"
  case "$got" in
    *"$want"*) report 1 "$name" "output contained '$want' — output: $(printf '%s' "$got" | tr '\n' ' ')" ;;
    *) report 0 "$name" ;;
  esac
}

# shellcheck source=/dev/null
. "$SCRIPT_DIR/compose_read.sh"

printf '\n── compose readers ──────────────────────────────────────────────────\n'

PROBE_YAML="$FIXTURES/probe-v5.3.0.yaml"
PROBE_JSON="$FIXTURES/probe-v5.3.0.json"
PROBE_SRC="$FIXTURES/probe-compose.yml"
PROBE_OVERLAY="$FIXTURES/probe-compose.overlay.yml"

for f in "$PROBE_YAML" "$PROBE_JSON" "$PROBE_SRC" "$PROBE_OVERLAY"; do
  [ -f "$f" ] || { printf 'FAIL missing fixture %s\n' "$f"; exit 1; }
done

# A volume's disposition and its reason, off the YAML render. The reason is a
# single-quoted scalar in the fixture ("the notes: they matter" has a colon),
# so this also pins the unquoting.
expect_str "reads_volume_disposition_from_the_yaml_render" \
  "$(cfg_volume_disposition vol_one < "$PROBE_YAML")" \
  "$(printf 'include\tthe notes: they matter')"

# A folded (`>-`) reason renders onto ONE line — measured, and the reason the
# readers can be line-based at all.
expect_str "reads_a_folded_reason_as_one_line" \
  "$(cfg_volume_disposition vol_two < "$PROBE_YAML")" \
  "$(printf 'exclude-ephemeral\ta cache declared only in the overlay.')"

# The full name is READ, never assembled from <project>_<key>.
expect_str "reads_the_full_volume_name_from_the_render" \
  "$(cfg_volume_name vol_one < "$PROBE_YAML")" "novaxprobe_vol_one"

# A long-syntax mount carries its own disposition, keyed by (service, target).
expect_str "reads_bind_disposition_from_a_long_syntax_mount" \
  "$(cfg_bind_disposition alpha /b < "$PROBE_YAML")" \
  "$(printf 'exclude-code\tfrom git')"

# The service extension for the volumes an IMAGE declares.
expect_str "reads_anon_disposition_from_a_service_extension" \
  "$(cfg_anon_disposition searxng-like /var/cache/thing < "$PROBE_YAML")" ""
expect_str "reads_anon_disposition_from_a_service_extension" \
  "$(cfg_anon_disposition alpha /var/cache/thing < "$PROBE_YAML")" \
  "$(printf 'exclude-ephemeral\ta cache; it regenerates on use.')"

# design-verdict.md §3, both halves, against the two renders of ONE source
# file. A top-level x- key survives the JSON render; a volume's, a service's
# and a long-syntax mount's do not. This is why the dispositions are read out
# of the YAML — and it is what notices the day compose starts keeping them.
expect_has "json_render_strips_nested_x_keys_so_the_reader_must_use_yaml" \
  "$(cat "$PROBE_JSON")" '"x-nova-top-level": "kept-or-not"'
expect_lacks "json_render_strips_nested_x_keys_so_the_reader_must_use_yaml" \
  "$(cat "$PROBE_JSON")" 'x-nova-backup:'
expect_lacks "json_render_strips_nested_x_keys_so_the_reader_must_use_yaml" \
  "$(cat "$PROBE_JSON")" 'x-nova-backup-anon'
expect_lacks "json_render_strips_nested_x_keys_so_the_reader_must_use_yaml" \
  "$(cat "$PROBE_JSON")" 'x-nova-backup-reason'
# ...and the YAML render keeps all four.
expect_has "yaml_render_keeps_every_nested_x_key" "$(cat "$PROBE_YAML")" 'x-nova-backup: include'
expect_has "yaml_render_keeps_every_nested_x_key" "$(cat "$PROBE_YAML")" 'x-nova-backup-anon:'
expect_has "yaml_render_keeps_every_nested_x_key" "$(cat "$PROBE_YAML")" 'x-nova-backup: exclude-code'

# shell-first C2: `vol_three` is declared and mounted by no service. Compose
# prunes it out of BOTH renders, so the declared set can only come from the
# raw text. The two halves are asserted together, because either one alone
# permits the wrong implementation.
RAW_VOLS="$(cat "$PROBE_SRC" "$PROBE_OVERLAY" | raw_volume_keys)"
expect_has "raw_volume_keys_sees_a_volume_the_render_prunes" "$RAW_VOLS" "vol_three"
expect_lacks "the_render_really_did_prune_it" "$(cat "$PROBE_YAML")" "vol_three"
expect_lacks "the_render_really_did_prune_it" "$(cat "$PROBE_JSON")" "vol_three"

# Every file in COMPOSE_FILE, not just the first: the GPU overlay makes this
# two files on any host with an NVIDIA runtime.
RAW_SVCS="$(cat "$PROBE_SRC" "$PROBE_OVERLAY" | raw_service_keys)"
expect_has "raw_service_keys_reads_every_file_in_COMPOSE_FILE" "$RAW_SVCS" "alpha"
expect_has "raw_service_keys_reads_every_file_in_COMPOSE_FILE" "$RAW_SVCS" "beta"
expect_str "raw_volume_keys_reads_every_file_in_COMPOSE_FILE" \
  "$(printf '%s' "$RAW_VOLS" | tr '\n' ' ')" "vol_one vol_three vol_two"

# A service's own `volumes:` block sits at four spaces and its entries at six;
# neither is a top-level declaration. A reader that keys on the word alone
# reports `- vol_one:/one` as a declared volume.
expect_lacks "raw_volume_keys_ignores_a_services_own_volumes_block" "$RAW_VOLS" "/one"
expect_lacks "raw_service_keys_ignores_indented_keys" "$RAW_SVCS" "image"

expect_str "reads_the_project_name_from_the_raw_text" \
  "$(cat "$PROBE_SRC" "$PROBE_OVERLAY" | raw_project_name)" "novaxprobe"
expect_str "reads_the_project_name_from_the_render" \
  "$(cfg_project_name < "$PROBE_YAML")" "novaxprobe"

expect_str "cfg_service_keys_lists_every_service_in_the_render" \
  "$(cfg_service_keys < "$PROBE_YAML" | tr '\n' ' ')" "alpha beta "

# dispositions.json is what crosses into the container, so the container needs
# no YAML parser. Shape is the contract; T3 renders it, novabundle.py reads it.
DISP="$(dispositions_json < "$PROBE_YAML")"
expect_has "dispositions_json_carries_volumes_keyed_by_compose_key" "$DISP" \
  '"vol_one": {"disposition": "include", "reason": "the notes: they matter"}'
expect_has "dispositions_json_carries_binds_keyed_by_service_and_target" "$DISP" \
  '"/b": {"disposition": "exclude-code", "reason": "from git"'
expect_has "dispositions_json_carries_anon_keyed_by_service_and_target" "$DISP" \
  '"/var/cache/thing": {"disposition": "exclude-ephemeral", "reason": "a cache; it regenerates on use."}'
expect_has "dispositions_json_is_parseable" \
  "$(printf '%s' "$DISP" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(sorted(d))')" \
  "['anon', 'binds', 'volumes']"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
