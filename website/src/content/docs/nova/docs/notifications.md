---
title: "Notifications"
description: "Push notifications to your phone via the bundled ntfy server — approvals, checkpoints, failures, and finished goal work."
---

Nova ships its own push-notification server ([ntfy](https://ntfy.sh), bundled
as the `ntfy` container) so autonomous work can reach you instead of waiting
silently in a dashboard tab. No cloud account, no phone-number registration --
your phone subscribes directly to your Nova instance.

## What gets pushed

| Event | Priority | When |
|-------|----------|------|
| Approval needed | High | A MUTATE/DESTRUCT action is waiting in Pending Approvals |
| Task failed | High | Any pipeline task fails |
| Needs review | High | A task escalated to human review |
| Needs clarification | High | A task is blocked on a question |
| Task complete | Default | Autonomous work only (goal-linked or cortex-dispatched) -- interactive chat tasks don't buzz your phone |

## Setup

1. Install the **ntfy** app ([Android](https://play.google.com/store/apps/details?id=io.heckel.ntfy) / [iOS](https://apps.apple.com/us/app/ntfy/id1625396347)).
2. In the app, add your Nova server as a custom server: `http://<nova-host>:8290`.
3. Subscribe to your instance's topic -- shown (with a copy button) in
   **Settings → Notifications**. The topic name (`nova-xxxxxxxx`) is randomly
   seeded at first boot and acts as the subscription secret: treat it like a
   password.
4. Press **Send test notification** in Settings to confirm delivery.

### Reaching ntfy from your phone

The ntfy port is loopback-only by default (like every non-essential Nova
port). Pick one:

- **Same network:** set `NTFY_BIND=0.0.0.0:` in `.env` and restart -- the
  server listens on `http://<host-lan-ip>:8290`.
- **Anywhere:** run the [Tailscale sidecar](/nova/docs/remote-access/) and
  point the app at your tailnet hostname.

## Configuration

Runtime config (Settings UI / platform config):

| Key | Default | Meaning |
|-----|---------|---------|
| `notify.enabled` | `true` | Master switch for push delivery |
| `notify.ntfy_url` | `http://ntfy` | Where the orchestrator publishes (in-network) |
| `notify.ntfy_topic` | seeded `nova-<hex>` | The topic / subscription secret |

Compose-level:

| Env | Default | Meaning |
|-----|---------|---------|
| `NTFY_BIND` | `127.0.0.1:` | Host bind prefix for port 8290 |
| `NTFY_BASE_URL` | `http://localhost:8290` | Public base URL ntfy embeds in links |

## API

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/notify/config` | Admin | Current channel config + subscribe hint |
| POST | `/api/v1/notify/test` | Admin | Send a test notification |

Delivery is best-effort by design: a push failure is logged as a warning and
never blocks consent decisions or pipeline execution.
