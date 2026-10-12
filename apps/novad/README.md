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
by core on the next replay, not prevented). The table below is the
everyday set; the admin path (`admin.*`), `daemon.update`, the box
(`box.*`) and jobs (`job.*`) have sections of their own:

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
| `net.wake`      | send a Wake-on-LAN magic packet `{mac, broadcast}`: 3 to the subnet-directed broadcast and 3 to 255.255.255.255, UDP 9, from the interface of this machine that owns that broadcast (a broadcast no interface owns is refused, never guessed); the result says what was sent where and when — sending is not waking, so it never says the target woke (core measures that, S46a). The MAC is never in the output |
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

## The admin path

S30b. One standing admin path per machine, so Nova can run **any** argv as
root (Linux, macOS) or as the owner elevated (Windows) with no prompt. It is
installed once, with at most one OS prompt — the owner's — and from then on
nothing asks and nothing refuses. Three capabilities carry it:
`admin.install`, `admin.uninstall` (Nova's tool `device_admin_path`, action
`install` or `uninstall`) and `admin.exec` (`device_run` with
`elevated: true`). Whether a machine has it is a fact, not a call: the
`admin_path` section below, which `device_info` and `machine_status` read.

**What it is.**

- **Linux and macOS — a sudoers drop-in naming a root-owned copy of the
  agent.** `novad admin install --user <u>` (run as root) copies the running
  binary to `/usr/local/libexec/nova/novad` (root, 0755, in a root-owned
  0755 directory) and writes `/etc/sudoers.d/nova-admin` (0440; the name has
  no `.` or `~`, or sudo ignores it):

  ```
  <u> ALL=(root) NOPASSWD: /usr/local/libexec/nova/novad admin exec *
  Defaults!/usr/local/libexec/nova/novad !requiretty
  ```

  The rule is checked with `visudo -cf` on a temp file before an atomic
  rename into place; a rule visudo refuses leaves no file and states
  visudo's words. Re-running replaces both. The rule names the root copy,
  never the agent's own binary under the user's home, which the user could
  rewrite. The kind is `sudoers`. macOS is the same code (its sudoers
  includes `/private/etc/sudoers.d` by default) — **built and tested, not
  walked**: no Mac is paired. `admin install` finds `visudo` on `PATH`;
  Linux sudo's `secure_path` covers that, macOS has none (not walked).
- **Windows — an elevated scheduled task for the owner's own account**
  (owner decision 2026-10-11; see the note in
  [`doing-things.md`](../../docs/plans/rebuild/doing-things.md) S30b). The
  task is `\Nova\NovaAdmin`, registered for the SID of the token that
  installed it — the owner's, read from the token, never a typed name —
  with an interactive token, run level highest, start on demand only (no
  triggers, no stored password: it runs only while he is signed in). Its
  one action is `<the protected copy> admin run-queued`. Two more parts:
  - **The protected copy** `%ProgramFiles%\Nova\Admin\novad.exe`. Its
    directory's DACL is protected and grants SYSTEM and Administrators
    only; the owner's unelevated token carries Administrators deny-only, so
    nothing running as him can replace it. Install verifies the copy's size
    and sha256 against the agent's own binary, and the runner refuses to
    run from anywhere else. The task never runs the agent's own executable
    under `%LocalAppData%`, which anything running as the owner could
    rewrite. (The runner does not re-read this directory's ACL at run
    time; it relies on Program Files' own ACL and the install-time check.)
  - **The request directory** `%ProgramData%\NovaAdmin`, owned by
    Administrators, a protected DACL granting SYSTEM, Administrators and
    the owner's SID only (created in one call; a directory someone else
    made there first is removed and recreated; cleared at install). The
    agent writes `<id>.req.json` there atomically and starts the task; the
    runner re-checks the directory's security on every pass, checks each
    request's owner, claims it by rename, runs it, and writes
    `<id>.res.json`. Anything running as the owner unelevated can place a
    request — the same trust as his own SID, which is exactly whom the task
    runs as.

  The kind is `task`. A console window may flash on the owner's screen per
  run (to be recorded on the Dell walk).

**How it is installed.** By Nova, through `device_admin_path` (action
`install`). The agent picks how to run the installer from what it reads,
then proves the result:

