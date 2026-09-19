# Hub move and setup surfaces: design for area C

## Summary

- **Backup and restore become installer verbs**: `./install backup [--move]`, `./install restore <archive> [--drill]` and `./install undo-move`.
  - Each database is dumped by the postgres container's own `pg_dump`, so the client and server versions match by construction.
  - Every backup test-restores itself into scratch databases before it counts as written.
  - A restore prints "verified" only after three things read back: every table's row count and md5, the core signing-key fingerprint, and a sha256 listing of every volume file.
- **Hub install becomes host-portable.**
  - The project subnet is chosen at install time, recorded in `.env`, and checked against docker networks and host routes. On the mini PC it lands on 172.22.0.0/16, because 172.17–172.21 are taken.
  - On a hub with no GPU, the bundled ollama stays installed for the embedder, and the installer makes sure the embedder model is pulled and verified.
  - `backup --move` leaves a marker on the Dell that stops the old stack from ever coming back up with the same tailnet identity.
- **One backend decides setup state for all three surfaces.** `app/machines.py`, with routes in `machines_api.py` and tools in `tools/machines.py`, holds the add-a-machine flow and computes the checklist. Onboarding, Settings → Models → Machines and Nova's tools all call the same functions, so they cannot drift.
- **Adding a machine is one command, served by the hub.** The owner mints a one-time code and runs one line on the GPU machine. That line installs novad and the node package, then pairs (or, for an already-paired machine, attaches).
  - The hub derives MAC, LAN and tailnet facts from novad's report; nothing is typed in by hand.
  - The node's bearer token is minted by the hub and handed over in that same exchange.
- **Nova gets five tools**: `machine_add_code`, `machine_status`, `machine_configure`, `machine_test_wake`, `machine_wake_check`. They come with one new guard (`code_claim`), two new narration kinds, capability phrases, a deferral action class, state-claim evidence for machine spans, and two eval cases.
- **Thin clients**: an "Use Nova on another device" section with a QR code of the tailnet address (taken from real tailnet requests, never typed in) and install steps per platform. No service worker is needed; the web sources for that are cited in (e).
- **Jeremy's SSH/secrets question: no SSH keys and no secrets manager.**
  - novad pairing gives each machine its own ed25519 key, and core's key is pinned on the device. Commands are signed and single-use.
  - The inference link uses a per-link bearer token minted by the hub and delivered when the machine pairs.
  - The wake packet needs no credential at all: it can only wake the machine, never command it.
  - What remains stored in plaintext: the node token and provider keys in the gateway database, and the backup archive, which holds sessions, provider keys and the signing key. That is Proposal A's scope. Archives are written 0600 and stay on the tailnet.

---

## Components & responsibilities

| Component | Owns |
|---|---|
| `deploy/install.sh` (+ `deploy/backup.sh`, sourced) | subnet choice; embedder check; `backup`, `restore`, `undo-move`; the moved-marker refusal |
| `services/core/app/machines.py` | add-codes (purpose `inference_node`); `attach`; `register_node` (calls the gateway); `checklist(name)`; `origin()`; wake-test orchestration, composed from area B's primitives |
| `services/core/app/machines_api.py` | `/api/v1/machines/*` routes and the public node bundle |
| `services/core/app/tools/machines.py` | the five tools, thin over `machines.py` |
| core image | builds novad for linux amd64 and arm64 through a compose `additional_contexts` entry; serves the bundle |
| `apps/novad` | new `repoint`, `attach-node` and `enroll --json` |
| `apps/web` | `AddMachineFlow`, `MachinesSection`, `OpenElsewhere`; the fourth engine option in ChooseEngine |

---

## Data model

**Core migration `035_machine_setup.sql`.** 035 is the next free number in `services/core/migrations/`; the latest is `034_attachments.sql`. The unmerged doing-things branch also claims 035, so whichever merges second renumbers.

```sql
ALTER TABLE pairing_codes
  ADD COLUMN purpose text NOT NULL DEFAULT 'device'
      CHECK (purpose IN ('device','inference_node')),
  ADD COLUMN machine_name text CHECK (machine_name ~ '^[a-z][a-z0-9-]{0,31}$'),
  ADD COLUMN used_by_device uuid REFERENCES devices(id) ON DELETE SET NULL;

-- The tailnet address other devices use, derived from real tailnet requests
-- (those nginx forwards Tailscale-User-Login on: only from the sidecar,
-- apps/web/nginx.conf.template:77,429). Never typed in.
CREATE TABLE tailnet_origin (
  id smallint PRIMARY KEY CHECK (id = 1),
  origin text NOT NULL CHECK (origin ~ '^https://[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$'),
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen  timestamptz NOT NULL DEFAULT now());
```

