#!/usr/bin/env bash
# Nova v4 — which /16 the project network gets, and the four addresses derived
# from it. Sourced by deploy/install.sh; defines functions only, runs nothing.
#
# bash 3.2 compatible (no associative arrays, no ${var,,}, no mapfile, no
# process substitution, no `sed -i`, no GNU-only date/stat/readlink) — the same
# contract as deploy/install.sh:7, and here it is load-bearing: `ip` does not
# exist on macOS, so the BSD leg below is the one that runs there.
#
# WHY THIS EXISTS. docker-compose.yml pinned 172.18.0.0/16 as a literal, and
# the fixed addresses in its upper half ARE web's trust boundary — nginx
# accepts a Tailscale identity header from the sidecar's address and from
# nothing else (apps/web/nginx.conf.template, docker-compose.yml's `networks:`
# comment). A second machine that already uses 172.18 cannot bring the stack
# up at all, and adopting addressing someone else chose is not a neutral
# convenience. So the subnet is DERIVED from what is actually allocated on
# this host, read at run time, and never from a table someone maintains.
#
# THE TWO RULES EVERY FUNCTION HERE FOLLOWS:
#   - a `docker`/`ip`/`netstat` call that FAILS is a refusal, never an empty
#     set. "Nothing is in use" and "I could not find out" are different
#     answers and only one of them may be acted on.
#   - the network to adopt is chosen by its com.docker.compose.project.config_files
#     LABEL, never by its name (python-tool M5). §10.1's cleanup removes
#     foreign containers and volumes but not networks, so a dead project's
#     `nova_default` outlives it and would otherwise be adopted, IPAM and all.
#
# Depends on deploy/install.sh for: log, die, canonical_path,
# config_files_are_ours, get_env_value, set_env_value, ENV_FILE, COMPOSE_FILE.
# Those resolve at call time, so the source order does not matter.

# The five keys decide_subnet owns. docker-compose.yml reads all five with
# `${VAR:-<today's literal>}` defaults, so an install that never ran this is
# unchanged.
NOVA_SUBNET_KEYS="NOVA_SUBNET NOVA_SUBNET_RANGE NOVA_SUBNET_GATEWAY NOVA_WEB_ADDR NOVA_TAILSCALE_ADDR"

# ---- CIDR arithmetic, pure bash 3.2 (no bc, no python, no awk) -------------

# Dotted quad -> 32-bit integer on stdout. 1 when it is not one.
# 10#$x throughout: an octet written 08 or 010 is decimal here, not octal,
# which is how $(( )) would otherwise read it.
ip_to_int() {
  local ip="$1" a b c d x OLDIFS="$IFS"
  case "$ip" in
    ""|*[!0-9.]*) return 1 ;;
  esac
  IFS='.'
  # shellcheck disable=SC2086
  set -- $ip
  IFS="$OLDIFS"
  [ "$#" -eq 4 ] || return 1
  a="$1"; b="$2"; c="$3"; d="$4"
  for x in "$a" "$b" "$c" "$d"; do
    [ -n "$x" ] || return 1
    [ "$((10#$x))" -le 255 ] || return 1
  done
  printf '%s' "$(( (10#$a << 24) + (10#$b << 16) + (10#$c << 8) + 10#$d ))"
}

int_to_ip() {
  local n="$1"
  printf '%d.%d.%d.%d' \
    "$(( (n >> 24) & 255 ))" "$(( (n >> 16) & 255 ))" \
    "$(( (n >> 8) & 255 ))" "$(( n & 255 ))"
}

cidr_addr() { printf '%s' "${1%%/*}"; }

cidr_prefix() {
  case "$1" in
    */*) printf '%s' "${1##*/}" ;;
    *) return 1 ;;
  esac
}

# Prefix length -> 32-bit mask. Shifting by 32 is deliberate and correct:
# bash arithmetic is 64-bit, so 0xFFFFFFFF << 32 masks back down to 0.
prefix_mask() {
  local p="$1"
  case "$p" in
    ""|*[!0-9]*) return 1 ;;
  esac
  [ "$p" -le 32 ] || return 1
  printf '%s' "$(( (0xFFFFFFFF << (32 - p)) & 0xFFFFFFFF ))"
}

