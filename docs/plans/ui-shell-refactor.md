# UI shell refactor — utility rail over the full-bleed canvas

> **Status 2026-07-22:** Jeremy approved building. **Phase 0 BUILT +
> verified** (nginx re-resolve proven: backend forced onto a new IP, :8080
> stayed 200 with web untouched; recenter icon + ingestion clip fix
> screenshot-verified). **Phase 1 BUILT + verified at :5173** (rail +
> router live; canvas-remount marker survived all navigation; chat toggle,
> back button, deep link, Nova-mark home all pass; mobile unchanged as
> planned). **Phase 2 BUILT + verified at :5173** (SettingsOverlay monolith
> deleted; Settings page = section nav over backend defs at
> /settings/:section, Library page = six managers at /library/:kind; every
> section and manager walked, live-save round-trip confirmed, tsc + vite
> build clean). **Phase 3 BUILT + verified** (Activity is a page; no-zeros
> skeletons on Observability + Activity, first-paint screenshots show
> skeleton → settled). **Phase 4 BUILT + verified on an emulated 390px
> viewport** (bottom tabs Chat / orb-with-assistant-name / Activity /
> Settings; phones land on /chat; FAB and floating chrome gone; canvas
> chrome hidden on the chat tab; Library via Settings, Observability via
> Activity; settings rows stack on phones; desktop regression-checked —
> no tab bar, /chat redirects home). Web rebuilt with all of it.
> **Real-device round 1 (Jeremy's iPhone screenshots, 2026-07-22):** top
> safe-area was ignored — chip strip and chat header drew under the
> status bar/Dynamic Island, and the theme-preview row clipped. Fixed
> same day: `env(safe-area-inset-top)` padding on the chat panel (mobile)
> and the canvas strip, theme previews wrap. Desktop pixel-identical
> (env()=0). Web rebuilt. **Round 2 accepted by Jeremy on-device
> 2026-07-22 ("usable-ish… decent enough for now") — the plan is
> COMPLETE, all phases verified.** Changes uncommitted, awaiting his
> commit call. Follow-on he raised: a native Android/iOS app "soon" —
> captured in ROADMAP.md discussion backlog, separate lane.

Authored 2026-07-22 from the UI/UX review Jeremy requested the same day;
reframed the same day after Jeremy's correction (below). Direction chosen
by Jeremy: a collapsible left icon rail + routed panels + dedicated mobile
nav, with the universe canvas untouched as the app's one primary surface.
The rail collapses to a 60px icon strip, so the canvas keeps effectively
the whole viewport — a trade Jeremy accepted ("boxes in the canvas" in
the review discussion was a verb — the shell *framing* the canvas — not
boxes rendered inside it).

**Jeremy's correction (2026-07-22, load-bearing):** v0.1.0-alpha is
*reference and inspiration only* — this is NOT a recreation of the v1
dashboard, and there is **no "Brain" destination**. In v1, Brain was one
page inside a dashboard. In v3 the canvas IS the app: Nova, her chat, and
her universe are the home surface you're always in; the rail exists only
to reach the utility surfaces (Library, Activity, Observability,
Settings), and closing any of them drops you back on the canvas. Nothing
user-facing is labeled "Brain", and the app must never read as a
dashboard that happens to contain Nova. (Internal names like
`pages/Brain.tsx` may be renamed opportunistically — the hard constraint
is the user-facing IA and labels.)

**LOCKED (Jeremy's decisions, 2026-07-22):**

- Shell: collapsible left icon rail on desktop, routed panels, dedicated
  mobile nav. Not the Atlas-as-manager direction, not a minimal regroup.
- v0.1.0-alpha is inspiration, not a template — mine mechanics (collapse
  behavior, tooltips, the fact that dedicated mobile nav works), never
  its IA, vocabulary, or code. No "Brain" nav item, tab, or label.
- The universe canvas stays the full-bleed home surface — the app itself,
  not a destination; the rail must be collapsible so the canvas loses at
  most ~60px, and chat stays docked beside the canvas on desktop as today.
- Settings stops being an admin console: true settings separate from
  entity management (the review finding that triggered this).

Everything else below is a recommendation open to pushback; genuinely open
calls are flagged at the bottom.

> Scope note: this plan **resolves ROADMAP #4 (mobile PWA routes/pages)** —
> #4 said "design WITH Jeremy after real on-device usage", and that usage
> happened: Jeremy's 2026-07-22 review is the input (PWA unusable, floating
> chrome overlaps, taps intercepted). The mobile design here is the answer
> to #4's open questions (which surfaces earn a page, bottom tabs vs
> drawer, deep links).