- `devices` stays identity-only. Which device serves models is the gateway engine row's `device_id` (interface A1). Wake measurements live in area B's table (B3).
- **No gateway or memory migrations** from this area.
- **No new settings keys**, so `KNOWN_KEYS` in `test_settings.py` does not move.

**New `.env` keys** (host-specific, never carried between hosts):
- `NOVA_SUBNET`, `NOVA_SUBNET_RANGE`, `NOVA_SUBNET_GATEWAY`. The existing `NOVA_WEB_ADDR` and `NOVA_TAILSCALE_ADDR` are now derived from the subnet.
- `MEMORY_EMBED_MODEL` is passed through to memory's environment, which today is only DATABASE_URL and SERVICE_TOKEN (`docker-compose.yml:100-102`).

**Backup archive**: `nova-backup-<host>-<UTCstamp>-<sha7>.tar`, mode 0600. It has a line-oriented `MANIFEST` because bash 3.2 has no JSON parser (`install.sh:7`):

```
format=nova-backup/1   mode=move|routine   source_host=…   source_sha=…
pg_server_version=16.x   pg_dump_major=16
core_signing_key_sha256=<sha256 of private_key_hex>   tailnet_dns_name=nova.tailba0abb.ts.net
migrations<TAB>nova_core<TAB>001_init.sql,…,034_attachments.sql
table<TAB>nova_core<TAB>public.turn_spans<TAB><count><TAB><md5>
volume<TAB>v4_memdata<TAB><files><TAB><sha256 of sorted sha256 listing>
file<TAB>db/nova_core.dump<TAB><sha256>
env_key<TAB>POSTGRES_PASSWORD   (also CORE_TOKEN, CORE_GATEWAY_TOKEN, CORE_MEMORY_TOKEN, SEARXNG_SECRET, NOVA_PUBLIC_GATE_TOKEN, TAILNET_HOSTNAME)
```

**What is carried**
- Logical dumps of `nova_core`, `nova_gateway`, `nova_memory`. Sessions come with them, so the phone stays signed in.
- `v4_memdata`: the notes and the vector cache.
- `v4_workspace`: files, attachments and trash.
- `v4_tailscale`: only in `--move` mode.
- The secret keys of `.env`: applied only when the target has no `.env`, and refused if they conflict with an existing one.

**What is not carried, and why**
- `v4_pgdata` raw: replaced by the dumps. The fresh volume initialises with the carried password (`postgres-init/01-databases.sql:11-20`).
- `v4_ollama`: model weights. They are re-pulled, or, on the Dell, the node package adopts the existing `nova_v4_ollama` volume so the 27B is not downloaded again.
- `v4_models`: it holds no data. Its only reader is a disk-free check (`admin.py:57,342`).
- `data/hardware.json`: regenerated at install (`install.sh:808-824`).
- Host-specific keys: `COMPOSE_FILE` holds absolute paths plus the Dell's GPU overlay; `COMPOSE_PROFILES`; the subnet and address keys; `TS_AUTHKEY`, which is used once while the identity lives on the volume.
- searxng: stateless.
- novad files: they live on each device, and still verify because the signing key moves with `nova_core`.

---

## Routes and wire frames

**Core routes, prefix `/api/v1/machines`**

| Route | Auth | Does |
|---|---|---|
| `GET ""` | person | engines (gateway `GET /admin/engines`, A1), joined with device liveness, `checklist`, and the last wake measurement (B3) |
| `POST /add-code {name?, device?}` | person | mints a code with purpose `inference_node`; returns `{code_id, code, expires_at, command, origin}` |
| `GET /add-code/{code_id}` | person | `{used_at, device, engine, checklist}`, polled by the web every 3 s |
| `POST /attach {device_id, code, ts, sig}` | **public**, rate-limited like enroll (`devices_api.py:42-49`) | the signature over canonical `{device_id, code, ts}` is verified against `devices.get_live(...).pubkey`; burns the code; `register_node`; returns `{engine, token}` |
| `PATCH /{name}` | person | area A/B configuration write, then read back |
| `POST /{name}/wake-test` → `{test_id}`; `GET /{name}/wake-tests/{id}` | person | background task plus polling. Polling fits inside nginx's 60 s `/api/` read timeout (`nginx.conf.template:419-434`) |
| `GET /{name}/wake-check` | person | structured power facts |
| `GET /node/install.sh`, `/node/novad-linux-{amd64,arm64}`, `/node/SHA256SUMS`, `/node/compose.yml` | **public GET**, open-source artifacts | `install.sh` is rendered with `HUB=<X-Forwarded-Proto>://<Host>` of the request that fetched it |

- **`GET /api/v1/system/origins`** returns `{tailnet: {origin, last_seen} | null, this_request}`.
- The public paths are added to `identity.PUBLIC_PATHS`, an exact-match set (`identity.py:44-51`).

