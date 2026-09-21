# The tailnet identity: how it works, and the move that can strand the owner

Read-only research for the Dell -> mini PC move (S45 context). Every claim
below is cited to `path:line` in this worktree, or to a command run against
the live Dell sidecar (`docker exec nova-tailscale-1 ...`) or the mini PC
(`ssh jeremy@<mini-pc> ...`, BatchMode, read-only). No container was started,
stopped, removed, or written to on either machine. Real tailnet IPs, the
tailnet's own DNS suffix, device hostnames and the account's tailnet email
are replaced below with placeholders (`<tailnet>`, `<ts-ip>`, `<peer>`) —
this repo is public. The docker-internal bridge addresses (`172.18.128.x`)
are NOT redacted: they are literal defaults already committed in
`deploy/docker-compose.yml`.

## 1. Where the identity lives, and what authenticates it

The sidecar (`deploy/docker-compose.yml:286-368`, service `tailscale`,
profile `tailnet`) is an ordinary container at a fixed bridge address
(`NOVA_TAILSCALE_ADDR`, default `172.18.128.20`) running
`tailscale/tailscale:v1.102.3` under `containerboot`. Two things are mounted
into it, and only one of them is the identity:

- **`v4_tailscale` (compose-named `<project>_v4_tailscale`) at
  `/var/lib/tailscale`** (`docker-compose.yml:342`) — `TS_STATE_DIR`
  (`docker-compose.yml:323`). This volume holds `tailscaled.state`: the
  node key, its certs, and the MagicDNS registration. **This is the
  identity.** It is the only thing that makes the node "nova" rather than
  a fresh, unnamed peer.
- **`deploy/tailscale/` bind-mounted read-only at `/config`**
  (`docker-compose.yml:344-357`) — `start.sh` and `serve_check.sh`, code
  only, in git. No identity lives here.

Login is `TS_AUTH_ONCE: "true"` (`docker-compose.yml:324`): containerboot
calls `tailscale up --authkey=$TS_AUTHKEY` **only when the state store has
no logged-in node yet**. If `v4_tailscale` already carries `tailscaled.state`
from a prior login, `TS_AUTHKEY` is never consulted, even if it is set —
confirmed in prose at `deploy/README.md:96-99` ("Not needed at all when the
volume already holds a logged-in node... the installer looks inside the
volume before asking") and in `deploy/install.sh:1138-1177`
(`tailscale_state_present`, which `docker run`s the sidecar's own image
read-only against the volume to test for the file before ever prompting for
a key).

**Confirmed live** (`docker exec nova-tailscale-1 tailscale status --json`):
`BackendState: "Running"`, `HaveNodeKey: true`, `Self.DNSName:
"nova.<tailnet>.ts.net."`, `Self.Created: "2026-07-14T21:13:49Z"` (the PR #61
merge date — this is the original node, never re-created), `KeyExpiry:
"2027-01-10T21:13:49Z"` (~3.5 months from today, 2026-09-21 — the standard
~180-day node-key rotation window, separate from the one-time auth key).
`CertDomains` includes `nova.<tailnet>.ts.net`, so HTTPS certificates are
enabled tailnet-wide (`deploy/tailscale/serve_check.sh:93-105` only warns if
they are not; it never gates on it).

## 2. Two different collision hazards, easy to conflate

**a) Two processes holding the SAME node key at once — "flap".** This is
what every guard in this repo is built against. The control plane sees one
identity checking in from two locations and bounces between them; a health
check does not notice it, because both sides read locally healthy
(`deploy/install.sh:361-364`, `docs/plans/rebuild/s41/design-verdict.md:1813`).
This is what happens if `v4_tailscale`'s contents are copied to a second
host while the source sidecar is still running — not "will probably break",
measured behavior the repo's own comments name explicitly
(`docker-compose.yml:444-452`, `deploy/README.md:170-172`).

