#!/usr/bin/env bash
# Readers over compose's own output, and over the raw compose text.
# Sourced by deploy/backup.sh and driven against checked-in fixtures by
# deploy/backup_test.sh. Nothing here shells out to docker: every function
# takes text on stdin, so the whole file is testable with no daemon.
#
# bash 3.2 compatible (no associative arrays, no ${var,,}, no mapfile), POSIX
# awk only — same constraint as deploy/install.sh:7.
#
# TWO SOURCES, and neither is a style preference (design-verdict.md §3, §6.1;
# s41/measurements.md R2, measured on compose v5.3.0 and v5.5.1):
#
#   raw_*  read the RAW TEXT of every file in COMPOSE_FILE, because compose
#          PRUNES a volume no rendered service mounts — out of `config`, out
#          of `config --format json` and out of `config --volumes` alike. A
#          declared volume nothing mounts is the exact case coverage exists to
#          catch, and it is the one case no render can show.
#
#   cfg_*  read the YAML render, because `config --format json` keeps only a
#          TOP-LEVEL `x-` key and strips every NESTED one — a volume's, a
#          service's, a long-syntax mount's — and every disposition lives
#          nested. A JSON-fed reader sees no dispositions at all and reports
#          every volume undeclared.
#
# Both directions are pinned by deploy/backup_test.sh against the two renders
# of deploy/backup/fixtures/probe-compose.yml, so a later "just parse the
# JSON, it needs no awk" simplification cannot land quietly, and the day a
# newer compose starts keeping nested keys is a day the suite says so.

# ── shared awk helpers ──────────────────────────────────────────────────────
# Prepended to every awk program below rather than repeated: one definition of
# what a YAML scalar and a JSON string are.
#
# The renderer (gopkg.in/yaml.v3) emits a plain scalar when it can, wraps in
# SINGLE quotes when the value needs it (doubling any embedded quote), and
# reaches for double quotes only for control characters, which a reason line
# does not carry. All three forms are handled; the double-quoted form handles
# \" and \\ and nothing else, which is all the emitter produces here.
_CR_AWK_LIB='
function cr_trim(s) {
  sub(/^[ \t]+/, "", s); sub(/[ \t\r]+$/, "", s); return s
}
function cr_unquote(s,   inner) {
  s = cr_trim(s)
  if (length(s) >= 2 && substr(s, 1, 1) == "\047" && substr(s, length(s), 1) == "\047") {
    inner = substr(s, 2, length(s) - 2); gsub(/\047\047/, "\047", inner); return inner
  }
  if (length(s) >= 2 && substr(s, 1, 1) == "\"" && substr(s, length(s), 1) == "\"") {
    inner = substr(s, 2, length(s) - 2)
    gsub(/\\"/, "\"", inner); gsub(/\\\\/, "\\", inner); return inner
  }
  return s
}
# The value of a "key: value" line, with the key (and any indent) removed.
function cr_value(line, key,   v, p) {
  p = index(line, key ":")
  if (p == 0) return ""
  v = substr(line, p + length(key) + 1)
  return cr_unquote(v)
}
# The key of an "  indent key:" line, indent-independent.
function cr_key(line,   k) {
  k = cr_trim(line); sub(/:.*$/, "", k); return cr_unquote(k)
}
function cr_json(s) {
  gsub(/\\/, "\\\\", s); gsub(/"/, "\\\"", s); gsub(/\t/, "\\t", s); gsub(/\r/, "\\r", s)
  return s
}
'

# ── the raw compose text (stdin = every file in COMPOSE_FILE, concatenated) ──

# A top-level section tracker, shared by the three raw readers: a key at
# column 0 opens a section; only keys at exactly two spaces inside it count.
# A service's own `volumes:` sits at four spaces and its entries at six, so
# `- v4_pgdata:/var/lib/postgresql/data` is never read as a declaration.
_cr_raw_keys() {
  awk "$_CR_AWK_LIB"'
    /^[ \t]*#/ { next }
    /^[A-Za-z_][A-Za-z0-9_-]*:/ { sect = cr_key($0); next }
    sect != want { next }
    /^  [A-Za-z0-9._-]+:/ { print cr_key($0) }
  ' want="$1"
}

raw_volume_keys() { _cr_raw_keys volumes; }
raw_service_keys() { _cr_raw_keys services; }

