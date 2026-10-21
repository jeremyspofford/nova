# Nova

Nova is a personal AI agent. It is built like Muse: a system prompt, standing
markdown files, memory, and an agent loop with a few tools. Plain files are
the only source of truth.

It is deliberately small. Each feature should be finished end to end before
the next one starts. The build plan and its phases live outside this repo, in
the project's `nova-harness-prompt.md`.

## Run it

You need Node 22+ and the `claude` CLI on your PATH (or another agent command,
see below).

```sh
npm install
npm start           # http://localhost:4317
```

For development:

```sh
npm run dev         # hot reload: CSS applies in place, anything else reloads
npm run dev:follow  # the same, and fast-forwards this branch every 5 s
```

Nova keeps your data in **`~/Nova`**: the standing files (`AGENTS.md`, `SOUL.md`,
`IDENTITY.md`, `USER.md`, `MEMORY.md`), dated notes in `memory/`, its
`workspace/`, and one JSONL log per conversation in `sessions/`. The folder is
seeded from `templates/home/` on first run, and nothing is ever overwritten.
It is a local git repository, with a commit after every reply, so its history
is the audit trail (for conversations and standing files; memory, skills and
sign-ins stay out). Back it up by putting it wherever you keep things that
matter (a NAS, iCloud, an Obsidian vault). Set `NOVA_HOME` to move it.
**Never point it inside this repo**, which is public.

**Memory.** Nova keeps what lasts in `MEMORY.md` (facts, preferences,
decisions, commitments) and day detail in `memory/YYYY-MM-DD.md`, written
before each reply finishes. Each entry ends with a small comment saying where
it came from. The Memory view (`/memory`) shows all of it: edit an entry by
clicking it, forget it with one click (or Delete), and undo for a few seconds
after. Forgetting a memory also forgets the day notes that say the same thing.
Memory files are kept out of the folder's git history, so a forgotten memory
leaves no copy behind.

**Skills.** A skill is a markdown playbook (`SKILL.md`) for one kind of work.
Nova ships two, Email summary and Shopping research, and the Skills view
(`/skills`) installs, explains and removes them. Installed skills live in
`~/Nova/skills/`, where you can read and edit them; removing one deletes its
folder, and nothing else refers to it.

Add your own under **Add your own** in Skills: a folder or a .zip with a
`SKILL.md`, up to 200 files and 5 MB. Nova reads Claude's skill format too
(`name` and `description` in the front matter, then the steps), so skills
written for Claude work as they are. Other files in the folder come along,
and Nova reads them when the steps point to them. A skill is instructions
Nova follows, so add ones you trust; anything it would run still asks first.

**Gmail.** Email summary reads your mail, saves drafts and organizes it
(archive, labels, read or unread). It never sends or deletes, and every draft
and change waits for your OK on a card that shows exactly what will happen.
To connect, open **App passwords** in your Google account
(<https://myaccount.google.com/apppasswords>; it needs 2-Step Verification),
create one called "Nova", and paste it into Skills with your Gmail address.
Nova talks to Gmail over IMAP. The password is stored in
`~/Nova/connectors/gmail/`, readable only by you; Disconnect deletes it, and
you can remove it at Google any time.

Work and school accounts often can't make app passwords. Under **Advanced**,
connect with a Google OAuth client of your own instead: in Google Cloud, turn
on the Gmail API, set up sign-in for External users with yourself as a test
user, create a **Desktop app** client, and paste its JSON into Skills. Then
connect at `localhost` on the machine Nova runs on. Google signs apps in
Testing out after 7 days; publish yours under Audience to stay connected
(Google will call it unverified, which is expected for an app only you use).

**The main conversation and schedules.** Opening Nova (`/`) shows the main
conversation, a front page that reports from scheduled work land in; + or
⌘⇧O starts a separate conversation. A schedule is a markdown file in
`~/Nova/schedules/` (`name`, a five-field `cron` on your time zone, where to
`deliver`, and the instructions as its body). Nova runs it unattended, one at
a time, and takes the steps that would ask you in a conversation on its own,
as `~/Nova/permissions.md` allows (every kind is "yes" to start; set one to
"ask" and it's suggested in the report instead). The Schedules view (`/schedules`) shows what's set, when it
last ran and what it said, with Run now, Pause and Remove. Nova ships one
schedule, the morning digest, to turn on there; you can also ask for one in
any conversation ("Every Friday at 4, remind me to send my timesheet"), which
waits for your OK. Schedules run only while Nova is running: a run missed in
the last six hours runs when Nova starts, and older ones are recorded as
missed. Every run is logged in `schedules/runs.jsonl`.

**Helpers and Activity.** Nova can hand a long piece of work (research,
comparing options, going through files) to a helper with the `delegate` tool,
so the conversation stays with you. A helper starts fresh: it sees only Nova's
brief, who you are, and up to five files Nova passes. It doesn't see the
conversation or your memory, keeps nothing in memory, and acts on its own
as `permissions.md` allows, since it can't ask you. Up to
three run at once; more wait their turn. The report comes back to the
conversation that asked. The Activity view (`/activity`) shows what Nova is
doing and did, a week at a time: each reply, scheduled run and helper, with
its steps (what it read, searched, ran and kept), what it asked you and what
you said. Stop or retry a helper there. Activity is read from the session
logs; it keeps no data of its own.

## Configure

Optional `nova.config.json` at the repo root (environment variables win):

| Key | Env | Default |
| --- | --- | --- |
| `home` | `NOVA_HOME` | `~/Nova` |
| `port` | `NOVA_PORT` | `4317` |
| `host` | `NOVA_HOST` | `127.0.0.1` |
| `agent_cmd` | `NOVA_AGENT_CMD` | `claude -p …` (see `src/config.js`) |
| `timezone` | `NOVA_TZ` | the system timezone |
|  | `NOVA_IMAP_URL` | `imaps://imap.gmail.com:993` (tests point it at a stand-in) |

`agent_cmd` is the one place a model is chosen. Nova writes the assembled
system prompt to a file and substitutes its path for `{system_file}`, sends the
conversation on stdin, and reads the reply from stdout, as plain text or as
Claude Code's stream-json. Any command that does that works.

## Check it

```sh
npm run check       # token lint + theme contract/contrast + unit and API tests
npm run shots       # drives the UI in Chromium: every state, every theme, budgets
```

`npm run shots` needs a Chromium; set `CHROMIUM=/path/to/chrome` if it isn't at
the Playwright default.

## Layout

```
src/            server, runner (the agent loop), context assembly, tools, memory,
                skills, schedules (cron, scheduler), connectors/ (Gmail)
skills/         the skills Nova ships (SKILL.md playbooks)
schedules/      the schedules Nova offers (the morning digest)
connectors/     connector docs (CONNECTOR.md: capabilities, limits, auth)
system/         Nova's system prompt
templates/home/ the standing files a new home is seeded from
ui/             the web UI: themes/ (token files only), styles/, js/
scripts/        token lint, theme checker, browser walkthrough, scripted test model,
                a stand-in Google for tests
tests/          node:test suites
docs/           ledger, phase reviews, screenshots
```

Themes are token files only (`ui/themes/*.css`). Components never hardcode a
color, font, radius, shadow or motion value; `npm run lint:tokens` enforces it.
The living style reference is at `/styleguide`.
