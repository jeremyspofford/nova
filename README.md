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
conversation (running commands, going online after reading mail, Gmail
drafts and tidying, schedules). All start at Ask first; switched on, Nova
does that without asking, anywhere, and Activity shows each time. The list
comes from Nova's tools, so a new tool's permission appears on its own. The
switches are kept in `~/Nova/permissions.md`.

**Helpers and Activity.** Nova can hand a long piece of work (research,
comparing options, going through files) to a helper with the `delegate` tool,
so the conversation stays with you. A helper starts fresh: it sees only Nova's
brief, who you are, and up to five files Nova passes. It doesn't see the
conversation or your memory, keeps nothing in memory, and waits for you on
any step that needs your OK. When its report arrives, Nova adds a short take
on what it means. Up to
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
| `mesh_url` | `NOVA_MESH_URL` | none: no other device can reach Nova |
| `mesh_public_url` | `NOVA_MESH_PUBLIC_URL` | `NOVA_MESH_URL` (required when it listens on every address) |
| `mesh_transport` | `NOVA_MESH_TRANSPORT` | none (`proxy` or `network`, for an `http://` mesh address) |
| `tls_cert`, `tls_key` | `NOVA_TLS_CERT`, `NOVA_TLS_KEY` | none (PEM files, for an `https://` mesh address) |
|  | `NOVA_VAULT_KEY` | `auto`: the vault's key in the system keychain if one answers, else `vault/key` in the home (`file` or `keychain` to insist) |
|  | `NOVA_CHROMIUM` | `CHROMIUM`, then known install paths: the Chromium that browser tasks use (none: browser work is unavailable, and Health says so) |
|  | `NOVA_CHROMIUM_SANDBOX` | on (`0` turns Chromium's own sandbox off, for a container without user namespaces) |

`agent_cmd` is the one place a model is chosen. Nova writes the assembled
system prompt to a file and substitutes its path for `{system_file}`, sends the
conversation on stdin, and reads the reply from stdout, as plain text or as
Claude Code's stream-json. Any command that does that works.

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