**b) A DIFFERENT node key, same requested hostname, while the old node is
still online.** This is Tailscale's ordinary name-disambiguation path (not
measured against this tailnet in this session — I did not create a second
node to test it): a new node authenticating with `TS_HOSTNAME=nova` while
another *online* peer already holds that name is not refused and does not
flap; it is silently renamed by the control plane (conventionally with a
numeric suffix, e.g. `nova-1`), producing a **second, different-URL**
peer. Nothing in this repo's code path exercises this deliberately — the
whole design instead makes sure this never has to be relied on, by
guaranteeing the source is stopped before the destination could ever
authenticate as anything.

Since the S41 design carries the SAME node key (not a new one), neither
hazard needs to fire in the sequence it specifies (§3 below) — hazard (a) is
what a bad manual copy would trigger, and hazard (b) is what a fresh-key
install with the same `TAILNET_HOSTNAME` would trigger.

## 3. The identity is MOVED, not re-authenticated — and there's precedent

`docs/plans/rebuild/s41/design-verdict.md:1782-1817` (§9.5): `backup --move`
changes `v4_tailscale`'s backup disposition from `move-only` (never carried)
to `include`, stops **every** service including `tailscale`
(`deploy/backup.sh:2178-2199`, `bk_park`, `--profile '*' stop`), verifies
each container's `.State.Running` reads `false`, and only then writes two
markers (`deploy/tailscale/MOVED_TO` and `deploy/.moved`,
`deploy/backup.sh:2205-2226`) with an explicit read-back check on both. On
the destination, `./install restore <bundle>` refuses a non-empty target
(`deploy/backup.sh:3638`, "§9.2 step 6") — the mini PC's disposable dry-run
stack must be torn down first — and restores `v4_tailscale` bit-for-bit.
`NOVA_TAILNET=1 ./install` afterward finds `tailscaled.state` already on the
volume and asks for no key (§1 above). The result is the same node key, same
DNS name, same TLS cert, on new hardware.

**This is not a new mechanism invented for S41.** `deploy/README.md:196-230`
("Migrating an existing node") documents the exact same move done by hand
for the v3 -> v4 sidecar migration on this same machine: stop the old
container, `docker run --rm -v old:/from:ro -v new:/to ... cp -a /from/.
/to/`, then install with no key. S41 automates that copy through an
encrypted, verified bundle instead of a bare `cp -a`; the identity mechanics
are identical.

`bk_tailnet_dns_name()` (`deploy/backup.sh:2005-2012`) reads the DNS name
for the marker via a **live** `docker exec ... tailscale status --json` on
the still-running sidecar, evaluated as a shell argument before `bk_park`
stops anything (`deploy/backup.sh:2935`) — so the marker records the real
name, not a config guess.

## 4. `tailscale serve` — rebuilt every start, not carried as config

