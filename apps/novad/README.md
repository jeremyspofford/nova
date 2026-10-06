# novad — the Nova agent daemon (Linux, macOS, Windows)

`novad` lets Nova act on a paired computer. It is a small pure-Go daemon that
enrolls with a one-time pairing code, holds an **outbound** WebSocket to core,
and executes only the commands that arrive as ed25519 one-use **signed
envelopes** — every one verified *on this machine* before anything runs. A
compromised or confused core-adjacent component cannot puppet the machine,
because it cannot produce the signature. The LLM never talks to novad; only
core does, through the same tool registry as every other tool.

This is the first Nova code that runs **outside** the compose stack. Since
S42a it runs natively on Linux, macOS and Windows — the same protocol above,
`CGO_ENABLED=0`, built per OS (six targets: two architectures each). On
Windows the agent is always the native build; it reaches WSL through
`wsl.exe` and `\\wsl.localhost` rather than running a second copy of itself
inside WSL.

|        | linux/amd64                     | linux/arm64 | darwin/amd64          | darwin/arm64          | windows/amd64            | windows/arm64          |
|--------|---------------------------------|-------------|-----------------------|-----------------------|--------------------------|------------------------|
| status | walked before S42a; S42a: CI    | built + CI  | built + CI, unwalked  | built + CI, unwalked  | walked 2026-09-28 (the Dell) | built + CI, unwalked   |

linux/amd64 was walked before S42a. S42a's walk has no Linux agent step, so
this slice's Linux changes are tested in CI, not walked.

Mac is unwalked by owner decision 11: Mac support is built and CI-tested, but
the owner's only Mac is his work device, so Nova is never installed on it.

## Build

The reproducible command, run from the repo root — the same flags CI uses,
so a hash you compute locally matches CI's and a downloaded binary's:

```sh
CGO_ENABLED=0 GOOS=<os> GOARCH=<arch> go build -trimpath -buildvcs=false \
  -ldflags "-s -w -buildid= -X main.version=$(bash deploy/agent_version.sh)" -o novad[.exe] .
```

`<os>`/`<arch>` is one of the six targets above; give `-o novad.exe` on
Windows. The version stamp is 12 hex characters of the **`apps/novad` tree**
— CI, the hub's `agent-dist` and this command stamp the same value — so one
tree builds one sha256, byte for byte, wherever it is built. A change
outside `apps/novad` does not change the agent's version.

**Anything installed on a machine is built from `~/workspace/nova` on
`main`**, never from a worktree.

## Enroll

In the Nova UI, **Settings → Devices**, mint a pairing code (short-lived,
single-use). Then on the machine you are pairing, run the enroll command for
your OS — see "Install" below for the exact commands. Every OS does
the same thing on the wire: `enroll` generates the device keypair locally
(the private key **never leaves this machine**, stored `0600` on Linux/macOS
or under the DACL described in Custody on Windows), sends only the public key
plus identity — `code`, `pubkey`, `name`, `platform` (`runtime.GOOS`, so core
sees the real OS), `hostname` — and on success pins core's public key.
Re-enrolling is deliberate — it refuses to overwrite an existing enrollment
without `--force`. A spent, expired, or wrong code is surfaced verbatim from
the server.

## Install

Settings → Devices → "Pair a device" gives one command per OS (POSIX `sh`
for Linux and macOS; one line of PowerShell 5.1 for Windows). Pasted into a
shell, it downloads the hub's build for this machine to a fresh temp
directory, checks its sha256 against the signed manifest **before anything
runs**, runs `novad install` with the code already in it, and deletes the
download whatever happened — nothing is left in Downloads. The card has no
WSL branch of its own: pasted inside WSL, the Linux command downloads the
Linux build exactly as it would on a native Linux machine, and `novad
install` is what then refuses, in its own words — see "Inside WSL", below.
(Setting up the hub machine's *own* agent is different: a WSL hub's
`./install` detects this itself and prints the Windows line instead of
installing here — see `deploy/README.md`.)

`novad install` itself:

```sh
novad install [--hub <url>]... [--code <code>] [--name <name>] [--if-missing] [--restart-later]
```

- `--hub` is Nova's address; repeat it for fallbacks, in order (the card's
  command already carries them).
