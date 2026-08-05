"""Lane A rails: the checks that stand between a web page and this machine.

Every one of these guards a hole that was live on 2026-07-24 and verified by
hand against the running stack:

  * a page on any site could read GET /api/v1/auth/token, because CORS was
    allow_origins=["*"] and a browser tab looks "local" to _is_local
  * the same page could POST an mcp_servers row with transport=stdio and an
    arbitrary command, which mcp-runner execs
  * fetch_url's deny-list missed 100.64.0.0/10 — the whole tailnet
  * manage_agents could disable guardian, or hand any agent any tool

and one that was still live on 2026-08-05, after all of the above shipped:

  * DNS rebinding walked straight through them. Point a domain you own at
    127.0.0.1 and your page's fetches are local by IP AND same-origin by
    Sec-Fetch-Site, so both surviving rails say yes. Verified by hand:
    `curl -H 'Host: evil.test:8000' -H 'Sec-Fetch-Site: same-origin'
    http://127.0.0.1:8000/api/v1/auth/token` returned 200 and the admin token.

These are the parts that are pure functions of their input; the DB-backed
half (update_agent's is_system refusal) is exercised live, since faking an
asyncpg pool would test the fake.

    docker compose exec backend python tests/test_security_rails.py
"""

import sys

sys.path.insert(0, "/app/backend")

from app import mcp_servers                                 # noqa: E402
from app.tools import builtin, web_fetch                    # noqa: E402

FAILURES: list[str] = []


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


class FakeClient:
    def __init__(self, host):
        self.host = host


class FakeUrl:
    def __init__(self, path):
        self.path = path


class FakeRequest:
    """Only what the middleware reads: headers, the socket peer, the path."""

    def __init__(self, peer=None, path="/api/v1/auth/token", **headers):
        self.headers = {k.replace("_", "-"): v for k, v in headers.items()}
        self.client = FakeClient(peer) if peer else None
        self.url = FakeUrl(path)


# ── 0. who counts as this machine ────────────────────────────────────────

def test_is_local():
    print("_is_local (the sidecar gate)")
    import app.main as m
    from app.main import _is_local as loc

    gw = m._GATEWAY_IP
    # pin the proxy set so the test does not depend on what is running
    m._proxy_cache = (float("inf"), frozenset({"172.18.0.12"}))
    try:
        check("the host, via a published port, is local", loc(FakeRequest(peer=gw)))
        check("loopback is local", loc(FakeRequest(peer="127.0.0.1")))
        check("a sidecar is NOT local", not loc(FakeRequest(peer="172.18.0.99")))
        check("a sidecar forging X-Real-IP is NOT local",
              not loc(FakeRequest(peer="172.18.0.99", x_real_ip="127.0.0.1")))
        check("nginx relaying the host IS local",
              loc(FakeRequest(peer="172.18.0.12", x_real_ip=gw)))
        check("nginx relaying the phone over the tailnet is NOT local",
              not loc(FakeRequest(peer="172.18.0.12", x_real_ip="100.73.238.101")))
        check("nginx with no X-Real-IP at all is NOT local",
              not loc(FakeRequest(peer="172.18.0.12")))
        check("a request with no peer at all is NOT local",
              not loc(FakeRequest()))
    finally:
        m._proxy_cache = None


# ── 1. browser cross-site detection ──────────────────────────────────────

def test_cross_site():
    print("cross-site detection (the drive-by gate)")
    from app.main import _browser_cross_site as x

    check("a hostile page is cross-site",
          x(FakeRequest(sec_fetch_site="cross-site")))
    check("a sibling site is cross-site too",
          x(FakeRequest(sec_fetch_site="same-site")))
    check("Nova's own page is not",
          not x(FakeRequest(sec_fetch_site="same-origin")))
    check("typing the URL in the address bar is not",
          not x(FakeRequest(sec_fetch_site="none")))
    check("curl on this host keeps the tokenless path",
          not x(FakeRequest()))
    check("no Sec-Fetch-Site: a foreign Origin still trips it",
          x(FakeRequest(origin="https://evil.example.com")))
    check("no Sec-Fetch-Site: our own dev origin does not",
          not x(FakeRequest(origin="http://127.0.0.1:5173")))
    check("Sec-Fetch-Site wins over a spoofed-looking Origin",
          x(FakeRequest(sec_fetch_site="cross-site",
                        origin="http://127.0.0.1:5173")))


