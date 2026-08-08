# She deploys herself, and only Jeremy gets in

**Status:** spec'd 2026-08-07, building. ROADMAP #21 said reachability is
deployment, not app code, and that was right for Tailscale. Guest access is
app code, and it is the larger half of this.

## What Jeremy asked for

> "I want to give nova the capability to go out, sign into cloudflare right
> now and deploy herself but ensure that only I can access her though some
> authentication method, or grant guest access over a small amount of time
> with specific llms to test out or whatever."

Three separate things wearing one sentence:

1. **Publish the origin.** Cloudflare tunnel instead of / alongside Tailscale.
2. **Only Jeremy gets in.** Already true, and thinner than it looks.
3. **Time-boxed guests, restricted to specific models.** Does not exist at
   all, and is the real build.

## Where this starts from

Tailscale is live and working: the sidecar serves `https://nova.<tailnet>.ts.net`
→ `web:80`, plus `:8443` ntfy and `:8123` Home Assistant. Cloudflare exists in
this repo **only as prose** — a README paragraph recommending a host-side
`cloudflared tunnel`, and two warnings. Zero code.

Auth is **one static bearer token**. No sessions, no expiry, no revocation
short of rotating `.env`, no route scoping. Identity tiers (operator / kid /
guest) exist — but only on the *voice* channel, where they clamp tools. Typed
chat is operator by definition. There is no model-allowlist concept anywhere
in the backend; `grep` for `allowed_models` is empty.

## 1. Publishing

A `cloudflared` compose service under a `cloudflare` profile, mirroring the
tailscale sidecar's shape: official image, `tunnel run` against `http://web:80`,
no published ports.

Two traps, both already documented in this repo and both about to bite:

- **nginx's Host allowlist** is `localhost 127.0.0.1 ~^.+\.ts\.net$`. A
  Cloudflare hostname gets a **444** until it is added — and `server_name` is
  baked into the `web` image, so this needs an envsubst template, not a file
  edit. Otherwise every dev cycle rediscovers the twice-documented staleness
  trap ("it isn't there on the phone").
- **`NOVA_TRUST_LOCALHOST` defaults true and is not overridden in the live
  `.env`.** A *host-side* cloudflared pointing at `127.0.0.1:8080` makes every
  internet request look local through the web proxy's `X-Real-IP` — i.e.
  tokenless public access. An in-compose sidecar avoids it (its compose IP
  fails `_is_local`), but that distinction is currently *understood*, not
  enforced. Set it false the moment any public tunnel exists, and make
  something refuse the combination rather than warn about it in prose.

**"Signing into Cloudflare" needs almost no new code.** Jeremy stores a
zone-scoped CF API token via Settings → Secrets today; `manage_tool_hosts`
approves `api.cloudflare.com`; an `http_call` tool carries
`Authorization: Bearer {{secret:cloudflare_api_token}}`, resolved late at the
call and never visible to the model. Both mechanisms are already live. What is
missing is the *tunnel lifecycle* — fixed `tunnel_up` / `tunnel_down` /
`tunnel_status` verbs on `inference-control`, copied from `_run_notify`, never
parameterised — plus a backend tool, **granted to `main`**.

One caution carried from a real incident: the tailscale sidecar must never be
recreated by automation (it wiped tailnet auth and the serve config once).
cloudflared will share that fragility — its connector credential must live
somewhere a toggle cannot blank, and config must be mounted as a **directory**,
never a single file.

## 2. "Only I can access her" — the honest state

Publishing makes the single static token the entire wall. The README already
says so verbatim. Auth failures only log; there is no rate limit and no
lockout, so a public origin invites credential stuffing against one HMAC
compare. Rate limiting and lockout ship **in the same change as the tunnel**,
not after.

## 3. Guests — the real build

Migration 118: `guest_sessions(token_hash, label, expires_at, allowed_models
text[], created_by, revoked_at, last_seen)`.

A second branch in `auth_middleware` matches a guest token, **mechanically
refuses past `expires_at`**, and stamps `request.state.role`.

> **This is the part that must not be split across two changes.** The
> middleware today is all-or-nothing by design. A guest branch added without
> simultaneous route-role gating hands guests `/api/v1/auth/token` — which
> returns the *admin* token — and `/api/v1/secrets/{name}/reveal`. A guest
> token that reaches those routes is an admin token. Token branch and route
> gating land together or neither lands.

**Tools:** reuse the seam that already exists. Map an HTTP guest to
`speaker_role='guest'` so the family clamp in `runner.py` applies to typed
turns exactly as it does to voice. Note it must cover *lazily loaded* tools too
— there is a line in the runner that exists because that was missed once.

**Models:** genuinely new. `run_agent`/`model_chain` validates the resolved
model against the session's `allowed_models` and refuses. Backend-enforced —
a guest prompt that says "only use model X" is a request, not a control.

Then an operator UI to mint and revoke time-boxed links, and a live auth matrix
verified through the real `:8080` path: 401 without a token, 200 with, guest
refused on every operator route, guest refused on a model outside its allowlist.

## Sequence

1. Rate limit + lockout on auth failure. (Cheap, and everything else makes it
   urgent.)
2. `guest_sessions` + the middleware branch + route-role gating, one change.
3. Model allowlist enforcement in the resolution path.
4. `cloudflared` service, env-driven `server_name`, `NOVA_TRUST_LOCALHOST=false`.
5. Tunnel verbs on the sidecar, backend tool, **granted to `main`**.
6. Operator UI for minting guest links.
7. Ask her to expose herself and read the trace — not curl it myself.