| What the agent reads | Route | The owner's prompt |
|---|---|---|
| it already runs as root / elevated | runs `novad admin install` directly | none |
| the path is already installed | through the path itself (how a reinstall updates the copy) | none |
| Linux/macOS, `sudo -n true` works (the hub) | `sudo -n <bin> admin install --user <u>` | none |
| Linux/macOS, sudo asks for a password | — | **the one command, named in the result:** `sudo '<bin>' admin install --user <u>`, run once on that machine; Nova reads it back with `facts.refresh` |
| Windows, the owner signed in at its screen | ShellExecuteEx `runas` on `<bin> admin install` | **one UAC click.** The prompt shows an unknown publisher (unsigned). The agent waits **60 s** (`caps.UACWait`) for the whole prompt, keeping 40 s for the read-back inside its 110 s command bound, so its answer reaches core before core's 120 s. A No and Windows closing the prompt look the same to the agent, so both — and the wait running out — are one answer: "no Yes came on <machine>'s UAC prompt within 60 s (it was declined, closed, or nobody answered) — nothing was installed: the admin path reads <state> now; …". When the wait ran out the prompt may still be up, and a Yes there still installs it (device_info reads whether it did). |
| Windows, nobody signed in | — | stated: nobody is signed in to answer the UAC prompt; the owner signs in, then clicks Yes |

**What install proves.** On Windows the installer itself, elevated, reads
back what it built before it exits 0: the task's definition (the SID,
interactive token, highest run level, the copy as its command), the request
directory's security, and an elevated `whoami` through the task. Then, on
every OS, the result is `ok` only after the agent, unelevated, reads it back
itself: the path reads installed (Linux/macOS: the root copy is there and
`sudo -n -l <copy> admin exec` allows it; Windows: the task, the request
directory and the copy are there), **and** an elevated round trip through
the path ran
`<copy> admin whoami` and answered euid 0 (unix) or an elevated token for the
owner (Windows). Fresh facts go to core before the answer. Either read-back
failing is `ok:false` with what was read. Core says "installed" only from
that read-back; an `ok` without it is "not confirmed".

**How it is removed, and what removal proves.** `device_admin_path` (action
`uninstall`) runs `admin uninstall` through the path itself — no prompt —
and keeps reading back (up to 20 s on Windows) until nothing of it is left.
On Linux/macOS it removes the drop-in **first**, then the copy, and stops on
a failed drop-in removal; the read-back sees the copy gone, but the agent's
user cannot read `/etc/sudoers.d`, so the rule's absence rests on that order
(a stale rule would name a root-owned path in a root-owned directory that no
longer holds a binary). On Windows it ends and deletes the task, removes the
request directory and the protected copy, and reads all three back. Through
the path the running copy cannot delete itself, so it is moved aside to
`%ProgramFiles%\Nova\novad-admin-removed-<8 hex>.exe` and marked to be
deleted at the next restart; the facts carry it as `pending` (state
`pending_restart`) until it is gone, and the result says "the task, the
request directory and the protected copy are gone; the agent copy is moved
aside to <path> and is deleted at the next restart" — never "nothing of it is
left", and the restart's deletion is scheduled, not proven. With no path
there, uninstall says "no admin path on <machine> — nothing to remove".
`novad uninstall` removes the admin path first, through the path, and says
so; a failure is in its error, never swallowed.