## Review findings this plan must fix (verified 2026-07-22)

Evidence gathered by code reading + live Playwright screenshots:

1. **Top-bar crowding/overlap** — `pages/Brain.tsx` renders one absolute
   top-left strip holding: inventory chips, Legend, Recenter, the
   IngestionActivity button+panel, Observability, and Settings. Open
   several and they overlap; on mobile the chips intercept taps meant for
   buttons behind them.
2. **Ingestion panel cut off at the top** — `IngestionActivity` owns both
   its button and its panel, and both render *inside* that top-bar flex
   strip. The panel's positioning is relative to the ~40px strip, not the
   viewport, so its top is clipped and its "red" failure state gives no
   per-item context until you scroll blind.
3. **Settings is a 3,486-line admin console** — `SettingsOverlay.tsx` has 7
   tabs (`settings, agents, models, automations, rules, tools, skills`);
   only the first is settings. Every new manager lands there because there
   is nowhere else to put one.
4. **Pop-in on every overlay** — overlays mount with `null`/empty state,
   paint zeros, then populate when the first fetch lands (confirmed
   first-paint vs settled on Observability, Settings, Models). No loading
   states anywhere.
5. **Recenter button illegible** — it is the bare glyph `⌖` with no label.
6. **Phone/PWA "loads but does nothing"** — two operational causes, both
   verified: (a) the `web` (:8080) nginx resolves the backend IP once at
   startup, so recreating backend without web 502s every API call; (b) the
   baked web build goes stale (CLAUDE.md trap). (a) gets a durable fix in
   phase 0; (b) stays a process rule but hurts less once the phone UI is
   genuinely usable.

## What exists (verified in code, 2026-07-22)

- **No router.** `App.tsx` (71 lines) is a token gate that renders
  `<Brain />`. `pages/Brain.tsx` (639 lines) hosts everything: the keyed
  WebGL canvas, the top-left strip, legend, `MemoryAtlas` (drag-resizable,
  `left-4`), the detail card (sidebar or modal style), `SettingsOverlay`,
  `ObservabilityOverlay`, `IngestionActivity`, and `ChatPanel`.
- **Canvas contract (do not break):** the canvas is `key`ed per
  renderer-create — a canvas that ever held a WebGL context can't hand out
  another (`Brain.tsx:467-474`); never `forceContextLoss` in destroy
  (StrictMode white-screen, see universe-view notes). The renderer already
  understands insets: `leftInset` re-centers Nova when the Atlas
  opens/resizes, and chat width is subtracted at `renderer.resize(...)`.
  **The rail is just one more inset** — this plumbing exists.
- **ChatPanel** is a right-docked, drag-resizable panel (width persisted at
  `nova.chat.width`); on mobile it is full-width and "chat IS the app",
  with the brain one tap away and a floating 💬 button to return.
- **Settings sections are backend-defined** (`defs[].section`, live list):
  Operator, Appearance, Voice, Context, Inference, Models (keep-warm),
  Agents (max tool rounds), Automations (subsystem), Observability
  (retention), MCP, Notifications — plus non-defs cards mounted by
  section: ModelStorage (Inference), Recent turns (Observability), notify
  test (Notifications). The other six tabs are entity CRUD.
- **Cross-overlay events** exist and must survive or be replaced:
  `nova:open-observability` (Settings → board), `nova:setting-changed`
  (live appearance/name updates), `nova:chat-activity` (orb reacts to
  chat). The first becomes a `navigate()`; the other two are untouched.
- **v1 prior art** (`git show v0.1.0-alpha:dashboard/src/components/layout/...`
  — mechanics only, per Jeremy's correction; never its IA, vocabulary, or
  code): the worthwhile mechanics are the 240px ↔ 60px collapse with the
  state in localStorage, icon-only rows with `title` tooltips, and an
  active-item accent bar. Its dashboard IA (Chat/Tasks/Goals/Brain/…
  pages, roles, preset visibility) is exactly what this plan does NOT
  rebuild.
