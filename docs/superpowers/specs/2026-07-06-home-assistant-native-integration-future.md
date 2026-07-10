# Home Assistant — First-Class Native Integration (Future Spec)

> **Origin:** Design convergence, 2026-07-06. See
> `docs/designs/2026-07-06-platform-vision-convergence.md`.
> **Status:** Future work — triggered when the MCP-only path proves insufficient.

## Goal

A first-class, native Home Assistant integration that goes beyond the MCP-only path (which
exposes HA's REST/websocket API as tool calls the agent can make one at a time). Native
integration treats HA scenes, automations, and event streams as **first-class Nova objects**
rather than sequences of individual device calls the agent has to reason about every time.

## What it adds over the MCP path

The MCP path (the v1 smart-home wedge, already on the roadmap as Phase 8b) covers:

- Single device actions: `light.turn_on`, `climate.set_temperature`, `lock.lock`, etc.
- Sensor queries: state of any HA entity.
- Agent-orchestrated "routines" expressed as multi-step plans over MCP calls.

The native integration adds what does **not** map cleanly to per-call MCP:

1. **Scene management as a Nova object** — create/edit/delete HA scenes through Nova, with
   Nova-side naming, tagging, and memory of *why* a scene exists ("goodnight" =
   lights off + doors locked + cameras armed). Scenes become durable memory items, not
   ad-hoc agent plans.
2. **HA automations as first-class Nova objects** — bidirectional: HA automations visible
   in Nova's memory/event model; Nova can create HA automations (not just trigger them).
   Enables "Nova notices I leave for work at 8am → suggests an HA automation that arms
   cameras on departure."
3. **Event subscription for reactive behavior** — subscribe to HA state-change events so
   Nova can *react* ("the back door opened after 10pm → alert me and arm cameras") rather
   than only act on voice/command. Ties into the Reactive Event System roadmap item
   (`docs/roadmap.md` — "Reactive Event System [spec]").
4. **Rich voice UX** — native integration owns the conversational surface ("make it
   cozy," "goodnight") that maps natural language to scene/routine selection, with
   disambiguation and confirmation for destructive multi-device actions.

## Trigger for doing this work

Don't build this until **one** of these fires:

- A concrete v1 routine **cannot** be expressed as a Nova agent plan over MCP calls and the
  user hits the limitation (this is the open question in the convergence doc, fork 2').
- The Reactive Event System roadmap item starts landing and HA state-change events need to
  feed it natively (polling HA via MCP is too laggy for reactive safety scenarios).
- Voice UX for scenes/routines is mature enough that per-call MCP orchestration is visibly
  degrading the experience (latency, disambiguation, multi-device confirmation).

If none of these fire, the MCP path is sufficient and this spec stays deferred. That is the
preferred outcome — the MCP path is cheaper, more standard, and inherits HA's compatibility
for free.

## Architecture sketch (not for build — directional only)

- A new optional service or a mode of an existing service (`home-worker`?) holding the
  long-lived HA websocket connection, credentials in `platform_secrets` (encrypted, same
  primitive as other platform credentials — SEC-006a).
- Surfaces HA state to Nova via the memory/event bus (not per-call HTTP).
- Owns the scene/automation CRUD that the MCP path doesn't cover.
- Voice UX layer (shared with the existing voice-service) for natural-language scene
  selection and multi-device action confirmation.
- Guardrail integration: multi-device actions with destructive potential (locks, garage
  doors, alarms) route through the existing checkpoint/approval flow.

## License & dependencies

Home Assistant core is Apache-2.0; HA OS and some add-ons have mixed licenses. Native
integration talks to HA over its documented REST/websocket API — no HA code is linked or
distributed — so license entanglement is minimal. Verify at build time; the integration is
API-level, not code-level.

## Non-goals (until this spec is activated)

- Replacing HA's own automation engine — Nova augments, doesn't replace.
- Supporting non-HA smart home hubs natively in this spec. Google Home / Apple Home / Reolink
  direct integration is a separate, later question; many route through HA already and the
  MCP path covers them transitively.

## Open question to resolve before activation

Whether the native integration is a **new service** or a **mode of an existing one**
(memory-service is the natural neighbor given its event/queue orientation, but it has no
database today and this needs persistence). Resolve when the trigger fires — don't
pre-commit.