**Change to the enroll response** (`devices.enroll`, `devices.py:197-265`): a code with purpose `inference_node` adds `node: {engine, token}`.
- `machines.register_node` runs inside the burn transaction. It calls gateway `POST /admin/engines {name, kind:'node', device_id, token}` with `base_url` left null.
- If the gateway fails, the whole transaction rolls back, the code is not spent, and enroll answers with the gateway's reason.
- The token is `secrets.token_hex(32)`. Core never stores it: its only home on the hub is the gateway row.

**Filling in the URL**: when a device's first facts frame arrives (B1), `machines.on_facts` sets the engine's `base_url` to `http://{tailnet_ipv4}:{node_gate_port}`.
- It uses the tailnet IP rather than the MagicDNS name, because container DNS on the hub may not resolve `ts.net` names. That is also a measurement (M6).

**novad CLI additions**
- `enroll --json`: prints the response so the install script can write `node.token` to `~/.config/nova-node/node.env` with mode 0600.
- `attach-node --code`: HTTP POST signed with the device key.
- `repoint --server URL`: dials `/api/v1/devices/ws` and reads the `challenge {core_pubkey}` frame (`devices_ws.py:44`). It saves the new server only if that key equals the pinned one; otherwise it refuses with "that server is not the Nova you paired with".

**The served `install.sh`**
1. Detect the architecture; download novad and check its sha256 against `SHA256SUMS`.
2. If novad is already enrolled and `repoint --check $HUB` passes, run `attach-node`; otherwise run `enroll --json`.
3. Unless `--device-only`: fetch `compose.yml` (area B), write `node.env`, `docker compose -p nova-node up -d`, adopting `nova_v4_ollama` if it exists and saying so.
4. Install the systemd user unit (`novad.service`) and enable linger; if linger fails, print the one `sudo loginctl enable-linger` line.

The script prints only what it checked. It never prints "done"; the hub's checklist is what verifies the result.

---

## File-level changes

### deploy/

**`docker-compose.yml`**
- `:332-334` becomes `${NOVA_SUBNET:-172.18.0.0/16}`, `${NOVA_SUBNET_RANGE:-172.18.0.0/17}` and `${NOVA_SUBNET_GATEWAY:-172.18.0.1}`. The defaults keep the Dell's live network unchanged.
- The memory environment gains `MEMORY_EMBED_URL: http://ollama:11434` and `MEMORY_EMBED_MODEL: ${MEMORY_EMBED_MODEL:-nomic-embed-text}`.
- core `build.additional_contexts: {novad: ../apps/novad, nodepkg: ./node}`.

**`install.sh`**
- New functions:
  - `docker_subnets_in_use`: a seam over `docker network inspect`; excludes this project's `nova_default`.
  - `host_routes_in_use`: a seam over `ip -4 route`.
  - `subnet_overlaps`: pure bash integer arithmetic.
  - `pick_project_subnet`: tries 172.18–172.31, then 10.200–10.254.
  - `derive_subnet_addrs`: lower /17 for dynamic addresses, `.0.1` gateway, `.128.10` web, `.128.20` sidecar.
  - `decide_subnet` (called in `cmd_install` after `generate_secrets`):
    - an existing project network means its subnet is adopted, so nothing is recreated;
    - a blank value means the first free subnet is picked and written;
    - a set value that collides means the installer dies, naming the colliding network or route.
  - `ensure_embedder`, after `wait_for_health` when the inference profile is on: pull `MEMORY_EMBED_MODEL` into the bundled ollama and verify it appears in `ollama list`.
  - `refuse_if_moved`: called first in `cmd_install`.
  - `host_sees_node_online`: only on a tailnet install whose state volume came from a move archive. It reads the host's `tailscale status --json` and refuses if a peer with the archived `tailnet_dns_name` is online. If the host has no Tailscale CLI, it says the check could not be made.
- `main` (`:1130-1137`) gains `backup`, `restore` and `undo-move`, sourced from `backup.sh`.
- Reused as-is: `compose_config_text`, `config_project_name`, `config_volume_name`, `config_service_image` (`:394-421`); `get_env_value`/`set_env_value` (`:867-899`); `container_health`/`wait_for_health` (`:1018-1054`); `tailnet_dns_name` (`:618-625`).
- The no-GPU log line (`:841`) now says that on a hub the CPU ollama serves the embedder and chat models belong on a machine with a GPU.