# ── 1b. Host allow-list (the DNS-rebinding gate) ─────────────────────────

def test_host_allowlist():
    print("Host allow-list (the rebinding gate)")
    import app.main as m
    from app import settings_store

    # a real value, not the shipped default of "", so the derivation is
    # actually exercised rather than skipped
    saved = settings_store._cache.get("ui.public_url")
    settings_store._cache["ui.public_url"] = "https://nova.example.ts.net"
    m._proxy_cache = (float("inf"), frozenset({"172.18.0.12"}))
    try:
        bare = m._bare_host
        check("a port is stripped", bare("127.0.0.1:8000") == "127.0.0.1")
        check("an origin reduces to its hostname",
              bare("https://nova.example.ts.net") == "nova.example.ts.net")
        check("IPv6 brackets are stripped", bare("[::1]:8000") == "::1")
        check("case cannot smuggle a host past the set",
              bare("EVIL.Test:8000") == "evil.test")
        check("empty stays empty", bare("") == "")
        check("a malformed host does not crash the middleware",
              bare("[::1") == "")

        hosts = m._nova_hosts()
        check("loopback names are ours",
              {"127.0.0.1", "localhost", "::1"} <= hosts, str(sorted(hosts)))
        check("the compose alias vite rewrites Host to is ours",
              "backend" in hosts)
        check("ui.public_url's host is DERIVED, not listed",
              "nova.example.ts.net" in hosts, str(sorted(hosts)))
        check("a foreign name is not ours", "evil.test" not in hosts)
        check("no empty string leaked in to match a missing Host",
              "" not in hosts)

        nova = m._host_is_nova
        check("the rebinding Host loses localhost trust",
              not nova(FakeRequest(host="evil.test:8000")))
        check("a subdomain of ours is still not ours",
              not nova(FakeRequest(host="nova.example.ts.net.evil.test")))
        check("the real loopback Host keeps it",
              nova(FakeRequest(host="127.0.0.1:8000")))
        check("the vite proxy's rewritten Host keeps it",
              nova(FakeRequest(host="backend:8000")))
        check("the operator's public URL keeps it",
              nova(FakeRequest(host="nova.example.ts.net")))
        check("a request with no Host at all is not Nova",
              not nova(FakeRequest()))

        ref = m._host_refused
        gw = m._GATEWAY_IP
        check("a foreign Host straight to :8000 is refused outright",
              ref(FakeRequest(peer=gw, host="evil.test:8000")))
        check("...including with the same-origin header rebinding gets free",
              ref(FakeRequest(peer=gw, host="evil.test:8000",
                              sec_fetch_site="same-origin")))
        check("our own Host straight to :8000 is not",
              not ref(FakeRequest(peer=gw, host="127.0.0.1:8000")))
        check("a name behind the proxy is left to the 401, never 400ed "
              "(that path is the phone)",
              not ref(FakeRequest(peer="172.18.0.12",
                                  host="nova.tunnel.example")))
        check("/health is exempt, so liveness never depends on a setting",
              not ref(FakeRequest(peer=gw, host="evil.test", path="/health")))
        check("a request with no Host at all is refused on the direct path",
              ref(FakeRequest(peer=gw)))

        # The 400 only beats the 401 because host_allowlist_middleware is the
        # OUTERMOST layer, which it is only because it is DECLARED LAST
        # (Starlette inserts each added middleware at index 0). That is an
        # ordering a later edit can silently invert by adding a middleware
        # below it, and nothing else in the file would complain — so the
        # property gets asserted rather than commented. Verified live
        # 2026-08-05: a foreign Host carrying a VALID Bearer token still gets
        # 400, which is only possible if the host gate ran first.
        outer = m.app.user_middleware[0]
        check("the host gate is the outermost middleware, ahead of auth",
              outer.kwargs.get("dispatch").__name__ == "host_allowlist_middleware",
              str([mw.kwargs.get("dispatch").__name__
                   for mw in m.app.user_middleware]))
    finally:
        m._proxy_cache = None
        if saved is None:
            settings_store._cache.pop("ui.public_url", None)
        else:
            settings_store._cache["ui.public_url"] = saved


