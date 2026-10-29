# Ledger

Decisions, dependencies and deviations, newest first within each section.

## Dependencies

Runtime: **none**. The server, runner, markdown renderer and tests use Node 22
built-ins only.

| Dependency | Kind | Why |
| --- | --- | --- |
| `playwright-core` 1.56.1 | dev | Drives Chromium for `npm run shots` (golden screens, keyboard path, budgets); no bundled browser download. |
| `claude` CLI | external | The default `agent_cmd`. Swappable by config; nothing in Nova depends on it. |

## Decisions

**2026-10-29 (M1): chat honors the privacy mode; the model command declares
its egress.** Found after the M1 gate passed: setup promised "nothing leaves
this machine", but chat still defaulted to a cloud model. Now `agent_egress`
(`none` | `local` | `remote`, from `NOVA_AGENT_EGRESS` or `agent_egress` in
`nova.config.json`) says where the model command sends conversations, and
undeclared counts as `remote`. With a local-only profile a remote model is
never started: the person gets a plain error saying nothing was sent, and
how to change it. Setup says up front when the configured chat model is a
cloud one. In local-only, tools that reach the internet (web, Gmail) are
not offered; `exec` still asks every time. Consequence: a new user who
keeps local-only has no chat until a local model is configured (M6 makes
that easy). That's the honest trade, per the non-negotiable that local-only
never falls back to cloud.

**2026-10-29 (M1): the core is TypeScript run directly by Node, inside the
same server.** `src/core/` is the modular-monolith core (ADR-1). Node 26
strips types natively, so there is still no build step; `tsc` only
typechecks (`npm run typecheck`). The existing server mounts the core at
`/api/v1` behind its existing loopback, Host and `X-Nova` guards: one
process, one Nova, not a second app beside the first. Only `core/index.ts`
may be imported from outside the core (a test enforces it). The JavaScript
modules move to TypeScript as they are touched. `engines` is now Node >=26,
the version actually tested.

**2026-10-29 (M1): SQLite through `node:sqlite`, no ORM.** Structured state
(profile, ledger, extensions, problems) is in `~/Nova/nova.db` (ADR-4).
Migrations are forward-only and checksummed, with a backup before every
upgrade; rollback is restoring that backup. Ported from Era 1's storage
package without drizzle. The database, logs, backups and extension data
stay out of the home's git history.

**2026-10-29 (M1): the task envelope gains one optional field, `inputs`.**
CONTRACTS §1 lists the brief's fields; a deterministic worker (no model)
can't act on a plain-language goal alone, so `inputs` carries its
structured parameters. Optional and additive, so envelope version stays 1.
Recorded here as the contract note the packet asks for.

**2026-10-29 (M1): a task can't be created without an evidence
requirement, and unknown evidence fails.** "Done without evidence is not
done" (NOVA-SPEC §3) is enforced at creation, and the verifier fails any
evidence kind it has no checker for, rather than passing it. Read-back is
the first checker: Nova re-reads the target itself.

**2026-10-29 (M1): setup is a scripted interview.** It has to work before
any model is configured and with no network (the M1 gate is local-only), so
it doesn't use one. Each answer is written to the profile as it is given;
unclear answers are asked again, never guessed. A model-assisted version
can replace the parsing later without changing the records it writes.

**2026-10-29 (M1): the persona moved out of `system/system_prompt.md`.**
"Who you are" is now rendered by `src/core/identity.ts` from the fixed
charter plus the profile (name, tuning), and the chat runner gets it from
the core. The old Truth / Respect / Restraint values are kept, as the
charter and the speech rules.

**2026-10-29 (M1): known debt, owned.** Era 2's helpers and schedules still
run outside the ledger, so for now there are two records of background
work. Schedules move onto the ledger in M2 (its gate requires it), and
helpers with them. The ledger runs one task at a time. A timezone set in
setup reaches the chat and scheduler side on the next restart.