- **External pattern check** (2026-07-22): Material 3 navigation-rail
  guidance matches the v1 pattern (collapsed icon rail, expandable);
  mobile-nav research is unambiguous that a bottom tab bar with 3–5
  destinations beats a hamburger/drawer for thumb reach and orientation.
  References: https://m3.material.io/components/navigation-rail/guidelines,
  https://www.uxpin.com/studio/blog/mobile-navigation-patterns-pros-and-cons/

## Design

### The shell

One new `AppShell` component owns the frame; `Brain` (canvas + docked chat
+ canvas-local chrome) is the **permanently mounted base layer** — routing
must never unmount it, or the WebGL renderer tears down/recreates on every
navigation (expensive, and historically the source of white-screens).
Routed surfaces render as full-height panels **over** the canvas, to the
right of the rail.

- **Desktop rail** (a utility rail, not a nav sidebar): collapsed 60px
  icon strip by default, expandable to ~240px, state in localStorage. Top
  to bottom: the **Nova mark** (orb glyph — clicking it closes whatever
  panel is open and returns to the canvas at `/`; a "return home"
  affordance, deliberately NOT a "Brain" destination), **Library**
  (`/library`), **Activity** (`/activity`, ingestion badge counts live
  here), **Observability** (`/observability`), spacer, **chat toggle**
  (collapses/expands the docked chat), **Settings** (`/settings`). The
  open surface gets the accent bar; collapsed items get `title` tooltips;
  Esc and each panel's × also return to the canvas.
- **Canvas inset:** rail width joins the existing inset math — canvas
  width = `innerWidth − chatWidth − railWidth`, and `leftInset` accounts
  for rail + Atlas so Nova stays centered in the clear band. No auto-hide
  in this round (flagged below).
- **Routes:** `/` the canvas (home — no panel open) · `/library/:kind?` ·
  `/activity` · `/observability` · `/settings/:section?` · `/chat`
  (mobile tab; desktop redirect to `/`). Deep links + back button now work — which is
  most of what ROADMAP #4 asked for. Recommend `react-router-dom`
  (conventional, v1 used it; a hand-rolled hash router saves a dep but
  re-invents history handling for no gain).
- **Top-left strip shrinks to canvas-local controls only:** inventory
  chips (Atlas doorway), Legend, Recenter. Ingestion, Observability, and
  Settings launchers move to the rail. Recenter gets a proper crosshair
  icon + visible affordance. The overlap problem dissolves because the
  strip no longer hosts panels — only three small controls.

### The Settings split

`SettingsOverlay.tsx` splits along the line the review drew:

- **Settings page** (`/settings/:section?`) — true settings only: the
  backend-defined sections (Operator, Appearance, Voice, Context,
  Inference + ModelStorage, MCP, Notifications, Observability retention,
  Automations subsystem toggles) with a left section list instead of the
  current single scroll. Keeps the live `nova:setting-changed` behavior.
