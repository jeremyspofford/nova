## Nova v4 deployment surface: findings for the hub/GPU-box topology

### (1) Cloud-only, with no ollama service

**Yes, it can run without ollama, but only as an install-time switch. There is no runtime toggle.**
- Ollama sits behind `profiles: ["inference"]` (deploy/docker-compose.yml:215). No service has a `depends_on` on it (core :61-63, gateway :85-87, memory :104-106).
- `NOVA_SKIP_INFERENCE=1 ./install` sets `BUNDLED_INFERENCE=0` (deploy/install.sh:247-252). It removes `inference` from `COMPOSE_PROFILES` in .env (install.sh:852-861, 990-1009) and drops ollama from the health wait (:848-850). The GPU check is skipped (:747-749).
- The engine step offers `KINDS = ("ollama","remote","cloud")`. Cloud requires url + api_key + model (services/gateway/app/backends.py:20, 96-104). The installer's closing hint mentions only "Remote endpoint", not cloud (install.sh:1109-1111).

**Caveats that matter for the hub design:**
- **The bundled-ollama address is fixed in compose, not in .env.** Gateway gets `OLLAMA_URL: http://ollama:11434` (docker-compose.yml:79). The builtin `ollama` provider row always resolves to that env var and never to a stored URL (providers.py:84-92, backends.py:74-79). It is seeded at startup and becomes the default if nothing else is (providers.py:222-237). So "proxy the bundled engine to the Dell" is not a setting today.
- The only way to reach another box is a `remote` row: OpenAI-shaped, `auth_shape='none'`, with a stored base_url (backends.py:30-38, 109-130). The model-management code is written against the *bundled* ollama (catalog.py:289, 460, 578; routing.py:278, 301). Model pulls go to the default backend's URL (admin.py:398-421).
- **Memory embeddings bypass the gateway.** `DEFAULT_URL = "http://ollama:11434"` and model `nomic-embed-text` (services/memory/app/embedding.py:70-83). `MEMORY_EMBED_URL` is read from env (:283), but compose never passes it: memory's environment is only DATABASE_URL and SERVICE_TOKEN (docker-compose.yml:100-102).
  - With no ollama, semantic recall reports itself unavailable (embedding.py:71-73).
  - If embeddings pointed at the Dell, they would fail whenever it sleeps. A hub-local CPU ollama just for embeddings (~274 MB model, :77) is the natural fit.
- **VRAM figures come only from a `nvidia-smi` call inside the gateway container** via the GPU overlay (docker-compose.gpu.yml:33-57). A hub gateway without a GPU degrades these to a stated reason. **It has no way to read the Dell's VRAM.** The fit verdicts, the `inference_degraded` check and `inference_health` depend on this (gpu.yml:37-44).

### (2) What the installer assumes about the host

**Required:** bash, written to be 3.2-compatible (install.sh:7); docker running (:62-70); compose v2 (:72-77); openssl (:85-90); at least 10 GB free at the repo root (:96-103).

**Optional:** `lsof`/`ss` for port probes (:105-118); curl or wget (:220-232); `nvidia-smi` (:641-668). RAM comes from `/proc/meminfo`, or `sysctl hw.memsize` on macOS (:629-639).

**Ports:** 3000, 8000, 8001, 8002 and 8380 only produce a warning (:37, 120-130). A busy 11434 is a hard refusal unless it is this stack's own ollama (:246-320).

**There is no arch, WSL or OS detection.** Grepping install.sh for uname, arch, arm, WSL or platform finds only an error-message mention of "WSL restart" (:799). There are no `platform:` keys in any compose file.

**GPU handling is NVIDIA-only:**
- `detect_gpu_runtime` greps `docker info` for "nvidia" (:670-676).
- `inference_library_for_driver` maps only `nvidia → CUDA` (:706-711).
- The overlay is merged only when that runtime is present (:829-835).
- With no GPU, the log says "bundled ollama will run on the CPU" and the CUDA check is skipped (:750-753, 840-842).

**Small x86 Linux mini PC with no GPU:** should work as-is. Ollama runs on the CPU, or is skipped with the flag.