# "a.b.c.d/p" -> the NETWORK address of that block, same prefix. 1 when the
# input is not a CIDR at all.
cidr_network() {
  local cidr="$1" a p i m
  a="$(cidr_addr "$cidr")"
  p="$(cidr_prefix "$cidr")" || return 1
  m="$(prefix_mask "$p")" || return 1
  i="$(ip_to_int "$a")" || return 1
  printf '%s/%s' "$(int_to_ip "$(( i & m ))")" "$p"
}

# Do two blocks overlap? (a & m) == (b & m) for m = mask(min(pa, pb)).
#   0 overlap   1 disjoint   2 one of them could not be read
# 2 is its own answer on purpose: a caller that treats "unparseable" as
# "disjoint" hands out a subnet that is already in use.
subnet_overlaps() {
  local a="$1" b="$2" ia ib pa pb p m
  ia="$(ip_to_int "$(cidr_addr "$a")")" || return 2
  ib="$(ip_to_int "$(cidr_addr "$b")")" || return 2
  pa="$(cidr_prefix "$a")" || pa=32
  pb="$(cidr_prefix "$b")" || pb=32
  p="$pa"
  if [ "$pb" -lt "$p" ]; then p="$pb"; fi
  m="$(prefix_mask "$p")" || return 2
  [ "$(( ia & m ))" -eq "$(( ib & m ))" ]
}

# ---- the host's routes (#22) ----------------------------------------------
#
# THE SEAMS. Separated so the parsers below can be driven against captured
# output with no `ip` and no `netstat` on the machine running the tests.
have_cmd() { command -v "$1" >/dev/null 2>&1; }
ip_route_text() { ip -4 route 2>/dev/null; }
netstat_route_text() { netstat -rn -f inet 2>/dev/null; }

# stdin: `ip -4 route`. stdout: one destination per line.
# `default` is a known non-destination and is dropped by name, not silently:
# anything this does not recognise reaches expand_route_dest, which PRINTS
# what it could not turn into a CIDR.
parse_ip_routes() {
  awk '
    NF == 0 { next }
    $1 == "default" { next }
    $1 == "broadcast" || $1 == "local" || $1 == "multicast" ||
    $1 == "unreachable" || $1 == "blackhole" || $1 == "prohibit" { print $2; next }
    { print $1 }
  '
}

# stdin: `netstat -rn -f inet`. stdout: one destination per line.
# The four things GNU never emits and BSD does: a "Routing tables" banner, an
# "Internet:" section header, a "Destination Gateway Flags ..." column header,
# and `link#N` where a gateway would be.
parse_bsd_routes() {
  awk '
    NF == 0 { next }
    /^Routing tables/ { next }
    /^Internet/ { next }
    $1 == "Destination" { next }
    $1 == "default" { next }
    $1 ~ /^link#/ { next }
    { print $1 }
  '
}

# One route destination -> a CIDR on stdout. 1 when it cannot become one.
#
# port-v3 m3 is the whole reason this is not `octets * 8`: a macOS host
# carrying 172.16.0.0/12 prints the destination as `172.16`, an octet-count
# expansion calls that a /16, and 172.18 then reads as free when the /12
# covers it. A short form with no length becomes the CONTAINING RFC1918
# block — wider, so the answer errs toward avoiding a subnet rather than
# toward taking one. An explicit /n is always honoured.
expand_route_dest() {
  local dest="$1" addr prefix n padded block
  case "$dest" in
    */*) addr="${dest%%/*}"; prefix="${dest##*/}" ;;
    *) addr="$dest"; prefix="" ;;
  esac
  case "$addr" in
    ""|*[!0-9.]*) return 1 ;;
  esac
  n="$(printf '%s' "$addr" | awk -F. '{ print NF }')"
  padded="$addr"
  while [ "$n" -lt 4 ]; do
    padded="$padded.0"
    n=$((n + 1))
  done
  if [ -n "$prefix" ]; then
    cidr_network "$padded/$prefix" || return 1
    return 0
  fi
  if [ "$(printf '%s' "$addr" | awk -F. '{ print NF }')" -eq 4 ]; then
    cidr_network "$padded/32" || return 1
    return 0
  fi
  for block in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16; do
    if subnet_overlaps "$padded/32" "$block"; then
      printf '%s' "$block"
      return 0
    fi
  done
  return 1
}

