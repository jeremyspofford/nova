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
leaves no copy in that history.

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
Nova follows, so add ones you trust; anything it would run follows the same switches in
Settings as everything else.

**Gmail.** Email summary has tools to read your mail, save drafts and organize
it (archive, labels, read or unread). It has no tool to send or delete, and
each draft and change asks for your OK on a card that shows exactly what will
happen, unless you switch that on in Settings.
To connect, open **App passwords** in your Google account
(<https://myaccount.google.com/apppasswords>; it needs 2-Step Verification),
create one called "Nova", and paste it into Skills with your Gmail address.
Nova talks to Gmail over IMAP. The password is kept in Nova's vault;
Disconnect deletes it, and you can remove it at Google any time.

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
a time. A step that needs your OK waits for you (Activity shows it), unless
you've switched that permission on in Settings. The Schedules view (`/schedules`) shows what's set, when it
last ran and what it said, with Run now, Pause and Remove. Nova ships one
schedule, the morning digest, to turn on there; you can also ask for one in
any conversation ("Every Friday at 4, remind me to send my timesheet"), which
waits for your OK. Schedules run only while Nova is running: a run missed in
the last six hours runs when Nova starts, and older ones are recorded as
missed. Every run is logged in `schedules/runs.jsonl`.

**Settings and permissions.** Settings (`/settings`) has one switch per
permission: each kind of step that changes something outside the
conversation (running commands, Gmail drafts and tidying, schedules). All
start at Ask first; switched on, Nova does that without asking, and Activity
shows each time. A command that follows outside content still asks. The list
comes from Nova's tools, so a new tool's permission appears on its own. The
switches are kept in `~/Nova/permissions.md`.

**Helpers and Activity.** Nova has a `delegate` tool for handing a long piece
of work (research, comparing options, going through files) to a helper, so
the conversation stays with you. A helper starts fresh: it sees only Nova's
brief, who you are, and up to five files Nova passes. It doesn't see the
conversation or your memory, keeps nothing in memory, and takes only the
steps Settings lets it take without asking. When its report arrives, Nova adds a short take
on what it means. Up to
three run at once; more wait their turn. The report comes back to the
conversation that asked. The Activity view (`/activity`) shows what Nova is
doing and did, a week at a time: each reply, scheduled run and helper, with
its steps (what it read, searched, ran and kept), what it asked you and what
you said. Stop or retry a helper there. Activity is read from the session
logs; it keeps no data of its own.

**Changes.** Changes to Nova don't go straight into the running copy. A change (a rule pack, a design
system, a setting, a decision template, an extension), whether you propose it
or Nova's foundry writes it for something you asked for, is tried on a sandbox
copy of Nova first, tested, released as a version in your home's history, and
then watched live in a canary before it stays; if a probe fails, the previous
version comes back by itself. Anything Nova writes for itself is set to wait
for your confirmed OK. Settings › Changes shows each one with its evidence.

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
| `mesh_url` | `NOVA_MESH_URL` | none: no other device can reach Nova |
| `mesh_public_url` | `NOVA_MESH_PUBLIC_URL` | `NOVA_MESH_URL` (required when it listens on every address) |
| `mesh_transport` | `NOVA_MESH_TRANSPORT` | none (`proxy` or `network`, for an `http://` mesh address) |
| `tls_cert`, `tls_key` | `NOVA_TLS_CERT`, `NOVA_TLS_KEY` | none (PEM files, for an `https://` mesh address) |
|  | `NOVA_VAULT_KEY` | `auto`: the vault's key in the system keychain if one answers, else `vault/key` in the home (`file` or `keychain` to insist) |
|  | `NOVA_CHROMIUM` | `CHROMIUM`, then known install paths: the Chromium that browser tasks use (none: browser work is unavailable, and Health says so) |
|  | `NOVA_CHROMIUM_SANDBOX` | on (`0` turns Chromium's own sandbox off, for a container without user namespaces) |
|  | `NOVA_SECRET_<NAME>` | none: a secret a provider names as `secret://<NAME>` (an n8n signing secret, a model server's key), until the vault holds it |
|  | `NOVA_OLLAMA_URL` | `http://127.0.0.1:11434`: where the hub's Ollama answers for the model manager (Settings › Models), unless the profile says otherwise |
|  | `NOVA_HARDWARE_FILE` | none: a JSON hardware reading used instead of this machine's (tests and the gate's stand-in run) |
|  | `NOVA_MODELS_WATCH_MS` | `15000`: how often work waiting on local capacity or the cloud budget is checked again |
|  | `NOVA_CAPTURE_POLL_MS` | `10000`: how often the hub pulls a capture source that is on (Screenpipe). Capture itself is off until you turn a source on in Settings › Capture |

`agent_cmd` is the one place a model is chosen. Nova writes the assembled
system prompt to a file and substitutes its path for `{system_file}`, sends the
conversation on stdin, and reads the reply from stdout, as plain text or as
Claude Code's stream-json. Any command that does that works.

## Keep it running

The supervisor runs Nova as its child, restarts it when it stops (waiting a
little longer each time), restarts it when it stops answering, and holds it in
safe mode if it keeps stopping right after it starts, saying why at Nova's
address and on Health:

```sh
node src/supervisor/main.ts run               # instead of npm start
node src/supervisor/main.ts status            # what it's doing, in words
node src/supervisor/main.ts recover           # leave safe mode once the cause is fixed
```

**Releases.** A release is a git tag. `deploy <tag>` asks you to type the tag
(every time), then runs the release's tests, starts it on a sandbox copy of
your home, probes it, switches, and watches health for a canary window (two
minutes by default, `--canary-s`); if health fails there it goes back to the
previous release by itself. `rollback` goes back by hand (type `rollback`, or
pass `--confirm rollback`). Going back across a database upgrade restores the
backup taken before it only if nothing was written since the newer release
started, its own start-up work included; otherwise Nova refuses, says why, and
keeps the newer release. Releases live in `~/.nova-supervisor/releases/<tag>/`
(`--dir`, a folder only you can open), each a git worktree of its tag. The
code you started the supervisor from runs as it was committed then, so editing
the checkout never changes what runs.

**Backups.** `PUT /api/v1/backups/settings {"target": "/path/to/folder"}`
(a folder of yours that already exists, outside Nova's home, that no one else
can write; from this screen or a device that may approve) starts a nightly
backup and a weekly restore drill, both in Automations. Each backup is a
consistent copy of the database and your home's files, with a manifest of
hashes, readable by you only; the vault's key and this computer's private keys
are never in it. Add `"encrypted_target"` for an AES-256-GCM copy in a second
folder: the reply shows its **recovery key once**. Keep it somewhere other
than this computer: with it the copy opens anywhere; without it the copy can't
be opened if this computer is lost. `POST /api/v1/backups/recovery-key
{"confirm": true}` shows it again, from this screen only. `"keep"` is how many
to keep (7). Forgetting something is carried into Nova's backups too; a backup
drive that is unplugged at the time gets the forget when it is back.
Health shows the last backup and the last drill; a failed drill is a problem
with steps.

## Your other devices

Nova's console, at `NOVA_HOST:NOVA_PORT`, answers only this computer: a
request counts as the console only if it comes from this machine, is addressed
to it, and passed through no proxy. Anything else, including a reverse proxy
pointed at the console port, gets nothing until it is paired.

> **Never point a port forward, tunnel or proxy at the console port.** Nova
> knows a proxy by the headers it adds (`X-Forwarded-For` and the like). A
> program on this computer that passes connections on without adding them
> (`ssh -L`/`-R`, `socat`, a TCP tunnel, a proxy that rewrites the address to
> `localhost`) makes everyone who reaches it look like you at this screen,
> with full control of Nova. Nova can't tell the difference, and says so
> every time it starts. Other devices pair at the mesh address instead.

To pair a phone, a browser or a computer, give Nova a second address, the
mesh address, that your devices can reach:

```sh
# Nova serves TLS itself, with a certificate your devices trust:
NOVA_MESH_URL=https://0.0.0.0:4320 NOVA_MESH_PUBLIC_URL=https://hub.example:4320 \
NOVA_TLS_CERT=cert.pem NOVA_TLS_KEY=key.pem npm start

# Or a TLS proxy in front of a local port:
NOVA_MESH_URL=http://127.0.0.1:4320 NOVA_MESH_TRANSPORT=proxy \
NOVA_MESH_PUBLIC_URL=https://hub.example npm start
```

Behind a proxy, Nova limits pairing attempts by the address the proxy puts
last in `X-Forwarded-For`. Make sure your proxy adds the client's address to
that header, or replaces it (Caddy does by default; nginx with
`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for`); a proxy that passes on
whatever the client sent lets a client choose its own address, and so its
own limit.

`NOVA_MESH_TRANSPORT=network` says an encrypted network (a tailnet) carries
plain HTTP; browsers then can't pair (they need HTTPS for the keys), but
computers can. Plain HTTP with neither statement is refused at startup.

Then open Settings › Devices and choose **Add a device**. A phone scans the
QR code; any browser opens the address and types the code; a computer runs the
one-line command. Each device makes its own key, and shows six digits that
your hub shows too: approve it on the hub only if they match. Codes work once,
for five minutes. Only enter a code at your hub's own address, on a device you
already trust. Revoke a device in the same place; it is signed out at once and
its key never works again.

### A computer

The one-line command needs Node.js 26 or newer on the computer, and installs
nothing outside its device home (`NOVA_DEVICE_HOME`, default `~/.nova-device`):

```sh
curl -fsS https://hub.example:4320/join.sh | sh -s -- ABCD-EFGH [--name "Desk computer"]
# A hub whose certificate the system doesn't know: trust its CA for this command only.
export CURL_CA_BUNDLE=ca.pem NOVA_CA_FILE=ca.pem
```

It shows six digits; approve on the hub if they match. The agent then runs in
the background and the computer shows Online in Settings › Devices. It is two
programs (ADR-3): a small boot agent that holds the keys, and a runtime it
starts under Node's permission model, which can't read those keys or change
the boot agent. What the computer sends while the hub is down waits in a queue
and arrives once, in order. Ask it how it is, or put it right:

```sh
node ~/.nova-device/agent/src/device/boot.ts status
node ~/.nova-device/agent/src/device/boot.ts recover   # reinstall the runtime, leave safe mode
```

### A standby

A standby is a second Nova, on another machine, that keeps a copy of
everything (your data, conversations and workspace) so it can take over if the
hub fails. The hub is a role, not a box. Enroll it with a blank home of its
own and the address devices will reach it at, approve it on the hub, then
start it:

```sh
node src/device/boot.ts join https://hub.example:4320 --code ABCD-EFGH --kind standby \
  --name Standby --nova-home ~/Nova-standby --address https://standby.example:4320
NOVA_HOME=~/Nova-standby NOVA_MESH_URL=https://0.0.0.0:4320 \
NOVA_MESH_PUBLIC_URL=https://standby.example:4320 NOVA_TLS_CERT=cert.pem NOVA_TLS_KEY=key.pem npm start
```

It copies the hub continuously and refuses changes ("This is the standby; …
is the hub"); the hub's Health shows how far behind it is. If the hub fails,
open the standby's own screen and choose **Make this the hub** (or set
`mesh.auto_failover_after_s` on the hub, off by default, to let it take over
by itself after that many seconds). Devices follow it. If the old hub comes
back, it sees that it was replaced and steps down rather than act as a second
hub. Connector sign-ins (Gmail) stay on the machine where you made them;
connect them again on the new hub.

### If the hub's keys were exposed

The hub's private keys live in `<home>/mesh/identity.json`, readable only by
you, and never in the home's git history. A home made before that rule saved
them in its history once, where anyone who can read the folder can read them;
Nova then shows a problem saying so at every start. Replace them, with Nova
stopped:

```sh
node scripts/rotate-hub-keys.js ~/Nova
```

The hub keeps its place and gets new keys, and the epoch goes up. Computers
and the standby trusted the old keys, so they are revoked: the script lists
them. Add each one again, a computer with a new device home
(`NOVA_DEVICE_HOME`), a standby with a new blank home. Phones and browsers stay
signed in. The old keys stay in the history but no longer open anything, and
the problem goes away.

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
