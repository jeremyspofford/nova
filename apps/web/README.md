# apps/web — the one origin

The static build plus nginx, and the only thing a browser (or a paired
`novad`) ever talks to: `/` is the PWA, `/api/` is relayed to core. Gateway
and memory are not reachable from here at all. `nginx.conf.template` is the
whole configuration and carries the reasoning inline; this file is the
operator's map of it.

nginx listens on `:80` inside the container. The host reaches it at
`127.0.0.1:3000`; other containers at `http://web:80`; the tailnet sidecar
(S5b) at web's fixed address, `NOVA_WEB_ADDR` (default `172.18.128.10`).

## The pre-auth gate

`NOVA_PUBLIC_GATE_TOKEN` blank (the default) means no gate: every path
behaves as if none of this existed. Set it (`openssl rand -hex 32`) only when
this origin is on a public URL — a cloudflared quick tunnel, or a tailscale
funnel — and every request then needs a matching `nova_gate` cookie, minted
once per browser by visiting `/gate?token=<value>`, or gets a neutral 401
page. Two carve-outs, from every source: `/healthz` (a static "ok" for the
compose healthcheck) and `/api/v1/devices/ws` (a paired daemon's socket,
which authenticates itself by ed25519 challenge and sends no cookie).

## Who is exempt: trust by source address

Tailnet peers do not need the token, and the mechanism is a fact about the
network rather than anything a client can claim:

- `tailscale serve` (the sidecar) injects `Tailscale-User-Login` (and
  `-Name`, `-Profile-Pic`) for a tailnet peer, **strips** any copy the
  client sent, and never sets them on funnel (public) traffic. So the
  header is a fact — but only when the request really came from serve, and
  a header cannot prove that on its own (a tunnel forwards whatever the
  client sent; so would any container that can reach this port).
- What can prove it is where the connection came from. On a docker bridge a
  TCP connection cannot be completed with a spoofed source address, and the
  sidecar sits at a **fixed** address, `NOVA_TAILSCALE_ADDR` (default
  `172.18.128.20`) — `deploy/docker-compose.yml` pins the project network's
  IPAM and keeps the fixed addresses in a range the allocator never hands
  out. `$remote_addr` equal to that address means "this came through serve",
  and nothing else does: traffic from the published host port arrives from
  docker's gateway (`172.18.0.1`); traffic from any other container arrives
  from that container's own address.
- nginx therefore treats *from the sidecar address AND a non-empty
  `Tailscale-User-Login`* as a tailnet peer (`$from_sidecar`, `$tailnet_peer`
  in the template) and does not apply the gate. The header from any other
  address is never consulted.
- `NOVA_TAILSCALE_ADDR` unset or blank means **nobody is trusted**: the map
  key renders as the empty string, which no source address ever equals (the
  Dockerfile bakes an empty default so a bare `docker run` cannot leave a
  placeholder in the conf).

Consequences:

- **Enrolling a device from the tailnet works through a gated origin**:
  `/api/v1/devices/enroll` from the sidecar with the identity header is
  ungated. Enrolling through the tunnel or funnel does not (pair via the
  tailnet or localhost); connecting an already-paired device works from
  everywhere.
- **Funnel visitors are gated** with no extra rule: they arrive *from the
  sidecar address* but *without* the header.
- **Tagged tailnet nodes are gated.** A node with a tag (a server, not a
  person) carries no identity headers, so its traffic looks like a funnel
  visitor's: token cookie required.
- The three `Tailscale-User-*` headers reach core only when the request came
  from the sidecar; from anywhere else they are dropped before the proxy, so
  the only copies core can ever see are serve's. Nothing in core reads them
  yet (S8 will).

## The forwarded scheme and Secure cookies

nginx terminates no TLS, so its `$scheme` is always `http`. The template
forwards `X-Forwarded-Proto` as the TLS-terminating hop sent it (`https`
from serve or cloudflared, matched case-insensitively) and falls back to
`$scheme` otherwise (`$fwd_proto`). Two cookies derive `Secure` from it:
core's session cookie (`identity.set_session_cookie` reads that one header)
and nginx's own `/gate` cookie. That is the only reason a login over the
tailnet URL yields a Secure cookie while a login on `http://127.0.0.1:3000`
yields one the browser will actually keep. A client can only influence its
own request's header (the proxies overwrite it for real visitors, browsers
never send it), and the worst a liar can do is give itself a Secure cookie
its own browser drops.

## Reply formatting

Her replies render as GitHub-flavoured markdown (`src/components/Markdown.tsx`:
`react-markdown` + `remark-gfm` + `remark-breaks`, pinned exact). Headings,
lists, tables, fenced code, blockquotes and links all render; a single
newline is a line break, as in a GitHub comment. What never happens: raw
HTML in a reply is shown as escaped text (no `rehype-raw`, no
`dangerouslySetInnerHTML`); a link whose scheme is not `https?`/`ircs?`/
`mailto`/`xmpp` (`javascript:`, `data:`, `file:`, …) renders as plain text
rather than an empty, still-clickable `<a>`; a markdown image becomes a link
rather than an `<img>` the browser would fetch on draw (and inside a link it
is just the link's text — never `<a>` in `<a>`); links open in a new tab with
`rel="noopener noreferrer"` except same-document `#` links (footnotes), which
stay put. Tables and code blocks scroll inside their own box, never the
page. The parse runs behind `useDeferredValue`, so a burst of stream deltas
coalesces into one re-parse instead of one per delta. The owner's own bubbles
are plain pre-wrap text — what he typed is not markdown. No syntax
highlighter: `rehype-highlight` was measured at +54 KB gzip on top of the
+49 KB the renderer itself costs (it imports all of lowlight's `common`
grammars, unshakeably), so code blocks are plain monospace.

## Tests

`gate_test.sh` builds the real image and runs the whole matrix against
throwaway containers — gate on, gate off, gate on with no trusted address,
and gate on with an upstream stub aliased `core` on a private network with a
declared subnet, where client containers are placed **at** the trusted
address and at another one so the source-address claim is made for real.
No stack needs to be running; it runs in CI (`web` job). Set
`GATE_TEST_PREFIX` to keep its container names apart from a live stack's.

## Deploy notes

- Declaring the project network's IPAM (same subnet the live network already
  has, so nothing moves) is not applied to an existing network in place: a
  one-time `docker compose down && docker compose up -d` recreates it.
  Volumes are untouched. Stop or disconnect any foreign container attached
  to `nova_default` first (the old `nova4-tailscale-1` node) — a running
  foreign endpoint blocks the recreate and leaves web down.
- Frontend source changes reach `:5173` via HMR but not this origin until
  `docker compose build web && docker compose up -d web`.