**`device_run(elevated: true)`** sends `admin.exec` (argv, optional cwd).
Linux/macOS: `sudo -n <copy> admin exec --timeout <s> [--cwd <d>] -- argv`;
the root side runs argv in its own session and kills the group itself at the
deadline (the agent's user cannot kill a root process group), set 2 s before
the agent's own; the child's exit code is the result's, and the root side's
own timeout (124) or start failure (127, with its line) is `ok:false`.
Windows: a request through the task; the runner runs argv as the owner,
elevated, in a kill-on-close job; stdout and stderr capped at 64 KiB each
like `shell.exec`; the default elevated run is about 93 s inside the 110 s
command bound (the task's start and the result write get the rest). The
result's first line says how it ran: "exit <code> elevated (as root)", "(as
<user>, elevated)", or — a standard user's highest token — NOT elevated.
Every elevated call, a cannot or a failure included, is a span with
`meta.elevated = true` and `meta.machine`. The stated cannots:

- "no admin path on <machine>" — nothing is installed (or the task is
  absent); nothing runs, never an unelevated fallback;
- "<machine>'s agent predates the admin path — update it with
  machine_update" — an agent without `admin.exec`;
- Windows: the task is disabled; nobody is signed in on the machine (the
  task runs only while the owner is).

**The surface.** Each machine with the path runs whatever core signs as root
or admin, with no prompt. **A compromise of Nova's core is root/admin on
every machine with the path.** The Devices page states this once, naming
those machines; removing the path from a machine is the way out.

## The box (S32.2)

Three capabilities run her change worktrees in a sealed container per change
(design: `docs/plans/rebuild/s32/spec.md` §4; operator view: "Her change
boxes" in `deploy/README.md`). Core sends them only to the repo's machine
(`NOVA_REPO_HOST`), and only for a `cwd` inside
`<checkout>/.worktrees/nova-<id>`.

| capability   | does |
|--------------|------|
| `box.start`  | brings the change's box up (network, cache volume, Postgres, box — each created if missing, started if stopped; a running box is left alone); `start_change` sends it |
| `box.exec`   | the same, then `docker exec -w <cwd> -u <uid>:<gid> nova-box-<id> argv…` — argv only, the same 64 KiB output cap and timeout words as `shell.exec`; a nonzero exit is `ok:true` with its code |
| `box.status` | every box on this machine and its state (`running` / `stopped`), from `docker ps -a --filter label=nova.box`; `list_changes` sends it |

- **The shape is Go code here, never data from the wire.** Core sends only
  `{argv, cwd, change, checkout, branch, limits}`; `internal/box` derives
  every name and path (worktree = `<checkout>/.worktrees/nova-<change>`,
  `.git` = `<checkout>/.git`) and refuses at the edge — a change that is not
  6 lowercase hex, an unclean or relative checkout, a `cwd` outside that
  worktree, a limit out of bounds — before any docker call. No mount, flag,
  image or env ever comes from core. The argv is pinned by
  `internal/box/spec_test.go` and checked against real docker by
  `deploy/devbox/seal_test.sh`.
- **The image** is `nova-devbox:t-<git -C <checkout> rev-parse
  <branch>:deploy/devbox>`, where `branch` is the repo's default branch (core
  never sends the change's own). novad never builds it — `./install` does;
  an image not in the store is ok:false "the box image … is not built —
  ./install from the checkout builds it; nothing was run".
- **Results.** `box.exec`'s meta is `{ran_in: "box", box, image, heavy,
  lock_waited_s}`. A box that cannot start is ok:false "cannot start the box
  nova-box-<id>: <docker's words> — nothing was run": there is no fallback to
  `shell.exec`, here or in core.
- **Dependencies.** Before the box starts (or under a running one), the
  worktree's lockfiles are hashed (read through `os.Root`, never leaving the
  worktree) and compared with the image's `nova.lock.<path>` labels and the
  change's marker; any that differ are fetched by a `docker run --rm`
  container with egress that mounts only a temp copy of the lockfiles and
  manifests and the change's cache volume.
- **The CPU lock.** When argv is exactly one of the suite commands in
  `git show <branch>:deploy/devbox/suites.toml`, run from that suite's
  directory, `box.exec` takes `flock` on `<checkout>/deploy/state/cpu.lock`
  around the exec, waiting until the call's deadline less 10 s. The output
  begins "waited Ns for the CPU lock" when it waited; still held -> ok:false
  "the CPU lock <path> stayed held for Ns — nothing was run".
- **Limits** arrive with each call from core's settings (`box.cpus`,
  `box.memory_gb`, `box.pids`, `box.max_running`); starting a box past
  `max_running` is ok:false naming the running boxes and their idle times.
- **Idle stop.** The agent touches a box on every `box.start` / `box.exec` and
  checks once a minute; a box idle 30 minutes is stopped with its Postgres. A
  box already running when the agent started counts from the first time it is
  seen. A box that runs a live job (see Jobs, below) is never stopped: its
  idle time counts from the last check that saw the job. Removal is not here
  yet (S32.3).
- **Where.** Linux (and macOS) with docker on the agent's PATH and the agent
  running as the owner, who must be able to use docker. The isolated network
  mode needs docker 28+. On Windows there is no box manager: each of the
  three answers "cannot: no box manager on this agent".
- An agent from before S32.2 answers `unknown capability "box.exec"`; core
  turns that into "…'s agent predates the box — update it with
  machine_update; nothing was run".

## Jobs (S30c)

A command through `shell.exec` / `box.exec` is killed at 110 s. Work that runs
longer — a whole test suite, a build, `sleep 200` — is a **job**: it outlives
the call, the turn, and a restart of the agent. Core's tools are
`device_job_start/status/log/stop` (design: `docs/plans/rebuild/
doing-things.md`, S30's *Landed (S30c)* line).

| capability   | does |
|--------------|------|
| `job.start`  | `{job_id, argv, cwd?, env?}` (+ the box args, below): writes the job's spec and spawns the detached wrapper; answers once the wrapper has written its first record — meta `{job, state, survives_agent, why?, detach, ran_in, box?}` |
| `job.status` | the job's record: `state` (`running`, `waiting_lock`, `done`, `failed_to_start`, `stopped`, `lost`), `exit_code` once it ended, pid, times, `lock_waited_s`, `log_bytes` |
| `job.log`    | its log by `offset`/`length` or `tail_bytes` (default: the last 256 KiB), at most 256 KiB per read; meta `{bytes_total, offset, length}` |
| `job.stop`   | writes a `stop` file, ends the child's whole group (Unix: `SIGTERM` to the group, `SIGKILL` 5 s later; Windows: `taskkill /T /F`), waits up to 10 s for the record |
| `job.list`   | every job on this agent, newest first (an unreadable job dir is named, never hides the rest) |

- **The wrapper.** `novad job-exec <jobdir>` is a separate process: it starts
  argv in cwd (argv only, no shell), in a session/process group of its own,
  writes `running` with the child's pid, captures stdout and stderr together
  into `output.log` (capped at 64 MiB; past the cap the child keeps running
  and the log says the cap was reached), then writes the terminal record with
  the exit code. A job dir runs once.
- **On disk.** `<state dir>/jobs/<id>/`: `spec.json` (argv, cwd, env NAMES —
  never values), `status.json` (written whole), `output.log`, `spawn.err`
  (the launcher's own stderr), and the markers `stop`, `audited`, `acked`.
  Env values reach the child only through the wrapper's process environment.
  Job dirs are kept; nothing prunes them yet.
- **Detached, per OS.** Linux and macOS: its own session (`setsid`), stdio on
  `/dev/null`. Under `systemd --user` (`--mode systemd-user`) the wrapper
  first goes into its own transient scope (`systemd-run --user --scope
  --collect --unit novad-job-<id>`), because stopping or restarting
  `novad.service` kills every process in the unit's cgroup; a scope that
  cannot be made still runs the job and says `survives_agent: false` and why.
  Windows: `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW |
  CREATE_BREAKAWAY_FROM_JOB`, out of the supervisor's kill-on-close job (which
  now allows breakaway); under a supervisor from before S30c the job runs
  inside it and says `survives_agent: false` — it ends with the supervisor.
  Windows and macOS are built and tested on CI's runners, not walked.
- **The scanner.** On every connect (after the audit replay) and every 5 s
  while connected: a job whose wrapper is gone with no end recorded (or whose
  record predates the last boot) is written `lost` with why; a terminal job
  gets ONE `job.end` audit entry (keyed to its start envelope, summary `job
  <id> <state> exit <n>`) — the wrapper never touches `audit.jsonl`, so the
  chain stays single-writer; and its `job` frame is sent to core until a
  `job_ack` comes back.
- **Box jobs.** With `{change, checkout, branch, limits}` the job runs inside
  `nova-box-<id>` (the box section's rules: a box that cannot start is
  ok:false, nothing runs, no host fallback). The wrapper's argv is `docker
  exec … nova-box-<id> …` with env values passed through the docker client's
  environment, never argv. A whole suite (the CPU lock rule above) has its
  WRAPPER take the CPU lock with no deadline — `waiting_lock` while it waits,
  `lock_waited_s` after — and hold it for the job's whole run; a stop while it
  waits ends the job with nothing run. `job.stop` also kills the process
  inside the box (by its pidfile), since killing the `docker exec` client
  does not. Windows has no box manager: "cannot: no box manager on this
  agent", nothing started.
- An agent from before S30c answers `unknown capability "job.start"`; core
  turns that into "…'s agent predates jobs — update it with machine_update;
  nothing was started". An unknown id is ok:false `no job <id> on this
  device`.

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
a multi-homed interface can lose addresses silently past the eighth. Core
reads the IPv4 host addresses in `net.ifaces[].ipv4_cidr` (prefix and
loopback dropped) to say which device a model provider runs on:
`machine_status` names this device when a gateway provider's URL host is one
of them — on a LAN, with no Tailscale (see `deploy/README.md` "Machines"). `net`
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

From S30b the frame also carries `admin_path` — `{installed, kind:
"sudoers"|"task"|"none", state, said?, pending?}` — read at every probe
(Linux/macOS: the root copy's stat and `sudo -n -l <copy> admin exec`;
Windows: the task's query, the request directory and copy, and any
moved-aside copy waiting for a restart). See "The admin path", above.

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