**`backup.sh` (new)**
- `cmd_backup`:
  1. stop core, gateway, memory and web, plus tailscale in `--move` mode, and verify each is stopped;
  2. count and md5 every table (`SET TimeZone='UTC'`; `md5(string_agg(t::text,'' ORDER BY t::text))`);
  3. dump each database with `pg_dump -Fc` inside the container;
  4. `createdb nova_verify_<svc>`, `pg_restore --single-transaction --exit-on-error`, compare, drop;
  5. tar each volume through a throwaway container of the postgres image (`--numeric-owner`), with a sha256 listing;
  6. write the manifest, build the archive, then re-read and re-hash it;
  7. routine mode: `start` the writers and wait for health. `--move`: leave everything stopped and write `deploy/.moved`.
- `cmd_restore`:
  1. verify every member's hash;
  2. refuse if any `nova` container or non-empty target volume exists, or if the checkout lacks a migration filename recorded in the manifest (naming the file and the source SHA);
  3. refuse if `pg_restore --version` major is lower than `pg_dump_major`;
  4. apply the carried `.env` keys;
  5. create the volumes with compose labels, then untar and diff each listing;
  6. `up -d postgres`, then `pg_restore --no-owner --role=<svc> --single-transaction`;
  7. re-count and re-md5 every table; compare the signing-key fingerprint;
  8. stop postgres and write `deploy/.restored`.
  - `--drill` does the same into a throwaway postgres started with `docker run` and throwaway volumes, then deletes them.
- `cmd_undo_move` removes `.moved`; the operator then re-runs `./install`.

