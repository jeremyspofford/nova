# Slice 5b — Tailnet access: close-out and carries

Plan: slice-05b-tailnet.md (revision 2). Commits: T2 eaa617e6 (source-address
gate, forwarded scheme, IPAM), T1a 3a3aaf46 (topology pin), T1b 820d1ab7
(the sidecar), T3 executed live 2026-09-04 (operational, no code).

## What shipped

- One durable tailnet origin, `https://nova.tailba0abb.ts.net`, served by the
  v4 stack's own `tailscale` service (profile `tailnet`) at a FIXED address
  (172.18.128.20) proxying web at its FIXED address (172.18.128.10). The
  project network declares its IPAM (172.18.0.0/16, dynamic allocation in
  the lower /17). Nothing joins another container's namespace; no name can
  go stale; `compose restart`, `docker restart <anything>`, `--no-deps web`
  are all order-independent (pinned by deploy/tailnet_topology_test.sh, 24
  checks, with the pod shape's owner-restart strand as a negative control).
- serve is applied by our wrapper on every start and READ BACK (exit
  non-zero if the 443 mapping to the target is absent; `serve --bg` bounded
  by a timeout because the CLI blocks forever when a tailnet lacks the HTTPS
  cap); the healthcheck reads the same two facts. No TS_SERVE_CONFIG —
  containerboot clears it on every start and re-applies through a racy
  watcher (open upstream bug tailscale/tailscale#19693 — the 09-03 "No
  serve config").
- nginx trusts `Tailscale-User-Login` only when `$remote_addr` is the
  sidecar's address (a bridge peer cannot complete TCP with a spoofed
  source; the allocator never reaches the fixed range; docker refuses a
  second holder); identity headers reach core only from that address;
  X-Forwarded-Proto is forwarded through a map so the session cookie's
  `Secure` follows the real scheme. gate_test.sh: 63 checks against a
  user-defined network with a client at the trusted address.
- install.sh `tailnet` profile: refuses unless a key is set or the volume
  already holds an identity (label lookup, then the compose-resolved name —
  a `docker run -v` volume is unlabeled); prints unhealthy services' log
  tail; reads the node's DNS name from status.

## T3 as executed (2026-09-04)

`docker stop nova4-tailscale-1` → `docker compose --profile inference
--profile tailnet down` (ollama holds an endpoint otherwise) → `docker
compose --profile … create tailscale` (the LABELLED volume + the IPAM
network; `create` has no `--no-deps` on compose 5.3) → copy the node state
from `nova_tailscale_state` with the tailscale image as the copier → `up -d`.
Same node key → same DNSName/IP (100.101.120.14), BackendState Running,
CertDomains present, serve → the fixed address, data intact (people 4,
messages 158, devices 1, turns 203), the local daemon reconnected by itself.
The stale :8443 entry the old lane left in the state was removed;
`COMPOSE_PROFILES=inference,tailnet` written to deploy/.env so a plain
`docker compose up/down` converges everything. Trap hit twice: zsh does not
word-split a `$VAR` holding a command — write compose commands out in full.

## DoD status

| # | Item | Status |
|---|------|--------|
| 1 | Phone: open the URL, login, chat, green tile, no gate | OWED — owner walk |
| 2 | Web recreate → URL keeps working, no manual step | DONE 09-04: `up -d --build --no-deps web` (new container, same address), sidecar → web answered, serve unchanged |
| 3 | Restart the sidecar → mapping present, healthy | pinned by the wrapper + healthcheck; live walk OWED |
| 4 | Pair a laptop from the tailnet origin | OWED — owner walk |
| 5 | Tunnel gated / tailnet not / forged header ⇒ 401 | tunnel is OFF (token blanked 09-04); the matrix is pinned in gate_test.sh; live walk when a tunnel is next needed |
| 6 | Stop the service → phone unreachable, localhost fine | OWED — owner walk |
| 7 | Host restart → both come back | OWED — when the owner is at the box |

## Carries

- The public gate's own cookie was hardcoded `Secure` before T2 and blocked
  plain-http localhost (the 09-04 "still asking for a token"); T2 derives it
  from the forwarded scheme — but it is NOT deployed on the gate path until
  a tunnel is next enabled; when it is, walk DoD 5.
- Retire `nova4-tailscale-1` (`docker rm`) once DoD 1 passes; its volume
  `nova_tailscale_state` belongs to the v3 stack and goes with it.
- Funnel: `serve --bg` resets funnel on every sidecar restart (measured in
  v1.102.3 source); keeping a funnel needs a wrapper flag. Not built.
- The rate limiter keys on the client IP; behind serve every tailnet peer
  shares the sidecar's address. A nuisance, not a hole; its own small task.
- Tagged tailnet nodes carry no identity headers → they get the token gate
  (documented in apps/web/README.md).
- S8 (identity as an auth factor) must give core provenance for the
  identity headers: `core:8000` is reachable on the bridge and published on
  127.0.0.1:8000, so a forged header can reach core directly, bypassing
  nginx's strip.
- Compose `--profile` on the CLI REPLACES .env's COMPOSE_PROFILES (measured
  on 5.3.0) — install.sh passes `--profile tailnet` explicitly; operators
  should use plain `up -d`.

## Addendum 2026-09-04 — ollama came back on CPU after T3

The T3 `up` used a bare `-f deploy/docker-compose.yml`; the GPU reservation
lives in the OVERLAY `deploy/docker-compose.gpu.yml` (install.sh merges it;
a hand-run `up` did not). ollama started with `library=cpu`, qwen3.8:27b
loaded 17 GB onto CPU, the next chat turn hit the 300 s gateway timeout and
the owner saw "still responding" then nothing. Fix: `COMPOSE_FILE` in
deploy/.env now lists BOTH files with ABSOLUTE paths — a relative
`COMPOSE_FILE` resolves against the CURRENT DIRECTORY, and from the worktree
root it loaded the v3 `docker-compose.yml` at the repo root ("no such
service: gateway" was the only thing that stopped it). Deploy rule: run
compose as `docker compose --project-directory deploy …` (or from deploy/)
and never pass a bare `-f`; verify with `config --services` (8 v4 services)
and `config | grep -A3 reservations` before any `up`. Tripwire being added
to install.sh: after health, ollama's "inference compute" line must report
the detected GPU library, else the install dies naming the overlay.