**2026-10-29 (M0): the builder packet governs; the current tree is the base.**
From here on `docs/builder-packet/` is the authoritative design, and where it
and this ledger disagree, the packet wins. The build continues from this tree
(Era 2) rather than restoring Era 1: it is the owner's deliberate clean slate
(`7ea842b5`), it is small and fully tested, and restoring Era 1's ~465k lines
wholesale would break the packet's per-component reuse rule. Era 1 components
whose design already matches the contracts (device pairing, the secrets
vault, browser takeover, the migration runner) are ported in the milestone
that needs them, with their tests and without their framework dependencies.
Evidence: `docs/inventory/M0-DELTA.md`.

**2026-10-29 (M0): CI runs on every PR; the toolchain is pinned.** Nothing
ran the suite on GitHub before. `.github/workflows/ci.yml` runs the token
lint, a parse check of every JS source (not a typecheck: there are no types
until the TypeScript core lands), the theme contract, the tests and
`npm audit`. Node 26.3.1 is pinned in `mise.toml` and CI installs it from
there, so local and CI match.

**2026-10-21 (Phase 2): memory is kept with blocks, not tools.** The model
ends its reply with `<remember>`, `<note>` and `<forget>` blocks; the runner
strips them from the stream and applies them before `done`. A tool call per
memory would cost a model round trip (~1.5 s each). Entries stay markdown
bullets with a trailing `<!-- id=… from=… at=… -->` comment, so they remain
readable and editable by hand, and the Memory view, corrections and forgetting
all point at the id.

**2026-10-21 (Phase 2): session logs record memory by id only.** The words
live in the memory files; conversations look them up. Forgetting therefore
removes a memory from every conversation view too.

**2026-10-21 (Phase 2): forgetting a memory forgets matching day notes.**
Same exchange and one shared word stem, or most of its word stems anywhere.
Otherwise search would bring it back.

**2026-10-21 (Phase 2): memory stays out of the home's git history.** The
home folder's `.gitignore` excludes `MEMORY.md` and `memory/*.md`, so
forgetting leaves no copy in old commits, and no history is ever rewritten.
Conversations and standing files keep their audit trail. Agreed with Jeremy
in the thread.

**2026-10-21 (Phase 3): skills are playbooks, loaded by their words.** A
skill is `SKILL.md` with front matter (`name`, `about` for the person, `when`
for the model, `words`, `needs`, `try`) and a markdown procedure. Nova ships
two in `skills/`; installing copies the folder into the home. When a message
contains one of a skill's `words`, the runner loads its playbook (and the docs
of the connectors it needs) before the first model call, which saves a round
trip. Every installed skill is also listed, so the model can load one with
`use_skill` when the words miss. Real model: "Anything I need to deal with
from overnight?" matched nothing and the model loaded Email summary itself.

**2026-10-21 (Phase 3): Nova reads Claude's skill format, and people can add
their own.** Jeremy asked for plugins like Claude's and ChatGPT's. Skills are
the part that fits Nova now: a `SKILL.md` with only `name` and `description`
loads (the description is both the summary and the trigger), and its other
files are copied and listed to the model. Adding takes a folder or a .zip
(read with a small zip reader in `src/zip.js`, no dependency), capped at 200
files and 5 MB, refusing name clashes and paths outside the folder. An added
skill is trusted instructions, not code: scripts only run through `exec`,
which always asks. MCP connectors are a later phase.

**2026-10-21 (Phase 3): skills and sign-ins stay out of the home's history.**
`skills/` and `connectors/` join the memory files in the home's
`.gitignore`, so removing a skill leaves nothing in old commits and no token
is ever committed. Conversations still record which skill they followed (by
name), and show "since removed" afterwards.

