# novad — the Nova agent daemon (Linux)

`novad` lets Nova act on a paired computer. It is a small pure-Go daemon that
enrolls with a one-time pairing code, holds an **outbound** WebSocket to core,
and executes only the commands that arrive as ed25519 one-use **signed
envelopes** — every one verified *on this machine* before anything runs. A
compromised or confused core-adjacent component cannot puppet the machine,
because it cannot produce the signature. The LLM never talks to novad; only
core does, through the same tool registry as every other tool.

This is the first Nova code that runs **outside** the compose stack.

## Build

```sh
cd apps/novad
go build -o novad .            # for this machine
```

Cross-compile a static binary (no libc dependency) for another Linux box:

```sh
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o novad-amd64 .
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -o novad-arm64 .
```

Install it on your PATH:

```sh
install -Dm755 novad ~/.local/bin/novad
```

Only Linux (amd64 + arm64) is supported in v1. macOS/Windows are a later slice.

## Enroll

In the Nova UI, **Settings → Devices**, mint a pairing code (short-lived,
single-use). Then on the machine you are pairing:

```sh
novad enroll --server https://your-nova-host --code A1B2C3D4 [--name laptop]
```

`enroll` generates the device keypair locally (the private key **never leaves
this machine**, stored `0600`), sends only the public key, and on success pins
core's public key. Re-enrolling is deliberate — it refuses to overwrite an
existing enrollment without `--force`. A spent, expired, or wrong code is
surfaced verbatim from the server. The enroll body carries identity only:
the code, the public key, the device name, platform and hostname.

Custody, under `~/.config/novad/` (honors `XDG_CONFIG_HOME`):

- `config.json` — device id, server, pinned core key.
- `key` — the device private key (seed), `0600` in a `0700` dir.

The audit chain lives at `~/.local/state/novad/audit.jsonl`
(honors `XDG_STATE_HOME`).

## Run

Two ways. For the pairing walk and for `apps.launch` / `system.notify`, run it
**in a desktop session** so it inherits `DISPLAY` / `WAYLAND_DISPLAY` /
`DBUS_SESSION_BUS_ADDRESS`:

```sh
novad run
```

For an always-on daemon, install the user service:

```sh
mkdir -p ~/.config/systemd/user
cp novad.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now novad
sudo loginctl enable-linger "$USER"   # survives logout
```

`novad status` prints the enrollment, the pinned core-key fingerprint, the last
audit seq, and a reachability probe of the server. It reports "reachable" only
when the HTTP server answers, and it never claims "connected" — reaching a host
is not the same as holding an authenticated socket.

### Graphical-session caveat (read this)

`apps.launch` and `system.notify` need a graphical session bus
(`DISPLAY` / `WAYLAND_DISPLAY` / `DBUS_SESSION_BUS_ADDRESS`). A bare
`systemctl --user` service started at boot may **not** inherit those, so in v1:

- `system.info`, `fs.*`, and `shell.exec` work headless (service or terminal).
- `apps.launch` and `system.notify` are documented as **run-in-session** — start
  `novad run` from a terminal inside your desktop, or import the graphical
  environment into the unit. Full graphical-session wiring is a later hardening.

## What it can do

Every command is verified on the device (signature, expiry, one-use) — that
proves WHO signed it; nothing on the device second-guesses WHAT core asked
for. There is no per-device grant, no path allow-list and no path blocklist: a
paired device runs whatever core signs, as the user `novad` runs as, and that
includes its own `key` and `audit.jsonl` (a rewritten audit chain is detected
by core on the next replay, not prevented). The eight:

| capability     | does                                                        |
|----------------|-------------------------------------------------------------|
| `system.info`  | disk free, memory, OS, hostname, uptime                     |
| `system.notify`| a desktop notification (needs a session; see above)         |
| `fs.list`      | list a directory                                            |
| `fs.read`      | read a file, **256 KiB cap** — a larger file is refused, never truncated |
| `fs.write`     | create/overwrite a file, **256 KiB cap** — larger content is refused, never partially written |
| `apps.list`    | scan `.desktop` apps                                         |
| `apps.launch`  | launch a `.desktop` app (needs a session; see above)        |
| `shell.exec`   | run **argv** (no shell), 64 KiB output cap, honors a timeout |

`shell.exec` is **argv-only** — there is no string-to-shell path anywhere. A
user who wants a shell passes it explicitly, e.g.
`["bash","-lc","echo hi"]`, in argv form, visible in the audit.

`result.ok` means the daemon **performed** the capability and captured a
result — it is *not* the command's own success. A `shell.exec` that runs to
completion is `ok:true` even on a nonzero exit; `exit_code` carries the
command's result. `ok:false` is reserved for the daemon being *unable* to
perform the capability at all (an unverifiable envelope, an over-cap read, an
unstartable binary, a timeout, or notify with no backend) — and a refusal is
still a result frame **and** an audit entry, never silent.

## Audit

Every verified command and every refusal is appended to a local, hash-chained
JSONL: `hash = sha256(prev_hash + canonical(entry))`. The daemon replays entries
core has not seen on connect and sends each new entry after the command. Core
re-verifies chain continuity; a break is a loud governance event, never silently
reindexed.
