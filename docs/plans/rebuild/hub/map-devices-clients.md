# novad, devices, and the web app as a thin client (v4)

Short version: none of the hub, inference-node or wake pieces exist yet. novad reports almost nothing about the machine it runs on, and it runs on Linux only. The web app is already a thin client: everything runs on the server.

## 1. novad: what it is

- It is a small Go daemon that pairs a machine with Nova using a one-time code. It keeps an outbound WebSocket open and runs only commands that core has signed. The model never talks to it (`apps/novad/README.md:3-9`, `apps/novad/main.go:1-6`). Subcommands: `enroll | run | status | version` (`main.go:40-52`). The version is hardcoded as `0.1.0-dev`, and "S6 wires a -ldflags build stamp" (`main.go:32-33`).
- **Pairing:**
  - A signed-in person mints a code with `POST /api/v1/devices/pairing-code` (`services/core/app/devices_api.py:92-93`). The code is 8 characters, has no lookalike letters, lasts 10 minutes, and is stored hashed (`devices.py:43-47`).
  - The device runs `novad enroll --server … --code …`. It generates an ed25519 keypair on the machine and POSTs to the **unauthenticated** `/api/v1/devices/enroll` (`main.go:96-108`, `devices_api.py:101`).
  - The enroll body is `code, pubkey, name, platform, hostname`, and **platform is hardcoded to `"linux"`** (`main.go:157-165`).
  - The response pins core's public key (`main.go:126-146`). Files on the device: `~/.config/novad/{config.json,key}` (permissions 0600/0700) and `~/.local/state/novad/audit.jsonl` (`config/config.go:17-23,38-60`).
- **Connection path:** the WebSocket URL is built from `--server`: http becomes ws, https becomes wss, and the path is `/api/v1/devices/ws` (`internal/client/client.go:96-114`).
  - It is nginx that forwards this to `core:8000`, with the Upgrade headers set (`apps/web/nginx.conf.template:398-410`). The web container is published on `127.0.0.1:3000:80` (`deploy/docker-compose.yml:118-119`).
  - A daemon on the same box uses `http://127.0.0.1:3000`. A remote daemon uses the tailnet URL (`deploy/README.md:149-151`).
  - The device WebSocket is **exempt from the public gate**. Enrolling through a gated public origin does **not** work, so pairing has to happen from localhost or the tailnet (`nginx.conf.template:40-47`, `docs/plans/rebuild/slice-05-carries.md:432-434`).
- **Handshake:**
  - Core sends `challenge {nonce, core_pubkey}`. The device sends `auth {device_id, sig}`. Core replies `ready {last_seq}` or `auth_error` (`internal/wire/envelope.go:27-78`, `services/core/app/devices_ws.py:52-67`).
  - If core presents a different key than the one pinned, the daemon exits and does not reconnect (`client.go:181-184`).
  - Reconnect backoff runs 1s, 2s, 5s, 15s, then 30s (`client.go:119`).
- **What novad reports about the machine (the "hello" data):**
  - **At enroll time only:** `platform` (always "linux") and `hostname`.
  - **The auth frame** carries only `device_id` and `sig` (`envelope.go:46-50`, `client.go:191-195`).
  - **`home_dir` has been removed:** migration 017 dropped the column (`services/core/migrations/017_no_approvals.sql:12-15`), and a test now asserts it is not sent (`apps/novad/main_test.go:37-38`). Core ignores it if an older novad still sends it (`devices_ws.py:63-64`).
  - **Heartbeat** is `{ts}` every 20s (`client.go:36`, `envelope.go:59-61`). Core ignores `ts` and sets `last_seen = now()` (`devices_ws.py:436-437`).
  - **No OS version, CPU architecture, novad version, MAC address, GPU or IP is ever reported.**
  - The frame format is meant to grow: unknown keys are ignored on both sides, so fields can be added without a version bump (`devices_ws.py:52-54`).
- **Signed commands:**
  - Core signs each command with a 60s TTL (`services/core/app/envelopes.py:55`). The device allows 120s of clock skew (`envelope.go:19-23`).
  - Each command can run once. The replay set survives reconnects (`client.go:58-64`).
  - The device gives a command up to 110s, and core waits up to 120s (`client.go:32`, `tools/devices.py:38`).
  - Every command or refusal is appended to a hash-chained audit log, which core re-verifies (`README.md:127-133`, `devices_ws.py:119-132`).
  - **There are no per-device grants.** A paired device runs whatever core signs (`devices.py:3-6`, `README.md:97-102`).
- **systemd user unit:** `ExecStart=%h/.local/bin/novad run`, `Restart=always`, `WantedBy=default.target` (`apps/novad/novad.service:1-12`). It needs `loginctl enable-linger` to keep running after logout (`README.md:69-77`). `apps.launch` and `system.notify` need a graphical session, so under the service they are "run-in-session" only (`README.md:84-93`).
- **Distribution: none.** You build it from source (`README.md:13-31`). CI only builds and tests Linux amd64 and arm64 (`.github/workflows/rebuild-ci.yml:98-112`). The pairing screen assumes novad is already installed (`DevicesSection.tsx:366-367`). There is no installer and no download link.

