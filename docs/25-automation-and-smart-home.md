# 25 — Automations & Smart Home

Nova is **reactive and proactive** (`docs/21` §11). This document defines the automation
engine and the smart-home integrations that let Nova perceive and act on the physical world.

## 1. Automation engine

An automation is a versioned rule: **triggers → conditions → actions**, evaluated by the Hub's
scheduler and event bus, able to call any Nova tool (including agents).

```jsonc
{
  "id": "…", "name": "Evening wind-down", "enabled": true,
  "triggers": [{ "kind": "time", "cron": "0 22 * * *" }],
  "conditions": [{ "kind": "device_state", "entity": "light.living_room", "is": "on" }],
  "actions": [
    { "kind": "smarthome", "service": "light.turn_off", "target": "all" },
    { "kind": "agent_run", "objective": "Summarize today's activity and unread messages" },
    { "kind": "notify", "channel": "inapp", "text": "Day wrapped up." }
  ],
  "mode": "single", "version": 3
}
```

### 1.1 Trigger kinds

| Kind | Examples |
| --- | --- |
| **Time** | cron, interval, sunrise/sunset, timezone-aware |
| **Event** | webhook, Slack/Teams/email, file change, connector event, run/agent event |
| **Device state** | smart-home entity changes (door opens, motion, temperature) |
| **Ambient** | on-screen event, spoken phrase, app/window change (`docs/24`) |
| **Location** | arrive/leave geofence (from a mobile client, with consent) |
| **Manual** | button, voice, deep link, dashboard |

### 1.2 Action kinds

| Kind | Examples |
| --- | --- |
| **Smart home** | scene, light/thermostat/lock control |
| **Agent run** | delegate a multi-step task |
| **Tool call** | any registered tool, policy-gated |
| **Messaging** | in-app, Slack/Teams, email, SMS |
| **Script** | sandboxed script/command |
| **Notification** | OS, in-app, channel |
| **Webhook** | outbound HTTP with signing |

### 1.3 Execution model

- A DAG with parallel branches, timeouts, retries, and compensation (undo) where available.
- **Dry-run/test** mode that reports what would happen without side effects.
- Every run is logged in the **Activity** view and the **Flight recorder**.
- Versioning with diff and rollback; disabling is instant.
- **Approvals**: physical-world or consequential actions require approval unless the user
  grants a scoped standing rule (`docs/12` §3).
- Rate limits and loop prevention (an automation's action cannot re-trigger itself).

## 2. Smart home

Nova is a **coordinator**, not a radio hub. It integrates with existing ecosystems rather than
shipping Zigbee/Z-Wave/Thread radios.

| Integration | Role |
| --- | --- |
| **Home Assistant** (primary) | Full entity/state/service access over its local API; covers Zigbee, Z-Wave, Thread/Matter, and thousands of devices |
| **Matter / Thread** | Direct where a controller exists; otherwise through Home Assistant |
| **MQTT** | Publish/subscribe for DIY and industrial devices |
| **Vendor APIs** | Philips Hue, LIFX, Sonos, Nest, Ecobee, etc., via connectors |
| **Voice ecosystems** | Google Home / Apple HomeKit / Alexa as *bridges* (Nova exposes scenes/devices) rather than replacements |
| **Cloud bridges** | Optional; local-first is preferred |

### 2.1 Device registry & state

- Normalized `entity` model: id, type (light, switch, sensor, climate, lock, media, camera,
  cover, vacuum…), state, attributes, area/room, tags.
- State is mirrored in the Hub DB for fast queries and automation evaluation.
- Areas/rooms and scenes are first-class; natural-language control maps to entities and
  services ("turn off the kitchen lights").

### 2.2 Agent integration

- Agents can read state and issue commands through the same policy engine; commands are
  **untrusted-output-safe** (device text is data).
- Examples: "if nobody is home, set the thermostat to eco"; "when the doorbell rings, tell me
  who is there and ask if I want to unlock".

## 3. Safety & privacy

- **Physical-world actions** (locks, alarms, garage doors, thermostats, cameras) are
  high-risk: default to **ask**, with optional scoped standing rules.
- Locks, alarm systems, and camera streams have their own consent and audit treatment;
  history is retained per policy.
- Automations never expose camera/microphone content to a model unless the user opts in for
  that automation and source.
- Managed policy can disable automation, restrict entity classes, or require approval for
  all physical actions.

## 4. Architecture

```
Triggers ─┐
Events  ──┼─▶ Hub event bus ─▶ Automation engine ─▶ Actions
Schedules ┘                       │  (policy-gated)
                                  ├─▶ Smart-home adapters (HA / MQTT / vendor)
                                  ├─▶ Agent runtime (Work runs)
                                  └─▶ Tools / messaging / webhooks
```

- Adapters are **connectors/plugins** (`docs/26`), so community integrations are possible.
- The engine runs on the Hub; heavy actions delegate to compute nodes or devices.

## 5. Requirements (see `docs/03` §P)

- Versioned automations, dry-run, logs, rollback.
- Trigger/condition/action model as above.
- Home Assistant + MQTT + at least one vendor connector in v1 of this track.
- Normalized entity model + area/scene management.
- Approval and audit for physical actions.
- Agent + automation interoperability (agents can create/modify automations with approval).