# Every disposition the RAW text declares, one per line:
#
#   volume<TAB><TAB><key><TAB><disposition><TAB>yes|no
#   bind<TAB><service><TAB><target><TAB><disposition><TAB>yes|no
#   anon<TAB><service><TAB><target><TAB><disposition><TAB>yes|no
#
# (the last field is whether a reason row is present, not its text: a folded
# `>-` scalar's text lives on the lines below it and only the render joins it)
#
# THIS IS THE ONE READER THAT LOOKS AT THE FILE A HUMAN EDITS. Everything else
# reads the render, and a render is a capture: delete a row from
# deploy/docker-compose.yml and a suite that only reads captures stays green
# while the next real backup refuses. deploy/backup/tests/test_policy.py
# compares this against the render in BOTH directions, which is also what
# notices a fixture nobody refreshed.
raw_dispositions() {
  awk "$_CR_AWK_LIB"'
    function flush_vol() {
      if (vkey != "") printf "volume\t\t%s\t%s\t%s\n", vkey, vdisp, (vreason ? "yes" : "no")
      vkey = ""; vdisp = ""; vreason = 0
    }
    function flush_mount() {
      if (mtype == "bind") printf "bind\t%s\t%s\t%s\t%s\n", svc, mtgt, mdisp, (mreason ? "yes" : "no")
      mtype = ""; mtgt = ""; msrc = ""; mdisp = ""; mreason = 0
    }
    function flush_anon() {
      if (atgt != "") printf "anon\t%s\t%s\t%s\t%s\n", svc, atgt, adisp, (areason ? "yes" : "no")
      atgt = ""; adisp = ""; areason = 0
    }
    function flush_all() { flush_vol(); flush_mount(); flush_anon() }

    /^[ \t]*#/ { next }
    /^[A-Za-z_][A-Za-z0-9_-]*:/ { flush_all(); sect = cr_key($0); invols = 0; inanon = 0; next }

    sect == "volumes" && /^  [A-Za-z0-9._-]+:/ { flush_vol(); vkey = cr_key($0); next }
    sect == "volumes" && /^    x-nova-backup:/ { vdisp = cr_value($0, "x-nova-backup"); next }
    sect == "volumes" && /^    x-nova-backup-reason:/ { vreason = 1; next }

    sect != "services" { next }
    /^  [A-Za-z0-9._-]+:/ { flush_mount(); flush_anon(); svc = cr_key($0); invols = 0; inanon = 0; next }
    /^    [A-Za-z0-9._-]+:/ {
      flush_mount(); flush_anon()
      invols = ($0 ~ /^    volumes:/); inanon = ($0 ~ /^    x-nova-backup-anon:/); next
    }
    invols && /^      - / {
      flush_mount()
      item = cr_trim($0); sub(/^- /, "", item)
      if (item ~ /^type:/) { mtype = cr_value(item, "type"); next }
      # SHORT SYNTAX. `<source>:<target>[:mode]`. Compose reads the source as
      # a host path — a bind — when it starts with `.`, `/`, `~` or `$`, and
      # as a named volume otherwise; a named volume carries its disposition
      # under `volumes:` instead, so calling one a bind would refuse every
      # backup. Reported with an EMPTY disposition, because the short form
      # cannot carry one: that is the whole point of reporting it.
      item = cr_unquote(item)
      p = index(item, ":")
      if (p == 0) next
      msrc = substr(item, 1, p - 1)
      mtgt = substr(item, p + 1)
      sub(/:.*$/, "", mtgt)
      c = substr(msrc, 1, 1)
      if (c == "." || c == "/" || c == "~" || c == "$") mtype = "bind"
      next
    }
    invols && /^        type:/ { mtype = cr_value($0, "type"); next }
    invols && /^        target:/ { mtgt = cr_value($0, "target"); next }
    invols && /^        x-nova-backup:/ { mdisp = cr_value($0, "x-nova-backup"); next }
    invols && /^        x-nova-backup-reason:/ { mreason = 1; next }
    inanon && /^      [^ ]/ { flush_anon(); atgt = cr_key($0); next }
    inanon && /^        disposition:/ { adisp = cr_value($0, "disposition"); next }
    inanon && /^        reason:/ { areason = 1; next }

    END { flush_all() }
  '
}

# The project name as the checkout's own text declares it — the value coverage
# compares the render's `name:` against, so a render of some other project
# cannot be mistaken for this one.
raw_project_name() {
  awk "$_CR_AWK_LIB"'
    /^[ \t]*#/ { next }
    !done && /^name:/ { print cr_value($0, "name"); done = 1 }
  '
}

# ── the YAML render (stdin = docker compose ... --profile '*' config) ────────

cfg_project_name() {
  awk "$_CR_AWK_LIB"'!done && /^name:/ { print cr_value($0, "name"); done = 1 }'
}

cfg_service_keys() {
  awk "$_CR_AWK_LIB"'
    /^[A-Za-z_][A-Za-z0-9_-]*:/ { sect = cr_key($0); next }
    sect == "services" && /^  [A-Za-z0-9._-]+:/ { print cr_key($0) }
  '
}

