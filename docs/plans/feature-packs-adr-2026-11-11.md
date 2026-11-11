# Feature packs (design, owner queue item 4, 2026-11-11)

**Sources:** the owner's batch of 2026-11-11, item 4, marked [DESIGN FIRST]
(`docs/builder-packet/INPUT-2026-11-11-OWNER-BATCH.md:65-73`), quoted here in full:

> Capabilities (Coding, Media generation, Smart home, Capture, others as they land) that can be
> enabled, disabled, and downloaded. A disabled pack leaves ZERO UI trace — no nav entries, no
> greyed placeholders, no settings stubs. Precedent to study: legacy Nova's feature-flags runbook
> and 2026-05-05 feature-flags design (on the Dell, arialabs/nova v0.1.0-alpha tree) — flags are the
> mechanism, packs are the product surface; do not confuse the two. The Coding pack governs Relay
> and coding-agent surfaces. MCP connections (e.g. Higgsfield, below) attach to packs, not to core.

And its attachment (`:105-110`): Higgsfield MCP is "the first media pack candidate"; "MCP generations
always consume paid credits"; "It attaches as an optional MCP connection behind privacy/egress
screening; in local-only mode it does not exist."

Its reconciliation with the ledger: `docs/builder-packet/nova-owner-batch-reconciliation-2026-11-11.md`,
item 4 (`:184-214`), conflicts C7 and C10 (`:36`, `:39`) and rulings R14, R15 and R22 (`:387-388`,
`:395`). The extension model (`docs/builder-packet/EXTENSION-MODEL.md:14-15`) and its manifest
(`docs/builder-packet/CONTRACTS.md:21`). The MCP host ADR, PROPOSED
(`docs/plans/mcp-host-adr-2026-11-09.md`). The navigation registry and its reachability plan
(`docs/plans/navigation-reachability-2026-11-02.md`). The standing constraint on paid calls
(`docs/plans/owner-priority-queue-2026-11-02.md:14`). Format follows
`docs/plans/mcp-host-adr-2026-11-09.md` and the self-investigation design of the same day
(PR branch `claude/self-investigation-design`, not merged at the time of writing).

**Status:** PROPOSED, 2026-11-11. Docs only: nothing in Nova changes in this step. The owner marked
the item [DESIGN FIRST], so nothing here is built until he rules on the list at the end (S4-R1 to
S4-R15, with R14, R15 and R22 carried over from the reconciliation). Where this record states a
builder's recommendation it says so; it decides nothing in the owner's place.