- **Library page** (`/library/:kind?`) — the six entity managers: Agents,
  Models (including Providers), Tools, Skills, Automations, Rules. Same
  components, mechanically extracted from the monolith into
  `components/library/*.tsx` (the split is file surgery, not a redesign —
  each tab's JSX/state moves as-is). Per the standing rule: no edit-mode
  style gates on this CRUD UI; `is_system` protections untouched.
- `ObservabilityOverlay` and `IngestionActivity`'s panel become the
  `/observability` and `/activity` pages; `RecentTurns`/Turn Inspector
  stay reachable from Observability as today.

### Loading convention (kills the pop-in)

Every routed page adopts one rule: **never paint data-shaped zeros before
the first fetch resolves.** A tiny shared `useLoaded`-style helper + a
skeleton block; pages render the skeleton until their first payload lands.
This is a convention applied during extraction, not a framework.

### Mobile

Bottom tab bar (fixed, safe-area inset aware), replacing all floating
chrome: **Chat · Nova · Activity · Settings** — four thumb targets. The
second tab is the orb glyph labeled with the configured assistant name
(`nova.assistant_name`, "Nova" by default) and opens the universe canvas
— per the correction, no tab is called "Brain". Library rides inside
Settings on mobile (a "Manage" group at the top of `/settings` linking
into `/library/*` — still click-path discoverable); Observability lives
as a segment of Activity on phones. Chat is the default tab (matches
today's "chat IS the app"). The floating 💬 button and the
tap-intercepting chip strip go away; chips remain on the canvas tab only. Verification for this phase happens on :8080 (rebuild web
first) with a real phone pass.

## Phases (one per session, in order)

**Phase 0 — stop the phone dying (independent quick wins).**
`frontend/nginx.conf`: switch the API proxy to a variable upstream with
`resolver 127.0.0.11 valid=10s` so nginx re-resolves the backend per
request — recreating backend alone must no longer 502 the phone path.
While there: give Recenter its crosshair icon + tooltip text, and move the
IngestionActivity panel to viewport-fixed positioning (interim fix for the
clipping until phase 3 makes it a page).
*Verify:* `docker compose up -d backend` (backend only, new IP) → :8080
API calls still 200 without touching web; ingestion panel fully visible;
recenter legible. Rebuild web for the :8080 checks.

**Phase 1 — shell skeleton (router + rail), nothing moves house yet.**
Add `react-router-dom`; introduce `AppShell` (rail + persistent `Brain`
base + routed panel outlet). Rail hosts Library/Activity/Observability/
Settings launchers pointing at routes that, for now, render the *existing*
overlay components inside routed panels; top-left strip drops to
chips/Legend/Recenter. Canvas inset math extended with rail width; chat
toggle on the rail.
*Verify at :5173:* navigate all routes and back — the canvas never
remounts (no WebGL init logs, orb state continuous), Nova re-centers on
rail expand/collapse, every old capability reachable by click path, back
button closes panels.

**Phase 2 — the Settings split.** Extract the monolith:
`components/settings/*` (true settings, section nav) and
`components/library/*` (six managers + Providers under Models). Delete
`SettingsOverlay.tsx`; replace `nova:open-observability` with `navigate`.
Pre-release rule applies: clean break, no legacy overlay left behind.
*Verify at :5173:* every setting and every manager reachable and
functional (walk each section; live appearance/name changes still apply
without reload); grep confirms the monolith is gone.

**Phase 3 — Activity page + loading convention.** IngestionActivity's
panel becomes `/activity` (full page: queue, failures with Retry, badge
counts on the rail item); apply the no-zeros skeleton rule to every routed
page.
*Verify at :5173:* first-paint screenshots show skeletons, settled shows
data (the review's pop-in repro, inverted); ingestion badge matches
`/api/v1/ingest/summary`.

**Phase 4 — mobile.** Bottom tab bar (Chat / Nova / Activity / Settings),
full-screen `/chat` on mobile, Manage group in Settings, remove the FAB
and floating chrome, safe-area insets.
*Verify:* rebuild web, then a real pass on the phone via :8080 — tab
switching, chat send, brain tap-targets, ingestion retry. Screenshot the
mobile viewport at :5173 as the fast loop first.

## Open decisions (Jeremy's calls, defaults chosen so work can start)

1. **Rail default state** — default *collapsed* (60px) to honor the
   full-bleed canvas; expanded is one click and persists. Auto-hide over
   the Brain route is deliberately **out** of this round (adds hover-reveal
   complexity; revisit if 60px still feels like a frame).
2. **"Library" name** — default is Library on its own merits (the shelf
   where Nova's parts live: agents, models, tools, skills, automations,
   rules); "Manage" or "Studio" are the alternatives.
3. **Mobile tab set** — 4 tabs with Library folded into Settings is the
   default; 5 tabs (adding Library) if the fold feels buried on-device.
4. **Desktop `/chat` route** — default is redirect-to-`/` (chat is docked,
   a second chat surface invites drift); flip only if a full-screen chat
   is ever wanted on desktop.

## Ground rules for implementing sessions

- CLAUDE.md applies: verify in the running app through :5173 (and :8080
  where the phase says so — **rebuild web first**), leave everything
  uncommitted, summarize for review.
- Never unmount `Brain` on navigation; never `forceContextLoss`; the
  canvas stays keyed per renderer-create.
- v0.1.0-alpha is idea-mining only — no code copying (repo policy), and
  per Jeremy's correction no IA copying either: nothing user-facing gets
  labeled "Brain", and the canvas is never demoted to a page among pages.
- If a mockup round happens, save every iteration as its own versioned
  file (standing rule after the 2026-07-14 loss).
- A conflict between this plan and the codebase means the plan is wrong —
  stop and flag, don't improvise.
