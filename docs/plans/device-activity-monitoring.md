# Device activity monitoring — plan (NOT approved, no code yet)

Planning doc only, authored 2026-07-18 at Jeremy's request to stress-test a
3-phase proposal (ActivityWatch+MCP now, iOS Screen Time later, custom
tracker way later) before anything gets scoped as a ROADMAP item. Nothing
here is built. Decisions flagged for Jeremy at the bottom; everything else
is a recommendation open to pushback.

## Headline finding: drop the MCP dependency from Phase 1

The original Phase 1 wires ActivityWatch to Nova **through MCP**. Checked
against the codebase: **Nova has zero MCP client code today** (`docs/plans/
mcp-client.md`, ROADMAP #19) — it's a 4-phase plan that hasn't started.
Routing activity data through MCP means Phase 1 secretly depends on #19
phases 1–2 landing first. That's a real, unstated dependency the original
sequencing didn't surface.

It's also unnecessary. ActivityWatch is not an MCP server — it's a plain
local REST API (default `127.0.0.1:5600`, a `/buckets` listing, per-event
queries, and its own aggregation language — AQL — for "sum duration by app
over a time range" style rollups). Nova already has the pattern for this:
the tool-creator's HTTP-tool path and builtins like `fetch_url`/
`web_search` call arbitrary REST endpoints today with zero MCP involved.
**Recommendation: build Phase 1 as a direct builtin tool against AW's REST
API, not an MCP bridge.** It still flows through `execute_tool` (the same
choke point MCP tools would use), so guardian rules and the narration
detector apply for free either way — the MCP layer would add indirection
without adding capability here.

This isn't a rejection of MCP as a direction — Home Assistant (Later item)
genuinely should go through #19, because HA ships its own real MCP server
and reinventing that integration would be waste. ActivityWatch has no
comparably-maintained MCP wrapper worth depending on; a raw REST tool is
strictly simpler and ships independent of #19's timeline. If Jeremy still
wants the MCP path specifically (e.g., to standardize all device-side
integrations on one transport), that's a fair call — see decision 1 below —
but it should be made knowingly, not by default.

## What this can reuse (a lot already exists)

Nova has already built every load-bearing piece this feature needs, in
service of other items:

- **Registry + operator-only registration pattern** — `mcp_servers` (design
  in mcp-client.md) is the exact shape a `activity_devices` table needs:
  id, name, base_url, enabled, status, last_seen. Same rule applies:
  registration is operator-only via the edit-mode-gated Settings API, **no
  agent-facing "register a device" tool** — the #18 self-escalation lesson
  (nothing an agent can write may be the switch) applies identically to
  "which machines does Nova pull activity from."
- **Scheduler** (`backend/app/scheduler.py`) — generic automation
  infrastructure (interval, per-run timeout override, consecutive-failure
  auto-disable, run history) already handles "poll on an interval." No new
  scheduling code needed; a device-activity pull is just another
  automation row pointed at a purpose-built agent/tool.
- **Append-only, month-capped digest pattern** (#26, migration 026) — built
  for exactly the "a running log grows without bound and re-generating it
  whole blows the timeout budget" shape of problem tech-news-digest hit.
  Device activity rollups are the same shape (a growing daily/monthly
  log) — reuse `write_memory(item_id=..., append=true)` rather than
  inventing new memory-writing machinery.
- **`about: user` / `maintained_by: <automation>` edges** (#28) — daily
  activity summaries are quintessentially "about the operator." Stamping
  `about: user` gets them an arc to the user star in the brain graph for
  free, and `maintained_by: activity-digest` gets provenance, without new
  graph code.
- **Retention-with-a-setting pattern** (`trace.retention_days`, migration
  028) — the right template for "keep raw rollups N days, prune older,"
  not a bespoke policy.
- **Tailscale** is already a compose profile and the documented reachability
  answer for "another device on the network" (used for the phone PWA
  today). Multi-device reach for activity monitoring should ride the same
  tailnet, not introduce a second tunneling mechanism.

None of this is "nice to have someday" — it's the difference between this
being a multi-week integration and a couple of sessions of mostly-plumbing
work.

## Data model: two layers, not one

The original plan's "store it as memory topics or a running log" elides a
real fork. Raw activity data (which app was foregrounded, second-by-second,
with window titles) is high-volume structured time-series data. Nova's
memory store is markdown files with a BM25 index built for topic
retrieval — it is the **wrong tool** for "how many minutes in VS Code this
week," and dumping raw events into it repeats the exact mistake #27 (tag
hygiene) and #28 (relationship edges) just finished cleaning up: a flood of
low-value, high-volume nodes drowning the graph and the retrieval index.

Two layers, matching the trace/memory split that already exists elsewhere
in this codebase:

1. **Structured layer — Postgres.** `activity_rollups` (device, date, app
   or category, duration_seconds, source watcher) populated by a daily
   pull from AW's own aggregating query endpoint (AW already IS the
   time-series store locally — Nova should pull pre-aggregated daily
   summaries, not raw per-second events, and should not duplicate AW's own
   database). Retention setting mirrors `trace.retention_days`. This layer
   answers analytical questions and feeds a dashboard; it is not meant to
   be read by an LLM directly.
2. **Prose layer — memory, append-only.** One short daily/weekly digest
   entry per device (or unified), written by the automation using the
   #26 append pattern, `about: user` + `maintained_by: activity-digest`
   stamped. This is what Nova actually retrieves in conversation ("what did
   I spend today on") — a few lines of prose, not a database dump.

Pulling **once a day**, not hourly, is a deliberate change from the
original proposal: AW buffers locally regardless of whether Nova is
watching, so there is no freshness reason to poll hourly, and a full-day
window avoids the "partial day, will look different next poll" noise an
hourly cadence introduces into both layers.

## Reachability, not "offline handling," is the actual risk

The original plan frames "laptop asleep" as a scheduling problem. It
isn't, given a daily pull over a range: AW keeps local history, so a
device that's asleep or off-network *at pull time* just gets caught up
whenever it's next reachable — no special-case code needed, same as any
idempotent range-based sync.

The real risk is **reachability at all**, and it's sharper than the
original plan implies: AW's REST API defaults to binding `127.0.0.1` **on
its own machine** — a security default, not an oversight. For Nova's
backend (a different machine, in a container) to reach it, every device
needs its AW instance rebound to a reachable interface. That is precisely
the shape of problem this codebase already hit and fixed once
(`ollama-container-shadows-host` in memory: bundled service defaults to
loopback, host/other-machine reachability needs an explicit, documented
bind change with a stated exposure trade-off). Recommendation: AW should
bind to the tailnet interface specifically (not `0.0.0.0` on the LAN),
and reachability should be verified per-device at registration time
(`GET /api/0/info` or equivalent), with `status` in the registry reflecting
it — not assumed.

## Privacy and consent — this is the load-bearing section

This is more sensitive than anything Nova currently ingests. Window titles
can carry email subject lines, URLs with tokens, therapy/medical/financial
site names, job-search activity — a durable, queryable record of the
operator's entire digital life is categorically different from a web page
Nova fetched once. Treat it accordingly, not as a bullet to revisit later:

- **Off by default, explicit opt-in**, same posture as the wake-word
  voice-biometric item (Later, item 11(b) in ROADMAP): "explicit opt-in,
  local only, browsable/deletable." Activity monitoring should ship
  disabled and require an explicit operator action to enable per device,
  not "registered = on."
- **Redact at ingestion, not after.** Existing guardrails (the
  `no-secret-in-requests` rule) watch *outbound* args on `fetch_url`/
  `web_search` for key-shaped strings — they were never designed to gate a
  first-party pipeline Nova runs on her own trusted local sources, so they
  simply won't fire here. This needs its own filter at the tool boundary:
  app name + duration always kept; **window titles default OFF**, a
  separate opt-in setting, and even when on, only ever land in the raw
  Postgres layer (never verbatim into memory/prose, which is what an LLM
  actually reads and could repeat back).
- **Deletable and exportable.** `delete_memory_item` already covers the
  digest topics. The raw table needs its own purge/export path (a settings
  action, not an agent tool) — same "give the operator their data back"
  posture the product already commits to.
- **Doesn't join the brain graph as raw nodes.** Only the daily digest
  topics do (via `about: user`), never individual app-usage events — the
  #27 lesson (mechanical, high-volume writes are not knowledge-graph
  material) applies directly.
- **Consent gate is the honest gap.** `v0.1.0-alpha`'s "consent gate +
  capability audit log" (ROADMAP's mining list) is reference-only today;
  v3's actual equivalent is guardian rules + edit-mode gating, which is a
  blunt instrument for "an always-on collector of sensitive personal data."
  This might be the first feature where that gap actually bites. Doesn't
  block Phase 1, but note it: if `#3`'s audit-log half (confirmed scope,
  still open) lands first, activity monitoring should log through it
  rather than growing its own bespoke audit trail.

## Platform corrections

- **Browser activity is per-browser, not per-OS.** AW's URL/tab-level data
  comes from `aw-watcher-web` browser extensions (Chrome/Firefox/Edge),
  installed once per browser regardless of which OS it runs on. The
  original platform table implies "Mac needs the extension" — actually
  every platform running a browser needs it, independently of the AW
  desktop client.
- **Idle detection already exists — don't rebuild it.** AW ships
  `aw-watcher-afk` by default alongside the window watcher; "3 hours in
  VS Code" from a stuck-open, unfocused window is already handled upstream.
  Worth stating explicitly since the original plan didn't mention it and a
  naive implementation might try to reinvent idle detection.
- **AW has no official iOS client and only an unofficial/limited Android
  story.** This is a known, present-day gap, not something Phase 3
  discovers later — worth naming now as Phase 3's most likely concrete
  trigger (see below), rather than leaving Phase 3 as a vague "if AW proves
  insufficient."

## Phase 2 (iOS) needs to be downgraded to a research spike

Two compounding facts make "Phase 2: Nova iOS App with native Screen Time
tracking" premature as a planned build phase:

1. **There is no Nova iOS app.** Nova today is a PWA (item #4, "mobile PWA
   routes," is still an open design item — there's no router, no native
   shell, no Apple Developer account anywhere in ROADMAP/memory). Building
   a native iOS app is its own multi-month initiative, almost certainly
   larger than this entire activity-monitoring feature. It shouldn't be
   scoped as "Phase 2 of activity monitoring" — activity monitoring should
   *ride* a Nova-iOS-app initiative the same way Home Assistant rides #19,
   not fund it.
2. **DeviceActivity/Screen Time is not a data API the way AW is.** Apple's
   framework is built around on-device thresholds and Apple's own
   `DeviceActivityReport` extension UI; third-party apps historically do
   not get an arbitrary "45 minutes in Safari, here's a number" handed to
   a server the way a desktop REST API does — access to granular per-app
   data outside Apple's own report-rendering surface is deliberately
   restricted. The original plan's "coarser granularity than desktop"
   framing undersells this: the real open question is whether the data
   Nova wants can leave the device to a home server *at all* in the shape
   assumed, not just "how coarse is it."

Recommendation: treat iOS as a **research spike** before any implementation
phase, exactly the posture this project already uses for uncertain-
feasibility items (#18 executable skills, #20 ACP phase 0). Deliverable:
findings + go/no-go, same shape as those specs — not a build plan yet.

## Phase 3 — agree, with a sharper trigger

The instinct not to build a custom tracker until AW proves insufficient is
correct and matches this project's own build discipline (no speculative
infra, see CLAUDE.md). Give it a concrete trigger instead of "we'll know it
when we see it": AW has **no mobile coverage today** — that's already a
known gap, not a discovered one. If mobile activity data matters and the
iOS research spike above comes back "not really extractable via
DeviceActivity," that is Phase 3's real trigger, not desktop AW falling
short (desktop AW is mature and unlikely to be the weak point).

## Gaps not in the original plan

- **Dashboard/UI.** Reuse conventions already in place rather than
  designing from scratch: a device list + status (mirrors the MCP
  "Servers" section design in the Tools tab) plus a simple rollup view
  (today/this-week totals) — Settings-adjacent, walked via the
  discoverable-by-navigation rule like every other new surface.
- **Alerting on patterns.** Naturally rides ntfy (#21, notifications —
  not yet built), the same way #5's model-upgrade alerts and #24's daily
  briefing already assume it. Sequence as Phase 1.5, after #21, not inside
  Phase 1 itself.
- **Data export.** Covered above under privacy — a real requirement, not
  a nice-to-have, given the sensitivity of the data.
- **Cross-device labeling.** A `device` field on every rollup row from day
  one (work laptop vs. personal desktop) — otherwise "3 hours in Slack"
  is ambiguous the moment there's a second machine. Loosely related to the
  Later item "Operator profile — structured, guaranteed," which this could
  eventually feed rather than duplicate.
- **Guardian visibility.** Because the integration is a plain tool call
  through `execute_tool` (not a special-cased pipeline), the guardian can
  target it with a rule the same way it targets any tool — e.g., a rule
  that blocks window-title capture regardless of the setting toggle, as a
  belt-and-suspenders control. Falls out of the "direct tool, not MCP
  bridge, but same choke point" decision above.

## Revised phase structure (proposed)

| Phase | Scope | Depends on |
|---|---|---|
| **1** | ActivityWatch, direct REST tool (no MCP), device registry, daily pull automation, two-layer storage (Postgres rollups + append-only digest), privacy defaults (titles off, opt-in, deletable) | Nothing unbuilt — buildable now |
| **1.5** | Alerting on activity patterns via ntfy; dashboard polish | #21 (notifications) |
| **2** | iOS — **research spike only**: what DeviceActivity actually exposes to a third-party server, whether a Nova iOS app is even on a timeline | A Nova native iOS app initiative (separate, much larger, not started) |
| **3** | Custom tracker, only if a concrete gap surfaces (mobile is the leading candidate, already known) | Living with Phase 1 + Phase 2's findings |

## Phase 1 milestones (concrete, one roughly per session)

1. **Spike**: install AW on one dev machine, confirm REST/AQL shape against
   the current AW version (API specifics drift across versions — verify
   at build time, same caveat mcp-client.md gives the `mcp` SDK), decide
   the exact kept fields (app name + duration always; window title
   default-off setting).
2. **Registry**: `activity_devices` table + operator-only, edit-mode-gated
   registration in Settings (no agent-facing tool) + a reachability check
   (`status`) at registration.
3. **Tool**: a builtin `query_activity(device, since, until)` against AW's
   aggregating endpoint, routed through `execute_tool` like everything
   else (guardian + narration detector apply for free).
4. **Storage**: `activity_rollups` Postgres table + a retention setting
   (mirrors `trace.retention_days`); a scheduled automation (reuses the
   existing scheduler — one new automation row) pulling **yesterday's**
   data once daily per device.
5. **Digest**: append-only, month-capped daily-activity memory topic
   (#26's pattern verbatim), `about: user` + `maintained_by` stamped
   (#28's mechanism verbatim).
6. **UI**: device status list + a simple rollup view in Settings, walked
   end-to-end via :5173 (discoverable-by-navigation rule).
7. **Privacy pass**: confirm titles-off end-to-end by default, ship the
   export/purge action for the raw table, decide whether a guardian rule
   belongs on this tool out of the gate.

Each milestone gets the same bar as everything else in this repo:
live-verified through the running app (:5173), not just tests — per
CLAUDE.md's definition of done.

## Decisions needed from Jeremy (Phase 1 proceeds on the defaults below without them)

1. **Direct REST tool vs. MCP bridge** — plan defaults to a direct builtin
   tool (ships now, no dependency on #19). Alternative: wait for #19 and
   wrap AW as an MCP server, standardizing all device integrations on one
   transport at the cost of blocking on unbuilt client infrastructure.
2. **Window-title capture** — plan defaults to OFF, opt-in, raw-table-only
   even when on (never in prose memory). Alternative: never capture titles
   at all, only app names — simpler, strictly more private, less useful
   for "what was I actually doing."
3. **Poll cadence** — plan defaults to once daily (matches AW's own local
   buffering, avoids partial-day noise). Alternative: keep hourly if
   near-real-time "what am I doing right now" queries matter enough to
   justify the added noise/cost.
4. **Where this lives once approved** — folded into `ROADMAP.md` as a new
   numbered "Next up" item (cross-referencing this doc, the established
   pattern) once the above are settled, or held as a doc-only plan until
   after the iOS research spike resolves Phase 2's shape.