**Conflicts are flagged, not resolved.** C7 (Higgsfield's paid credits against the standing "no …
paid calls" and the MCP host ADR's "no paid call is made") stays open under R15; this design places
Higgsfield in a pack and builds nothing that calls it. C10 (the legacy tree against SYSTEM-MAP:9) stays
open under R22; section 1 records what was found, without correcting SYSTEM-MAP.

**Hard limits kept by this design and by any build of it until the owner lifts them:** no paid call;
no account created; no key read; no real MCP server, package, image or model installed or pulled; no
network fetch of a pack from anywhere until S4-R4 and S4-R5 are answered; `features.interstitial` (D8)
and `features.memory_gate` untouched; nothing of the parked items (section 10). Every claim about
today's code was read at `e79dd8bbb` (main after PR #504) and carries a `file:line`.

## 1. The precedent: legacy Nova's feature flags (found locally)

**Found.** The legacy tree is on this build host, read-only, at `~/workspace/legacy-nova-src`: a git
checkout with no remote configured, `git describe --tags` = `v0.1.0-alpha`, last commit `022b44609`
dated 2026-05-09. The two documents the owner names:

| Document | Path in that tree | sha256 |
|---|---|---|
| Feature-flags runbook | `docs/runbooks/feature-flags.md` (245 lines) | `e4e6a966ec06760359e6d0e932a4ad395f939a3c0bfb8d5fcd19c008faa9115b` |
| 2026-05-05 feature-flags design | `docs/superpowers/specs/2026-05-05-feature-flags-design.md` (520 lines) | `a5f59684903e1ba82decf3d2c4e4f86770943698ec5179bd66596768e2553107` |

They are cited here by path and hash, not copied into the packet: filing them is R22. **Fact for
C10, not a resolution:** SYSTEM-MAP:9 says the legacy tree is "dormant since Apr 2026"; this checkout
has commits to 2026-05-09 and a dated 2026-05-05 design. The tree is Python services (orchestrator,
memory-service) with a TypeScript dashboard, which agrees with "Python".

**What the legacy flags were.** A code-first registry (`register_flag(...)` at import), overrides
stored in a table ("no row = code default"), hot reload over pub-sub, an admin Settings section
listing every declared flag (design `:17-34`). The runbook gives flags three jobs (`:10-26`): kill
switches, behaviour toggles, and **capability / surface gates** "to hide partially-built features or
surfaces until they're ready". Its namespace table (`:41-46`) makes `feature.<area>.enabled`
**temporary, with a delete-by date** (`:82-101`), and its "when not to use a flag" table (`:221-229`)
says a "permanent feature enable/disable with no rollback story" is not a flag. Surface hiding was a
per-item filter on the sidebar (`presetVisibility`, `:199-217`), applied to the nav only.

**The lesson this design takes.** The owner's sentence and the legacy runbook agree: a flag is an
operator's switch on a code path, short-lived when it gates a capability, and invisible to the person;
a pack is a capability the person chooses to have, permanent, with a lifecycle and a product surface.
Legacy Nova had no pack; its nearest thing (`feature.capture.enabled`) was a flag with a delete-by
date, and its surface gating covered the nav and nothing else (no Settings search, palette, routes or
shortcuts). Both gaps are what "zero UI trace" closes.

## 2. What exists today

| Piece | Where | What it does now |
|---|---|---|
| Flags | `src/config.js:44-50` | `features.interstitial` (`NOVA_FEATURE_INTERSTITIAL`) and `features.memoryGate` (`NOVA_FEATURE_MEMORY_GATE`), off unless set on. Read from env or `nova.config.json`; no UI, no registry, no audit |
| Flag-gated skills | `src/skills.js:24-26`, `:54-55`, `:109-120` | `FEATURE_SKILLS` maps a skill to a flag; "while it is off, Nova behaves as if they didn't exist (not listed, matched, loaded or installed)". The only "no trace" mechanism in Nova today, for one surface kind |
| The extension host | `src/core/extensions.ts:12-14`, `:19-40`; `install` `:208`, `enable` `:232`, `disable` `:238`, `remove` `:255`; routes `src/core/index.ts:1289-1293` | Seven kinds (`connector`, `mcp-server`, `plugin`, `skill-pack`, `agent-adapter`, `automation-adapter`, `design-system`). Manifest (CONTRACTS §4) with permissions, secrets by name, `nova_compat`, `on_remove`. Install starts disabled; enable needs the permission OK; removal follows `on_remove` and "leaves nothing behind". Runs no extension code |
| The extension lifecycle (spec) | `EXTENSION-MODEL.md:14-15` | discover → review permissions → install (sandboxed) → health check → enable → update (ADR-9 pipeline) → disable → remove |
| The change pipeline | `src/core/changes/kinds.ts:329-470` (per the MCP host ADR's table) | Takes `skill-pack`, `plugin` and `mcp-server` manifests: sandbox, tests, health, approval, canary, promote or roll back. Refuses a non-loopback `network` permission under local-only (`:389-391`) |
| Navigation | `ui/js/nav.js:4-21` (`DESTINATIONS`), `:30-33` (`PLACES`), `:48-58` (`routeOf`); `ui/js/app.js:300` (`VIEWS`) | A fixed list of 16 destinations, 9 primary, 7 under Settings (Capture and Topology among them). An unknown path routes to Home with `unknown: true` (`nav.js:57`; `app.js:900`) |
| Settings | `ui/js/settings-ia.js:8-22` (`CATEGORIES`), `:25-30` (`GROUPS`), `:35-63` (`ENTRIES`); `ui/js/app.js:1845` (`PARTS`) | 13 categories, one of them Capture (`:15`). Search entries carry the words people use; the Providers entry's words include `relay` and `coding agent` (`:50`); Capture's include `screenpipe` (`:47`) |
| The command palette | `ui/js/palette.js:59-75` | Builds its places from `DESTINATIONS`, its settings from `CATEGORIES` and `searchSettings`, plus fixed actions. Whatever those lists hold, the palette finds |
| Keyboard shortcuts | `ui/js/app.js:2336-2349` | Ctrl/Cmd K, Ctrl/Cmd Shift O, Ctrl/Cmd \\, Alt arrows, Ctrl/Cmd Z, `/`, Esc. All core today; none belongs to a pack |
| Chat tools | `src/tools.js` | A fixed list; pack-shaped ones today: `code_change` (`:276`), `code_status` (`:308`), `nova_capture` (`:474`), `home_call` (`:554`, through `service_call` `:425`) |
| Coding surfaces | `src/core/coding/routes.ts:8-17`; `ui/js/surfaces.js:221-223` (the merge sheet), `:1366-1422` ("Coding tasks go to …" in Models and providers); `src/core/providers/builtins.ts:16`, `:24`, `:59` (Claude Code, Codex, Relay as `coding-agent` adapters) | Coding runs (M10c) and their sheets; Relay is one agent a run can use (CAPABILITY-INVENTORY:61, :65) |
| Capture surfaces | `src/core/capture/routes.ts`; `ui/js/capture.js:1-5`; `ui/js/app.js:2114`, `:2164` | The indicator on every page, Settings › Capture, the `/capture` view, `nova_capture`, capture proposals that feed Memory's review (F-034, `ui/js/view.js:540`) |
| Smart home | `src/core/connectors/home-assistant.ts`; CAPABILITY-INVENTORY:56; ADR `docs/plans/smart-home.md:31` ("Nothing here is built") | Home Assistant is a built connector (M5): connect, states, service calls through `home_call`. The Smart Home page and device model are designed, not built |
| Media generation | none | Nothing in `src/` or `ui/`. Higgsfield appears only in the batch and the reconciliation |
| MCP | `docs/plans/mcp-host-adr-2026-11-09.md:18-24`, `:28-29` | PROPOSED; "Nova has no MCP host". OAuth servers wait for broker-held OAuth (`:78`, `:160`) |
| Privacy modes | `src/core/envelope.ts:12`; `src/core/workers.ts:55-59` | `local-only`, `local-preferred`, `cloud-allowed`; `permits(mode, egress)` refuses remote under local-only |
| Effects and tiers | `src/core/approvals/index.ts:41` | `irreversible` covers "sending, spending, devices, accounts, running code": floor 1, default 3 |
| Tests that assert today's surfaces | `tests/navigation-registry.test.js:7-12`; `tests/ui/navigation-reachability.test.ts`, `navigation-drawn.test.ts`, `command-palette.test.ts`, `settings-rebuild.test.ts`; `tests/ui-fixes.test.js` (settings search) | Every destination is reachable in every layout, every `DESTINATIONS` path routes to itself, and the drawn doors match. CAPABILITY-INVENTORY:72 claims "nine primary navigation destinations plus Capture and Topology secondary views have real doors in phone and rail" |

### What is missing

1. **No unit called a pack.** A capability's surfaces live in six fixed lists (nav, settings
   categories, settings search, palette actions, chat tools, server routes) plus ad-hoc code
   (sheets, provider rows, the capture indicator). Nothing says which entries belong together.
2. **No single place every surface reads from.** Hiding Coding today would mean an `if` in each list,
   which no test can prove complete.
3. **No signed download.** Nothing in Nova verifies a downloaded bundle against a publisher key; the
   only Ed25519 use is the broker's outbox (`src/broker/crypto.ts:95-108`).
4. **No "MCP belongs to a pack" rule,** because there is no MCP host yet.

## 3. Decision (proposed)

Add **packs**: a pack is a named capability the person enables, disables, downloads or removes, and
the one thing that owns every surface of that capability. A pack is a **manifest over things that
already exist**: extensions (connectors, agent adapters, skill packs, MCP servers), core routes,
chat tools, UI destinations, Settings categories and search entries, shortcuts, approvals and health
checks. Every surface Nova draws reads **one registry** that answers "is this surface's pack on?"; a
disabled pack's surfaces are removed from that registry's output, never drawn and then hidden.
**Flags stay the mechanism** underneath (a pack's on/off is stored and read like a flag); the person
never sees a flag.

## 4. Flags and packs, stated once

| | Flag | Pack |
|---|---|---|
| What it is | A switch on a code path | A capability the person has or doesn't |
| Who sets it | The operator or builder (env, `nova.config.json`) | The person, in Nova's own UI, under an approval tier |
| Lifetime | Short for a capability gate (legacy runbook `:82-101`: a delete-by date); permanent for a kill switch | Permanent: a pack exists as long as the capability does |
| Visible to the person | Never (no UI today; legacy showed flags to an admin only) | Its own surfaces when on, nothing when off; one Packs list (S4-R8) |
| Unit of | One behaviour | Many surfaces: nav, settings, routes, tools, skills, MCP connections, shortcuts |
| Lifecycle | on, off | absent, available, enabled, disabled, removed (section 7) |
| Data | Owns none | Owns its data; what happens to it on disable is S4-R1 |
| Example | `features.interstitial`, `features.memory_gate` | Coding, Capture, Smart home, Media generation |

**Rules that keep them apart:**
- A pack's state is stored as one flag per pack (`packs.<id>`), read through the same registry; no
  other flag may gate a pack surface. A flag may still gate *a behaviour inside* a pack.
- Existing flags are not packs and are not moved into packs: `features.interstitial` (D8, parked) and
  `features.memory_gate` stay exactly as they are (`src/config.js:44-50`).
- A flag never appears in the Packs list; a pack is never toggled from `NOVA_FEATURE_*`. An operator
  override for a pack (`NOVA_PACK_<ID>=0`, for tests and recovery) may only *turn a pack off*, never
  on, so the environment can't hand the person a capability they did not enable.

## 5. The pack manifest

A pack manifest is an extension manifest (CONTRACTS §4, `extensions.ts:19-40`) of a new kind,
`pack`, with these fields added. Fields marked *core-only* may name core code and are accepted only
for packs that ship inside a signed Nova release (section 7).

| Field | Meaning |
|---|---|
| `id`, `name`, `version`, `nova_compat`, `on_remove` | As every extension |
| `summary` | One line in the person's words, shown in the Packs list |
| `capabilities[]` | What the pack lets Nova do, in words; each one an approvals capability (`approvals/index.ts`) with its effect class |
| `words[]` | The vocabulary only this pack uses ("relay", "coding agent", "screenpipe", "home assistant"): the probe's negative oracle (section 8). Words a core surface also uses are refused at registration |
| `surfaces.nav[]` | Destinations it adds (`{id, label, path, parent?}`, the `DESTINATIONS` shape) |
| `surfaces.settings[]` | Settings categories it adds (`CATEGORIES` shape) and search entries (`ENTRIES` shape) |
| `surfaces.routes[]` | API route prefixes it owns (*core-only*: `/coding`, `/capture`) |
| `surfaces.tools[]` | Chat tools it owns (*core-only*: `code_change`, `code_status`) |
| `surfaces.skills[]` | Skills it owns (generalises `FEATURE_SKILLS`, `skills.js:26`) |
| `surfaces.shortcuts[]` | Keyboard shortcuts it adds, each with its key and action |
| `surfaces.sheets[]`, `surfaces.cards[]` | Named sheets and Home cards it contributes (the coding merge sheet) |
| `surfaces.health[]` | Health checks it owns (the `capture` check of `GET /health`) |
| `surfaces.schedules[]` | Built-in automations it contributes, and the digest sections it feeds |
| `extensions[]` | Extensions it brings, by id: connectors, agent adapters, skill packs |
| `mcp[]` | MCP connections it hosts, each an `mcp-server` extension id (section 9) |
| `egress` | The widest egress it needs: `none`, `local`, or `remote:<named service>`; checked against the privacy mode |
| `paid` | `true` when any capability spends money (Higgsfield); forces the effect class `irreversible` on those capabilities (`approvals/index.ts:41`) |
| `default_state` | `enabled` or `disabled` at first run; the first-run defaults are S4-R9 |

**Registration rules (enforced by the registry, not by review):**
- Every id a pack names (destination, category, entry, route prefix, tool, skill, shortcut, health
  check, extension, MCP connection) belongs to exactly one pack or to core; a second claim is refused.
- A pack may not claim a core surface (section 6's core list).
- Paths and keys may not collide with core's.

## 6. One registry every surface reads from

**Server side: `src/core/packs.ts` (proposed).** Holds every pack manifest and its state, and answers
two questions: `on(packId)` and `owner(surfaceId)`. Every list that becomes a surface goes through it:

| Surface | Today | Under packs |
|---|---|---|
| Chat tools | `src/tools.js` fixed list | Tools owned by an off pack are not offered to the model, not callable, and absent from the tool docs the model reads, as `FEATURE_SKILLS` does for skills |
| Skills | `FEATURE_SKILLS` (`skills.js:26`) | Generalised: a skill owned by an off pack is not listed, matched, loaded or installed |
| API routes | `src/core/index.ts` route table | A route under an off pack's prefix answers exactly as an unknown route (same status, same body). It is also absent from the route list the API serves |
| Health checks | `src/core/index.ts:1108-1140` | An off pack's checks are not run and not listed |
| Problems | `src/core/log.ts` | An off pack raises none (it runs nothing); its open problems are hidden with it (S4-R2) |
| Approvals | `src/core/approvals/index.ts` | An off pack's capabilities are unregistered, so Settings › Approvals lists none of them |
| Extensions | `src/core/extensions.ts` | A pack's extensions are disabled with it (their own state remembered for re-enable) |
| Schedules and the digest | `src/core/triggers.ts`; the morning digest is a schedule whose prompt the model answers | An off pack's built-in rules don't fire; its tools and data are out of the model's reach, so a digest can't mention them |
| Boot payload to the UI | none | One list, `GET /api/v1/surfaces`: every *on* surface with its owner. Off packs' surfaces are not in it at all |

**Client side.** `nav.js`, `settings-ia.js`, `palette.js` and the shortcut table stop being the source
of truth for pack surfaces: core's own entries stay where they are; pack entries come only from
`GET /api/v1/surfaces`. Concretely:
- `DESTINATIONS` keeps the core destinations; pack destinations are appended from the surfaces list.
  `routeOf` resolves a pack path only if the surfaces list has it.
- `CATEGORIES` and `ENTRIES` keep core's; pack categories and entries come from the surfaces list.
  Core entries lose pack words: the Providers entry's `relay` and `coding agent` (`settings-ia.js:50`)
  move to a Coding-owned entry; the Device roles entry's `capture source` (`:54`) move to Capture's.
- The palette builds from the same lists, so it can only find what is on.
- Shortcuts: one table (`SHORTCUTS`) that the keydown handler (`app.js:2336-2349`) reads, core rows
  plus pack rows from the surfaces list. A pack's key with the pack off does nothing (not "not
  available").
- Ad-hoc pack UI (the coding merge sheet, the capture indicator, the "Coding tasks go to …" row) is
  drawn only when its id is in the surfaces list.

**Fail closed.** A surface id that names a pack the registry doesn't know is treated as off and fails
the static test (section 8). There is no "unattributed" surface: every entry in the core lists is on
the core allow-list in the test file, and a new entry fails CI until it is placed in core or a pack.

**Not a UI trace (stated, so the probe doesn't chase it):** a bundled pack's JavaScript and CSS may
still be in the served shell and the service-worker cache; nothing of them is drawn, routed, found or
announced. A downloaded pack's UI code exists only after download.

## 7. Lifecycle: download, enable, disable, remove

```
 absent ──download──▶ available (disabled) ──enable──▶ enabled ──disable──▶ disabled
   ▲                       │                              │                    │
   │                       └──────────remove──────────────┴────────remove──────┘
   └────────────────────────────────────────────── (on_remove) ◀──────────────┘
```

**Two kinds of pack, by where its code lives.**
- **Built-in packs** (Coding, Capture, Smart home today): their code is in the Nova release, so they
  are `available` from first boot. "Download" is a no-op; they are signed by being in a signed
  release. Only built-in packs may use the *core-only* manifest fields.
- **Downloadable packs** (Media generation, later ones): a bundle of extension manifests, skills,
  MCP server declarations and UI files, no core code. They go through the change pipeline (ADR-9),
  which already takes `skill-pack`, `plugin` and `mcp-server` manifests and runs no code.

**Download (downloadable packs only).** Where from is S4-R4; the options are a Nova-hosted index
(which would sit on item 7's domain, not built), a local file the person picks, or both. Whatever the
source:
1. The bundle comes with a detached **Ed25519 signature** over the sha256 of its canonical archive,
   and a small index entry (`id`, `version`, `sha256`, `nova_compat`, `egress`, `paid`).
2. Nova verifies the signature against **publisher keys pinned in the Nova release** (who holds the
   key, and whether any other signer is ever accepted, is S4-R5), then the sha256, then
   `nova_compat`, all in a staging folder before anything is installed. Any mismatch deletes the
   staging folder and records why.
3. The verified bundle enters the change pipeline as a `pack` change: sandbox, its tests, health,
   approval at its tier, canary, promote, or automatic rollback.
4. A pack's publisher key list is core and outside the change pipeline's reach (a change that names
   it is refused, as for the gates).

**Offline and local-only.** Under `local-only` Nova fetches nothing from a remote index. Built-in
packs work as usual. A side-loaded file (if S4-R4 allows it) is verified the same way, offline. A
pack whose `egress` is remote cannot be enabled under local-only (the contract check that refuses a
non-loopback `network` permission already does this for extensions, `kinds.ts:389-391`); switching
to local-only while it is enabled closes its remote sessions (as the MCP host ADR does, `:242`).
Whether such a pack then leaves zero trace or shows as unavailable in the Packs list is S4-R7.

**Enable.** Shows the pack's capabilities and permissions in plain words (`review()`,
`extensions.ts:151`), at the tier of its widest capability (S4-R6). Enabling turns on its
extensions, registers its approvals, tools, skills and routes, and adds its surfaces to
`GET /api/v1/surfaces`; every open UI picks the change up from the event bus
(`src/core/index.ts:966` already emits extension changes).

**Disable.** In order: stop what the pack runs (Capture: every source stops *before* any surface is
removed, so the capture indicator can never be hidden while something captures); deal with its open
work (S4-R10); disable its extensions and close its MCP sessions; unregister its tools, skills,
approvals and routes; drop its surfaces from the list. Its data is handled per S4-R1. Disable is a
tightening and is reversible.

**Remove.** Disable, then the extension host's `remove` for each of its extensions, following
`on_remove` exactly (export, keep, delete, revoke). Nothing of the pack stays behind, as today's
removal promises (`EXTENSION-MODEL.md:15`). Built-in packs can be disabled, not removed (their code
is the release's).

## 8. "Zero UI trace", made testable

Three tests, each failing on today's code for a pack that is declared and turned off.

**8.1 Static attribution (unit, `tests/packs-surfaces.test.js`).** Reads every core list
(`DESTINATIONS`, `CATEGORIES`, `ENTRIES`, palette actions, `SHORTCUTS`, the tool list, the route
table, health checks, `FEATURE_SKILLS`) and every pack manifest, and asserts: each id is owned exactly
once (core allow-list or one pack); no core entry's label or words contain a word from any pack's
`words[]`; every pack's `words[]` is disjoint from core vocabulary. A new unowned surface fails it.

**8.2 The off-pack probe (browser, `tests/ui/packs-zero-trace.test.ts`, Chromium and WebKit).** For
each pack P, a served Nova with P off and every other pack on, at phone (390×844) and desktop
(1280×820), checks:

| What | How | Passes when |
|---|---|---|
| Nav | The existing reachability crawl from Home (`tests/ui/navigation-reachability.test.ts`) through every door, rail and drawer | No destination of P; no element's text, `aria-label` or `title` contains any of P's `words[]` or labels |
| Settings | Open every category; search each of P's labels and words in Settings search | No category, row, empty stub or "turn on" row of P; every P word returns "no results" exactly as a nonsense word does |
| Palette | Open with Ctrl/Cmd K; type each P label and word | No result in any group |
| Shortcuts | Press each of P's declared keys on Home, Chat and Settings | Nothing happens: no navigation, toast, sheet or announcement |
| Deep links | Load each of P's paths directly, cold and from inside the app | The render equals the render of a never-existing path (S4-R3 decides what that render is) |
| Home, Tasks, Health, Activity, Receipts, Memory | Seed P's records (a coding run, a capture event) before turning P off; visit each | Per S4-R1 and S4-R2: with "hidden", nothing of P; the counts shown match a Nova that never had P |
| Status | Read the mark, the Health badge and the status line | No problem, check or "Needs you" from P |
| The digest | Run the built-in morning digest against a stand-in model that echoes its tool list and context | The context and tool list carry nothing of P |
| Chat | Ask the stand-in model to list its tools | None of P's tools |
| Notifications and messages | Fire P's seeded triggers | Nothing delivered (Nova has no OS notifications today, `ui/` has no `showNotification`; the messages inbox is design-only, `ui/js/sg-inbox.js:11`). The probe covers both when they are built |
| API | `GET` the route list and each of P's routes | P's routes are absent and answer as an unknown route |

**8.3 Round trip.** Turn P off, then on: every surface P had is back, and with S4-R1's "kept" option
its records are back unchanged.

**The existing tests change, in the open (R14).** `tests/navigation-registry.test.js:7-12` asserts
`DESTINATIONS` equals the views in `app.js VIEWS`; under packs it asserts *core destinations plus the
on packs' destinations* equal the views reachable for that pack set, and runs for "all on" and
"each one off". The reachability, drawn-navigation, palette and settings-search tests run with all
packs on (today's behaviour) and gain the off cases above. CAPABILITY-INVENTORY:72's claim becomes
"core destinations, plus each enabled pack's, have real doors". None of this is amended until R14 is
answered.

**The styleguide** (`/styleguide`, `src/server.js:383`) draws every surface for review. Whether it is
exempt as a developer reference or must follow the packs too is S4-R14.

## 9. MCP connections attach to packs

- An `mcp-server` extension is accepted only with a pack id: the pack's manifest lists it under
  `mcp[]`, and the extension host refuses an MCP server no pack claims. "Not to core" becomes a
  refusal, not a convention.
- A pack off: its MCP sessions are closed, its tools unregistered, and the connection is absent from
  Connections and from every list (section 8 applies).
- Under local-only, a remote MCP connection **does not exist**, as the batch says for Higgsfield:
  not listed, not offered, not connectable, and its tools are not registered; an open session is
  closed when the mode tightens. This is the MCP host ADR's transport table (`:232-244`) plus the
  zero-trace rule.
- Everything else (transport, sandbox, credentials through the broker, the ingest gate on tool
  output, tool tiers) is the MCP host ADR's, which is PROPOSED and awaits the owner's second-model
  review. Packs add no MCP behaviour of their own.

## 10. The first packs, mapped to today's code

| Pack | Built-in? | Surfaces it would own (today's code) | Status |
|---|---|---|---|
| **Coding** | Built-in | Routes `/coding/*` (`src/core/coding/routes.ts:8-17`); tools `code_change`, `code_status` (`src/tools.js:276`, `:308`); the merge sheet (`ui/js/surfaces.js:221-223`); "Coding tasks go to …" in Models and providers (`:1366-1422`); the agent adapters Claude Code, Codex and Relay (`src/core/providers/builtins.ts:16`, `:24`, `:59`); Relay's settings; the Providers search words `relay`, `coding agent` (`ui/js/settings-ia.js:50`); coding run rows in Tasks; coding approvals | All built (M8b, M10c). Relay is governed here as the owner says. Whether Claude Code and Codex as *chat* providers also belong here is S4-R12 |
| **Capture** | Built-in | Routes `/capture/*`; the `/capture` view and Settings › Capture (`nav.js:14`, `settings-ia.js:15`, `:47`); the indicator (`ui/js/capture.js:70`); `nova_capture` (`src/tools.js:474`); the `capture` health check; capture proposals feeding Memory's review and the digest (F-034); the spoke carrier (`src/device/carrier.ts`); the Devices role word `capture source` | Built (M6a, M10h). Item 1 (screen capture) builds inside this pack |
| **Smart home** | Built-in | The Home Assistant connector (`src/core/connectors/home-assistant.ts`); `home_call` (`src/tools.js:554`); the `home-assistant.service` approval; its Connections row and the search word `home assistant` (`settings-ia.js:48`); later, the Smart Home page of `docs/plans/smart-home.md` | Connector built (M5); page designed, not built |
| **Media generation** | Downloadable | Higgsfield as its first MCP connection (`mcp[]`), `egress: remote:higgsfield`, `paid: true`; a generation is a capability of effect `irreversible` (spends money, `approvals/index.ts:41`) | Nothing exists. Blocked on the MCP host (PROPOSED), broker-held OAuth (not built), and R15 (C7, open). Under local-only it does not exist (section 9). How it would run once those are settled is S4-R13 |

**Stays core** (no pack can claim it): Home, Chat, Tasks (the list; a pack's rows are its own),
Memory, Automations, Skills (the catalog), Activity, Health, Settings and its core categories (You,
Appearance, Privacy, Connections as a container, Models and providers, Devices, Services, Security,
Backups and changes, Configuration, About, Start over), Receipts, the version and changelog pages, the
command palette itself, pairing, the vault and broker, the ledger, tiers and approvals as a system,
the change pipeline, the supervisor, and the design-system extensions. Mail (Gmail), n8n and Nova
Computer are left core in this design and asked about in S4-R11.

**Explicitly not packs:** Jarvis (its promotion is parked; nothing here makes it a pack, a pack
candidate or a pack surface), `features.interstitial` and the Interstitial Research skill (D8,
parked: the flag stays a flag, not attached to any pack), `features.memory_gate`, design systems.

## 11. Security

- **Signed or not installed.** A downloadable pack is verified (signature, digest, compatibility)
  before it touches anything outside staging; the publisher keys are pinned in the release and outside
  the change pipeline's reach (section 7).
- **The environment can only turn a pack off** (section 4), so a stray variable can't grant a
  capability.
- **Disable is enforced server-side,** not only hidden in the UI: tools, routes, skills, schedules,
  MCP sessions and extensions stop. A hidden surface whose route still answered would be both a trace
  and a hole.
- **Privacy outranks enablement.** A pack's `egress` is checked against the privacy mode at enable, at
  every session start and on every mode change; local-only is absolute.
- **Paid capabilities** carry effect `irreversible` and are never auto-approved below its floor; no
  paid call is made while C7 is open.
- **Capture stops before it hides.** The capture indicator rule (visible whenever anything captures)
  is kept by ordering: sources stop, then surfaces go.
- **Core-only fields** (routes, tools, core sheets) are refused in a downloadable pack, so a
  downloaded bundle can never register a route or a native tool.

## 12. What this does not touch

**F-012** (conversation deletion), **F-049** (handoffs workflow), **Jarvis promotion**, **D8
Interstitial Part 3** (`features.interstitial` untouched, no eval runs), **slice 1b of ADR #481**, and
**PR #207**. No code changes in this PR; no navigation, settings or reachability test is amended
until R14 is answered.

## 13. Acceptance criteria for a later build

Each becomes at least one test that fails on the code before it.

1. Every surface id in the core lists and every pack manifest is owned exactly once; an unowned or
   doubly owned id fails the static test.
2. No core label or search word contains a word from any pack's `words[]`.
3. With a pack off, the probe of 8.2 finds nothing of it at phone and desktop, in Chromium and
   WebKit: nav, Settings categories and search, palette, shortcuts, Home, Tasks, Health, status,
   Approvals, Connections, Models and providers, chat tools and the digest's context.
4. A deep link to an off pack's path renders exactly what a never-existing path renders.
5. An off pack's API routes answer exactly as unknown routes and are absent from the route list.
6. Off, then on, restores every surface (and, under S4-R1's "kept", every record unchanged).
7. Disabling Capture stops every source before the indicator or any Capture surface is removed; at no
   instant is a source capturing with no indicator.
8. A downloadable pack with a bad signature, an unknown signer, a digest mismatch or an incompatible
   `nova_compat` is refused in staging; nothing outside staging changes.
9. Under local-only, a pack with remote egress can't be enabled; one already enabled has its remote
   sessions closed and makes zero remote requests (the stand-in receives none).
10. An `mcp-server` extension no pack claims is refused at install.
11. `NOVA_PACK_<ID>=1` does not turn a pack on; `=0` turns it off.
12. A downloadable pack that declares a route or a native tool is refused.
13. With every pack on, every existing navigation, palette, settings and status test passes unchanged.

## 14. Slices (smallest useful first)

1. **The registry and the probe, nothing switchable by the person.** `src/core/packs.ts` with
   Coding, Capture and Smart home declared as built-in packs, all on; `GET /api/v1/surfaces`; the
   client lists read pack entries from it; pack words moved out of core entries; the static test
   (8.1) and the probe (8.2) driven by `NOVA_PACK_<ID>=0` in the test server only. Data untouched
   when off (the non-destructive choice, whatever S4-R1 later decides). Value: "zero UI trace"
   becomes a passing test before any person can turn anything off, and every later surface is placed
   on day one. Criteria 1 to 5, 11, 13. Needs R14 and S4-R3.
2. **Packs in Settings.** The Packs list (S4-R8), enable and disable under S4-R6's tiers, the disable
   order and open-work handling (S4-R10), S4-R1's data rule and S4-R2's history rule. Criteria 6, 7.
3. **Signed bundles, local file only.** Staging, signature and digest checks, the `pack` change kind
   through the pipeline. No network fetch. Criteria 8, 12. Needs S4-R4, S4-R5.
4. **MCP attaches to packs,** once the MCP host ADR is accepted and built. Criteria 9, 10.
5. **Media generation with Higgsfield,** only after R15, broker-held OAuth and S4-R13.

**Proposed first slice:** slice 1. It changes nothing the person sees with all packs on, it is the
only way to prove "zero UI trace" for every later surface, and it needs only R14 and S4-R3.

## Rejected alternatives

- **Packs as flags** (legacy `feature.<area>.enabled`). Wrong lifetime (a delete-by date, runbook
  `:82-101`), wrong audience (an operator), and the legacy filter covered the nav only.
- **Packs as one more extension kind with no surface registry.** The extension host knows its own
  manifests, not the nav, settings, palette, shortcuts or core routes; hiding would still be an `if`
  in each list, which no test can prove complete.
- **Greyed or "turn on" placeholders.** Forbidden by the batch.
- **Hide in the UI only.** Leaves routes, tools and schedules running: a trace through deep links,
  chat and the digest, and a security hole.
- **Move today's flags into packs.** D8 is parked, and a flag is not a product surface.

## Consequences

- Every new surface must name its owner on day one; the static test makes that the build's rule.
- The navigation and reachability tests stop asserting one fixed set and assert per pack set (R14).
- "What Nova can do" becomes per install; CAPABILITY-INVENTORY gains a pack column.
- Downloadable packs need a signing key and its custody before the first one ships (S4-R5).

## Ruling list for the owner

Carried over from the reconciliation, not duplicated: **R14** (packs on the flags, the extension
lifecycle or both; and whether "zero UI trace" may amend the navigation and reachability tests and
the inventory: this design proposes both, flags as the stored switch and the extension lifecycle as
the pack's, and the test amendments of section 8), **R15** (C7: paid Higgsfield calls and its wait on
the MCP host and broker OAuth), and **R22** (C10: filing the legacy references, now found at
`~/workspace/legacy-nova-src`, and SYSTEM-MAP:9).

- **S4-R1:** a disabled pack's data: kept and hidden (turning it back on restores it), kept and hidden with an offer to delete after a period, or deleted on disable (disable becomes remove)?
- **S4-R2:** records of a disabled pack's past work in core places (Tasks history, Activity, Receipts, problems, memories promoted from capture, changelog entries): hidden with the pack, kept visible as history, or kept with the pack's words removed?
- **S4-R3:** a deep link to a disabled pack's page: identical to an address that never existed, or a plain page offering to turn the pack on?
- **S4-R4:** where downloadable packs come from: a Nova-hosted signed index (on item 7's domain), a file the person picks, or both?
- **S4-R5:** who holds the pack-signing key (your offline key, a CI-held key, or both required), and is a pack signed by anyone else refused outright or allowed at tier 3?
- **S4-R6:** tiers: enabling at the tier of the pack's widest capability (tier 3 when it adds remote egress or spends money) and disabling at tier 1 from any paired device, or other?
- **S4-R7:** under local-only, a pack whose every capability needs the network (Media with only Higgsfield): zero trace like a disabled pack (its on state kept for when the mode loosens), or listed as unavailable in the Packs list only?
- **S4-R8:** where packs are turned on and off: a Packs category in Settings, inside Connections, or also in guided setup?
- **S4-R9:** first-run state: Coding, Capture and Smart home on (today's behaviour), off, or asked during setup?
- **S4-R10:** disabling while the pack has work open (a coding run waiting for merge, a capture sync): cancel it after showing the list, refuse until it ends, or let it finish unseen?
- **S4-R11:** Mail (Gmail), n8n and Nova Computer: core as in this design, or packs of their own (or Nova Computer inside Coding)?
- **S4-R12:** do Claude Code and Codex move into the Coding pack entirely, or stay core as chat providers with only their coding-agent use in the pack?
- **S4-R13:** once R15 allows paid calls and the MCP host exists: Higgsfield with every generation at tier 3 and a daily credit cap, or no media pack until a local media model exists?
- **S4-R14:** the styleguide: exempt as a developer reference, or also hides a disabled pack's compositions?
- **S4-R15:** start with slice 1 (the registry and the probe, nothing switchable by the person), or begin at slice 2 once S4-R1, S4-R2, S4-R6 and S4-R10 are answered?
