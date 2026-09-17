# The tagged releases — what each Nova was, and what it could do

Written 2026-09-17 by reading the tag trees, not from memory. Every claim here
was read out of the tagged source or the release notes; where something was not
checked, it says so.

## Why this exists

`CLAUDE.md` tells every session that `v0.1.0-alpha` (v1) and `v0.5.0-alpha`
(v2 final) are the reference tags to mine for ideas. **That list is
incomplete.** The repository carries eight release tags, and the two most
recent are newer and richer than either of the named ones:

| Tag | Date | Line |
|---|---|---|
| `v0.1.0-alpha` | 2026-05-09 | v1 — Aria Labs |
| `v0.1.1-alpha` … `v0.4.0-alpha` | 2026-05 → 07 | v1 → v2 increments |
| `v0.5.0-alpha` | 2026-07-13 | **v2 final** |
| `v0.6.0` | 2026-07-21 | v3 — MCP client |
| `v2.0.0-alpha` | 2026-08-09 | **v3 final** |
| `archive/v3-vite-scaffold` | — | the dead `nova-v3-dev` lane |

Only `v0.5.0-alpha` has GitHub Release notes. The rest had to be read from
their trees.

**One useful shortcut, verified:** `ROADMAP.md` on today's `main` is
**byte-identical** to `ROADMAP.md` at `v2.0.0-alpha` (blob `9a11142`). v3's
full 51-item roadmap and its 49 `docs/plans/*.md` are already on disk — v3
needs no archaeology, only reading.

---

## v1 — `v0.1.0-alpha`, 2026-05-09

**"Nova is a self-directed autonomous AI platform."** Built by Aria Labs,
licensed PolyForm Noncommercial with commercial licensing offered. This was a
product, with a marketing site (`website/`) and a docs domain.

### Architecture — eleven services

| Service | Port | Role |
|---|---|---|
| dashboard | 3000 | React admin UI |
| orchestrator | 8000 | agent lifecycle, tool dispatch, pipeline queue, MCP |
| llm-gateway | 8001 | Anthropic, OpenAI, Ollama, Groq, Gemini, Cerebras, OpenRouter |
| memory-service | 8002 | embedding + Engram graph over pgvector |
| chat-api | 8080 | WebSocket streaming for external clients |
| cortex | 8100 | **the autonomous brain** — thinking loop, goals, drives, budget |
| intel-worker | 8110 | RSS / Reddit / GitHub-trending poller |
| voice-service | 8130 | STT/TTS proxy (OpenAI, Deepgram, ElevenLabs) |
| recovery | 8888 | backup / restore / factory reset / service management |
| postgres | 5432 | pgvector — agents, tasks, pods, config, engrams |
| redis | 6379 | agent state, task queue, rate limiting |

### Capabilities v4 does not have

- **An autonomous goal loop.** Cortex decomposed a goal, executed, evaluated,
  re-planned, with drives and a budget tracker. v4 has timers, beats and
  checks — scheduled work — but nothing that sets and pursues its own goal.
- **A recovery service** with backup, restore and factory reset behind an API.
- **`./install` and `./uninstall` wizards.** Three inference modes
  (hybrid / local-only / cloud-only), starter-model pulls, and an uninstaller
  that reported disk reclaimed and deliberately left shared upstream images
  alone.
- **IDE integration** — an OpenAI-compatible endpoint at `:8000/v1` for
  Cursor, Continue.dev and Aider, plus `editor-vscode/` and `editor-neovim/`.
- **`screenpipe-bridge/`** — desktop capture.

### UI — 29 dashboard pages

`AIQuality`, `About`, `AgentEndpoints`, `AuditLog`, `Brain`, `CapturePage`,
`Chat`, `Editor`, `Editors`, `Expired`, `Friction`, `Goals`, `Integrations`,
`Invite`, `Keys`, `Login`, `MCP`, `Models`, `PendingApprovals`, `Pods`,
`Recovery`, `Rules`, `Settings`, `Skills`, `Sources`, `Tasks`, `Usage`,
`UserProfile`, `Users`.

Note `Users` / `UserProfile` / `Invite` (multi-user), `Keys` (secrets),
`MCP` / `Integrations`, `Recovery`, `Friction` (a friction log users filed
into), and `AuditLog`.

### The design system — and it survived

`DESIGN.md` (197 lines) is a full design system: "Industrial/Utilitarian —
function-first, data-dense". Mood: **"Calm control room… a well-engineered
instrument panel — precise, readable, and warm enough to spend hours with."**
References Vercel, Linear, W&B.