**Also in deploy/**
- `deploy/node/`: the node package from area B, served in the bundle.
- `.env.example`: document the subnet keys.
- `README.md`: "Backups", "Moving Nova to another host" and "Machines" sections; the "Migrating an existing node" text (`:176-202`) now points to `backup --move`.

### services/core/
- `app/machines.py`, `app/machines_api.py`, `app/tools/machines.py` (new).
- `app/devices.py`: `mint_pairing_code(..., purpose, machine_name)`; the burn SQL (`:75-86`) returns `purpose, machine_name` and sets `used_by_device`; `enroll` calls `machines.register_node` when the purpose is `inference_node`.
- `app/identity.py`: add the public paths; plus a small hook that upserts `tailnet_origin` when `Tailscale-User-Login` is present and Host matches the regex, throttled to at most once an hour.
- `app/main.py`: include the router.
- `app/tools/__init__.py:80-111`: `*machines.TOOLS`.
- `app/live_facts.py`: `machine_status` goes in `AUTO_RUN`. `machine_wake_check` goes in `NOT_AUTO_RUN` with the reason "it runs fixed reads on another machine; a note must not reach into a machine nobody asked about".
- `app/chat.py` (prompt at `:814-844`): one guidance sentence naming the tools through their module constants.
- `app/guards.py`: see the guards section below.
- `Dockerfile`: a Go build stage producing `/app/node-bundle/{novad-linux-amd64,novad-linux-arm64,SHA256SUMS,compose.yml,install.sh.tmpl}`, built with `-ldflags -X main.version=<sha>`.

### apps/web/src/
- `lib/api.ts:17`: `EngineKind` gains `'machine'`, plus the API wrappers.
- `pages/onboarding/steps.ts:64`: the download step is kept for `machine` only if the gateway can pull to an engine (A3).
- `steps/ChooseEngine.tsx:8-35`: a fourth option, **"Another machine on my network"**, which renders `AddMachineFlow` inline. Continue is enabled when reachable and models are listed.
- `steps/HardwareDetection.tsx:108`: the no-GPU copy points to that option.
- `steps/Ready.tsx`: a link that opens `OpenElsewhere`.
- `pages/settings/MachinesSection.tsx` (new), placed first on the **Models** tab. The tab's blurb (`tabs.ts:32-35`) already says "where it runs", and a machine is where models run. Each tile shows:
  - name and kind;
  - live state, stated and never used to decide anything;
  - models, and GPU library/VRAM;
  - wake setup, relay, and the measured wake time with its date, relay and interface;
  - "Test wake" and "Check power settings";
  - the **"This hub runs chat models"** switch on the hub's tile;
  - "Add a machine", which opens `AddMachineFlow`.
- `pages/settings/OpenElsewhere.tsx` (new), first on the **Devices** tab. Inference-node device tiles get a "Serves models" badge linking to Models.
- `SettingsPage.tsx:184-256`: wire both sections in.
- `package.json`: one pinned zero-dependency QR encoder (for example `uqr`), rendered as inline SVG. There is no CSP in `nginx.conf.template`, so nothing blocks it.

### apps/novad/
- `main.go`: the three verbs above.
- `main_test.go`: tests for them.

---

## Nova's tools

All five use the existing funnel with no gate (test_no_approvals). Each refusal states that a call CANNOT run and why; none says it may not.

| Tool | Parameters | `reads_only` | `ephemeral` | `facts_sink` | What the result states |
|---|---|---|---|---|---|
| `machine_add_code` | `name?` (the qualifier in model ids, e.g. `dell`), `device?` (a paired device for attach) | False (writes a code row) | **True**: a code is a credential and must never become a memory | `{"machine_code": code_id, "expires_at"}` | "Code 7KQ2-M9XP, single use, expires 14:32. On the GPU machine, in a Linux shell (Ubuntu under WSL on Windows), signed in to your tailnet, run: `curl -fsSL https://nova.tailba0abb.ts.net/api/v1/machines/node/install.sh \| bash -s -- --code 7KQ2M9XP`. No SSH key or password: the machine makes its own key, and I hand it the token its models are guarded by." |
| `machine_status` | `machine?` | True | True | `{"device": <device>, "connected": bool}` (the existing shape) and `{"engine": name, "state": …}` (B4) | the checklist, one line per item with a reason on every ✗: paired, connected, facts reported, engine registered, reachable over the tailnet (address, latency, ollama version), models (n), GPU (`library=CUDA`, card, VRAM), wake path (MAC, subnet, relay on the same subnet and connected), measured wake (value, date, relay, interface, or "none yet") |
| `machine_configure` | `machine`, plus any of `serves_models`, `lifecycle` (`always_on`/`wake_on_lan`), `wake_relay`, `wake_mac`, `wake_deadline_s` (30–600) | False | False | the device-connected fact for a relay | the values **read back** after the write (pattern of `models.py:695-706`). Cannot: "mini-pc has no interface on 192.168.0.0/24, so its broadcast cannot reach the Dell; pair a device on that network or set it always on." |
| `machine_test_wake` | `machine`, `max_wait_s?` | False (sends a packet, writes a measurement) | True | connected facts | Progress (via `ctx.progress`): "waiting for the Dell to go quiet (novad still connected)… asleep at 14:01:50 → packet sent from mini-pc via wlo1 to 192.168.0.255:9 → novad back at +8.4 s → engine answering at +12.9 s → CUDA confirmed". Success needs **the wake source Windows reports** (`powercfg /lastwake`, read through interop) to be the network adapter. Otherwise: "awake, but Windows credits the power button, so this did not show Wake-on-LAN works." Failure: "No wake within 600 s", plus the last wake-check blockers. |
| `machine_wake_check` | `machine` | True | True | `{"machine": name, "wake_blockers": [...], "wake_armed": [...]}` | Parsed in code, not by the model. Example: "Sleep states: S3, Hibernate. Hibernate after 180 min on AC: a hibernated machine cannot be woken by a Wi-Fi magic packet. Fast Startup on (affects shutdown only). Intel Wi-Fi 7 BE200: Wake on Magic Packet enabled, armed. Killer E3100G: armed, cable unplugged. I cannot read the BIOS; if a test fails with Windows set correctly, check 'Wake on WLAN' there." Then the steps she cannot take herself. |

How `machine_wake_check` reads the machine: it sends a **fixed argv set** through `_admit`, `_command` and `_require_ok` (`tools/devices.py:122-183`, promoted to non-private names).
- Windows, through WSL interop: `powercfg.exe /a`, `/devicequery wake_armed`, `/lastwake`, `/query SCHEME_CURRENT SUB_SLEEP`; `reg.exe query …\Power /v HiberbootEnabled`; `powershell.exe -NoProfile -Command "Get-NetAdapterPowerManagement | ConvertTo-Json"`.
- Linux: `/sys/class/net/*/device/power/wakeup`, `ethtool`, `iw … wowlan show`.

The model never chooses the commands.

## Guards (`services/core/app/guards.py`)

1. **New `code_claim_check(reply, spans, user_message)`, guard name `code_claim`**, wired next to the others (`chat.py:4256-4410`).
   - It fires on a pairing-code-shaped token (alphabet from `devices.py:47`, `XXXX-?XXXX`) that appears after `--code` or near "code", when that token is absent from every successful `machine_add_code` span's `result_head` in this turn (`chat.py:2255`) and from the user's own message.
   - Correction: "No code was minted this turn, so that one is not real."
2. **Narration kinds** in `_KIND_TOOLS` (`:66-74`):
   - `woke_machine`, backed by `machine_test_wake` and B's `machine_wake`;
   - `configured_machine`, backed by `machine_configure`;
   - plus `_target_of` branches (`:870-890`) reading `args["machine"]`.
3. **`_CAPABILITY_TOOLS`** (`:1188`) gains phrases:
   - "wake (up) (your/the) computer/PC/machine", "Wake-on-LAN", "magic packet" map to the wake tool;
   - "set up/add/connect another machine/computer/GPU" maps to `machine_add_code`;
   - "power/sleep settings" maps to `machine_wake_check`.
4. **An `_ActionClass` `_SETUP_MACHINE`** in `_OFFER_CLASSES` (`:1920`): an instruction to add a machine answered with an offer ("Would you like me to generate a code?") fires.
5. **State-claim evidence**: `_DEVICE_SPAN_PREFIX` (`:2417`, used at `:2538`) becomes the tuple `("device_", "machine_")`. `machine_*` spans carry the existing `connected` fact, so "the Dell is asleep" is backed after `machine_status`.
6. The stack-claim carve-out is area A/B's; these tools supply the `{"engine", "state"}` fact it needs.

## Eval cases (`evals/cases/`)

Both are real tool calls. Minting a code is harmless: it expires, and the turn is not remembered.
- `adds-a-gpu-machine-with-a-minted-code.json`: "I want your models to run on my gaming PC's GPU — how do I hook it up?". Contract: `tool_called machine_add_code`, `guard_absent code_claim`, `guard_absent capability_claim`.
- `checks-power-settings-before-guessing.json`: "why won't my PC wake up when you need it?". Contract: `tool_called machine_wake_check` (with no such machine it still refuses as a span), `guard_absent capability_claim`.
- Pins: `suite_version` 13 → 14 in every file, count 23 → 25 (`test_eval_corpus.py:376-382, 423`), with a history note.

---

## Tests that must move or be added

**Pinned suites that move, each with a stated reason**
- `test_tools_registry.py`:
  - the registered set THIRTY-NINE → FORTY-FOUR, with a history note (`:115-185`);
  - the `reads_only` set gains `machine_status` and `machine_wake_check` (`:501-547`);
  - the tools-that-change-things list gains the other three (`:550-571`).
- `test_live_facts.py`: the two classifications.
- `test_capability_guard.py` MUST_FIRE (`:36`):
  - "I can't wake your computer remotely."
  - "I'm unable to send a Wake-on-LAN packet."
  - "I can't set up another machine for you."
  - "I don't have access to your PC's power settings."
- `test_eval_corpus.py`.
- `tabs.test.tsx` `SECTIONS_BY_TAB` (`:47`): "Machines" under models, "Use Nova on another device" under devices.
- `test_devices_e2e.py`: the PUBLIC_PATHS section.

**New tests**
- `deploy/install_test.sh`:
  - the subnet picker on fixtures (172.17–172.21 in use gives 172.22);
  - an explicit colliding value dies naming the collider;
  - an existing `nova_default` on 172.18 is adopted untouched;
  - the derived addresses;
  - `refuse_if_moved`;
  - `ensure_embedder` refuses on a missing model.
- `deploy/backup_test.sh` (stubbed seams):
  - manifest round-trip;
  - a count or md5 mismatch exits 1 and never prints "restored";
  - pg major 17 → 16 is refused;
  - carried-key filter;
  - refusal on non-empty volumes;
  - missing-migration refusal;
  - hash mismatch touches nothing.
- `tests/e2e/`: a live round trip. Back up an isolated project and restore it into a second project; tables, counts and the signing-key fingerprint must be equal.
- Core:
  - `test_machines.py`: purpose codes; the enroll response carries `node` only for a node code; a gateway failure rolls the burn back; `attach` signature, skew and replay; `on_facts` URL derivation; the checklist and relay subnet match.
  - `test_machines_api.py`.
  - `test_tools_machines.py`: the read-back, the wake-source rule, the ephemeral flags.
  - `test_guards.py`: `code_claim` including the pasted-code exemption, the two narration kinds, `_SETUP_MACHINE`, machine-span state evidence.
  - `test_no_approvals` stays green.
- novad: `repoint` refuses a different key and saves the same one; `attach-node` signature canonicalisation.
- Web: `steps.test.ts`; ChooseEngine; `MachinesSection.test.tsx`; `OpenElsewhere.test.tsx` (no QR when no tailnet origin is known; localhost is never encoded).

---

## (b) Migration runbook: verification at every step, rollback always available

**Preparation (no downtime)**
- **P1.** Put the mini PC checkout at the Dell's commit. Verify: `git rev-parse HEAD` matches.
- **P2.** Take measurements M1–M10 below and record them in the slice document.
- **P3.** On the Dell, `./install backup` (routine). On the mini PC, `./install restore --drill <archive>`. Verify: the drill prints matching counts and md5s, and the signing-key fingerprint matches.
- **P4.** On the Dell, `novad repoint --server https://nova.tailba0abb.ts.net`, then restart the user service. Verify: `novad status` shows the new server, and Settings → Devices shows DELL-XPS-8950 online. This is done before the move so that after it novad reconnects to the hub by itself: the URL and the pinned key stay the same.

