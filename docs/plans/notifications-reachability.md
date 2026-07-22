# Notifications reachability — make the delivery path UI-driven and hot

Roadmap #21 follow-on. The notification *settings* (provider, topic, server
mode, priority) are already DB-backed, UI-driven, and hot. What is NOT is the
last-mile **reachability plumbing**: which containers run (`notify`/`tailscale`
profiles), the Tailscale proxy route (`tailscale/serve.json`), and ntfy's
`base-url` (a compose env). Jeremy's principle (2026-07-22): "everything should
be hot-swappable, automated, and configurable through the UI." This lane closes
that gap for notifications.

Motivating incident (2026-07-22): a self-hosted ntfy + iPhone setup silently
failed background push because ntfy's `base-url` (compose env, defaulted to
`localhost:8280`) did not match the URL the phone subscribes to
(`https://nova.<tailnet>.ts.net:8443`). The APNs upstream relay hashes a
sync-topic from base-url, so a mismatch misaddresses the wake-up ping — the app
only receives when open. Invisible, file-based, deployment-specific: exactly the
class of config that must move into the UI and be derived, not hand-set.

## Principle applied

- **Nova is the source of truth.** The phone-facing URL is derived from what
  Nova already knows (`ui.public_url`) + ntfy's tailnet port; ntfy's `base-url`
  is set FROM that, so it can never drift out of sync (prevent, don't detect —
  ntfy's `/v1/config` reports `base_url:""` behind a proxy, so detection isn't
  even reliable).
- **Hot, no files, no recreates where possible.** Tailscale `serve` can be set
  at runtime via its LocalAPI/CLI — no `serve.json` edit, no container recreate.
- **Reuse the existing control seam.** The `inference-control` sidecar already
  holds the docker socket and does fixed-verb `compose up/down` of the ollama
  service; the model-store relocation applies host changes live via a read-only
  control file. Same posture here — no new privileged surface, no parameterized
  docker commands from the backend.
- **Some bootstrap stays out-of-band.** The tailnet join key (`TS_AUTHKEY`) is a
  chicken-and-egg secret needed before any tailnet UI exists; it belongs to the
  secrets-management lane, not here.

## What the backend can/can't see (verified 2026-07-22)

- CAN: probe `http://ntfy:80/v1/health` (bundled up/down), `https://ntfy.sh`
  (public), a custom URL. Derive the phone URL from `ui.public_url`.
- CANNOT (from the backend alone): verify the Tailscale `:8443` route is live
  (backend isn't on the tailnet), read ntfy's effective base-url (`/v1/config`
  base_url is empty behind the proxy), or start/stop containers. Those need the
  `inference-control` sidecar (docker socket) or a tailscale-aware control verb.

## Phases

### Phase 1 — Reachability status (read-only, no privilege) — BUILD FIRST
A `GET /api/v1/notify/reachability` endpoint + a **Reachability** panel in
Settings → Notifications. Reports, honestly labelled as verified-by-Nova vs
operator-responsibility:
- provider enabled + configured (topic/URL present)
- ntfy server reachable (health probe of the resolved publish URL) — a real
  up/down dot
- the exact **phone-facing URL** to enter in the app (derived), shown
  prominently so there is nothing to guess
- for builtin: a checklist of what still needs the operator (notify + tailscale
  profiles running, base-url matching) — the pieces the backend can't verify
Safe, immediately useful (turns "is my path even wired?" from invisible to
visible), and the surface the control actions in later phases attach to.

### Phase 2 — Derived, auto-applied base-url (kills the iOS-mismatch bug)
Nova computes the correct base-url (`ui.public_url` host + ntfy tailnet port)
and ensures the bundled ntfy uses it — via the sidecar recreating ntfy with the
value written to a read-only control file (the model-store control-file
pattern; no parameterized docker command). Then the mismatch that broke the
iPhone cannot happen: change your public URL, ntfy's base-url follows.

### Phase 3 — Service toggles from the UI
Start/stop the `ntfy` and `tailscale` services from the Reachability panel, via
new fixed verbs on the `inference-control` sidecar (`notify_up`/`notify_down`/
`notify_status`), mirroring the bundled-inference toggle. No more
`docker compose --profile notify up -d`.

### Phase 4 — Live Tailscale route (no serve.json, no recreate)
Apply the `:8443 → ntfy` route at runtime via `tailscale serve` (sidecar exec of
a FIXED command, or the tailscale LocalAPI), so exposing ntfy is a UI toggle,
not a `serve.json` edit + container recreate. Removes the operational trap that
cost real debug time (a running node ignores serve.json edits until recreated).

## Security posture

No new privileged surface: all docker/tailscale control stays behind the
existing `inference-control` sidecar's fixed-verb API (compose-network only, no
published ports, no parameterized commands — the backend triggers named verbs,
the sidecar runs fixed operations reading Nova-written control files). The
backend never touches the docker socket. Phase 1 needs none of this.

## Open decisions for Jeremy

1. Confirm the sidecar approach for phases 2-4 (extend `inference-control` vs a
   dedicated `notify-control` sidecar). Recommendation: extend the existing one
   — it already has the socket and the fixed-verb pattern; a second sidecar is
   more surface for no gain.
2. ntfy tailnet port: fixed at 8443 (current) or operator-configurable? Fixed is
   simpler and one less thing to misconfigure; revisit only if it collides.
3. Web Push (ntfy has native VAPID web-push, `enable_web_push` — seen in
   `/v1/config`): a possible route to notify the Nova PWA directly with no
   separate app. Track under #21's Web Push future-provider item, not here.