- `--code` is a pairing code, needed only when this machine has no pairing
  Nova still knows. It can also travel as `NOVA_PAIRING_CODE` in the
  environment instead of `--code` — never on the command line, which `ps`
  shows to every other user, and never printed; `install` unsets the
  variable as soon as it reads it, so nothing this process starts (a
  supervisor, a command run for her) can inherit it.
- `--name` is the machine's name (default: the card's, else the hostname).
- `--if-missing` leaves an agent that is already installed and running
  exactly as it is.
- `--restart-later` schedules the service restart instead of waiting for
  it, and keeps this machine's pairing without asking Nova — used when Nova
  installs through an existing agent's own `shell.exec` (an S42a agent that
  answers `unknown capability "daemon.update"`; see Updates, below).

Where the binary goes (P1): Linux `~/.local/bin/novad`; macOS
`~/Library/Application Support/Nova/novad`; Windows
`%LocalAppData%\Programs\Nova\novad.exe`. The service each OS gets (P3–P6):
a systemd user unit plus linger on Linux; one LaunchAgent (`nova.novad`) on
macOS; the HKCU Run value "Nova agent" on Windows. Each one starts `novad
supervise --mode <systemd-user|launch-agent|run-key>` — the parent on every
OS, started by the service definition, never meant to be run by hand.

**"Installed" means the new agent's own status said `ready`, as this
version — never that the command merely exited 0 (P5).** `install` waits up
to 60 s for that before it reports success, and names what the status last
said when it did not arrive in time.

Exit codes:

| Code | Means |
|---|---|
| 0 | ok, or a clean stop |
| 1 | an error (its words are on stderr) |
| 2 | bad usage |
| 3 | `install` needs a pairing code — this machine has none Nova still knows |
| 75 | `run` staged an update; its supervisor swaps it in (see Updates) |
| 78 | not enrolled, or revoked — final; restarting cannot help |

`novad uninstall [--forget]` (P21) stops and removes the service and every
staged build (`.prev`, `.new`, `.failed`, anything moved aside). The
pairing is kept by default, so a later `novad install` reuses it;
`--forget` sets it aside instead. Either way it never claims the device is
unpaired on Nova's side — only a revoke in Settings → Devices does that.

`novad supervise --mode <systemd-user|launch-agent|run-key>` is what each
service definition's command line runs; it is not meant to be started by
hand — see "Running interactively", below, for what running the agent
itself by hand changes.