# ── 2. SSRF allow-list ───────────────────────────────────────────────────

def test_ssrf():
    print("SSRF address allow-list")
    pub = web_fetch.is_public_address

    check("CGNAT/tailscale 100.64/10 is refused", not pub("100.64.0.1"))
    check("this tailnet's own node is refused", not pub("100.101.120.14"))
    check("loopback is refused", not pub("127.0.0.1"))
    check("the compose network is refused", not pub("172.18.0.3"))
    check("LAN is refused", not pub("192.168.1.5"))
    check("cloud metadata is refused", not pub("169.254.169.254"))
    check("unspecified is refused", not pub("0.0.0.0"))
    check("multicast is refused", not pub("224.0.0.1"))
    check("IPv6 loopback is refused", not pub("::1"))
    check("IPv6 ULA is refused", not pub("fd00::1"))
    check("IPv4-mapped loopback is unwrapped, then refused",
          not pub("::ffff:127.0.0.1"))
    check("NAT64-wrapped loopback is unwrapped, then refused",
          not pub("64:ff9b::7f00:1"))
    check("a real public v4 still passes", pub("8.8.8.8"))
    check("a real public v6 still passes", pub("2606:4700::1111"))
    check("NAT64-wrapped public still passes", pub("64:ff9b::0808:0808"))


# ── 3. stdio MCP launcher allow-list ─────────────────────────────────────

def test_stdio_commands():
    print("stdio MCP launcher allow-list (the exec endpoint)")

    def refused(cmd):
        try:
            mcp_servers._check_stdio_command(cmd)
            return False
        except ValueError:
            return True

    check("/bin/sh is refused", refused("/bin/sh"))
    check("bare sh is refused", refused("sh"))
    check("bash is refused", refused("bash"))
    check("an absolute path to an allowed name is refused",
          refused("/usr/bin/npx"))
    check("a relative path is refused", refused("../../bin/sh"))
    check("empty is refused", refused(""))
    check("npx is allowed", not refused("npx"))
    check("uvx is allowed", not refused("uvx"))
    check("surrounding whitespace does not smuggle a path",
          refused("  /bin/sh  "))


# ── 4. capability confinement on tool grants ─────────────────────────────

async def test_grant_confinement():
    print("agent tool grants cannot exceed the granting agent's own")
    ctx = {"agent_name": "agent-manager",
           "granted": {"list_agents", "manage_agents", "search_memory"}}

    esc = await builtin._escalating_grants(
        ["search_memory", "delete_memory_item", "fetch_url"], ctx)
    check("tools the caller lacks are flagged",
          esc == ["delete_memory_item", "fetch_url"], str(esc))

    esc = await builtin._escalating_grants(["search_memory", "list_agents"], ctx)
    check("tools the caller holds pass through", esc == [], str(esc))

    esc = await builtin._escalating_grants(["anything"], {"agent_name": "x"})
    check("no ctx['granted'] (operator/eval path) confines nothing",
          esc == [], str(esc))

    esc = await builtin._escalating_grants("not-a-list", ctx)
    check("a malformed allowed_tools does not crash the tool", esc == [])

    msg = builtin._grant_refusal("helper", ["delete_memory_item"])
    check("the refusal names the tool and points at Settings",
          "delete_memory_item" in msg and "Settings" in msg)


async def main():
    test_is_local()
    print()
    test_cross_site()
    print()
    test_host_allowlist()
    print()
    test_ssrf()
    print()
    test_stdio_commands()
    print()
    await test_grant_confinement()
    print()
    if FAILURES:
        print(f"FAILED ({len(FAILURES)}): " + "; ".join(FAILURES))
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    import asyncio
    sys.exit(asyncio.run(main()))