The 443 -> web mapping is **not** persisted via `TS_SERVE_CONFIG` — that
path is deliberately unused because containerboot's own serve watcher races
its own re-apply (`deploy/tailscale/start.sh:7-19`, citing upstream issues
tailscale/tailscale #19693 and #14559, reproduced here 2026-09-03). Instead
`deploy/tailscale/start.sh` is the container's command
(`docker-compose.yml:359`) and is the **one writer**: on every start it waits
for `BackendState: Running`, then runs `tailscale serve --bg --https=443
http://$NOVA_WEB_ADDR:80` (default `172.18.128.10`, a fixed bridge address,
never a name — `start.sh:21-22`), then refuses to let the container report
up unless `serve_check.sh`'s `serve_ok` reads the mapping back from
`tailscale serve status --json` (`serve_check.sh:107-124`). The same file is
the compose healthcheck (`docker-compose.yml:361-368`). Practically: the
destination needs no separate serve setup — it comes from the *same*
`docker-compose.yml` and the *same* `NOVA_WEB_ADDR` default, carried in git,
so the mapping start.sh (re)builds on the mini PC targets the mini PC's own
`web` container and is verified before compose reports healthy. **Confirmed
live** on the Dell (`docker exec nova-tailscale-1 tailscale serve status
--json`): `"443":{"HTTPS":true}`, `Web["nova.<tailnet>.ts.net:443"].
Handlers["/"].Proxy == "http://172.18.128.10:80"` — exactly the shape
`serve_ok` checks for.

## 5. What the phone PWA has cached

`apps/web` ships **no service worker** (searched `apps/web/src`,
`apps/web/public` for `service-worker`/`sw.js`/`manifest*` — only
`public/manifest.webmanifest`, the install manifest, and no caching script
exists to break). So there is no offline API cache to invalidate. What *is*
cached, at the OS level, is the **origin**: an iOS/Android "Add to Home
Screen" install is bound to the exact URL it was added from
(`https://nova.<tailnet>.ts.net`), and per prior memory
(`ios-pwa-icon-frozen-at-install`) iOS never re-fetches the icon or
re-resolves that binding — the only fix measured for staleness is delete and
re-add. Auth is a session cookie scoped to that same origin
(`POST /api/v1/auth/login`, per `CLAUDE.md`). **If the DNS name is
bit-identical after the move (§3's carried-identity path), none of this
changes** — same origin, same cert, same cookie scope, restored Postgres
still holds the session row. **If the DNS name changes** (hazard 2b, or a
deliberate fresh-key install), the home-screen icon on every enrolled phone
points at a URL that no longer serves anything, and getting back means
delete-and-re-add plus a fresh login on each device — this is the concrete,
owner-visible cost of not carrying the identity.

## 6. Live state measured today

- **Dell** (this machine, `nova-tailscale-1`, `Up 10 hours (healthy)`):
  `BackendState: Running`, serving `nova.<tailnet>.ts.net` -> the Dell's
  `web` container. This is the node identity that would be carried.
- **Mini PC** (`ssh jeremy@<mini-pc>`, its own native `tailscale status`):
  runs `nova-web-1`, `nova-core-1`, `nova-memory-1`, `nova-gateway-1`,
  `nova-postgres-1`, `nova-searxng-1`, `nova-ollama-1` — seven containers,
  **no `nova-tailscale-1`** — confirming the situation brief's "no tailnet
  profile" as measured fact, not just an assertion. The mini PC also has
  its **own, separate, already-registered native tailnet node** (hostname
  `<peer>`, distinct identity, distinct from "nova") — this identity is
  untouched by the move; only the Nova sidecar's identity travels.
  `tailscale status --json` on the mini PC currently sees the Dell's `nova`
  peer as **online** right now (`Online: true`), which is the exact fact
  `undo-move`'s liveness check (§9.5 step 3, design-verdict.md:1826-1830) is
  designed to read before letting anyone bring the source back up.

## 7. The sequence that keeps the owner from being locked out — and where it is NOT yet built

**As designed** (design-verdict.md §9.5, backed by the 2026-09-21 ruling in
`docs/plans/rebuild/s41/rulings.md`), the safe order is:

1. Tear down the mini PC's disposable dry-run stack (its own, no-tailnet-profile
   containers/volumes) so the restore target is genuinely empty.
2. On the Dell: `./install backup --move`. This stops every service
   (including `tailscale`), verifies each one stopped, packs and **verifies**
   the encrypted bundle, and only writes the two park markers after the
   bundle is durably on disk. Every failure branch names itself: "the bundle
   IS written... Separately: ... this host is NOT parked" — never a bare
   silent exit (`deploy/backup.sh:2183-2199`, `2224-2226`).
3. Move the bundle to the mini PC (out of scope here — file transport).
4. `./install restore <bundle>` on the mini PC — refuses on a non-empty
   target (`deploy/backup.sh:3638`); restores `v4_tailscale` bit-identically
   since `--move` made it `include`.
5. `NOVA_TAILNET=1 ./install` on the mini PC — finds the existing
   `tailscaled.state`, asks for no key, `start.sh` rebuilds and verifies the
   same serve mapping. Same DNS name, same cert, same cookie scope: no phone
   re-pairing, no re-login.

There is an unavoidable **downtime window** between step 2 (source's
sidecar stops) and step 5 completing (destination's `serve_check.sh` passes)
where `nova.<tailnet>.ts.net` answers from nowhere — inherent to
never running two claimants of one node key at once, not a defect.

**Three gaps found by reading the code today, none of which are in the
design doc's own risk list, that make an actual attempt right now less safe
than the design describes:**

- **The move-mode failure path does not restart what it stopped.**
  `bk_backup_cleanup`'s writer-restart branch is unconditionally skipped
  whenever `BK_RUN_MODE == "move"` (`deploy/backup.sh:1676`:
  `if [ -n "$BK_RUN_STOPPED" ] && [ "$BK_RUN_MODE" != "move" ]`). The
  2026-09-21 ruling (`rulings.md`, "a failed `--move` parks or restarts, and
  says which") states this must not happen — every exit path must end
  running or parked. As read, a failure in `--move` mode between when
  writers are stopped for the DB dump (`deploy/backup.sh:2593`) and when
  `bk_park` either succeeds or fails (`2935`) leaves the stack stopped with
  **no automatic restart attempt** — only `bk_park`'s own `bk_fail` messages
  say "NOT parked" (informative, but not a restart). This reads as the
  ruling stating a requirement the code does not yet implement — the most
  recent commit touching this (`7b662253`) is `docs(s41)`, not `fix(s41)`.
- **`start.sh` has no `MOVED_TO` guard yet.** `grep MOVED_TO
  deploy/tailscale/start.sh deploy/tailscale/serve_check.sh
  deploy/tailscale/start_test.sh` matches nothing. Only
  `deploy/install.sh`'s `refuse_if_moved` (`install.sh:369-384`, keyed off
  `deploy/.moved`) checks today, and it only runs inside `./install`. A bare
  `docker compose up -d tailscale` (or `up -d` with the profile already in
  `COMPOSE_PROFILES`) on a parked host would not be refused by anything —
  design-verdict.md calls a *bypass via an unmounted `/config`* the
  "smaller hole"; today the ordinary compose command is a bigger one than
  the doc describes, because the sidecar-side check it promises isn't
  written yet.
- **`undo-move` does not exist.** `grep -n "undo.move\|undo_move"
  deploy/install.sh` matches only the comments that reference it as a
  future command; there is no `cmd_undo_move`/`undo_move` function anywhere
  in `deploy/backup.sh` or `deploy/install.sh`. If a real `--move` is run
  today, there is currently no scripted way back onto the source — only
  manual deletion of `deploy/.moved` and `deploy/tailscale/MOVED_TO`.

**The sequence that WOULD lock the owner out**, concretely:

- Running `--move` for real today and hitting a failure after writers stop
  but before `bk_park` finishes (network blip during upload, a `docker
  compose stop` timeout, disk full mid-tar) — the Dell is left with
  `tailscale` (and `core`/`gateway`/`memory`) stopped, no marker, and
  nothing restarts it (gap 1 above). Nova is unreachable and there is no
  built "undo" (gap 3) — only a manual `docker compose up -d` by hand.
  This is the exact hole the 2026-09-21 ruling names, currently unclosed
  in code as far as this reading found.
  - **A partial mitigation exists**: `install.sh:361-384`'s
    `refuse_if_moved` still stops a *second, confused* `./install` from
    starting a duplicate identity in this state — it just doesn't get the
    owner *back up*.
- Copying `v4_tailscale`'s contents to the mini PC (by hand, or by skipping
  step 2's stop) while the Dell's sidecar is still running — two live
  claimants of one node key, hazard (a) in §2: a flap neither healthcheck
  notices, intermittent and hard to diagnose rather than a clean outage.
- Installing fresh on the mini PC with a *new* `TS_AUTHKEY` and
  `TAILNET_HOSTNAME=nova` while the Dell's node is still online — hazard
  (b): a differently-named peer, every enrolled phone's home-screen icon
  now pointing at a dead URL, delete-and-re-add required on each device
  (§5).

## 8. Open risks not settled by reading alone

- **Node key expiry during a long park window.** `KeyExpiry` measured today
  is 2027-01-10 — comfortably past any short move, but if the source is
  parked for months before the destination is actually stood up, the key
  could lapse while offline, forcing a real re-auth and breaking the
  bit-identical guarantee this whole design rests on. Whether this tailnet
  has key expiry disabled for this node was not checked (would need the
  admin console, out of reach read-only).
- **Hazard (b)'s exact rename behavior** (§2) is stated from general
  Tailscale behavior, not measured against this tailnet in this session —
  no second node was created to confirm it.
