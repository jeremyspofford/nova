# S50–S52: one Devices page, one Nova page, devices she can see into

Designed 2026-10-06 with the owner in conversation. **Low priority and
unscheduled** (owner, 2026-10-06: "it's low priority, I'd rather do other things
instead"). Nothing here is built. Each slice becomes an epic under `.epics/`,
run by the `epic-tdd-loop` skill, once the owner places it in the order.

The owner asked for three things:

- the Models/Devices mess sorted out, so that every device lives on the Devices
  tab;
- one place to see her skills, tasks, rules, soul, goals, agents and
  connectors, which she can change too;
- more knowledge of each device: models, what it's for, what she's done there,
  health, uptime, errors, networking, and the router.

## What exists today (read 2026-10-06, `main` at 34f1cdb3)

Device data appears in three places that share no code:

| Where | Backing data | Shows |
|---|---|---|
| Models page | `GET /models/catalog` | the machine only as an id prefix (`hub:`), GPU fit, probe VRAM. Pull and remove always act on the bundled ollama |
| Settings → Models → Machines | gateway `engines`, `engine_models` | serving, compute, models held, routing toggle |
| Settings → Devices | core `devices` (+ `facts` jsonb) | online state from `last_seen`, OS, hostname, agent version; rename and revoke |

"Machine" means two things in the UI, and nothing joins a device's
`machine_uid` to an engine. The installed models are listed twice. Two things
are recorded but never shown: `device_audit` (a hash-chained log of what Nova
did on a device) and the network interfaces in `facts`.

Configuration:

| Kind | Stored | Owner sees | She changes |
|---|---|---|---|
| Skills | `skills` + `<WORKSPACE_ROOT>/skills/*.md` | `/skills`, full edit | no (only `load_skill`, `run_skill`) |
| Schedules | `timers` | `/schedules`, no create | `create_timer`, `cancel_timer` |
| Agents | `agents` | `/agents`, full edit | full CRUD |
| Tools | `tools.REGISTRY` (code) | only inside the agent form | no |
| Soul (persona) | hardcoded, `chat.py` "You are Nova…" | no | no |
| Rules | hardcoded, `stable_system_prompt` | no | no |
| Goals | not built (S34) | — | — |
| Connectors / MCP | not built (S37a in progress) | — | — |

## S50 — one Devices page

**One entry per physical computer** (owner's choice A, 2026-10-06). The Dell
is one card whether it runs the agent, an inference engine, or both.

- **Join.** Match a `devices` row to an `engines` row by `machine_uid` (the
  device reports it in `facts`; the engine needs to report it too). A device
  with no engine is an agent-only card, and an engine with no device is a
  model-host-only card. A match is never guessed from hostname. If there is no
  `machine_uid`, the two stay as separate cards.
- **Card:** name, online/stale/offline, OS, a role chip (agent, model host or
  both), GPU and VRAM, model count, **storage (each drive: used and free)**,
  last seen.
- **Device page** (a full page, not a modal; mobile pages-not-modals):
  - Overview: hostname, OS, agent version, paired at, rename, revoke.
  - Models: the models it holds, the serving toggle, and pull/remove aimed
    at **this** machine.
  - Storage: every volume, with mount or drive letter, used, free and total.
  - Activity: `device_audit` read newest first (capability, summary, ok, exit
    code, time). This needs a new read endpoint.
  - Network: interfaces from `facts`.
- **The Models page** keeps the catalog only. The Machines section leaves
  Settings → Models, and a "where" column on the catalog links to the device
  page.
- **Agent change (novad):** today `platform.Disk(path)` reads one volume, on
  demand, through `system.info`. S50 enumerates all volumes on Linux, macOS and
  Windows and reports them in `facts`: at connect, then every few minutes. A
  volume the agent cannot read is reported with its error, never left out.
- **Her side:** she already reads devices through the `device_*` tools. Add
  storage and the audit read to what `device` facts return to her, so what the
  page shows she can also see.

Done when: the Dell shows as one card with its models, storage and activity;
pull/remove on its page act on the Dell; the Models page has no machine
section; and she answers "how much space is left on the Dell?" from a tool
call, checked in `turn_spans`.

## S51 — the Nova page (her configuration, seen and changed)

**This slice absorbs S37b** ("her own configuration as data", Q11, answered
2026-09-30: *her instructions and typed settings are data she changes with a
tool; compose and nginx stay code*).

- **One page, `/nova`, with a section per kind:** soul, rules, skills,
  schedules, agents, tools, goals, connectors. Each section shows what exists,
  a one-line purpose, and an edit link to the existing page where one exists
  (`/skills`, `/schedules`, `/agents`). A kind that isn't built yet shows as an
  empty section that names its slice ("comes with S34"). The page never shows
  one as present when it isn't.
- **Soul and rules become data.** They move out of `chat.py` into tables. Every
  revision is a row with who wrote it (owner or Nova), when, and the text. The
  prompt is built from the current rows. The owner edits them on the page. She
  edits them with `set_soul` / `add_rule` / `update_rule` / `retire_rule`. The
  page shows the history and a revert. A rule she wrote takes effect at once
  and shows in the trace (the Q11 downside, accepted).
- **Her missing writes:** `create_skill` and `update_skill` (the table row and
  the file together, so they can never disagree), and a create button on
  `/schedules`.
- **Tools** get a read-only section listing `tools.REGISTRY`, the live list.
- **Goals** (S34) and **connectors** (S37a) fill their sections when they land.
  They are not built here.
- No approvals: nothing she writes waits on the owner (`no-approvals.md`).
  Honesty still applies. A config write returns what is now stored, read back
  after the write, and a write that cannot be read back fails with an `Error:`
  that says so.

Done when: the owner sees all eight sections on `/nova`; asked in chat, she
adds a rule and the next turn's prompt carries it (checked in `turn_spans`);
she creates a skill that appears on `/skills`; and her change to the soul shows
in the history with her as author.

## S52 — devices she can see into, and the router

The parts that need new collection on the agent. S50 already covers the activity
log, network interfaces and storage.

- **Health over time.** The agent reports CPU, memory, GPU, uptime and recent
  errors (system log errors, agent errors) on a schedule. Core keeps a bounded
  history. The device page shows the current values plus a short trend, and
  she gets a tool to read it.
- **"What it is mostly used for."** She writes a short summary from the
  device's facts, installed apps, the models it holds and her own activity on
  it. The page shows the summary with the date she wrote it and what it was
  based on. It is refreshed by a job, not on every page load.
- **What it connects to.** Listening ports and established connections, read
  by the agent and shown on the device page.
- **The router.** Not built for one router (owner: "I may get a new one and
  other people won't all own the one I have"):
  - **One interface.** Read WAN status, clients, DHCP leases and port
    forwards. Change port forwards, DHCP reservations and Wi-Fi settings, and
    reboot. The page and her tools only ever see this interface.
  - **Drivers behind it**, picked by detecting the router:
    1. **Browser first** (the owner agreed 2026-10-06). She drives the
       router's own web UI with her browser (S38), so it works on any router,
       ISP boxes included. **Depends on S38.**
    2. **Generic discovery + UPnP IGD.** Read-only, and works on most routers
       with no login.
    3. **API drivers per make**, TP-Link first (the owner has an Archer
       BE550), then OpenWrt, UniFi and OPNsense. Each is its own small slice.
  - **A way back from bad changes.** Before a change she saves the current
    setting. After it, she checks that the router and the internet are still
    reachable. If not, she restores the saved setting and says what happened.
    This is a check on whether the change worked, not a permission gate.
  - **Owed spike:** does the open-source `tplinkrouterc6u` library work with
    the BE550? It was not confirmed on 2026-10-06 (a search found only product
    pages). Test it against the owner's router before planning driver 3.

Done when: the Dell's page shows a health trend and her written summary; asked
in chat, she lists the router's connected clients and adds a port forward
through the browser driver, checked in `turn_spans`, and a deliberately bad
change is rolled back with her saying so.

## Order and dependencies

- S50 depends on nothing. It is the smallest, and it is where S52's pages go.
- S51 depends on nothing. It pulls S37b forward from "after S34". Goals and
  connectors join it when S34 and S37a land.
- S52 needs S50's device page, and its router part needs S38.
- The owner places all three in the order. As of 2026-10-06 they sit after the
  committed order (S42b → balances → S30b → S46a → S46c → the doing lane).