cfg_volume_keys() {
  awk "$_CR_AWK_LIB"'
    /^[A-Za-z_][A-Za-z0-9_-]*:/ { sect = cr_key($0); next }
    sect == "volumes" && /^  [A-Za-z0-9._-]+:/ { print cr_key($0) }
  '
}

# The full name compose gives volume $1 — READ from the render, never
# assembled from <project>_<key>: `name:` under the key is what docker will
# actually be handed, and a compose file may override it.
cfg_volume_name() {
  awk "$_CR_AWK_LIB"'
    /^[A-Za-z_][A-Za-z0-9_-]*:/ { sect = cr_key($0); inkey = 0; next }
    sect != "volumes" { next }
    /^  [A-Za-z0-9._-]+:/ { inkey = (cr_key($0) == key); next }
    inkey && !done && /^    name:/ { print cr_value($0, "name"); done = 1 }
  ' key="$1"
}

# "<disposition>\t<reason>" for volume $1, or nothing when it carries none.
# Nothing is not a default: coverage turns it into R2_UNCLASSIFIED.
cfg_volume_disposition() {
  awk "$_CR_AWK_LIB"'
    /^[A-Za-z_][A-Za-z0-9_-]*:/ { sect = cr_key($0); inkey = 0; next }
    sect != "volumes" { next }
    /^  [A-Za-z0-9._-]+:/ { inkey = (cr_key($0) == key); next }
    inkey && /^    x-nova-backup:/ { d = cr_value($0, "x-nova-backup") }
    inkey && /^    x-nova-backup-reason:/ { r = cr_value($0, "x-nova-backup-reason") }
    END { if (d != "") printf "%s\t%s\n", d, r }
  ' key="$1"
}

# Every mount of service $1, one per line:
#   <type>\t<source>\t<target>\t<read_only>\t<disposition>\t<reason>
# The render normalises short and long syntax into the same block, so a
# `- v4_pgdata:/data` short mount and a long-syntax bind read identically —
# only the long form can carry a disposition, which is why binds are written
# long in deploy/docker-compose.yml.
cfg_mounts() {
  awk "$_CR_AWK_LIB"'
    function flush() {
      if (have) printf "%s\t%s\t%s\t%s\t%s\t%s\n", t, s, g, ro, d, r
      have = 0; t = ""; s = ""; g = ""; ro = "false"; d = ""; r = ""
    }
    /^[A-Za-z_][A-Za-z0-9_-]*:/ { flush(); sect = cr_key($0); insvc = 0; invol = 0; next }
    sect != "services" { next }
    /^  [A-Za-z0-9._-]+:/ { flush(); insvc = (cr_key($0) == svc); invol = 0; next }
    !insvc { next }
    /^    [A-Za-z0-9._-]+:/ { flush(); invol = ($0 ~ /^    volumes:/); next }
    !invol { next }
    /^      - / {
      flush(); have = 1; ro = "false"
      line = $0; sub(/^      - /, "", line)
      if (line ~ /^type:/) t = cr_value(line, "type")
      next
    }
    /^        type:/ { t = cr_value($0, "type"); next }
    /^        source:/ { s = cr_value($0, "source"); next }
    /^        target:/ { g = cr_value($0, "target"); next }
    /^        read_only:/ { ro = cr_value($0, "read_only"); next }
    /^        x-nova-backup:/ { d = cr_value($0, "x-nova-backup"); next }
    /^        x-nova-backup-reason:/ { r = cr_value($0, "x-nova-backup-reason"); next }
    END { flush() }
  ' svc="$1"
}

# "<disposition>\t<reason>" for the mount of service $1 at target $2.
cfg_bind_disposition() {
  cfg_mounts "$1" | awk -F'\t' -v tgt="$2" '$3 == tgt && $5 != "" { printf "%s\t%s\n", $5, $6 }'
}

# Every x-nova-backup-anon row of service $1, one per line:
#   <target>\t<disposition>\t<reason>
# This is the ONLY place a volume the IMAGE declares can carry a disposition:
# compose never names such a volume, so it has no entry under `volumes:` to
# hang one on (searxng's /var/cache/searxng is live proof).
cfg_anon() {
  awk "$_CR_AWK_LIB"'
    function flush() {
      if (tgt != "") printf "%s\t%s\t%s\n", tgt, d, r
      tgt = ""; d = ""; r = ""
    }
    /^[A-Za-z_][A-Za-z0-9_-]*:/ { flush(); sect = cr_key($0); insvc = 0; inanon = 0; next }
    sect != "services" { next }
    /^  [A-Za-z0-9._-]+:/ { flush(); insvc = (cr_key($0) == svc); inanon = 0; next }
    !insvc { next }
    /^    [A-Za-z0-9._-]+:/ { flush(); inanon = ($0 ~ /^    x-nova-backup-anon:/); next }
    !inanon { next }
    /^      [^ ]/ { flush(); tgt = cr_key($0); next }
    /^        disposition:/ { d = cr_value($0, "disposition"); next }
    /^        reason:/ { r = cr_value($0, "reason"); next }
    END { flush() }
  ' svc="$1"
}

