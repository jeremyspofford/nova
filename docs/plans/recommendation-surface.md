# Recommendation / notification surface — Nova speaks up proactively

> **Status 2026-07-23:** **Phase 1 was already SHIPPED** by a parallel lane
> (migrations 032 + 037, `recommendations.py`, endpoints,
> `raise_recommendation` builtin granted to main + ingestion, chat banner —
> this doc's "no inbox exists" claim below is a 2026-07-21 snapshot) except
> the automation re-point, which landed today: `mcp-server-discovery` now
> raises cards (dedupe_key `mcp:<slug>`, priority from relevance) alongside
> its topic writes. **Phase 2 BUILT + verified 2026-07-23, uncommitted:**
> bell + new-count badge in the chat header, inbox panel (actionable incl.
> snoozed, then 30 days of recently-decided), decide-from-inbox, banner's
> "+N more" opens it. Also fixed: `later` now actually snoozes — the banner
> queue excludes it (it used to reappear on the next poll). Verified live:
> three planted cards → approve from banner, snooze + dismiss from inbox,
> badge/groups tracked, statuses correct in the DB; fixtures removed.
> Phase 3 (actionable Approve through the consent rails) not started.

Implementation plan (authored 2026-07-21 with Opus, at Jeremy's request).
Goal: give Nova and her automations a first-class way to **proactively raise
a recommendation or notification that the operator actually sees** — a card
in chat with Approve / Later / Dismiss — instead of quietly writing to a
memory topic and hoping to mention it at conversation start.

This is the OUTPUT half of the self-improving arc. The INPUT half (learn from
the web) is `content-ingestion.md` (#8, was video-ingestion.md — reconciled
2026-07-21 into one source-agnostic pipeline) + the existing ingestion agent. This
surface is the rung between "Nova learned something" and "the operator acts on
it," and the backbone of the eventual learn → recommend → approve → test →
promote loop.

## Why now (the concrete gap, 2026-07-20)

Jeremy asked Nova to learn from mcpservers.org and *proactively notify* him of
servers worth adding. Nova set up the ingestion + a weekly automation, then
hit a wall — in her words: "I can't do banners or push notifications — I have
no control over Nova's frontend UI," so the automation just writes to a
`mcp-server-recommendations` topic and hopes to lead with it next
conversation. That's true **today**: there is no notification surface, only
the mid-turn operator-consent gate. This plan builds the missing surface so
that automation raises an actionable card instead.

## What exists (verified in code, 2026-07-21)

- **Operator-consent gate** (`consents.py`, migration 029/030;
  `guarded-actions-consent.md`): mid-turn, an agent calls
  `request_operator_confirmation`; ChatPanel renders an Approve/Deny card and
  the decision is relayed back in-channel. This is *reactive* (blocks a turn),
  not proactive, but the **card rendering + decide-relay pattern is the model
  to generalize** (`ChatPanel.handleConsent`).
- **Model-curation proposals** (`model-curation-proposals.md`): a
  domain-specific "propose → review queue → accept" flow for curated models.
  This surface **generalizes that pattern** to any recommendation kind, with a
  shared store and a chat-visible surface (curation proposals become one
  `kind`).
- **Automations** infra (`automations.py`): scheduled dispatch to an agent.
  The mcp-server-discovery automation already runs weekly; it just has no
  actionable output channel.
- **No** inbox / notifications / banner / ntfy in the v3 backend (grep-clean).
  Nova's "I can't push" is accurate — build it.

## Design

### Data model (new migration — check `backend/app/migrations/` for next free number)

```sql
recommendations (
  id           uuid primary key,
  kind         text not null,        -- 'mcp_server' | 'model' | 'action' | 'note' | ...
  title        text not null,        -- one line ("Add the GitHub MCP server")
  body         text not null,        -- markdown: why + what value it adds
  source       text not null,        -- automation/agent that raised it (provenance)
  status       text not null default 'new',  -- new | seen | approved | later | dismissed | done
  action       jsonb,                -- optional structured one-click apply (phase 3)
  priority     int not null default 0,
  dedupe_key   text,                 -- weekly automations set this so re-runs don't re-raise
  created_at   timestamptz not null default now(),
  decided_at   timestamptz,
  decided_by   text                  -- 'operator'
)
-- unique(dedupe_key) where dedupe_key is not null  → idempotent re-raises
```

`dedupe_key` is the anti-spam guard: `mcp:github`, `model:qwen3:14b`, etc. A
weekly automation re-raising the same finding updates the existing row (bumps
`created_at`/priority if still `new`) instead of stacking duplicates.

### Backend

- **`recommendations.py`** store: `list(status_filter)`, `create(...)` (dedupe
  on `dedupe_key`), `decide(id, choice)`, `count_new()`.
- **Endpoints** (`router_chat.py`):
  - `GET /api/v1/recommendations?status=new|all` → list (newest-first, by
    priority then time).
  - `POST /api/v1/recommendations/{id}/decide {choice}` → operator sets
    approved|later|dismissed|done; returns the row. `later` snoozes (drops off
    the banner, stays in the inbox).
  - Count rides on an existing lightweight poll or a dedicated
    `GET /api/v1/recommendations/count`.
- **Builtin tool `raise_recommendation`** (enforced in the tool, not the
  prompt): `raise_recommendation(kind, title, body, action?=null,
  dedupe_key?=null, priority?=0)`. This is how an automation/agent surfaces a
  finding. Agents can RAISE; only the operator DECIDES (the decide endpoint is
  operator-only, never agent-reachable — same boundary as settings). Granted
  to the ingestion/research agents and main.

### Frontend surface (reachable by navigation — memory rule)

Two complementary surfaces, both fed by the same store:

1. **Chat banner** — when there are `new` recommendations, a card renders at
   the top of the chat stream (or pinned above the composer): "★ Nova
   recommends" + title + rendered body + **[Approve] [Later] [Dismiss]**.
   Reuse the consent-card rendering/decide pattern. Deciding removes it from
   the banner and updates status. Cap the banner at the top 1–2 by priority so
   it never buries the conversation; the rest live in the inbox.
2. **Inbox + badge** — a bell icon in the chat header with a `new` count;
   opening it lists recommendations (new + recently decided, grouped),
   each with the same actions and its provenance/source. Nothing is lost:
   dismissed/approved stay visible in "recently decided" for a window.

Surfacing timing: fetch `new` on chat load and after each automation-bearing
poll; show the banner then. Show a given card once per session until decided
(don't nag every message). This complements — doesn't replace — Nova's spoken
opener; the card is the durable, clickable version.

### The self-improving loop (what this unlocks)

```
ingestion/automation  ──learns──▶ analysis (agent identifies gaps/opportunities)
   (mcpservers.org,                        │
    MCP videos via #8)                     ▼
                              raise_recommendation(kind, title, body, action)
                                           │
                                   ┌────────┴────────┐
                              chat banner        inbox/badge
                                           │
                                    operator decides
                                           │
                              Approve ─▶ (phase 3) run action under the
                                          consent/safety rails ─▶ (later)
                                          stage → test → operator-test → promote
```

Phase 1 delivers the recommend→decide rung (the mcpservers.org use case end to
end). The staged implement/test/promote rungs are the longer roadmap built on
top — each a guarded action through the existing consent gate, never a bypass.

## Phases (each ends live-verified through :5173; changes left uncommitted, summarized)

1. **Store + tool + chat banner.** Migration, `recommendations.py`, the three
   endpoints, `raise_recommendation` builtin, and the chat banner with
   Approve/Later/Dismiss + on-load surfacing. Re-point the `mcp-server-discovery`
   automation to call `raise_recommendation` (dedupe_key `mcp:<name>`) instead
   of only writing the topic. **Verify:** run the automation (or call the tool
   in chat); a card appears in chat; Approve/Dismiss updates status and clears
   the banner; a second run doesn't duplicate (dedupe).
2. **Inbox + badge.** Bell + count in the chat header, list of new + recently
   decided, priority ordering, `later` snooze. **Verify:** raise three, decide
   one from the banner and one from the inbox, snooze one; counts + lists
   track; recently-decided visible.
3. **Actionable recommendations.** Structured `action` (e.g.
   `{tool:"register_mcp_server", args:{...}}`) executed on Approve **through
   the existing consent/safety rails** (not around them). **Verify:** approve
   an "add MCP server X" card → the server is actually registered (still behind
   its own approve/consent gate), receipt shown.
4. **(Later) staged implement→test→promote** scaffolding for the full
   self-improving loop — separate plan once the rung above is proven.

## Decisions (defaults chosen; build can start on phase 1)

1. **In-app only for v1** (chat banner + inbox). Push (ntfy/Telegram) is a
   later add — the in-app surface is the thing Nova genuinely lacks and works
   in the existing PWA. Default: no push in v1.
2. **Approve = mark-only in phase 1**, actionable execution deferred to phase 3
   so the surface ships without entangling the action-execution + safety
   surface. Default: yes (decouple).
3. **Retention**: keep decided recommendations 30 days in the inbox, then
   archive. Default: 30d.
4. **Who can raise**: ingestion/research agents + main (tool grant). Guardian
   and system agents don't raise recommendations. Default: as stated.

## Traps / risks

- **Nagging / spam** is the top risk. Dedupe on `dedupe_key`, cap the banner to
  the top 1–2, show once per session until decided, and require weekly
  automations to pass a stable dedupe_key. A recommendation the operator
  dismissed must not re-raise unless materially new (different dedupe_key).
- **Approve must not be a consent bypass.** Any recommendation that *executes*
  something (phase 3) routes through the guarded-actions consent gate and the
  autonomous safety rails (ledger + wall-clock budget) — the card is a
  convenient entry point, not an authorization shortcut.
- **Operator decides, agents raise.** The decide endpoint is operator-only
  (localhost/token surface), never callable by an agent/tool — same boundary
  that protects settings and the model-store path.
- **Provenance is mandatory** (`source`): every card says who raised it and
  (via body) why, so the operator can judge it — the "empty automation
  description" lesson from the mcpservers.org exchange, applied.
- **Don't lose recommendations** to a missed conversation opener: the inbox +
  badge are the durable record; the banner is just the proactive nudge.
- Reachable by navigation (memory rule): the inbox must be clickable from the
  chat UI, not search-only.
```
