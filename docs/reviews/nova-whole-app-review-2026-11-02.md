# Nova review, 2026-11-02

Reviewed read-only at `048eea0e` (main after #282). Three parallel reviews (backend code, frontend code and design, backend-to-frontend wiring) plus a survey of the Claude Code plugin, MCP and skill landscape for building Nova well. Nothing in the repo was changed; this file is the only addition and is not committed.

## The verdict in five lines

1. **The backend is well engineered, not sprawl.** The security boundaries (loopback console, `X-Nova`, vault, SSRF guard, path guards, domain-separated signatures) hold up under reading, `tsc` passes clean, and the tests assert behaviour rather than snapshots. The real defects sit at the seams between the Era 2 JavaScript and the TypeScript core.
2. **The most consequential architectural choice is invisible from the UI:** Nova drives Claude as a bare text model. Every native tool is disabled, tool calls are a home-grown `<tool_call>` text protocol, one tool per round, and each round re-spawns the CLI and resends the transcript. That forfeits native tool schemas, parallel tool calls, prompt-cache continuity, and the whole Claude Code tool and MCP ecosystem.
3. **The backend is far ahead of the frontend.** Of roughly 190 routes, two entire modules (cost caps, diagnostics) are not even mounted, and about a dozen built capabilities (receipts, foundry, extensions, Nova Computer, infra projects, network targets, rule editing, backups settings, a messages inbox) have no door in the app and no chat tool.
4. **The design is no longer slop in the purple-gradient sense, but it is still undecided.** Home is six equal glass cards, the right column repeats the page, the rail orb is a flat disc, and two of the six shipped themes (Nova, Aurora) are exactly the indigo-on-black look the design system now bans.
5. **The builder's toolkit is thin for a project this size.** No `CLAUDE.md` or `AGENTS.md` at the repo root, no MCP servers configured, Superpowers one patch behind, and none of the official LSP, security, review or hook plugins installed.

## 1. Backend code review

Typecheck passes (`tsc -p tsconfig.json`, exit 0). Findings are ranked; each was confirmed by reading the code at HEAD.

### Correctness and security

| # | Finding | Where | Why it matters | Fix |
|---|---|---|---|---|
| 1 | The `exec` tool and the Era 2 chat agent inherit the server's full environment, including `NOVA_SECRET_<NAME>` and `NOVA_MESH_NAME_TOKEN`. `agent.js` strips only `CLAUDE*` vars and the mesh token. | `src/tools.js:596`, `src/agent.js:20-23` | A tainted page talks the model into `env \| curl -d @- …`; the person approves "a command"; the API key leaves. The provider path already does this right (`src/core/providers/cli.ts:45-50`, `childEnv` drops all `NOVA_*`). | Pass `env: childEnv()` in both `runCommand` and `runAgent`. |
| 2 | A worker that ignores its abort signal runs concurrently with its own retry. On timeout the race rejects, the id leaves `#running`, the retry is queued and dispatched while attempt N's promise is still live. | `src/core/ledger.ts:519-537, 590-593` | Workspace and coding workers get two attempts writing the same tree. `#mayRerun` only holds external-effect workers. | Keep orphaned promises in a map; refuse to dispatch that id or lane until they settle. |
| 3 | Malformed zip gives a 500, and stored (method 0) entries are not length-checked. | `src/zip.js:36-39` | Untrusted central-directory offsets reach `readUInt32LE` unchecked; `ERR_OUT_OF_RANGE` surfaces as "Something went wrong". | Bounds-check `local + 30` and `start + packed`; assert `raw.length === size`; wrap `RangeError` into `ZipError`. |
| 4 | Era 2 `readBody` accepts non-object JSON and then destructures it. | `src/server.js:257-262` (used at 368, 383, 525, 550, 562) | `JSON.parse("null")` becomes a `TypeError` and a 500 carrying the raw engine message. `api.ts:95` already rejects non-objects. | Copy that check. |
| 5 | `web_search` follows redirects outside the SSRF guard. | `src/tools.js:163-166` | A 3xx from the search host to `http://127.0.0.1:<port>/api/…` is followed. Bounded (parsed, not shown), but the guard exists for this. | `redirect: 'error'`, or route through `safeFetch`. |
| 6 | Silently truncated pages pass as whole. | `src/safe-fetch.js:141` | Over `MAX_BODY` the partial body is returned with status 200 and no marker, then handed to the ingest screen as the page. | Append a truncation marker or return a `truncated` flag. |
| 7 | Route-existence leak on method mismatch. | `src/core/api.ts:136-142, 163` | Unauthenticated `GET /api/v1/hooks/x` answers `405 allow: POST`, contradicting the "learns nothing" comment. | Use `person` scope when no method matches. |
| 8 | The coding provider relies on `--safe-mode` to keep a repository's own `.claude/settings.json` hooks, plugins and `CLAUDE.md` out of the worker, and the comment says it was "not run against a real session". | `src/core/providers/claude-code.ts:42` | Claude Code's docs now name `--bare` as the recommended mode for scripted calls and say a `-p` session without it runs the project's hooks and `.mcp.json` servers "even in a folder you've never trusted". | Verify against a real run; prefer `--bare` plus explicit `--mcp-config`/`--settings`. |

What was checked and found sound: the console test in `mesh/access.ts` (loopback peer, loopback Host, no forwarding header, no upgrade); `X-Nova` plus Origin guard on every non-GET in both `api.ts` and `server.js`, with the hook route the single documented exemption; hook tokens and pairing codes compared in constant time; `safe-fetch.js` resolves then connects to the checked address and re-checks each redirect; path guards (realpath on reads, lstat every component plus `O_NOFOLLOW` on writes, secret dirs refused); vault AES-256-GCM with vault-id AAD and crash-safe swap order; sealed boxes in `wire.ts` bind both public keys into the HKDF info and every signed message is domain-prefixed. No `Math.random` anywhere in `src/`.

### Robustness

| # | Finding | Where | Fix |
|---|---|---|---|
| 9 | The test suite leaks temp homes by design: `blank()` in `tests/acceptance/support.ts:48-50`, `tests/support/models.ts:49`, and 64 `tests/core/*.test.ts` files call `mkdtempSync` with no `rmSync`. `/tmp` on this machine holds 1,804 `nova-*` folders right now. | tests | One `tmpHome()` helper in `tests/support` that registers an `after` cleanup; have `npm test` set `TMPDIR` to a per-run folder it removes. |
| 10 | `runAgent` leaks its scratch dir when spawn fails, and quotes the system-file path with bare single quotes where `custom-cli.ts:40` escapes it. | `src/agent.js:31, 84, 94` | Clean up in the error handler; share the quoting helper. |
| 11 | No `unhandledRejection` handler anywhere in `src/`. Node 26 exits on one; there are 212 empty `catch {}` blocks and many `void x()` fire-and-forgets. | `src/` | Install a handler that records a problem via `log.problem` and keeps running. |
| 12 | Approval listeners accumulate per run (an `abort` listener per approval, never removed on a normal decision). Bounded by `maxSteps`. | `src/runner.js:434-437` | Remove after resolve, or use the `{ signal }` listener option. |
| 13 | `Sandbox.start` leaves the child running and the scratch home on disk when it times out; the pipeline's `finally` happens to clean up. | `src/core/changes/sandbox.ts:74-80` | Clean up inside the class. |
| 14 | Quadratic lane accounting in the ledger pump. Harmless today. | `src/core/ledger.ts:403` | A `Map<lane, count>`. |

### Structure

- **Oversized composition root.** `src/core/index.ts` is 1,758 lines with about 102 routes defined inline inside the `createCore` closure, plus health, views, hub start and stop, and the agent download. `browser/routes.ts`, `capture/routes.ts` and `coding/routes.ts` already show the right pattern. Same treatment for `mesh/handover.ts` (1,502), `capture/capture.ts` (1,450) and `models/index.ts` (1,332).
- **Duplicated memory scoring.** `src/memory.js:484-498` and `src/core/memory.ts:214-225` are the same `terms`/`need`/`score` algorithm copied; the runner recalls only through the Era 2 one. One exported scorer.
- **Two cron paths.** `src/scheduler.js` (30 s tick, own missed-run window) and the heartbeat in `src/core/triggers.ts:438-451`, both over `src/cron.js`. The scheduler already fires through `triggers.fire`, so a schedule could be a heartbeat rule.
- **Era 2 `/api` is a second, undocumented API.** `src/server.js:323-571` hand-dispatches on path parts, POST-only mutations, its own `readBody` and `json`, and is absent from `/api/v1/openapi.json`. Migrating these resources into `Route[]` entries fixes findings 4 and 7 for free.
- **Dead code.** `pairingConfirmation` (V1) in `src/core/mesh/wire.ts:66-70` exists only for one test. Cosmetic: `server.js:399-400` enforces 8 MB and says 5 MB.

### Tests

Assertion quality is strong: 6,361 `assert.equal`, 1,856 `assert.match`, 1,524 `assert.deepEqual`, 360 `assert.throws`, no tautologies, no snapshot library. The weakness is cost and hygiene: acceptance tests spawn the real server per test and poll (303 sites, 25 ms up to 800 tries); 147 tests declare timeouts of 120 to 300 s. That plus the temp-home leak is why the suite is slow and fills `/tmp`.

## 2. Frontend code review

Ranked, confirmed at HEAD (after #279, #280, #282).

1. **Six hand-rolled "preserve state across innerHTML" routines.** Every view draws with `el.x.innerHTML = render(...)`, then focus, open `<details>`, typed values and scroll are re-applied by hand in `renderMemoryView` (`app.js:906-914`), `renderSkillsView` (1074-1084), `renderSchedulesView` (1322-1335), `renderActivityView` (1450-1463), `renderSettingsView` plus `keepEdits` (1712-1744), `drawCapture` (1888-1893) and `renderCore.keep` (321-328). Each is a slightly different bespoke diff with its own bug surface (Settings refuses to redraw only while a text input has focus, so a focused `<select>` is redrawn under the pointer). State lives in at least seven stores.
2. **Three parallel HTTP clients with unequal safety.** `core.request` (`core.js:35`) has a 10 s abort, 401 renew and offline detection. `app.js` keeps a second `post()` (75-86) and six raw `fetch()` loaders with none of that; two don't send the `x-nova` header. Three EventSource families run at once in chat. `JSON.parse(e.data)` is unguarded at `app.js:215, 225, 372, 381, 384, 386`.
3. **Copy-pasted loaders and view-enter boilerplate.** Five identical 15-line loaders; the enter animation pasted at 915, 1085, 1336, 1464 though `enter(node)` exists at 313; nine `showX` functions open with the same six lines.
4. **Full re-serialisation of the conversation on every stream event.** `onEvent` (405) and the live handler (384) call `renderThread`, which rebuilds HTML for every turn (`view.js:388`) and string-compares (`app.js:490, 515`). The main conversation is permanent and grows daily, so this is O(total turns) per SSE event.
5. **Destructive actions on single keystrokes.** `Delete`/`Backspace` on a focused memory, skill or schedule removes it (`app.js:1043, 1296, 1425`). Undo toasts expire in 8 s and the `state.undo` slot is single, so a second removal overwrites the first undo. Global `Escape` inside an approval card sends a deny decision (2047); everywhere else Escape dismisses.
6. **Service worker.** `SHELL` is a hand-maintained list and `cache.addAll` failure is swallowed (`sw.js:7-13`, `app.js:2078`), so a renamed module silently kills offline; `skipWaiting` plus `clients.claim` activates under open tabs with no refresh prompt; every successful `/api/*` GET not in `NEVER` is cached, including task briefs, reports and evidence, unencrypted in Cache Storage on every paired browser.
7. **Unreachable-server loop ignores tab visibility** (`app.js:240-248`, 2 s forever), and two separate `visibilitychange` handlers exist (2067, 2075).
8. **`renderChrome` on every keystroke** replaces the Send icon's SVG and rebuilds banner buttons (`app.js:604, 621-637, 787`).
9. **XSS is mostly solid.** `markdown.js` escapes before markup, restricts hrefs, and `rel="noopener noreferrer"` wraps external links; tool args, previews, approvals and events are escaped in `view.js` and `surfaces.js`. Residual: `ui/js/styleguide.js:396` interpolates an installed design-system package's `id` and `name` into `<option>` unescaped (an extension manifest controls that string).
10. **Accessibility is above average with specific gaps:** per-turn actions revealed only by `:focus-within` so a screen-reader user tabs blind; exact message time is hover-only; `base.css:62` forces one full orb animation cycle even under reduced motion; the UX review's 75 axe nodes and sub-44pt targets remain advisory in CI.
11. **Dead code.** No-op ternary in `rememberShape` (`app.js:310`), unreachable return in `settingsTarget` (1560), `dev-reload.js` in the SW shell list, two notice channels (`say()` and `toast()`).
12. **Error states.** Legacy views have "Try again"; `renderHome`/`renderTasks` (`surfaces.js:114, 157`) render an empty-looking real layout after a failed first load, distinguished only by the banner. `openTask` fires four sequential awaited GETs before anything appears.

### Frontend architecture

Keep: pure render functions (`components.js`, `view.js`, `topology-view.js`), the pure domain modules (`nav.js`, `layout.js`, `status.js`, `settings-ia.js`, `reduce.js`), token CSS generated by `design.ts`, the token lint, the styleguide-coverage rule, `design-shots.ts`, and no bundler.

Change, in order of leverage: (1) one DOM-morph primitive (idiomorph, about 5 KB, no build step, or generalise the existing `morph` at `app.js:509`) replacing every `innerHTML` assignment, which deletes `keepEdits` and the typed/open captures; (2) one HTTP client (`core.request`) and one global event stream; (3) one store with subscriptions, slice by slice, starting with chat which already has a reducer; (4) incremental chat rendering once (1) exists.

Do not: adopt React/Svelte/Solid (forces a build step, splits the renderers from the styleguide pipeline, 40 UI tests tied to real DOM ids, a fold-posture matrix); adopt web components (shadow DOM breaks the single-CSS-variable token model); keep the status quo (each new surface adds another bespoke redraw-and-restore routine).

## 3. The architecture finding the reviews don't cover

`src/config.js:15-20` runs the chat model as:

```
claude -p --output-format stream-json --verbose --include-partial-messages
  --tools "" --strict-mcp-config --setting-sources "" --disable-slash-commands
  --no-session-persistence --system-prompt-file {system_file}
```

and `src/tools.js:1-6` documents the consequence: "The protocol is text so any agent_cmd can drive it: the model ends its message with one `<tool_call name="...">{json}</tool_call>` block and stops." `src/agent.js` spawns a fresh `/bin/sh -c claude …` for every round; `src/context.js:11` trims the transcript to 120,000 characters, oldest turns first.

What this costs, concretely:

- **No native tool use.** No JSON schema validation on arguments, no `strict` mode, no parallel tool calls (one per round by protocol), and a model that has been trained on native `tool_use` is asked to emulate it in prose.
- **No prompt-cache continuity.** Every round resends system prompt plus transcript through a new process. Claude Code caches the system prefix, but Nova's assembled prompt includes memory and day notes that change, and the transcript is re-serialised each time.
- **No access to Claude Code's tools, skills, hooks or MCP client.** The architecture doc's ADR-6 names MCP as the extension protocol; the capability inventory confirms "MCP servers and plugins still run no code." The one program on this machine that already speaks MCP well is the one Nova switches off.
- **Licensing.** The Agent SDK overview states Anthropic does not allow third-party developers to offer claude.ai login or rate limits for their products, and the headless docs recommend `--bare` with an API key for scripted use. NOVA-SPEC says Nova "is a general product other people can use." Those two statements need reconciling before anyone but the owner runs it.

The design intent (Nova owns tools and approvals; any stdin/stdout command can be the model) is sound. It can be kept while fixing the above:

1. **Expose Nova's tools to Claude Code as an MCP server** instead of a text protocol. Either in-process through the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`: `createSdkMcpServer` plus `tool()`), or as a stdio server passed with `--mcp-config` to `claude -p --bare`. Nova's approval gate becomes the SDK's `canUseTool` callback, which sees every call that nothing else resolved; Nova's ingest screen and receipts become `PreToolUse`/`PostToolUse` hooks; the session API keeps the transcript server-side so the cache holds.
2. **Keep the text protocol as the fallback adapter** for the `openai-compatible`, `custom-cli` and Ollama providers, where it is the only option. That preserves "any command works" without making it the primary path.
3. **Make Nova an MCP host** (ADR-6, EXTENSION-MODEL "MCP server (wrapped)"): a connector kind whose manifest names a stdio or HTTP MCP server, tools namespaced and permissioned like native ones, every result through the ingest gate. The owner already uses Calendar, Drive, Sheets, Gmail, Spotify, Cloudflare and Hugging Face connectors on claude.ai; each becomes a Nova connector for free.

## 4. Backend-to-frontend wiring gaps

### Not mounted at all

| Module | Routes | State |
|---|---|---|
| Cost caps | `GET /caps`, `PUT /caps/limits` (`src/core/caps/index.ts:329-333`) | `capsRoutes` is only re-exported (`index.ts:183`); `new Caps(` appears nowhere outside tests; `runner.caps` is initialised to `null` (`runner.js:108-111`) and never set. The only safety ceiling on autonomous spend is inert. |
| Diagnostics | `GET /diagnostics` (`src/core/diagnostics/index.ts:207-215`) | `diagnosticsRoutes` only re-exported (`index.ts:186`); `buildDiagnostics` called nowhere outside tests. |
| Test-clock ticks | `/triggers/tick`, `/capture/tick`, `/changes/tick` | `NOVA_TEST_CLOCK=1` only, by design. |

### Built, mounted, no door in the app and no chat tool

| Capability | Routes | What's missing |
|---|---|---|
| Receipts / egress log | `GET /receipts` | The privacy promise has a writer and no reader; Health shows counts only. |
| Foundry | `POST /foundry` | No UI, no tool. |
| Extensions | `GET/POST /extensions`, enable, disable, delete | No generic extension lifecycle UI (Skills is Era 2 and kind-specific). |
| Nova Computer | 9 routes in `computer/routes.ts` | A whole module with no door. |
| Service placement / deploy | `POST /services/placement`, `GET /services/devices`, `POST /services/devices/deploy` | None. Topology (#280) is the services surface but shows only existing eligible actions. |
| Home Assistant actions | states, service calls, settings (`home-assistant.ts:299-341`) | Connect/disconnect is wired; nothing else. |
| Webhooks | `POST /hooks/{name}` | The token is returned only by rule creation, which has no UI, so webhooks are unusable without curl. |
| Device inbox refusals | `GET /mesh/inbox/refusals` | None. |
| Ingest screen records | `/ingest/screens`, `/ingest/screens/{id}` | No browser of what was screened and why. |

### Partially wired

| Capability | Wired | Missing |
|---|---|---|
| Triggers (core rules) | Automations lists rules with pause, resume, delete (`surfaces.js:411-422`) | Create, edit, fire; firing records; the trigger engine is the headline feature and only pause/delete exist. |
| Proactive messages | Two Home banners (`surfaces.js:116-122`) | Inbox, history, quiet-hours control (`triggers.ts:73` Policy exists with no control). |
| Backups | Resilience summary, backup now, drill | Settings, recovery key, deploy, rollback. Health literally says "Choose one with PUT /api/v1/backups/settings" (`surfaces.js:378`). |
| Core memory | `store.memory` loaded (`surfaces.js:41`) but no renderer uses it; Memory view is Era 2 | Search, export, confirm, correct. |
| Coding / infra / network | Visible only as task sheets for an existing task; chat tools `code_change`, `infra_plan`, `network_change` | Run lists (`GET /coding|/infra|/network`), infra project and budget forms, network target and token forms, settle. The chat tools refuse to register projects and targets, so M10d is unstartable from the app. |
| Browser | Takeover reachable from a task sheet when `t.owner === 'browser'` (`surfaces.js:203-206`); sites; accounts via `account_change` | Task start, `DELETE /logins`, pending logins, flows library, `GET /browser`. |
| Providers | List, choice, enable, disable, config, test-run | `check`, `callback-token` (the n8n token cannot be regenerated), `policy`. |
| Models | GET, accept, pull, remove, disk, budget | Per-role assignment, wake (wake words shown at `models.js:78` but never called), prices, cloud, versions, refresh. |
| Vault | `PUT` inside provider setup | Names list, delete, reset. |
| Design systems | Apply, rollback, follow, contrast fix | Install (`POST /design-systems`), validate. |
| Profile | Most of Settings | `mesh.auto_failover_after_s` and quiet hours have no control. |
| Services backend | Settings › Services calls `GET /services/backend` | That route is a hardcoded stub (`backend: 'supervisor', switchable: false`). |

### Suspicions refuted (these are wired)

Memory candidates review (Era 2 `/api/memory`, `app.js:1023`); problems, playbooks and one-click repair in Health (`surfaces.js:351-366, 403`); decision-model choice in Settings (`models.js:182`); eval scorecards (`models.js:32`, `surfaces.js:1003`, so LEDGER line 164 is stale); standby and promotion (`surfaces.js:889-945`); device purposes editing (`surfaces.js:847-880`). Era 2 `/api/config` has no caller. No UI call targets a nonexistent route.

### Top 15 gaps to close, in order

1. Mount cost caps, construct `Caps`, set `runner.caps`, add the limits form and month spend in Health.
2. Mount diagnostics and add the Health download link (one spread, one anchor; already tested).
3. Backups settings and recovery key in Settings › Backups.
4. Rule editor in Automations: create, edit, fire, webhook token reveal.
5. Messages inbox and quiet hours.
6. Receipts and egress viewer.
7. Infra projects and network targets forms.
8. A Nova Computer view or chat tool.
9. Browser task start and the flows library.
10. Supervisor deploy and rollback in Health.
11. Coding, infra and network run lists in Tasks.
12. Memory view onto core routes (search, export, confirm, correct).
13. Provider `check`, `callback-token`, `policy` buttons.
14. Models per-role assignment, wake, cloud and prices.
15. Vault names list, delete, reset; Home Assistant states and services.

## 5. Design verdict

**It is no longer AI slop in the purple-gradient, Tailwind-default sense. It is still AI-built in the sense that matters: everything is competent and nothing is decided.** Stage 1 (#279) fixed the named symptoms (card radius 24 to 12, control radius 8, the composer is no longer a pill, one icon set at 1.5 stroke, 4 pt spacing lint, shadows down to one hairline level). What remains is a point of view.

Evidence, from the newest screenshots under `docs/screenshots/design-quality/after/` and `navigation-reachability-2026-11-02/`:

- **Everything is one weight.** `after/home-desktop.png` and `before/home-desktop.png` are nearly indistinguishable: Brief, Verified result, Memory, Nova is handling, Devices, System health are six identical glass rectangles with the same h3, icon, padding and tint. The one thing that happened (Verified result) is visually equal to "No brief yet".
- **The right column repeats the page.** Tasks shows "Nova is handling / All tasks" beside the Tasks view; Health shows "System health" beside Health. Three permanent cards on every desktop screen is dashboard furniture.
- **The rail orb is a flat disc with a ring.** The phone hero orb is genuinely good (depth, rim, soft glow); the 44 px rail version (`components.css:263`) loses all of it because the four-layer recipe doesn't scale.
- **Flat type.** Six sizes are defined; Home uses two effective tiers. In chat the largest type on the page is a date (`empty-date` uses h1, `components.css:448`).
- **The teal-on-teal background** (two radials plus a linear, `base.css:15-19`) under frosted cards, with a second blur on the rail and tabs, is the single most "dark-mode mockup" thing on screen.
- **The copy is the most distinctive asset** ("Nothing is done until Nova has checked the evidence; tap Verified to see it") and it is typeset like the chrome, so the voice doesn't land.

What is distinctive and should be protected: the phone hero orb; un-bubbled Nova turns with tail-less user bubbles; the rotated `ALLOWED` stamp (`views.css:625-632`); the typed status vocabulary and pills; the settings IA and search; the honest offline and stale banners; the composer after F0; the Topology view with hairline connectors, the first control surface that looks designed rather than assembled.

**The six themes.** Orb Teal is the only one with a rendering recipe. By their JSON values, Nova (`#0a0a0c` with `#6e8cf5`, Inter in the stack) and Aurora (`#5856d2`/`#7d7aff` on black or `#f5f5f7`) are the indigo-on-black "AI aesthetic" that DESIGN-SYSTEM §0.3 now lists as an anti-reference. Obsidian (amber on black, mono display) is a Linear/terminal cliché but coherent. Paper and Companion Light are near-duplicates; Companion Light is the only light theme with a reason to exist. Recommendation: Orb Teal lead, Companion Light finished as the light counterpart, Obsidian as the power option, retire Nova, Aurora and Paper. #279's "More designs · not yet at Nova's design bar" is the right interim.

**Ten changes that would most raise perceived quality**

1. Home hierarchy by weight, not count: one hero card (what needs you, or the latest verified result) at h2; everything else a plain hairline list. Delete the Brief card until a brief exists (`components.js:99-104` is a permanent placeholder, slop item 8).
2. Kill the always-on right column or make it contextual: suppress the card that duplicates the current page; collapse to nothing when all three say "nothing" (`renderAside`, `surfaces.js:139`).
3. Fix the rail orb: below 48 px drop the shade and swirl layers, raise the sheen, widen the glow, or render it as a two-layer SVG; verify at 44 px in the styleguide orb entry.
4. Background discipline: one radial behind the hero only; flat `bg/base` elsewhere; remove the second radial and the rail and tabs blur. Glass only on Home.
5. Use the type scale: group labels 11 px caps, row titles body 400, section titles h3 500, view title h1, nothing else bold. Give `font/display` a real display face; in Orb Teal it currently equals `font/body`, which is the cheapest way to stop looking like a system-font mockup.
6. Lists, not cards, for like things (§0.2): Health checks, devices, tasks within a group, settings rows.
7. Empty states that say something true and specific; prefer no card over a card that explains its own absence.
8. One accent per view: today icons, links, Verified pills, the active rail item, Send and the focus ring are all `accent/primary`.
9. Motion with intent: `rise` and `fade-in` on every card and paragraph (`views.css:60`, `components.css:673`) is decorative; keep motion for the orb, the toast and new turns.
10. Retire themes as above and finish Companion Light so "dark because no light design has reached the bar yet" stops being a visible confession in Appearance.

## 6. Plugins, MCP servers and skills for building Nova

What's on this machine today: Claude Code with `superpowers` 7.0.0 (7.0.1 shipped 2026-10-21), `frontend-design` and `code-review` from the official marketplace; no MCP servers in `~/.claude.json`; the repo has no `CLAUDE.md`, no `AGENTS.md` (Codex reads that), no `.mcp.json`, no `.claude/settings.json`. The builder packet (`START-HERE`, `OPERATING-RULES`) is the de facto instruction file, but nothing loads it automatically for either Claude or Codex.

Everything below was checked against its primary source (the official marketplace manifest or the project's own repository), not vendor roundups.

### Tier 1: install this week (official marketplace, Anthropic-authored, free)

| Plugin | Why for Nova | Command |
|---|---|---|
| `typescript-lsp` | 226 TypeScript files run directly by Node with no build; go-to-definition and live diagnostics instead of grep. | `/plugin install typescript-lsp@claude-plugins-official` |
| `security-guidance` | Warns on command injection, XSS and unsafe patterns at edit time. Finding 1 above is exactly its category. | `/plugin install security-guidance@claude-plugins-official` |
| `pr-review-toolkit` | Review agents for comments, tests, errors, types and simplification. OPERATING-RULES already requires independent adversarial reviews; this standardises one. | `/plugin install pr-review-toolkit@claude-plugins-official` |
| `code-simplifier` | For the 1,758-line composition root and the five duplicated loaders. | `/plugin install code-simplifier@claude-plugins-official` |
| `claude-md-management` | Generate and maintain a root `CLAUDE.md` from the builder packet; mirror it as `AGENTS.md` for Codex. | `/plugin install claude-md-management@claude-plugins-official` |
| `hookify` | Encode the mechanical rules as hooks: `lint:tokens` on any `ui/` edit, refuse `git rebase` on eval branches, require a LEDGER entry in a merge PR. | `/plugin install hookify@claude-plugins-official` |
| `playwright` | A real browser for design review loops against the preview on 4318, with WebKit as well as Chromium. This host's Chromium can't start (no `libnspr4`), so either install that library or point it at the Docker route Nova's UI tests already use. | `/plugin install playwright@claude-plugins-official` |
| `mcp-server-dev`, `agent-sdk-dev` | The two plugins for section 3: building Nova's MCP host and moving the chat loop onto the Agent SDK. | `/plugin install mcp-server-dev@claude-plugins-official` |
| `superpowers` 7.0.1 | Already installed; update. Also distributed for Codex, so the builder and Codex can share one workflow. | `/plugin update superpowers` |

Optional from the same catalogue: `context7` (live library docs; modest value since Nova has almost no dependencies), `modern-web-guidance` from Google Chrome (web best practices for the vanilla-JS UI), `ralph-loop` (autonomous iteration loops for long milestones; only with the cost caps mounted first), `chrome-devtools-mcp` (performance traces and console; needs a working Chrome).

### Tier 2: the design-quality stack

| Tool | Verdict |
|---|---|
| **impeccable** (`pbakaus/impeccable`, Apache-2.0, about 100k stars) | **Adopt.** Twenty-four design commands (`critique`, `audit`, `polish`, `typeset`, `layout`, `quieter`, `distill`, `harden`, `adapt`) and 62 deterministic slop detectors that need no model: Inter everywhere, purple-to-blue gradients, nested cards, cramped padding, skipped headings. Its design hook scans UI files the agent edits and reports before the agent calls the work done. Map its rules onto DESIGN-SYSTEM §0.4's eight slop items so the per-PR slop check becomes mechanical instead of self-reported. `impeccable init` writes `PRODUCT.md`; `document` writes `DESIGN.md` from the existing tokens. Install: `/plugin marketplace add pbakaus/impeccable`. |
| **frontend-design** (official) | Already installed. Keep; it sets the aesthetic bar at generation time, impeccable checks it afterwards. |
| **ui-ux-pro-max** (`nextlevelbuilder`, MIT, about 144k stars) | **Use once, don't live in it.** A BM25-searchable database of 79 styles, 192 palettes, 74 font pairings and 192 industry rules. Useful for one exploration session on Orb Teal's display face and Companion Light's palette. Its "industry pattern" framing pulls toward the generic looks §0.3 bans, so it is a reference, not a rule source. |
| **superdesign**, **Wonder**, **Figma MCP** | **Skip unless the owner designs in a canvas.** The stage-1 workflow approves rendered styleguide entries as screenshots, which Playwright already produces. A Figma loop only pays if the owner is drawing in Figma. |
| The claude.ai **design** plugin already enabled (critique, design-system management, accessibility audits) | Use it for the owner-side UX review that OPERATING-RULES says scores the slop list independently. |

### Tier 3: memory and continuity for the builder

The handoff note is 224 lines of tacit knowledge that nearly got lost between builders. Two options, both local:

- **episodic-memory** (`obra/episodic-memory`, MIT): semantic search over Claude Code and Codex transcripts, embeddings computed locally with Transformers.js, index in SQLite with sqlite-vec, MCP `search` and `read` tools. Fits Nova's local-first ethos and indexes both harnesses. `/plugin marketplace add obra/superpowers-marketplace` then `/plugin install episodic-memory@superpowers-marketplace`. **Recommended.**
- **claude-mem** (`thedotmack/claude-mem`, Apache-2.0, about 111k stars): richer (observations compressed by a model, Chroma vector search, a web viewer) but it pushes a hosted "observer" with a 30-day trial and falls back to your plan afterwards. Heavier than this project needs. **Skip.**

Claude Code's own auto-memory is already on for this project; keep it for the short facts.

### Tier 4: for Nova the product

These are the plugins that make Nova smarter rather than the builder:

1. **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) as the primary chat adapter, per section 3: in-process MCP tools, `canUseTool` for approvals, hooks for receipts and ingest, sessions for cache continuity, subagents for `delegate`. Keep the text protocol for non-Claude providers.
2. **An MCP host in the extension model** so any stdio or HTTP MCP server becomes a Nova connector behind the ingest gate. Start with the ones the owner already uses on claude.ai.
3. **Nova's own tools published as an MCP server**, so Claude Code, Codex and the owner's other agents can call into Nova (memory, schedules, tasks) with Nova's approval gates intact. That is the "agent OS" story: Nova as the hub other agents plug into, not only a chat window.

## 7. Suggested order

1. Finding 1 (secrets in the `exec` environment) and finding 2 (ledger double-run) this week; both are small.
2. Mount cost caps and diagnostics (wiring gaps 1 and 2); they are written and tested.
3. Root `CLAUDE.md` and `AGENTS.md` from the builder packet; install Tier 1; update Superpowers; add impeccable with its rules mapped to §0.4.
4. Frontend changes (1) and (2): one morph primitive, one HTTP client. Do this before design stage 2 so the two don't collide in `app.js`.
5. Design stage 2 with the ten changes in section 5, Home first.
6. The Agent SDK adapter behind the existing `agent_cmd` abstraction, measured against the text protocol on the regression evals before it becomes the default.
7. The MCP host, then the rest of the wiring list in order.
