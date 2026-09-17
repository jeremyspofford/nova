#!/bin/sh
# The two facts that make the tailnet sidecar "up", read from tailscaled
# itself — never from a log line, a file we wrote, or an exit code:
#
#   1. `tailscale status --json` reports BackendState "Running" (logged in,
#      connected). NeedsLogin, Stopped, Starting — anything else — is not up.
#   2. `tailscale serve status --json` carries the mapping the wrapper is
#      supposed to have applied: HTTPS on 443 whose "/" handler proxies to
#      http://$NOVA_WEB_ADDR:80. "No serve config", a different target, the
#      target on another port next to a stale 443 — none of that is up.
#
# ONE implementation, two callers, so they can never disagree: start.sh
# sources this file and calls `serve_ok` after applying the mapping (and
# exits non-zero if it is not there), and the compose healthcheck runs this
# file directly. Exit 0 only when both facts hold; otherwise print WHY on
# stderr and exit 1. A third, derived fact is reported as a WARNING, never a
# gate: whether the node's name is in `CertDomains` (HTTPS certificates
# enabled for the tailnet).
#
# POSIX sh — the image is Alpine/busybox with grep, sed, awk and tr but no
# jq, so the JSON is read with grep -o on its keys and the serve config is
# compared with its whitespace stripped (the CLI pretty-prints it; the keys
# are the Go field names of ipn.ServeConfig, and Go sorts map keys, so the
# substring below is stable).
#
# `tailscale serve --bg ...` exits 0 even when it changed nothing (measured
# against v1.102.3: logged out, it prints "Logged out." and exits 0), which
# is exactly why an exit code is not one of the facts.

# The mapping's target, from the one env var that carries web's fixed address
# (deploy/docker-compose.yml passes it; blank is refused, not defaulted —
# the default lives in the compose file, and a check that guessed one could
# pass against a web nobody is serving).
serve_target() {
  if [ -z "${NOVA_WEB_ADDR:-}" ]; then
    echo "NOVA_WEB_ADDR is not set — nothing to verify against" >&2
    return 1
  fi
  printf 'http://%s:80' "$NOVA_WEB_ADDR"
}

# Prints the value of one string key from `status --json` output on stdin
# (first occurrence wins — Self's DNSName precedes the peers'). Empty if
# absent.
json_string() {
  grep -o "\"$1\": *\"[^\"]*\"" | head -n 1 | sed 's/^[^:]*: *"//; s/"$//'
}

backend_state() {
  tailscale status --json 2>/dev/null | json_string BackendState
}

auth_url() {
  tailscale status --json 2>/dev/null | json_string AuthURL
}

dns_name() {
  tailscale status --json 2>/dev/null | json_string DNSName | sed 's/\.$//'
}

# Why the backend is not Running, for the operator: its Health lines and the
# login URL if tailscaled is waiting for one. Reads status once. The Health
# array is printed with awk because it is `[]` on ONE line once containerboot
# has run `tailscale up` (a sed range `/\[/,/\]/` then runs to EOF and dumps
# the peer list — measured).
explain_not_running() {
  status="$(tailscale status --json 2>&1)"
  printf '%s\n' "$status" \
    | awk '/"Health": \[/{f=1; if (/\]/) f=0; next} f && /\]/{f=0} f' \
    | sed 's/^ *//; s/^/  health: /' >&2
  url="$(printf '%s\n' "$status" | json_string AuthURL)"
  if [ -n "$url" ]; then
    echo "  login URL: $url" >&2
  fi
}

# Fact 2. Exit 0 iff the serve config has HTTPS on 443 AND the 443 web
# handler for "/" proxies to the target — the two are bound together by the
# `<host>:443` key, so a stale 443 next to the target on another port fails.
serve_mapping_present() {
  target="$(serve_target)" || return 1
  cfg="$(tailscale serve status --json 2>/dev/null | tr -d ' \n\t\r')"
  case "$cfg" in
    *'"443":{"HTTPS":true'*) ;;
    *) return 1 ;;
  esac
  case "$cfg" in
    *":443\":{\"Handlers\":{\"/\":{\"Proxy\":\"$target\""*) return 0 ;;
  esac
  return 1
}

# The derived third fact, as a warning only: a tailnet without HTTPS
# certificates enabled never lists the node in CertDomains, and serve on
# :443 cannot issue a certificate for it.
warn_if_no_cert_domain() {
  name="$1"
  certs="$(tailscale status --json 2>/dev/null | tr -d ' \n\t\r' | grep -o '"CertDomains":\[[^]]*\]')"
  case "$certs" in
    *"\"$name\""*) ;;
    *)
      echo "warning: CertDomains in tailscale status does not list $name — HTTPS certificates may not be enabled for this tailnet (admin console: DNS -> HTTPS Certificates)" >&2
      ;;
  esac
}

# Both facts. Prints one honest line on success; the reasons on failure.
serve_ok() {
  state="$(backend_state)"
  if [ "$state" != "Running" ]; then
    echo "tailscaled is not Running (BackendState: ${state:-unknown})" >&2
    explain_not_running
    return 1
  fi
  if ! serve_mapping_present; then
    target="$(serve_target)" || return 1
    echo "serve mapping HTTPS 443 -> $target is NOT present; tailscale serve status says:" >&2
    tailscale serve status 2>&1 | sed 's/^/  /' >&2
    return 1
  fi
  name="$(dns_name)"
  warn_if_no_cert_domain "$name"
  echo "serving https://$name/ -> $(serve_target)"
}

case "$0" in
  *serve_check.sh) serve_ok ;;
esac