**ARM:** not guarded, and nothing in the repo tests the stack on it.
- Every image is a stock multi-arch image; this comes from general knowledge, not the repo: postgres:16, python:3.12-slim, node:22, nginx:alpine, ollama 0.33.1, tailscale v1.102.3, searxng.
- Python dependencies are fastapi, uvicorn[standard], asyncpg, argon2-cffi, cryptography, httpx, pyyaml and python-multipart (services/*/pyproject.toml). All have arm64 wheels, again from general knowledge.
- novad explicitly supports arm64 (apps/novad/README.md:23-24, 33).

**Other host-portability hazards:**
- The project network is pinned to `172.18.0.0/16`, with fixed IPs at 172.18.128.10 and .20 (docker-compose.yml:126, 255, 329-334). This can collide with an existing docker or LAN subnet on a new host.
- `data/hardware.json` is written once at install (install.sh:808-824) and mounted read-only (compose:83).
- There is no systemd unit or boot setup. Autostart relies only on `restart: unless-stopped` plus the docker daemon.

### (3) Networking and Wake-on-LAN

**No service uses `network_mode`.** No service has `cap_add`, macvlan/ipvlan or `extra_hosts` either.
- The only `network_mode` hits are a negative test (deploy/tailnet_topology_test.sh:213, 223).
- A test asserts the sidecar has neither (deploy/tailscale/start_test.sh:501-502).
- All services share the one `default` bridge (compose:329-334).
- Every published port is bound to `127.0.0.1` (compose:36, 75, 99, 119, 190, 217).

**Consequences:**
- **No container can put a LAN broadcast out today.** This is an inference, not a repo fact: a bridge container's 255.255.255.255 stays on the docker bridge, and directed broadcasts are not forwarded by default.
- WoL would need one of:
  - a small `network_mode: host` "waker" service. This works on native Linux docker, which a mini PC would run. On Docker Desktop, host mode does not reach the physical LAN.
  - macvlan.
  - a unicast magic packet plus a static ARP entry.
  - novad on the hub host, which has `shell.exec` (apps/novad/internal/caps/caps.go:61) and is Linux-only (README:33).
- The tailscale sidecar runs in userspace (`TS_USERSPACE: "true"`, compose:269-274) and only does inbound `serve`. It is not a route for other containers, and it carries no L2 broadcast.
- **The installer's advice to use `http://host.docker.internal:11434` is wrong on native Linux** (install.sh:318). v4 compose has no `extra_hosts: host-gateway`, so the name will not resolve from gateway there. v3 had it on `backend` (root docker-compose.yml:165-166).
- **The Dell's ollama is not reachable from the mini PC.** Its bundled ollama publishes only on `127.0.0.1:11434` (compose:217). It would need a LAN bind, and under WSL2 NAT a Windows portproxy or mirrored networking.
- **LAN-only thin clients cannot reach the hub.** Web is loopback-only (compose:119). The README states "nothing but this sidecar (and an explicit tunnel or funnel) exposes the stack beyond loopback" (deploy/README.md:220-222). Thin clients therefore need Tailscale or a changed bind.

**Web nginx** (apps/web/nginx.conf.template):
- Only `core:8000` is proxied; gateway and memory are unreachable from a browser (:1-3). Core's address is re-resolved through docker DNS `resolver 127.0.0.11` (:221).
- **Gate:** opt-in `NOVA_PUBLIC_GATE_TOKEN`, cookie minted at `/gate` (:104-113, 138-141, 258-265).
- **Tailnet exemption:** a request is trusted only if its source IP is `NOVA_TAILSCALE_ADDR` **and** it carries the `Tailscale-User-Login` header (:117-133).
- **Long streams**, 3600 s timeout and unbuffered: chat stream, model pull and timer fire (:293-362).
- **Device WebSocket** `/api/v1/devices/ws`: the only Upgrade-aware location, deliberately ungated and authenticated by ed25519 (:398-415).
- **Generic `/api/`:** 60 s read timeout (:419-434). Uploads are capped at 100 MB (:210). `/healthz` is ungated (:238-242).

**Tailscale sidecar:**
- Pinned to v1.102.3 at a fixed IP (compose:243, 253-256). It runs `start.sh`, which applies `tailscale serve --bg --https=443 http://$NOVA_WEB_ADDR:80` with a timeout (deploy/tailscale/start.sh:148-166) and then verifies it (:170-173).
- The healthcheck (serve_check.sh:108-124) passes only when BackendState is `Running` **and** the 443 mapping is present.
- It is turned on with `NOVA_TAILNET=1`, which needs `TS_AUTHKEY` or an existing node state (install.sh:537-614).

### (4) Backup, restore, migration and update

**v4 has no backup or restore tooling.** The v4 roadmap says so verbatim, "v4 has nothing" (docs/plans/rebuild/ROADMAP.md:282-295), and a grep for pg_dump, pg_restore or backup in deploy/, services/ and install finds none.
- `scripts/nova_restore.py` and `backend/app/backup_*.py` are **v3** and useful only for mining. The script mirrors `backend/app/backup_crypto.py` (nova_restore.py:35-36) and restores a single `nova` database (:491-492).

**What a Dell → mini PC move must carry by hand:**
- **Databases:** `nova_core`, `nova_gateway`, `nova_memory`, each with its own role (deploy/postgres-init/01-databases.sql:13-20).
- **Volumes:** `v4_pgdata`, `v4_memdata`, `v4_workspace`, `v4_models`, `v4_ollama`, `v4_tailscale` (compose:336-351).
- **`deploy/.env`.** The roles' password is set from `POSTGRES_PASSWORD` only on the first init of an empty volume (01-databases.sql:1-11). A copied pgdata volume is unusable without the matching .env.
- `data/hardware.json` is simply regenerated by the installer.

The only documented volume-copy procedure is the tailscale node migration: `docker run --rm -v A:/from:ro -v B:/to … cp -a` (deploy/README.md:176-202). The same pattern would apply to the other volumes.

**Update path:**
- `./install update` is a stub that exits 1 ("arrives in a later slice", install.sh:1125-1128; install:10).
- In practice an update is `git pull` plus re-running `./install`, which does `up -d --build` (install.sh:1013-1016). Services run their migrations at startup (services/core/app/main.py:46-60; services/memory/app/main.py:20-38).
- Everything is built from source; no registry images of our own. Pinned upstream images are ollama 0.33.1 (compose:208) and tailscale v1.102.3 (:243).

### (5) Existing multi-host, remote-inference or WoL material

**Wake-on-LAN is not built anywhere.** A whole-repo grep finds no code at all.
- The only design is the **v3** plan docs/plans/machine-management.md:84-89 and :112. It says WoL should be a typed tool ("a MAC address and a UDP send, with no command string"), not a shell call. That doc references v3 `backend/app` and migrations.

**What exists in v4:**
- The wizard's "Remote endpoint" option (install.sh:246-250, 315-318; apps/web/src/pages/onboarding/steps/ChooseEngine.tsx:22-23). The hardware step suggests "a small local model or a remote endpoint" when no GPU is found (HardwareDetection.tsx:108).
- The `MEMORY_EMBED_URL` comment: "A deployment that runs ollama somewhere else sets MEMORY_EMBED_URL" (embedding.py:70-73). It is not wired into compose.
- The tailnet README: one HTTPS origin for phones, laptops and remote `novad` daemons, and pairing from the tailnet URL (deploy/README.md:56-58, 144-151).
- The novad daemon: an outbound WSS "second machine" with signed envelopes (docs/plans/rebuild/slice-05-daemon.md:18-26, 94-104). It is Linux-only; macOS and Windows are deferred to a later slice (:216).
- Slice 23, "serving runtime" (context/VRAM sizing), is **parked** with nothing built (docs/plans/rebuild/slice-23-serving-runtime.md:3-6).
- The v3 plan docs/plans/named-inference-endpoints.md:11, 30, 64-65 records the `host.docker.internal` / `extra_hosts` trap.

**Nothing describes** a hub/worker split, a remote-GPU "local" engine, remote VRAM reporting, power state or wake of an inference host, or a compose profile for "hub without GPU".