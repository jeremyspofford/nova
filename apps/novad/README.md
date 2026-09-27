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

|        | linux/amd64 | linux/arm64 | darwin/amd64          | darwin/arm64          | windows/amd64          | windows/arm64          |
|--------|-------------|-------------|-----------------------|-----------------------|------------------------|------------------------|
| status | walked      | built + CI  | built + CI, unwalked  | built + CI, unwalked  | built + CI; walk pending | built + CI, unwalked |

Mac is unwalked by owner decision 11: Mac support is built and CI-tested, but
the owner's only Mac is his work device, so Nova is never installed on it.

## Build

The reproducible command — the same flags CI uses, so a hash you compute
locally matches CI's and a downloaded binary's:

```sh
CGO_ENABLED=0 GOOS=<os> GOARCH=<arch> go build -trimpath -buildvcs=false \
  -ldflags "-s -w -buildid= -X main.version=$(git rev-parse --short=12 HEAD)" -o novad[.exe] .
```

`<os>`/`<arch>` is one of the six targets above; give `-o novad.exe` on
Windows. The version stamp is always 12 hex characters of the commit — CI
stamps the identical value from `${GITHUB_SHA::12}` — so a build of the same
commit lands on the same sha256 byte for byte, which is what a downloaded
binary's card (S42b) verifies against.

**Anything installed on a machine is built from `~/workspace/nova` on
`main`**, never from a worktree.

## Enroll

In the Nova UI, **Settings → Devices**, mint a pairing code (short-lived,
single-use). Then on the machine you are pairing, run the enroll command for
your OS — see "Install per OS" below for the exact commands. Every OS does
the same thing on the wire: `enroll` generates the device keypair locally
(the private key **never leaves this machine**, stored `0600` on Linux/macOS
or under the DACL described in Custody on Windows), sends only the public key
plus identity — `code`, `pubkey`, `name`, `platform` (`runtime.GOOS`, so core
sees the real OS), `hostname` — and on success pins core's public key.
Re-enrolling is deliberate — it refuses to overwrite an existing enrollment
without `--force`. A spent, expired, or wrong code is surfaced verbatim from
the server.

## Install per OS (manual until S42b adds the installers and service modes)

**Linux:** the systemd user unit and linger, as today:

```sh
install -Dm755 novad ~/.local/bin/novad
novad enroll --server https://your-nova-host --code A1B2C3D4 [--name laptop]
mkdir -p ~/.config/systemd/user
cp novad.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now novad
sudo loginctl enable-linger "$USER"   # survives logout
```

The unit now carries `RestartPreventExitStatus=78`: once core revokes this
device, systemd stops it instead of restarting it every 5 s forever (see
Revoked, below).

**Windows:** in PowerShell,

```powershell
.\novad.exe enroll --server https://nova.<tailnet>.ts.net --code <CODE>
.\novad.exe run
```

SmartScreen may ask once ("More info" → "Run anyway"); the binary is unsigned
for now (owner decision 12). There is no Windows service mode yet — leave the
window open, or start it yourself at logon; the Run-key launcher and `novad
supervise` are S42b.

**Inside WSL:** do not install novad there. `enroll` refuses:

```
novad: cannot: on Windows, Nova's agent runs on Windows itself; run the Windows command (novad.exe enroll) in PowerShell, not this one inside WSL
```

Pair the Windows machine instead — its agent reaches WSL through `wsl.exe`
and `\\wsl.localhost` (see "What it can do", below), so nothing inside WSL
needs its own agent.

**macOS:**

```sh
./novad enroll --server https://your-nova-host --code A1B2C3D4 [--name laptop]
./novad run
```

Unwalked. A LaunchAgent comes with S42b; for now, run it from a terminal, or
launch it yourself at login.

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
systemctl --user restart novad                                 # Linux; on macOS/Windows, restart the running `novad run` yourself until S42b's service mode
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
| `facts.refresh` | send a fresh `facts` frame on this connection, then answer — core has no caller yet (S46a is the first) |

`shell.exec` is **argv-only** — there is no string-to-shell path anywhere. A
user who wants a shell passes it explicitly, e.g. `["bash","-lc","echo hi"]`
on Linux/macOS or `["cmd","/c","dir"]` on Windows, in argv form, visible in
the audit. WSL is reached the same way, through the Windows agent:
`["wsl.exe","-d","<distro>","--",…]` (`WSL_UTF8=1` is set on the child so
`wsl.exe`'s own output is UTF-8, not the OEM code page — other Windows
console programs still print in the OEM code page; see the carries).

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
WebSocket ping core must answer within 10 s; that same 10 s bounds every
heartbeat and facts-frame write, so a write stuck on a dead path (the kernel
still accepting bytes into a connection nobody is reading any more) ends the
session rather than hanging it. Beside that, a 1 s wall-clock watchdog — no
I/O of its own — notices a sleep (a wall-clock jump of more than about 5 s
between its samples) and reconnects within about 2 s of the machine waking;
the heartbeat's own slower version of the same check (a gap of more than
twice its own 20 s interval) stays as a backstop beside it, not a
replacement.

## Audit

Every verified command and every refusal is appended to a local, hash-chained
JSONL: `hash = sha256(prev_hash + canonical(entry))`. The daemon replays
entries core has not seen on connect and sends each new entry after the
command. Core re-verifies chain continuity; a break is a loud governance
event, never silently reindexed. A revoked device's chain is set aside, not
deleted, and never replayed under a new id — see Revoked, above.