# Every route this host holds, as "<cidr> <where it came from>" lines.
#   2 — neither `ip` nor `netstat` is here, or the one that is failed.
#       decide_subnet then refuses to pick rather than picking blind.
host_routes_in_use() {
  local text dests dest cidr src
  if have_cmd ip; then
    src="ip -4 route"
    text="$(ip_route_text)" || {
      log "subnet: \`ip -4 route\` failed, so this host's routes could not be read"
      return 2
    }
    dests="$(printf '%s\n' "$text" | parse_ip_routes)"
  elif have_cmd netstat; then
    src="netstat -rn -f inet"
    text="$(netstat_route_text)" || {
      log "subnet: \`netstat -rn -f inet\` failed, so this host's routes could not be read"
      return 2
    }
    dests="$(printf '%s\n' "$text" | parse_bsd_routes)"
  else
    log "subnet: neither \`ip\` nor \`netstat\` is on PATH, so this host's routes"
    log "        cannot be read. Refusing to pick a subnet blind — install"
    log "        iproute2, or set NOVA_SUBNET in $ENV_FILE yourself."
    return 2
  fi
  for dest in $dests; do
    if cidr="$(expand_route_dest "$dest")"; then
      printf '%s route %s (%s)\n' "$cidr" "$dest" "$src"
    else
      log "subnet: route destination '$dest' could not be turned into a CIDR —"
      log "        it is NOT being taken into account when picking a subnet"
    fi
  done
}

# ---- docker's networks -----------------------------------------------------
#
# THE SEAMS.
docker_network_ids() { docker network ls -q 2>/dev/null; }
docker_network_row() {
  docker network inspect --format \
    '{{.Name}}{{"\t"}}{{index .Labels "com.docker.compose.project.config_files"}}{{"\t"}}{{range .IPAM.Config}}{{.Subnet}} {{end}}' \
    "$1" 2>/dev/null
}

# "<name>\t<config_files label>\t<subnet> <subnet> …" per network.
#   2 — docker could not be asked. Not an empty list: see the header.
network_rows() {
  local ids id row
  ids="$(docker_network_ids)" || return 2
  for id in $ids; do
    row="$(docker_network_row "$id")" || return 2
    printf '%s\n' "$row"
  done
}

# The subnet of THIS checkout's project network, or nothing. The name is
# necessary and not sufficient: the config-files label has to be ours too.
#   2 — docker could not be asked.
project_network_subnet() {
  local project="$1" rows row name labels subs s
  [ -n "$project" ] || return 2
  rows="$(network_rows)" || return 2
  while IFS= read -r row; do
    [ -n "$row" ] || continue
    name="$(printf '%s' "$row" | cut -f1)"
    [ "$name" = "${project}_default" ] || continue
    labels="$(printf '%s' "$row" | cut -f2)"
    if ! config_files_are_ours "$labels"; then
      log "subnet: a network named ${project}_default exists but was created from"
      log "        [${labels:-no compose config-files label}], not from this checkout."
      log "        Its addressing is someone else's; treating it as in use."
      continue
    fi
    subs="$(printf '%s' "$row" | cut -f3-)"
    for s in $subs; do
      printf '%s' "$s"
      return 0
    done
    log "subnet: ${project}_default is this checkout's but reports no IPAM subnet"
  done <<EOF
$rows
EOF
  return 0
}

# Every subnet docker has allocated, as "<cidr> network <name>" lines, minus
# this checkout's own project network (which the caller adopts instead).
#   2 — docker could not be asked.
docker_subnets_in_use() {
  local project="$1" rows row name labels subs s
  rows="$(network_rows)" || return 2
  while IFS= read -r row; do
    [ -n "$row" ] || continue
    name="$(printf '%s' "$row" | cut -f1)"
    labels="$(printf '%s' "$row" | cut -f2)"
    subs="$(printf '%s' "$row" | cut -f3-)"
    if [ -n "$project" ] && [ "$name" = "${project}_default" ] && config_files_are_ours "$labels"; then
      continue
    fi
    for s in $subs; do
      [ -n "$s" ] || continue
      printf '%s network %s\n' "$s" "$name"
    done
  done <<EOF
$rows
EOF
}