- **Plus Jakarta Sans** for display/body ("humanist shapes give warmth that
  geometric fonts can't"), **Geist Mono** for data with tabular numerals.
- A **custom teal** primary — deliberately not stock Tailwind — with amber
  reserved for *cognitive states* ("signals the AI is thinking").
- Warm **stone** neutrals, dark-first, `--font-scale` for accessibility.

**This is not dead prior art.** v4's `apps/web/src/index.css:32-39` carries
`--accent-500: 25 168 158` — `#19A89E`, v1's `teal-500`, exactly. The v1
palette is the v4 palette. The amber-for-thinking convention also survives, in
the Nova orb and the home-screen icon.

### Its own roadmap (`TODOS.md`)

Deferred work, each item with what / why / how / effort / date. Cortex autonomy
gaps led: goal decomposition into subtask DAGs, **learning from failures**
("Cortex writes reflections to engrams after each cycle but never queries them.
It repeats the same mistakes"), a maturation pipeline executor, and — noted
without irony — "**zero test coverage on the autonomous brain**".

---

## v2 — `v0.5.0-alpha`, 2026-07-13

Same eleven-service architecture, matured. Adds `browser-worker/`,
`observability/`, `architecture/`, and an `InboxPage` and `Monitoring` page to
the dashboard. Drops `screenpipe-bridge` and the `baseline-*` benchmark
directories.

The only tag with release notes, titled **"Models you can trust, safety rails
that hold."**

### What it shipped

- **Validated live model discovery** — key rejections surface as badges,
  retired models are delisted, and the provider Test button survives rotten
  free-tier slugs and hung backends.
- **"No pin may ever point at a model that doesn't exist"** — pod, agent and
  tier-hint assignments validated on write (422); deleting a model in use
  returns 409 with a repoint dialog.
- **A backend pool** — local inference as named backends (bundled containers
  plus user-named remotes like `remote-vllm-a`), each with its own catalog and
  health; requests route to the backend that actually serves the model.
- **Soul sync** — the persona in Settings and the memory bundle's
  `self/soul.md` two-way synced.
- **MCP lazy tool loading** — installed integrations cost ~15 prompt tokens
  until used; agents pull a server's tools in on demand via one meta-tool.
- **Per-stage wall-clock kill** — a runaway pipeline stage is actually
  cancelled, in-flight LLM calls and tool rounds stopped, with a retryable
  error. Plus a reaper liveness fix (it had been force-failing healthy tasks at
  ~150 s on CPU-local models), a tool idempotency ledger and a cron
  transactional outbox.
- **Cancel-and-replace** — sending while Nova is responding replaces the
  in-flight answer instead of returning 409.
- A config audit that removed **placebo context sliders**: "if the UI shows a
  knob, it works."

### Deliberately not carried to v4

The notes also describe approvals: `/approvals` showing recently decided items,
Inbox messages linking to live approval status, expired approvals swept. The
owner's 2026-09-03 ruling (`docs/plans/rebuild/no-approvals.md`) removed that
whole shape from v4, and `services/core/tests/test_no_approvals.py` is what refuses its
return. It is recorded here as history, **not** as a candidate.

---

## v3a — `v0.6.0`, 2026-07-21

The rewrite. Eleven services collapse into `backend/` + `frontend/` plus
sidecars (`inference-control`, `mcp-runner`, `kokoro`, `whisper`, `searxng`,
`tailscale`). The first tag to carry a root `ROADMAP.md`.

Its release commit (`b61b465`) shipped two things:

- **The MCP client** — register and approve HTTP **and** stdio MCP servers from
  Settings → Tools, with a lazy tool index and meta-tool, per-agent
  `mcp:<server>/<tool>` grants (nothing auto-granted), and an always-inject
  toggle. Servers are spawned by the **`mcp-runner` sidecar — no docker socket,
  no DB credentials**. Migration 031.
- **Model storage relocation** — move the bundled Ollama LLM store and the
  Kokoro/Whisper voice models to any host path (external drive, NAS, bigger
  disk) with no `.env` or compose edits. The `inference-control` sidecar
  migrates non-destructively and rebinds each service, driven by a **read-only
  `/state` control file so a compromised chat client cannot set paths**.

---

## v3b — `v2.0.0-alpha`, 2026-08-09 — the last tag

Adds `coder/`, `e2e/`, `git-landing/`, `media/`, `workloads/`, `.githooks/`.

Its tip commit is **settings auditing**: `backups.every_hours` had vanished
from the settings table on 2026-08-08/09 — nightly backups silently off, found
only because the heartbeat complained about staleness — and nothing recorded
what removed it. Every settings write now leaves a `capability_events` row, an
unattributed caller records as "backend (unattributed)", and `clear_value()` is
the only sanctioned delete, so a future removal is audited by construction.

That commit is a good summary of what v3 became: a system that records what it
did to itself.

### Its roadmap is already on disk

51 items — see `docs/archive/ROADMAP-v3.md`. The ones that matter for v4:

| # | Item | v3 state |
|---|---|---|
| 19 | MCP client | shipped (`v0.6.0`) |
| 31 | Data backups — snapshot / restore / factory reset | spec'd, Wave 1 |
| 32 | Secrets management | **phases 1–3 shipped 2026-07-30** |
| 41 | The Vault — Obsidian-style view over her files | — |
| 43 | Computer use — control the desktop | spec'd |
| 45 | Heartbeat — she looks around on her own | spec'd |
| 48 | Managing machines — linux, windows, macos | spec'd |
| 49 | Public access and time-boxed guests | spec'd |
| — | `speaker-id.md` — voiceprints, per-speaker persona | approved, not built |

---

## What v4 carries, and what it does not

Checked against `main` at `0996a31`. **Three things I expected to be gaps are
not** — which is the reason this section reads from code rather than from the
v3 roadmap.

### Already in v4 (do not re-propose)

- **Onboarding.** `apps/web/src/pages/onboarding/OnboardingWizard.tsx` — an
  eight-step wizard: Welcome → CreateAccount → Timezone → HardwareDetection →
  ChooseEngine → PickModel → Downloading → Ready. Plus `./install` →
  `deploy/install.sh` (preflight → hardware → secrets → up → health table).
  This is *better* than v1's shell wizard, not a regression.
- **The design system.** v1's palette and type scale survive in
  `apps/web/src/index.css`.
- **A quality page.** `apps/web/src/pages/quality/AIQualityPage.tsx` exists —
  S26 is about what the corpus *measures*, not about building a page.
- **Activity / audit.** `/activity`, backed by `services/core/app/activity.py`.
- **The person model.** `people` with `role IN ('owner','adult','kid','guest')`
  and a unique index enforcing one owner
  (`services/core/migrations/002_core_schema.sql:4-14`); `person_id` scoping on
  conversations, turns, timers, queued messages and attachments.

### Genuinely absent from v4

| Capability | Where it existed | v4 evidence |
|---|---|---|
| **Encrypted secret store** | v3 #32, shipped 2026-07-30 | gateway stores provider keys as plaintext `text` (`services/gateway/migrations/003_providers.sql:22`), masked only on read (`providers.py:62`). No `cryptography` import anywhere in `services/gateway/app/`. |
| **MCP client** | v2 (lazy loading) + v3 `v0.6.0` (full) | no `mcp` module in `services/core/app/`; `mcp-runner/` is v3 leftover, not wired to v4 core. |
| **A second person** | v1 `Users`/`Invite` | `/register` refuses once any person exists (`auth_api.py:79-83`); no route creates another; Settings has five tabs, none for people. |
| **Backups / restore / factory reset** | v1 `recovery` service, v3 #31 | nothing in `services/`. |
| **Autonomous goal loop** | v1 `cortex` | v4 has timers/beats/checks — scheduled, not self-directed. |
| **A files/Vault view** | v3 #41 | `/files` exists; the Obsidian-style graph does not. |
| **Friction log** | v1 `Friction` page | nothing. |
| **IDE integration** | v1 `:8000/v1` + editor plugins | nothing. |

### Not carried, on purpose

Approvals, consent cards, dispositions, earned autonomy, per-agent or
per-device grants, `fs_roots` and deny-roots — every authorization shape from
v1/v2/v3. Owner ruling 2026-09-03
(`docs/plans/rebuild/no-approvals.md`); `services/core/tests/test_no_approvals.py` refuses
their return. v1's `PendingApprovals` page and v2's `/approvals` are history,
not backlog.

---

## Two housekeeping facts this pass turned up

1. **`README.md` on `main` still describes v3** — "Brain Home Screen +
   Multi-Agent Chat", `frontend/`, "Settings → Models → Providers". It was last
   touched 2026-08-07, before the v4 lane. `CLAUDE.md` says "Read `README.md`
   for what works", which currently points at the wrong product.
2. **`main` carries both codebases.** v4 added `apps/`, `services/`, `deploy/`,
   `install`, `tests/` and `.github/` on top of v2.0.0-alpha's tree and
   **removed nothing** — `backend/`, `frontend/`, `coder/`, `git-landing/`,
   `media/`, `workloads/`, `inference-control/`, `mcp-runner/` are all still
   v3's. Useful as a mining source; confusing as a working tree.