## 2. Device capabilities and core tools

| Device capability (`caps/caps.go:45-66`) | Core tool (`services/core/app/tools/devices.py`) |
|---|---|
| none (reads Nova's own records) | `device_list` (:187-199, 283-297) |
| `system.info` (hostname, OS, disk free at `$HOME`, memory, uptime; `system.go:17-52`) | `device_info` (:202-206) |
| `fs.list` | `device_list_files` (:209-212) |
| `fs.read` (256 KiB cap) | `device_read_file` (:215-218) |
| `apps.list` (XDG `.desktop` files) | `device_list_apps` (:221-224) |
| `system.notify` (`notify-send`) | `device_notify` (:227-232) |
| `shell.exec` (argv only, 64 KiB output) | `device_run` (:235-244) |
| `fs.write` (256 KiB cap) | `device_write_file` (:247-264) |
| `apps.launch` (`gtk-launch`, then `gio`, then the Exec line) | `device_launch_app` (:267-270) |

- That is nine tools (`tools/devices.py:1`). **There is no separate disk tool**; disk free is only part of the `system.info` text (`system.go:27-39`).
- Before sending anything, core checks three things in order: the device is paired, its socket is connected, and any file path is absolute (`tools/devices.py:119-134`).
- **The path check is POSIX-only:** it requires `path.startswith("/")` and uses `posixpath` (`:114-116`). A Windows path like `C:\…` is refused.

## 3. Settings → Devices and liveness

- **Page:** `apps/web/src/pages/settings/DevicesSection.tsx`. Each device tile shows `platform · hostname` (:264) and offers only Rename and Revoke (:23-26). The list polls every 15s (:20). The pairing modal prints `novad enroll --server ${window.location.origin} --code …` (:352, `devicesFormat.ts:55-57`).
- **Liveness is computed from `last_seen`** (`devicesFormat.ts:18,36-48`). The states are revoked, "never connected", online (heard from within 60s) and stale.
- The REST `connected` field is always `False` (`devices.py:95-113`). Only the `device_list` tool reads live connections from the hub (`tools/devices.py:189-198`).

## 4. Is there a device role or kind?

**No.**
- Table columns: `id, name, platform, hostname, pubkey, owner_person, enrolled_at, last_seen, revoked_at` (`migrations/011_devices.sql:40-65`). The grant columns were dropped (`017:12-15`).
- The API shape is in `device_spec` (`devices.py:104-113`), and the enroll body is in `EnrollBody` (`devices_api.py:56-65`).
- Nothing distinguishes a hub, a client or an inference node. The whole v4 tree has **no Wake-on-LAN code**. The only mention is a v3 plan that suggests it as a typed tool, not a shell command: "a MAC address and a UDP send" (`docs/plans/machine-management.md:84-89,112`).

## 5. Could novad on the GPU box act as an inference-node agent?

What exists that would help:
- The signed channel and the heartbeat already work.
- Frames can take new fields without a version bump (`devices_ws.py:52-54`).
- `device_run` could already call `nvidia-smi` or `ollama ps`, but only as unstructured text.

What is missing:
1. **A role/kind column plus an enroll or auth field.** Nothing like this exists (§4).
2. **GPU and Ollama reporting.** Today every VRAM number comes from `nvidia-smi` run inside the **gateway's own container** (`deploy/docker-compose.gpu.yml:33-40`, `services/gateway/app/devices_vram.py:3,155`). The gateway reaches Ollama only through the `OLLAMA_URL` environment variable (`docker-compose.yml:79`, `gateway/app/providers.py:85-91`). On a mini PC hub with no GPU, fit checks and `inference_health` would have no card to read.
3. **A MAC address and a sender for the wake packet.** novad reports no network facts. The magic packet has to come from the hub, because the sleeping box's novad is offline. My inference, not verified: Docker's bridge network may not pass LAN broadcast, so the hub may need host networking or a host-side helper to send it.
4. **A wake lock or sleep policy.** This needs Windows APIs. novad has no Windows build (§6). From inside WSL, `device_run` could only reach Windows through `powershell.exe` interop. That is my inference and untested.
5. **Handling the socket after sleep.** When the Dell sleeps, WSL freezes and the socket drops, so the device shows stale and tools refuse with "not connected — its tile is stale" (`tools/devices.py:101-105`). Nothing waits for the device to reconnect after a wake. The roadmap already notes that "Watching stops when the machine sleeps… where Nova runs is a bigger question" (`ROADMAP.md:161-163`, `slice-11-carries.md:51-56`).
6. **Moving core carries a trap.** Core's signing key lives in the database and is created once (`devices.py:9-14,119`). Moving the database to the mini PC keeps every pairing. Starting on a fresh database means every novad hits the key-changed exit (`client.go:181-184`) and must re-enroll with `--force` (`main.go:86-88`).

## 6. Windows and S6

- **Not supported.** "Only Linux (amd64 + arm64)… macOS/Windows are a later slice" (`README.md:33`). S6 covers "macOS/Windows daemons, installers, signed self-update" (`slice-05-daemon.md:24,216`). Other S6 mentions: a Windows toast when WSL is detected (`slice-09-carries.md:97-102`) and hardening the graphical-session wiring (`slice-05-carries.md:136`).
- **S6 is not scheduled.** The order of work lists only S26 and S27 (`ROADMAP.md:32-39`).
- **Code that only works on Linux:**
  - `syscall.Statfs` (`system.go:31-32`), which would not compile for Windows.
  - Reads of `/proc/meminfo` and `/proc/uptime` (`system.go:97,127`) and `/etc/os-release` (`system.go:79`).
  - `SysProcAttr{Setsid}` (`apps.go:176`).
  - `notify-send` (`system.go:62`) and XDG `.desktop` app scanning (`apps.go:18-40`).
  - The hardcoded `"linux"` platform (`main.go:162`) and core's POSIX path check.
- novad does run **inside WSL2** today (the owner's Dell). `notify-send` fails there because WSLg has no notification daemon (`slice-09-carries.md:95-100`).

## 7. The web app as a thin client

- **Manifest:** `apps/web/public/manifest.webmanifest:1-30` (standalone display, maskable icon). It is linked from `index.html:32`, with Apple tags at `index.html:17,33-42`. nginx serves it with no-cache and a real 404 if missing (`nginx.conf.template:448-457`), and `index.html` is never cached (:459-465). This was added as the "web manifest" item (`decisions-2026-09-15.md:26-29`, `ROADMAP.md:34`).
- **There is no service worker in v4.** `apps/web/package.json` and `vite.config.ts` have no PWA plugin or workbox, and nothing in `apps/web/src` registers a service worker. So there is no offline app shell and no web push. The root `README.md:224-226` says a service worker caches the app shell, but that README describes v3 (`CLAUDE.md` says so). v3's version is worth mining: `frontend/vite.config.ts:3,50,66-75` (VitePWA plus `push-sw.js`).
- **Installing:** Android and Chromium use the manifest. iOS uses the apple-touch-icon, which is copied once and never refreshed (`index.html:18-31`). iOS needs HTTPS, which the tailnet provides.
- **How phones reach it:**
  - The tailnet origin is `https://nova.tailba0abb.ts.net`, served by the stack's own `tailscale` sidecar (profile `tailnet`, fixed IP 172.18.128.20, proxying to web at .10) (`slice-05b-carries.md:9-17`, `docker-compose.yml:230-244`). The node's identity lives in the `v4_tailscale` volume (`docker-compose.yml:286,351`).
  - My inference: if Nova moves to the mini PC, you either move that volume or use a new authkey, and the URL only stays the same if the node name does.
  - Tailnet peers skip the public gate. nginx trusts `Tailscale-User-Login` only when the request comes from the sidecar's address (`nginx.conf.template:53-79`, `deploy/README.md:55-61`).
  - The public route is `NOVA_PUBLIC_GATE_TOKEN` plus a cookie from `/gate?token=` (`nginx.conf.template:5-26`, `docker-compose.yml:128-135`), optionally through funnel (`deploy/README.md:~155`). Login is a session cookie (`CLAUDE.md`).
- **Desktop wrapper: none.** There is no Tauri or Electron in v4 and none planned in `docs/plans/rebuild/`. The only repo-wide matches are false positives on "DataUri" in `app-icon.ts`.
- **Nothing runs on the client.** Every call goes through `/api` to core (`nginx.conf.template:1-3`, 419). The only device APIs the browser uses are `navigator.clipboard` (e.g. `components/ui/Code.tsx:20`, `DevicesSection.tsx:389`). Slash commands only clear the chat or add a local help row (`lib/commands.ts:16-23`). The browser has no notifications, speech, workers, IndexedDB or install-prompt handling.

## 8. Onboarding, Settings, and Nova walking the user through it

- **Wizard steps:** welcome, account, timezone, hardware, engine, model, downloading, ready (`apps/web/src/pages/onboarding/steps.ts:11-33`). The engine choices are Bundled Ollama, **Remote endpoint** (an OpenAI-compatible URL, "another box on the network, or one on your tailnet") and Cloud (`steps/ChooseEngine.tsx:14-35`).
  - Pointing at the Dell works today only as a fixed URL, with no waking.
  - The wizard has **no device pairing, hub role, or wake step**.
- **Nova has no tools for this setup.** She cannot mint a pairing code, set or change the inference engine or its URL, send a wake packet, or read a device's role or GPU. The only tool that writes a setting is `model_pull`'s `set_as_chat_model`, which writes `chat.model` (`tools/models.py:695-699`). Her full toolset: `tools/*.py`, tool names at lines like `devices.py:284-405` and `inference.py:161`.