# "<disposition>\t<reason>" for service $1's anon row at target $2.
cfg_anon_disposition() {
  cfg_anon "$1" | awk -F'\t' -v tgt="$2" '$1 == tgt { printf "%s\t%s\n", $2, $3 }'
}

# ── dispositions.json ───────────────────────────────────────────────────────
# What crosses into the pack container, so it needs no YAML parser (the core
# image carries `cryptography`; nothing guarantees PyYAML). Shape:
#
#   {"volumes": {"<key>":     {"disposition":…, "reason":…}},
#    "binds":   {"<service>": {"<target>": {"disposition":…, "reason":…,
#                                           "source":…, "read_only":…}}},
#    "anon":    {"<service>": {"<target>": {"disposition":…, "reason":…}}}}
#
# Only DECLARED rows appear. A mount with no row is not a default — coverage
# turns its absence into R2_UNCLASSIFIED naming it.
dispositions_json() {
  local text svc key line d r src tgt ro first_svc first_row
  text="$(cat)"

  printf '{\n  "volumes": {'
  first_row=1
  for key in $(printf '%s' "$text" | cfg_volume_keys); do
    line="$(printf '%s' "$text" | cfg_volume_disposition "$key")"
    [ -n "$line" ] || continue
    d="${line%%	*}"; r="${line#*	}"
    [ "$first_row" -eq 1 ] || printf ','
    first_row=0
    printf '\n    "%s": {"disposition": "%s", "reason": "%s"}' \
      "$(_cr_j "$key")" "$(_cr_j "$d")" "$(_cr_j "$r")"
  done
  [ "$first_row" -eq 1 ] || printf '\n  '
  printf '},\n  "binds": {'

  first_svc=1
  for svc in $(printf '%s' "$text" | cfg_service_keys); do
    first_row=1
    while IFS='	' read -r t src tgt ro d r; do
      [ "$t" = "bind" ] || continue
      [ -n "$d" ] || continue
      if [ "$first_row" -eq 1 ]; then
        [ "$first_svc" -eq 1 ] || printf ','
        printf '\n    "%s": {' "$(_cr_j "$svc")"
        first_svc=0
        first_row=0
      else
        printf ','
      fi
      printf '\n      "%s": {"disposition": "%s", "reason": "%s", "source": "%s", "read_only": %s}' \
        "$(_cr_j "$tgt")" "$(_cr_j "$d")" "$(_cr_j "$r")" "$(_cr_j "$src")" \
        "$([ "$ro" = "true" ] && printf 'true' || printf 'false')"
    done <<EOF
$(printf '%s' "$text" | cfg_mounts "$svc")
EOF
    [ "$first_row" -eq 1 ] || printf '\n    }'
  done
  [ "$first_svc" -eq 1 ] || printf '\n  '
  printf '},\n  "anon": {'

  first_svc=1
  for svc in $(printf '%s' "$text" | cfg_service_keys); do
    first_row=1
    while IFS='	' read -r tgt d r; do
      [ -n "$tgt" ] || continue
      [ -n "$d" ] || continue
      if [ "$first_row" -eq 1 ]; then
        [ "$first_svc" -eq 1 ] || printf ','
        printf '\n    "%s": {' "$(_cr_j "$svc")"
        first_svc=0
        first_row=0
      else
        printf ','
      fi
      printf '\n      "%s": {"disposition": "%s", "reason": "%s"}' \
        "$(_cr_j "$tgt")" "$(_cr_j "$d")" "$(_cr_j "$r")"
    done <<EOF
$(printf '%s' "$text" | cfg_anon "$svc")
EOF
    [ "$first_row" -eq 1 ] || printf '\n    }'
  done
  [ "$first_svc" -eq 1 ] || printf '\n  '
  printf '}\n}\n'
}

# JSON-escape one value. A reason is prose written by hand in the compose
# file, so quotes and backslashes are ordinary, not exotic.
_cr_j() {
  printf '%s' "$1" | awk "$_CR_AWK_LIB"'{ printf "%s%s", (NR > 1 ? "\\n" : ""), cr_json($0) }'
}