# ---- choosing ---------------------------------------------------------------

# Does $1 collide with anything in the "<cidr> <source>" list $2? Prints the
# colliding line and exits 0 when it does.
subnet_overlaps_any() {
  local cand="$1" list="$2" line c rc
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    c="${line%% *}"
    subnet_overlaps "$cand" "$c" && rc=0 || rc=$?
    case "$rc" in
      0) printf '%s' "$line"; return 0 ;;
      2) log "subnet: ignoring an in-use entry I cannot read: $line" ;;
    esac
  done <<EOF
$list
EOF
  return 1
}

_subnet_candidate_free() {
  local cand="$1" list="$2" hit
  if hit="$(subnet_overlaps_any "$cand" "$list")"; then
    log "subnet: $cand is taken by $hit"
    return 1
  fi
  return 0
}

# The first /16 in r1's order that collides with nothing in the list $1.
# 1 when both bands are exhausted.
pick_project_subnet() {
  local list="$1" cand o
  o=18
  while [ "$o" -le 31 ]; do
    cand="172.$o.0.0/16"
    if _subnet_candidate_free "$cand" "$list"; then
      printf '%s' "$cand"
      return 0
    fi
    o=$((o + 1))
  done
  o=200
  while [ "$o" -le 254 ]; do
    cand="10.$o.0.0/16"
    if _subnet_candidate_free "$cand" "$list"; then
      printf '%s' "$cand"
      return 0
    fi
    o=$((o + 1))
  done
  return 1
}

# The four keys derived from a /16 (#23), as KEY=VALUE lines.
#
# The dynamic range is the LOWER half, so the two fixed addresses at .128.x
# sit where docker's allocator never reaches. That is the invariant nginx's
# trust boundary rests on, so a subnet this cannot be derived from is a
# refusal rather than a best effort: addresses outside their own network make
# `up` fail later, in a place that does not say why.
derive_subnet_addrs() {
  local cidr="$1" p norm a b
  p="$(cidr_prefix "$cidr")" || return 1
  [ "$p" = "16" ] || return 1
  norm="$(cidr_network "$cidr")" || return 1
  a="${norm%%.*}"
  b="${norm#*.}"; b="${b%%.*}"
  printf 'NOVA_SUBNET_RANGE=%s.%s.0.0/17\n' "$a" "$b"
  printf 'NOVA_SUBNET_GATEWAY=%s.%s.0.1\n' "$a" "$b"
  printf 'NOVA_WEB_ADDR=%s.%s.128.10\n' "$a" "$b"
  printf 'NOVA_TAILSCALE_ADDR=%s.%s.128.20\n' "$a" "$b"
}

# Write all five keys and READ EVERY ONE BACK. A write that does not read back
# is a failure here, not a warning: compose falls back to the 172.18 literals
# when a key is missing, and a fixed address outside the adopted network fails
# at `up` with a message about nothing in particular.
# 1 — $1 is not a /16, so nothing was written.
write_subnet_env() {
  local cidr="$1" why="$2" addrs line k v got
  addrs="$(derive_subnet_addrs "$cidr")" || return 1
  set_env_value NOVA_SUBNET "$cidr"
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    set_env_value "${line%%=*}" "${line#*=}"
  done <<EOF
$addrs
EOF
  # Read back all FIVE, driven from NOVA_SUBNET_KEYS rather than from what
  # was just written: a key that derive_subnet_addrs stopped emitting would
  # otherwise be verified by not being looked at.
  for k in $NOVA_SUBNET_KEYS; do
    if [ "$k" = NOVA_SUBNET ]; then
      v="$cidr"
    else
      v="$(printf '%s\n' "$addrs" | awk -F= -v k="$k" \
        '$1 == k { print substr($0, index($0, "=") + 1); found = 1 } END { exit !found }')" \
        || die "subnet: no $k was derived from $cidr, so nothing verified it"
    fi
    got="$(get_env_value "$k")"
    [ "$got" = "$v" ] || die "subnet: wrote $k=$v to $ENV_FILE but read back '$got'"
  done
  log "subnet: $cidr — $why"
  log "        NOVA_SUBNET=$cidr"
  printf '%s\n' "$addrs" | sed 's/^/        /' >&2
  log "        (changing these needs \`docker compose down && up\`: IPAM is not"
  log "         applied in place to a network that already exists)"
}