**Cutover (downtime starts)**
- **C1.** Dell: `./install backup --move`. Verify:
  - the output says "backup verified";
  - `docker compose ps` lists nothing running;
  - after a few minutes, `tailscale status` on the mini PC shows `nova` offline.
- **C2.** Copy the archive over the tailnet with `scp`. Verify: the tar's sha256 matches on both ends.
- **C3.** Mini PC: `./install restore <archive>`. Verify: it prints "verified" per database, per volume, and for the key fingerprint.
- **C4.** Mini PC: `NOVA_TAILNET=1 ./install`. Verify:
  - it states the chosen subnet 172.22.0.0/16 and the collisions it avoided;
  - it does not ask for an auth key (the state volume holds the node);
  - the old-node-online check passes;
  - the health table is all healthy, and `ensure_embedder` shows `nomic-embed-text`;
  - it prints `https://nova.tailba0abb.ts.net/`.
- **C5.** On the phone PWA: still signed in, threads present, and the Devices tab shows the Dell online. Chat works only if a cloud route exists; no local engine exists until C7.
- **C6.** Pair the hub's own novad: Settings → Devices → Pair, then on the mini PC host run `curl -fsSL http://127.0.0.1:3000/api/v1/machines/node/install.sh | bash -s -- --code X --device-only`. Verify: the `mini-pc` tile is online and `loginctl show-user $USER -p Linger` shows `yes`.
- **C7.** Settings → Models → Machines → Add a machine → "already paired: DELL-XPS-8950", name `dell`, then run the command in the Dell's WSL. Verify: every checklist item is ✓, the ollama volume was adopted (the 27B is listed), and the library is CUDA.
- **C8.** Route chat to `dell:qwen3.8:27b`. Verify: a turn's `turn_spans` shows provider `dell`. Downtime ends here.
- **C9.** Soak for 7 days. The Dell's `nova` stack stays stopped with its volumes intact.