**2026-10-21 (Phase 3): Gmail connects with an app password, over IMAP;
your own OAuth client is the Advanced way.** Jeremy found the OAuth-client
setup (Google Cloud project, consent screen, Desktop client, JSON) too much
for anyone to do. The one-click "Connect" other assistants offer needs a
Google-verified app; Gmail scopes are "restricted", so that means Google's
review (weeks) and a yearly third-party security assessment, and until then a
warning screen and a 100-user cap. Not now. An app password takes about two
minutes and no Google Cloud at all. Costs: it needs 2-Step Verification, it
opens the whole mailbox (no read-only), and work or school accounts often
can't make one, which is what Advanced is for. The OAuth path (PKCE, loopback
redirect, so localhost only) stays as it was, now with `gmail.modify`.
Connecting one way disconnects the other. This reverses the earlier call to
reject IMAP; what kept it safe is below.

**2026-10-21 (Phase 3): Gmail drafts and organizes; it never sends or
deletes.** Jeremy asked for actions. Drafts, archive, labels and read state
are all reversible from Gmail; sending and deleting aren't, so Nova has no
code for either (no SMTP, no delete call). Every draft and change waits for
the person on an approval card that shows the exact draft or the exact
messages, worked out before asking; a draft or change that can't be worked
out (a gone message, a label that doesn't exist) fails before the card.
Reading uses `BODY.PEEK`, so it never marks mail read.

**2026-10-21 (Phase 3): after mail is read, going online asks first.** Email
is outside content, and a malicious message can ask the model to put mailbox
details into a URL. In a conversation where Gmail has been read, `web_fetch`
and `web_search` wait for the person's approval. Real model: told to "do what
the security email says", it read the email, declined, and explained why.

**2026-10-21 (Phase 3): web search is DuckDuckGo's HTML page.** No API key
and no dependency; Nova parses titles, links and snippets, and drops ads. It
breaks if DuckDuckGo changes its markup; `NOVA_SEARCH_URL` points it
elsewhere, and the walkthrough uses a stand-in.

**2026-10-21 (Phase 3): shopping researches and never buys.** Payments are
out of scope and a purchase can't be undone. Real model: big retailers often
refuse automated page reads (503s, rate limits), and the playbook's rule of
quoting only prices it saw made it stop short of a recommendation. The
playbook now asks deciding details first, caps page reads at about six, and
falls back to agreeing sources labelled "reported".

**2026-10-21 (Phase 5): permissions, all "ask" by default, in Settings.**
Jeremy first chose full autonomy for unattended work, then revised: every
permission defaults to ask, with a Settings page of switches whose list is
dynamic. Each tool that needs an OK declares `permission: {id, label,
note}`; tools without one get a permission named after the tool, so plugin,
MCP or Nova-made tools appear without code changes. Going online after
reading mail is the one permission not tied to a tool. On = take the step
without asking everywhere (`approval {allow, auto: true}`, stamped "Without
asking"). Off = ask; with no one watching, the run or helper waits for the
answer, and a waiting scheduled run steps aside so the queue keeps moving.
Stored in `~/permissions.md`; `write_file` can't edit it. This replaces
Phase 4's "unattended runs decline approvals".

**2026-10-21 (Phase 5): Nova comments on a helper's report.** Jeremy's call.
After a helper's report is delivered (ok, not stopped), the runner starts a
turn with no message from the person (`user {text: '', followup: <handoff
id>}`), prompted with a `<followup>` note asking for its take and the next
step. Nothing is shown for the person's side of that turn.

**2026-10-21 (Phase 5): helpers start fresh.** A helper is its own session
(`kind: "helper"`, hidden from the list) with a scoped context: the base
prompt, AGENTS/SOUL/IDENTITY/USER, skills, its brief and up to five files the
parent passes. No MEMORY.md, day notes, recall or schedules, and memory blocks
it writes are ignored. The parent writes a self-contained brief, which keeps
the helper's context small and its work checkable from the log.

**2026-10-21 (Phase 5): helpers can't nest or schedule.** A step that needs
an OK waits for the person, per Settings (above); `delegate` and
`schedule_*` aren't offered. Up to three run at once and the rest queue. Stop and Try again are
in Activity and on the report; on start, a helper cut off by a shutdown
reports that it didn't finish.

**2026-10-21 (Phase 5): Activity is derived, not stored.** `/api/activity`
reads the session logs and `runs.jsonl` for a week in the person's time zone,
caching each parsed log by size and modified time. Steps keep only a few
arguments (path, url, command, query, name, id, title); tool output stays in
the logs. An `activity` server event (throttled) keeps the "N waiting" count
in the sidebar current.

**2026-10-21 (Phase 5): a fetch that fails is a failed step.** `web_fetch`
now throws on an HTTP error status instead of returning the error page, so
Activity and the transcript don't show a 429 as "Read".

**2026-10-21 (Phase 4): the main conversation is the front page.** "/"
opens one long conversation (`sessions/main.jsonl`) that scheduled reports are
delivered into, and a reply to a report continues there. New conversations
moved to `/new` (+, ⌘⇧O). A report's first sentence is set as a headline, so
the digest reads as a front page rather than a notification.

**2026-10-21 (Phase 4): a schedule is a markdown file with cron.** Front
matter (`name`, `cron`, `deliver`, `once`, `paused`) and the instructions as
the body, in `~/Nova/schedules/`. Five-field cron evaluated on the wall clock
of the configured time zone; a time skipped by daylight saving runs just
after, a repeated one runs once. No scheduler library: the evaluator is under
200 lines and tested on DST edges.

**2026-10-21 (Phase 4): schedules run only while Nova runs.** The scheduler
ticks every 30 s and runs one job at a time. On start, a run missed in the
last six hours runs late, once; older ones are recorded as missed in
`runs.jsonl`. Running while Nova is closed needs an always-on host (the hub
idea), which is out of scope.

**2026-10-21 (Phase 4): unattended runs decline approvals.** A run is its own
session (`kind: "run"`, hidden from the list). Anything that would ask for
approval is declined and recorded as not asked; the model is told to suggest
it in the report. Waiting for a person would stall the queue.

**2026-10-21 (Phase 4): schedules are set through an approval.** The model
uses `schedule_set` and `schedule_remove`, which always show a card with the
exact instructions; `write_file` refuses `schedules/`, so there's no way
around the card. The system prompt forbids promising a follow-up without one.

**2026-10-21: personal data lives outside the code.** The repo is public
(AGPL). Each person's Nova data is one folder of plain files (`NOVA_HOME`,
default `~/Nova`), seeded from `templates/home/`, and a local git repository
with a commit after every reply. Backup is wherever that folder lives. No
database, no sync service. This also fits a later hub-and-spoke deployment:
the data lives with the runner, and inference spokes only see prompts.
Jeremy asked for a recommendation; this is it, and it is a default path only.

**2026-10-21: a text tool protocol, not a framework.** The model ends a message
with one `<tool_call name="…">{json}</tool_call>` block; Nova runs the tool and
calls the model again with the transcript. This keeps `agent_cmd` swappable
and keeps every approval in Nova's hands. Claude Code is run with its own
tools, hooks, MCP servers and settings disabled.

**2026-10-21: four tools.** `read_file` and `write_file` are confined to the
home folder and cannot touch `sessions/`. `exec` always asks first and starts
in `~/workspace`. `web_fetch` reads http(s) pages as text. There is no
"always allow" in Phase 1.

**2026-10-21: the session log is append-only.** Regenerating a reply starts a
new attempt for the same turn; the view shows the newest attempt and the log
keeps all of them. If the server dies mid-reply, the conversation shows the
reply as interrupted, with Regenerate.

**2026-10-21: the agent's environment is cleaned.** When Nova runs inside a
Claude Code session, that session's memory reached `claude -p` through
environment variables, and Nova repeated things it had no business knowing.
Nova now strips `CLAUDE*MEMORY*`, `CLAUDE*ADDITIONAL_DIRECTORIES*` and
`CLAUDE*CLAUDE_MD*` before spawning the agent. Verified: a canary in
`~/.claude/CLAUDE.md` does not reach the model either.

**2026-10-21: the reply ends when the model stops, not when the process
exits.** `claude -p` spends about 2 s on housekeeping after the last token.
Nova finishes at `message_stop` and ends the process, which takes ~2 s off
every step of a tool loop.

**2026-10-21: the scroll budget is judged on Nova's own work per frame.**
The build container has no GPU, so Chromium composites in software and frame
intervals flip between 17 and 33 ms on identical code. The walkthrough traces
the scroll and requires the page's main-thread work to stay under 8 ms a
frame (half the budget); raw intervals are still reported. Older turns use
`content-visibility: auto`, so long threads only lay out what is on screen.

**2026-10-21: no conversation rename or delete in Phase 1.** Restraint: titles
come from the first message, and the files are on disk.

**2026-10-21: localhost only.** The server binds 127.0.0.1 and refuses other
Host headers (DNS rebinding) and cross-site POSTs (a custom header CORS never
grants). Phone access would need `NOVA_HOST` and has no authentication yet;
the server warns when started that way. Not in Phase 1 scope.

**2026-10-22: Nova is the default theme, as one token file (Path A).**
Jeremy kept the existing build rather than restarting. `ui/themes/nova.css`
comes from `design-system-nova.md`, and `nova` is first in `THEMES`, the
fallback in `theme.js`, and the first paint in `index.html` and
`styleguide.html`. Paper, Aurora and Obsidian are unchanged and stay
optional. A browser that already chose a theme keeps it. The Stellar Map is a
later phase.

## Theme token gaps

None of the three specs defines every token THEMING.md requires. Gaps are
filled from each theme's own palette (mostly `mockups.html`) and marked
`/* derived */` in the token file. Values changed to pass the contract's own
contrast check:

| Theme | Token | Spec | Shipped | Why |
| --- | --- | --- | --- | --- |
| Paper | `--text-2` | `#7A736A` | `#726C63` | 4.38:1 on `--bg`; needs 4.5 |
| Paper | `--text-3` | `#A79D8F` | `#91887B` | 2.5:1 on `--bg`; needs 3 |
| Paper dark | `--accent` | `#C4502B` | `#D9714C` | too dark on evening paper |
| Aurora dark | `--accent-text` | (none) | `#000000` | white on `#7D7AFF` is 3.4:1 |
| Nova | `--accent-text` | `#FFFFFF` | `#0A0A0C` | white on `#6E8CF5` is 3.12:1 |

Contract additions this build needed, proposed for THEMING.md (every theme
defines them, `scripts/check-themes.js` requires them):

- `--font-mono`, `--t-mono`: code, commands, keyboard hints.
- `--t-wordmark`: the sidebar wordmark.
- `--column`: the reading column (680 / 720 / 760 px).
- `--material-blur`: Aurora's frosted surface; 0 elsewhere.
- `--shift`: how far views move when they change; 0 under reduced motion.

Obsidian's spec names differ from the contract (`--panel` is `--surface`,
`--accent-dim` is `--accent-wash`, `--shadow-pop` is `--shadow-2`). Obsidian
is dark in both modes, as its spec defers a light variant.

Nova (default since 2026-10-22, Path A) is dark in both modes too: its spec
defines only the dark workspace. Its starlight tokens and `--folder` are not
shipped yet; they arrive with the surfaces that use them (Stellar Map, Files
explorer). Its spec gives the sidebar `--surface`, but the shared components
paint the sidebar `--bg` and the page `--surface`, so in Nova the sidebar is
the darker of the two. Swapping that is a component change, left for Jeremy.

## Known limits

- Screenshots are rendered on Linux, where New York, Iowan and SF are absent;
  the serif and sans fall back to Liberation/DejaVu. On a Mac, Safari renders
  New York (`ui-serif`) and Chrome renders Iowan Old Style.
- Performance numbers come from the build container, not Jeremy's Mac.
- Margin notes appear when a message matches a dated note. Nothing writes
  dated notes automatically until Phase 2's memory discipline.