# ---- the decision (#12, #22, #23) -----------------------------------------
#
# Three branches, all of which write and read back:
#   1. this checkout's project network already exists -> adopt its subnet.
#      Changing IPAM in place is not a thing compose does, so adopting is the
#      only non-destructive answer — but it must still WRITE, or .env carries
#      no NOVA_WEB_ADDR, compose falls back to 172.18.128.10, and that address
#      is outside the adopted network.
#   2. NOVA_SUBNET is pinned -> check it against both sources and die naming
#      the collision. A subnet the operator pinned is never silently moved.
#   3. neither -> pick, logging every candidate rejected and why.
decide_subnet() {
  local project adopted inuse routes pinned pin_src norm chosen collision
  project="$(compose_project_name)" || project=""
  [ -n "$project" ] || die "subnet: compose reported no project name, so this checkout's own network cannot be told from anyone else's"

  adopted="$(project_network_subnet "$project")" || die "subnet: docker could not be asked which networks exist (\`docker network ls\` / \`docker network inspect\` failed). Refusing to pick a subnet blind."
  if [ -n "$adopted" ]; then
    write_subnet_env "$adopted" "adopted from the existing ${project}_default network" && return 0
    die "subnet: the existing ${project}_default network is $adopted, which is not a /16, so NOVA_SUBNET_RANGE, NOVA_SUBNET_GATEWAY, NOVA_WEB_ADDR and NOVA_TAILSCALE_ADDR cannot be derived from it. Either recreate that network (\`docker compose down && docker compose up -d\`) or set NOVA_SUBNET yourself in $ENV_FILE."
  fi

  inuse="$(docker_subnets_in_use "$project")" || die "subnet: docker could not be asked which subnets are allocated (\`docker network ls\` / \`docker network inspect\` failed). Refusing to pick a subnet blind."
  routes="$(host_routes_in_use)" || die "subnet: this host's routes could not be read (see above). Refusing to pick a subnet blind."
  inuse="$(printf '%s\n%s\n' "$inuse" "$routes" | awk 'NF')"

  pinned="${NOVA_SUBNET:-}"
  pin_src="the NOVA_SUBNET environment variable"
  if [ -z "$pinned" ]; then
    pinned="$(get_env_value NOVA_SUBNET)"
    pin_src="NOVA_SUBNET in $ENV_FILE"
  fi
  if [ -n "$pinned" ]; then
    norm="$(cidr_network "$pinned")" || die "subnet: $pin_src is '$pinned', which is not a CIDR (expected something like 172.22.0.0/16)"
    if collision="$(subnet_overlaps_any "$norm" "$inuse")"; then
      die "subnet: $pin_src pins $pinned, which collides with $collision. Nothing was changed. Pin another NOVA_SUBNET, or free that one."
    fi
    write_subnet_env "$norm" "pinned by $pin_src" && return 0
    die "subnet: $pin_src pins $pinned, which is not a /16. NOVA_WEB_ADDR and NOVA_TAILSCALE_ADDR live in the upper half of a /16 by construction, so a shorter or longer block cannot be used here."
  fi

  chosen="$(pick_project_subnet "$inuse")" || die "subnet: every candidate (172.18–172.31, then 10.200–10.254) is already in use on this machine. In use: $(printf '%s' "$inuse" | tr '\n' ';')"
  write_subnet_env "$chosen" "picked: the first candidate free of every docker network and host route on this machine" && return 0
  die "subnet: $chosen could not be turned into the four derived addresses"
}