**Rollback (any time during the soak)**
- **R1.** Hub: `docker compose stop`, including the sidecar, and verify every container is stopped.
- **R2.** Dell: `docker compose -p nova-node down`, which keeps the ollama volume; then `./install undo-move`, then `./install`. The pre-move data comes back. Anything done on the hub after C3 is lost unless it is carried back by a reverse move: `backup --move` on the hub, then restore onto the Dell after its old volumes are removed deliberately.
- **R3.** The Dell's novad is already pointed at the tailnet URL and reconnects, because the core key is the same.

After the soak: remove the Dell's old `nova` volumes except `nova_v4_ollama`, which the node package now owns.

---

## (e) Thin clients

`OpenElsewhere` shows a QR code of `tailnet_origin` together with how old that observation is.

- **If no tailnet origin is known**, it states: "Nova has no address another device can reach: turn the tailnet on (`NOVA_TAILNET=1 ./install`)." It never encodes `127.0.0.1`.
- **Prerequisite, shown first:** the device must be signed in to the same tailnet in the Tailscale app. Nova cannot check this; the page loading on that device is the check.
- **Install steps per platform:**
  - iPhone/iPad: Safari → Share → Add to Home Screen → keep "Open as Web App" on (iOS 26) → Add. The icon is copied once (`index.html:18-31`).
  - Android Chrome: ⋮ → Install app.
  - Chrome/Edge on a desktop: install from the browser menu (Edge: ⋯ → Apps → Install this site as an app).
  - Firefox: bookmark only.