**Walk status (S42b).** Installing, the three service modes, updates and
re-pair are built and tested in CI on Linux, macOS and Windows, not walked,
until Task 32's walk dates a native one. macOS stays unwalked beyond that
either way, by owner decision 11 (the owner's only Mac is his work device).

## Updates

The hub's own build is the desired state for every agent. Nova sends it one
idle machine at a time — the hub's own agent first, then the rest — never a
build that failed anywhere, and never to a machine already tried with it.
"Idle" means connected, with no command in flight and none sent to it in
the last five minutes.

On the wire this is the `daemon.update` capability: the agent downloads the
build the signed command names, checks its sha256, and stages it as
`novad.new` beside the running binary — only while it is running supervised
by its service; a hand-started agent states *cannot* (see "Running
interactively"). It then exits **75** so its supervisor can swap the build
in: `supervise` renames the running binary to `.prev`, starts the staged
one, and waits up to 120 s for it to report `ready` as the new version —
past that, or if it cannot even start, `supervise` puts `.prev` back and
records why, instead of looping on a build that cannot run.

**Nothing confirms an update except this device's own next authenticated
connection reporting the new version.** Until then, Nova's side says "sent,
not confirmed" — never "updated". An agent whose service predates S42b (a
hand-written systemd unit that answers `unknown capability
"daemon.update"`) is updated instead through its own `shell.exec`: core
composes the download, the sha256 check and `install --restart-later`
itself, and says so in the result. If one of those steps fails, the result
names it and the one step left to you: run the command on that machine's
setup card there, which installs the hub's build in place over the pairing
it has. From the device's tile, Update then opens that card.

## Re-pair

A pairing code is normally for a machine with no pairing yet. "Re-pair" on
a device's tile in Settings → Devices instead mints a code bound to that
one device id (decision 4). Running the card's command, or `novad install
--code <code>`, on that same machine then does one of two things: while
Nova still knows the machine's current pairing, the command just keeps it
and the code goes unused (it expires either way); only once Nova no longer
recognizes the old pairing does the code get spent, rebinding the device's
key while its name and history are kept.

Re-pairing ends the old key's session on core's side, but nothing reaches
out and stops whatever still holds that key running elsewhere: an old agent
left running after a re-pair keeps retrying and failing with "signature did
not verify" until it is stopped by hand — there is no retired-key table
yet (see the carries).

## Inside WSL

Do not install novad there. `enroll` and `install` each refuse on their
own — two independent checks, in their own words, neither calling the
other. `novad enroll` (`main.go`'s `enrollPreflight`):

```
novad: cannot: on Windows, Nova's agent runs on Windows itself; run the Windows command (novad.exe enroll) in PowerShell, not this one inside WSL
```

`novad install` (`internal/install/install.go`'s own check, run before
pairing or placing anything):

```
novad: cannot: on Windows, Nova's agent runs on Windows itself; run the Windows command in PowerShell, not this one inside WSL
```

Pair the Windows machine instead — its agent reaches WSL through `wsl.exe`
and `\\wsl.localhost` (see "What it can do", below), so nothing inside WSL
needs its own agent. `./install` on a WSL hub prints the Windows line
rather than installing anything on that machine (see `deploy/README.md`).

## Custody

- **Linux:** `~/.config/novad/` (honors `XDG_CONFIG_HOME`) holds
  `config.json` (device id, server, pinned core key) and `key` (the device
  private key, `0600` in a `0700` dir). The audit chain is
  `~/.local/state/novad/audit.jsonl` (honors `XDG_STATE_HOME`).
- **macOS:** `~/Library/Application Support/novad/` holds all three —
  config, key and the audit log live together.
- **Windows:** config and key in `%AppData%\novad\`; the audit log in
  `%LocalAppData%\novad\` — deliberately not the roaming folder, since the
  audit log is this machine's own record and must never travel with a
  roaming profile. Windows ignores the `0600`/`0700` modes the other two
  OSes rely on, so both directories instead get a protected DACL granting
  full control to only SYSTEM and your own account, inherited by everything
  created inside.
- **Caveat:** on a domain roaming profile, `%AppData%` — and with it the
  device's private key — travels with the profile. See the carries.

## Repoint (the hub moved)

When Nova's hub moves to another machine — restored from a backup bundle, so
core's signing key came with it — the only thing that changed for this device
is the URL:

```sh
novad repoint --server https://nova.new-host.example --check   # prove it
novad repoint --server https://nova.new-host.example           # then write it
systemctl --user restart novad                                 # Linux; macOS/Windows: stop the running agent and let its service start it again (see Install)
```

`repoint` opens the device socket at the new URL and completes the **whole**
handshake before it writes anything: it refuses a server whose `core_pubkey`
is not the key pinned at enrollment, and it refuses a server that holds the
right core key but has forgotten this device. Either way the config is left
byte-for-byte as it was. `--check` prints the verdict and **writes nothing
even when the proof succeeds** — that is how you decide between `repoint` and
a fresh `enroll`.

What it does not do: it never re-keys, never re-enrolls, and never restarts
the daemon. It prints the restart command; `novad status` is what says whether
the new server answers.

Whoever owns a DNS name can serve a Nova-shaped websocket. They cannot produce
core's ed25519 public key, which is why the pinned key — not the URL — is the
identity this command checks.

## Running interactively (read this before filing "it isn't working")

For the pairing walk, and for any capability that needs a desktop —
`system.notify`, `apps.launch` — run novad **inside that desktop session**,
not from a bare service, until it has one wired to the session on every OS:

```sh
novad run
```

- **Linux** needs `DISPLAY` / `WAYLAND_DISPLAY` / `DBUS_SESSION_BUS_ADDRESS`
  in its environment — a bare `systemctl --user` service started at boot may
  not inherit them.
- **macOS** needs to be running in the Aqua session that owns `/dev/console`
  — a LaunchAgent started before login, or a process started over SSH, is
  not.
- **Windows** needs to be outside session 0 — a process a service manager
  starts runs in session 0, where a toast or a launched app's window never
  shows.

`system.info`, `fs.*`, `shell.exec` and `facts.refresh` need none of this and
work headless on every OS.

**A `novad run` started this way reports its mode as `foreground`** (see
Facts, below) — never `systemd-user`, `launch-agent` or `run-key` — and
that is not cosmetic: `daemon.update` states *cannot* on a `foreground`
agent, since nothing but whoever started it by hand would be there to
restart it into a new build (P12). Nova can act on an agent only once a
service owns it; hand-starting `novad run` is for the pairing walk and
desktop-only capabilities, not how an agent is meant to run day to day —
`novad install` is.

`novad status` prints the enrollment, the pinned core-key fingerprint, the
last audit seq, and a reachability probe of the server. It reports
"reachable" only when the HTTP server answers, and it never claims
"connected" — reaching a host is not the same as holding an authenticated
socket.

## What it can do

Every command is verified on the device (signature, expiry, one-use) — that
proves WHO signed it; nothing on the device second-guesses WHAT core asked
for. There is no per-device grant, no path allow-list and no path blocklist: a
paired device runs whatever core signs, as the user `novad` runs as, and that
includes its own `key` and `audit.jsonl` (a rewritten audit chain is detected
by core on the next replay, not prevented). The nine:

| capability      | does                                                        |
|-----------------|-------------------------------------------------------------|
| `system.info`   | disk free, memory, OS, hostname, uptime                     |
| `system.notify` | a desktop notification (needs a session; see above)         |
| `fs.list`       | list a directory                                            |
| `fs.read`       | read a file, **256 KiB cap** — a larger file is refused, never truncated |
| `fs.write`      | create/overwrite a file, **256 KiB cap** — larger content is refused, never partially written |
| `apps.list`     | list launchable apps                                         |
| `apps.launch`   | launch an app (needs a session; see above)                  |
| `shell.exec`    | run **argv** (no shell), 64 KiB output cap, honors a timeout |
| `facts.refresh` | probe again (how it runs, elevation, WSL — see Facts), send a fresh `facts` frame on this connection, then answer — core has no caller yet (S46a is the first) |

`shell.exec` is **argv-only** — there is no string-to-shell path anywhere. A
user who wants a shell passes it explicitly, e.g. `["bash","-lc","echo hi"]`
on Linux/macOS or `["cmd","/c","dir"]` on Windows, in argv form, visible in
the audit. WSL is reached the same way, through the Windows agent:
`["wsl.exe","-d","<distro>","--",…]` (`WSL_UTF8=1` is set on the child so
`wsl.exe`'s own output is UTF-8, not the OEM code page — other Windows
console programs still print in the OEM code page; see the carries).

**On Linux and macOS, every child a command starts gets no terminal and
empty input (P30):** it leads its own session (`Setsid`), so there is no
controlling terminal for it to ask on, and its stdin is already at
EOF — a program that would prompt (`sudo`, `ssh`) fails at once in its own
words instead of hanging to the timeout waiting for someone who is not
there. **Windows does not have this yet:** a child novad starts there still
runs with whatever console and stdin novad itself has, so a program that
prompts can still hang until the timeout; closing that gap waits on a
further reading of what Windows actually does here (see the carries).

A timeout, or the connection to Nova dropping mid-command, kills the
**whole** process group (Unix — `SIGKILL` on the group, falling back to the
root pid directly if the group is already empty) or process tree (Windows —
`taskkill /T /F`, falling back to `TerminateProcess`), so a backgrounded
child can no longer keep a command "running" past the call that started it.
What actually happened to the process — never the state of the connection —
decides the result: a process that exited on its own before the kill lands
is reported by that exit code, never as timed out or cancelled; a process
that exits 0 while a background child of its own still holds the output pipe
is `ok:true` with a note that later output was not read; an actual timeout is
`ok:false` ("timed out"); a call cut short only because the connection
dropped or novad itself is stopping is `ok:false` ("cancelled…").

`system.notify` and `apps.list`/`apps.launch` reach the OS's own mechanism:

|                            | Linux                                   | macOS                                                              | Windows |
|----------------------------|------------------------------------------|---------------------------------------------------------------------|---------|
| `system.notify`            | `notify-send`                           | `osascript` (`display notification`)                                | a WinRT toast via Windows PowerShell 5.1, the message read from stdin as UTF-8 bytes so `café` survives |
| `apps.list` / `apps.launch`| the XDG `.desktop` catalogue, via `gtk-launch`/`gio` | every `*.app` under `/Applications`, `/Applications/Utilities`, `/System/Applications`, `/System/Applications/Utilities` and `~/Applications`, via `open -a` | the Start menu's own list (`Get-StartApps`), launched through `explorer.exe shell:AppsFolder\<AppID>` — the same way the Start menu itself launches it, Store apps included |

`result.ok` means the daemon **performed** the capability and captured a
result — it is *not* the command's own success. A `shell.exec` that runs to
completion is `ok:true` even on a nonzero exit; `exit_code` carries the
command's result. `ok:false` is reserved for the daemon being *unable* to
perform the capability at all (an unverifiable envelope, an over-cap read, an
unstartable binary, a timeout, or notify with no backend) — and a refusal is
still a result frame **and** an audit entry, never silent.

## Facts

Two shapes, both riding the socket core already authenticated (TLS, or
loopback in dev). **Facts themselves are not signed** — they travel exactly
the way a result frame does. (The one thing on this socket that IS signed is
a revoke refusal — see Revoked, below.)

**Auth-frame facts** — small, ≤4 KiB, sent inside the handshake's `auth`
frame and recorded by core only after the signature verifies (never a reason
to refuse the socket):

```json
{
  "v": 2,
  "agent": {"version": "...", "mode": "systemd-user|launch-agent|run-key|foreground", "session_interactive": true},
  "os": {"goos": "linux|darwin|windows", "arch": "amd64|arm64", "version": "Ubuntu 26.04 LTS", "wsl": null},
  "hostname": "...",
  "machine_uid": "..."
}
```

`agent.version` is the build stamp from "Build", above — 12 hex characters of
the commit a properly built binary was built from. `mode` is `run-key` only
from S42b's Windows launcher onward; until then
Windows always reports `foreground`, Linux reports `systemd-user` under the
unit above or `foreground` run by hand, and macOS reports `launch-agent`
under launchd or `foreground` run by hand. `os.wsl` is `{"distro": "..."}`
only when this Linux runs inside WSL — detected from the kernel's own
`/proc/sys/kernel/osrelease` string, never an environment variable, because a
systemd unit inside WSL does not get one; `distro` comes from
`WSL_DISTRO_NAME`, or `""` when that is unset (see the carries).

`machine_uid` is `sha256("nova/machine-uid/v1:" + lowercase raw id)`, as hex
— the raw id (Linux `/etc/machine-id`, falling back to
`/var/lib/dbus/machine-id`; macOS `IOPlatformUUID` via `ioreg`; Windows
`HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid`) never leaves the machine.
It exists for one thing: spotting two Nova agents reporting the same
computer.

**The `facts` frame** — ≤16 KiB, sent after `ready`, again on a change (at
most once a minute), every ten minutes regardless, and on `facts.refresh`:

```json
{"type": "facts", "net": {"ifaces": [{"name": "eth0", "mac": "...", "ipv4_cidr": ["192.0.2.10/24"], "up": true}]}, "unreadable": [{"item": "...", "reason": "..."}]}
```

Loopback interfaces are dropped; at most 32 interfaces are sent, and going
over that is itself an `unreadable` entry rather than a silent cut — but a
single interface's own IPv4 addresses are capped at 8 with no such note, so
a multi-homed interface can lose addresses silently past the eighth. `net`
and `unreadable` are everything S42a fills in —
power, ollama, compute, hold and overlay are later slices' sections (see the
carries); a section this build does not know is dropped by core, never
stored as a mystery key.

From S42b the frame also says what Nova needs to act on this machine without being
told (`service`, `elevation`, `wsl_distros`, `probed_at`): the name the service manager
knows this agent by, its binary, config, process and account; whether it runs as
root or elevated and what `sudo -n true` did (Windows: membership of Administrators
and Windows sudo's setting); and on Windows every WSL distribution — looked inside
only when it is already running, since looking would start it. These run programs,
so they are probed at connect and on `facts.refresh` only; every frame between
carries the last result and `probed_at`. A reconnect within ten minutes of the last
probe keeps it instead of probing again. Each program is waited for at most 10 s and a
whole probe at most 45 s, whatever its kill does: a program the agent cannot stop
(`sudo`, once it runs as root) is left to exit by itself, the frame says it gave no
answer in time, and such a probe is not kept across a reconnect; a `sudo` with no
answer is `unknown`, with the reason, and `elevated` is still said. What runs is listed
again just before each look. `novad_pids` is `null` — unknown, never "none" — unless the
distribution is stopped or a finished look found none. `wsl.exe` always runs with
`WSL_UTF8=1`, and what a program said (a refusal, an error) is carried as its first line
only — core refuses a control character in these fields.

A fact that could not be read is never dropped silently: it is named in
`unreadable`, with why.

## Revoked

When core revokes this device, the *reason string* `"revoked"` alone proves
nothing — anyone who can end the socket can send a string. So core signs the
refusal:

```json
{"type": "auth_error", "reason": "revoked",
 "proof": {"kind": "revoked", "v": 1, "device_id": "...", "nonce": "..."},
 "sig": "..."}
```

`sig` is core's own signing key over the canonical JSON of `proof` — the same
key every command envelope is checked against, pinned at enrollment. Core
sends this exact shape **only** for a row it actually revoked; an unknown
device id (for instance, one a restored database forgot) gets a different,
unsigned reason, and the agent leaves its identity alone.

The agent wipes its identity — deletes `config.json` and `key`, and sets
`audit.jsonl` aside as `audit.jsonl.revoked-<unix>` (never overwriting an
earlier one) — **only** when the proof names this device's own id and this
handshake's own nonce, and verifies against the **pinned** core key (never
the key merely presented earlier in this same handshake's challenge frame —
trusting that would let whoever forged the socket prove itself to itself).
Any other refusal, including this same reason string without a valid proof,
is retried like any ordinary auth failure.

Either way — a clean wipe, or one that only partly succeeded — the process
then exits **78**. `novad.service` carries `RestartPreventExitStatus=78`, so
systemd stops instead of restarting a device that can never get back in. When
a wipe only partly succeeds, the message names exactly which files are still
on disk, checked fresh rather than assumed from which step failed — so
re-enrolling by hand never replays a revoked device's audit chain under a new
id.

## Liveness

The reconnect backoff (1 s, 2 s, 5 s, 15 s, 30 s) resets to 1 s after any
session that authenticated — five dropped connections in a row no longer
means every later reconnect waits the full 30 s for the life of the process.

Once serving, a heartbeat goes out every 20 s, each one followed by a
WebSocket ping core must answer within 10 s. The ping is what catches a dead
path: on one, the kernel keeps taking bytes into its send buffer, so a write
can return although its bytes never arrive — no write error reports that, but
the ping's answer never comes. That same 10 s bounds every heartbeat and
facts-frame write directly: once the send buffer is full a write blocks, and
a write stuck on a dead path ends the session rather than hanging it. The
bound holds on a live link too: a heartbeat or facts write that takes longer
than 10 s — a slow link, say — ends the session, which then reconnects. A
command's result write carries no bound of its own: it ends the session only
once the next heartbeat (or facts) write queues in behind it and that write's
own 10 s bound fires, closing the connection under the stuck result write
too. Beside that, a 1 s wall-clock
watchdog — no I/O of its own — notices a sleep (a wall-clock jump of more
than about 5 s between its samples) and reconnects within about 2 s of the
machine waking; the heartbeat's own slower version of the same check (a gap
of more than twice its own 20 s interval) stays as a backstop beside it,
not a replacement.

## Audit

Every verified command and every refusal is appended to a local, hash-chained
JSONL: `hash = sha256(prev_hash + canonical(entry))`. The daemon replays
entries core has not seen on connect and sends each new entry after the
command. Core re-verifies chain continuity; a break is a loud governance
event, never silently reindexed. A revoked device's chain is set aside, not
deleted, and never replayed under a new id — see Revoked, above.