**Verified today:**
- Chrome dropped the service-worker fetch-handler requirement for installing from the menu: since version 108 on mobile and 112 on desktop. ([Chrome for Developers](https://developer.chrome.com/blog/update-install-criteria), updated 2023-12-05)
- The *automatic* install prompt still requires a fetch handler, so the steps point to the menu.
- The current criteria list has no service worker in it. ([web.dev](https://web.dev/articles/install-criteria))
- iOS 26's "Open as Web App" toggle is on by default. ([MacRumors](https://www.macrumors.com/how-to/save-safari-bookmark-web-app-iphone-home-screen/), [Apple](https://support.apple.com/guide/iphone/open-as-web-app-iphea86e5236/ios))

**Assumed, not verified:**
- Edge's menu install matches Chromium's.
- The exact menu wording in the current Chrome release.
- `tailscale serve` passes on `Host: nova.tailba0abb.ts.net` (M4).

---

## Live DoD walk

1. Steps P1–C8 above, each verification observed.
2. "Set up the Dell as a machine for your models." She calls `machine_add_code(device="DELL-XPS-8950", name="dell")` and quotes the command. After it runs: "is it ready?" She calls `machine_status` and reads the checklist.
3. "What would stop the Dell waking up?" She calls `machine_wake_check` and names the hibernate timer and the BIOS step she cannot take.
4. "Test waking it." Jeremy sleeps the Dell; she calls `machine_test_wake`, the progress bubble moves, and the measured time or an honest failure is shown.
5. "Stop running chat models on the hub." She calls `machine_configure(serves_models=false)` and reads the value back.
6. Read the `turn_spans` for each step: the right tool span, and no guard fires.
7. Scan the QR code from a second phone and install; take 393 px screenshots of the Machines section, AddMachineFlow, OpenElsewhere and the fourth ChooseEngine option.

---

## Risks and the measurements that must come before building

**Risks**
- **Two tailnet nodes with one identity.** Mitigated by `--move` stopping and verifying the sidecar, the `.moved` refusal, and the host peer-online check.
- **Measurements changing meaning.** The Dell's probe and speed history would read as the N150's under the builtin row. The move must wait for A2.
- **A signing-key mismatch** would make every novad exit (`client.go:181-184`). Mitigated by the fingerprint verification.
- **The archive is a live secret** (sessions, provider keys, signing key). It is written 0600 and kept on the tailnet; encryption at rest is Proposal A's.
- **An N150 running the stack alongside minecraft** may be short of memory.
- **A Wi-Fi-only hub** is unreachable while its Wi-Fi is down.
- **Memory numbers measured on the 3090** (`embedding.py:86-110`) do not describe the N150.

**Measurements, before building**
- **M1.** Subnets and routes on the mini PC.
- **M2.** Postgres `postgres:16` minor versions on both hosts.
- **M3.** Database and volume sizes, and the md5 time on the Dell.
- **M4.** The Host and X-Forwarded-Proto that core sees through `tailscale serve`.
- **M5.** Does WSL on the Dell resolve and reach the tailnet URL (mirrored mode, DNS tunnelling)?
- **M6.** Can the hub's gateway container reach `<dell-tailnet-ip>` through the host's kernel Tailscale?
- **M7.** Warm and cold nomic-embed-text query latency on the N150, against the 1.5 s budget.
- **M8.** Free RAM with the stack and minecraft running.
- **M9.** Is linger on Pop!_OS possible without sudo?
- **M10.** WSL interop (`powercfg.exe`) from a systemd user service, and whether `powercfg /lastwake` credits the Wi-Fi adapter after a magic-packet wake from S3.

---

## Interfaces required from the other areas

**From A (gateway engines)**
- **A1.** Engine rows plus `GET/POST/PATCH /admin/engines`, with:
  - `name` (the id qualifier), `kind hub|node`, `device_id`, stored `base_url`, `token`, `serves_models`;
  - `POST` idempotent on `device_id`; `PATCH` returning the stored row;
  - `GET /admin/engines/{name}/probe` returning `{reachable, version, models, state}` and never waking anything.
- **A2.** Pre-existing probe and speed rows moved into a frame no engine decision reads (the precedent is `008_probe_vram_frame.sql`). This must land **before C1**.
- **A3.** `/admin/pull` and `/admin/suggest` accept an `engine`.
- **A4.** Creating a provider no longer lists the builtin's tags (`admin.py:659-672`).

**From B (node, wake)**
- **B1.** The novad facts frame, stored by core and read with `devices.facts(id)`: `{os, arch, novad_version, wsl, interfaces:[{name, mac, ipv4_cidr, kind, up}], tailnet_ipv4, gpus, node_gate_port}`. Under WSL, the MAC comes through interop if mirrored mode hides it.
- **B2.** `deploy/node/compose.yml`, plus a gate that refuses everything when `NODE_TOKEN` is unset and listens only on the tailnet IP, with `GET /nova/compute` returning ollama's `library=` line.
- **B3.** `wake.send(engine, relay)` (a typed novad `net.wake`), `wake.wait_ready(engine, deadline, progress)`, the `wake_attempts` table with `started_by='test'`, the plain `machine_wake` tool, and where the wake configuration lives, with one write-and-read-back function.
- **B4.** How `state` is derived, and the facts shape used by the stack-claim carve-out.

---

## Open questions (owner-level only)

1. **Slice numbers.** S29–S37 and the "S38+" range are claimed by doing-things. I propose S40 (backup/restore and portable install), S41 (engines, A), S42 (node and wake, B), S43 (setup surfaces), S44 (thin clients), and S45 (the move, a walk plus docs). S40 and S44 can land first.
2. **The public node bundle.** The install script and novad binaries would be served without a session on any address the stack answers, including a gated public origin if one is on. Is that acceptable, or should the bundle be restricted to tailnet peers only?
3. **Where this goes in the order of work**, relative to item 0, S26, Proposal A, and S27's open flag-first rule.

### Critical Files for Implementation
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/deploy/install.sh
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/deploy/docker-compose.yml
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/core/app/devices.py
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/core/app/guards.py
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/apps/web/src/pages/onboarding/steps/ChooseEngine.tsx