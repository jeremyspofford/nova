# Distributed Deployment Architecture

> **STATUS: DESIGN ONLY — NOT READY FOR IMPLEMENTATION**
>
> This spec captures the architectural vision for Nova's distributed deployment.
> It was brainstormed 2026-03-28/29 and approved at the design level, but several
> sections need further discussion before implementation begins. When revisiting
> this spec, **resume the brainstorming process** — do not jump straight to
> implementation planning.

---

## Problem Statement

Nova runs as a monolithic Docker Compose stack on a single machine. All services share one bridge network, communicate via container DNS, and assume co-location. This limits deployment to machines with enough resources to run everything (currently ~8-16GB RAM) and offers no flexibility in where or how Nova is deployed.

Different users have fundamentally different needs:

- Privacy-conscious users want everything local with zero cloud dependency
- Home lab users want always-on access on cheap hardware with GPU compute elsewhere
- Cloud users want managed infrastructure without maintaining hardware
- Teams want scalable deployments that grow with usage

Nova should support all of these from a single codebase, with clear documentation and helper scripts for each path.

## Design Principles

1. **Location-agnostic services** — every inter-service URL is configurable, defaulting to current container DNS names (backwards compatible)
2. **One codebase, many topologies** — deployment options are configuration and packaging differences, not forks
3. **Each layer delivers value independently** — the tier architecture works with Compose alone; K8s and IaC are additive, not prerequisite
4. **Minimum viable always-on** — the smallest useful Nova responds to chat, has memory, and routes to available LLMs
5. **Privacy as a guarantee, not an assumption** — "local only" mode actively blocks external calls, not just "don't configure cloud keys"
6. **Graceful degradation** — Nova adapts when resources become unavailable (GPU machine sleeps, cloud is unreachable, internet drops) rather than crashing

---

## Deployment Options

These are the user-facing deployment paths. Each option has a clear target audience, prerequisites, and trade-offs. Users select an option at setup time; a guided setup wizard or CLI generates the right configuration.

### Option 1: Local Private (Air-Gappable)

**Target:** Privacy-first users, enterprise behind firewall, "I own my data" deployments.

**What runs:** All services on one machine. Local inference (Ollama/vLLM with GPU). No external network calls.

**Prerequisites:** 16GB+ RAM, GPU (NVIDIA or AMD), Docker.

**Privacy guarantees:**
- `NOVA_PRIVACY_MODE=strict` blocks all outbound calls except to configured local endpoints
- Embedding model runs locally (not API-based) — required, not optional
- No telemetry, no cloud API fallback, no external DNS for service resolution
- Air-gap capable: Docker images buildable offline, Ollama models pre-downloadable

**Trade-offs:** Requires the most hardware. No cloud fallback — if local inference is down, Nova can't respond. Model quality limited by local GPU VRAM.

**Compose recipe:** Full single-machine stack with `NOVA_PRIVACY_MODE=strict` and inference profile active.

### Option 2: Local + Cloud APIs (Default On-Ramp)

**Target:** Users with a decent machine but no GPU, or who prefer cloud model quality. This is what Nova is today for most users.

**What runs:** All services on one machine. LLM inference via cloud APIs (Anthropic, OpenAI, Groq, etc.).

**Prerequisites:** 8-16GB RAM, API keys for at least one provider, Docker.

**Privacy model:** Data (engrams, sources, workspace) stays local. Prompts and completions transit cloud APIs — users must be comfortable with that.

**Trade-offs:** Easiest setup. Ongoing API costs. Dependent on internet for LLM responses.

**Compose recipe:** Current docker-compose.yml, no inference profile. This is the existing default — no changes needed.

### Option 3: Distributed Home Lab

**Target:** Home lab enthusiasts with multiple machines. Jeremy's N95 + Dell setup.

**What runs:**
- **Always-on machine** (mini PC / RPi): Gateway Tier + Brain Tier — chat, dashboard, orchestrator, memory, routing
- **GPU machine** (desktop, NAS): Inference Tier — Ollama, vLLM, on-demand via WoL
- **Optional cloud fallback**: Cloud APIs when GPU machine is unavailable

**Prerequisites:** Two LAN machines, Tailscale account (free tier works), Docker on both.

**Privacy model:** All data stays on your LAN. Cloud API fallback is optional — without it, this is as private as Option 1 but distributed. With it, prompts transit cloud APIs when local GPU is offline.

**Dashboard adaptation:** The dashboard adapts to what's deployed. If cortex isn't running on the gateway machine, the Brain view shows a clear "not deployed" state rather than an error. Services that are intentionally omitted (per deployment config) are distinguished from services that have crashed.

**Networking:** Tailscale mesh gives each machine a stable DNS name. Services discover each other via env vars pointing to Tailscale hostnames. Alternative for same-LAN: static IPs or mDNS (documented but Tailscale recommended).

**Trade-offs:** More setup complexity (two machines, networking). GPU machine availability is intermittent. Best balance of privacy, cost, and capability.

**Compose recipes:**
- Gateway machine: `docker-compose.yml` + `docker-compose.gateway.yml` + `docker-compose.brain.yml`
- GPU machine: `docker-compose.inference.yml` + `docker-compose.gpu.yml` (self-contained, no postgres/redis dependency)

### Option 4: Home Gateway + Cloud Compute

**Target:** Users who want a home access point but lack powerful local hardware.

**What runs:**
- **Home** (mini PC / RPi): Gateway Tier — chat, dashboard, routing, recovery
- **Cloud** (VPS or cloud instance): Brain Tier + Inference — orchestrator, memory, LLM

**Prerequisites:** Mini PC or RPi, cloud account (VPS or managed service), Tailscale.

**Data location decision:** This option has a fundamental tension — where does postgres live?
- **Postgres at home** (recommended): Data stays on your hardware. Cloud brain connects back via Tailscale. Adds latency to every DB query (~5-20ms LAN-to-cloud). Requires stable home internet.
- **Postgres in cloud**: Lower latency for brain services. Data leaves your home network. Simpler networking. Home gateway becomes a thin proxy that still works if cloud is reachable.
- The setup wizard should present this trade-off and let users choose.

**Trade-offs:** Ongoing cloud costs. Depends on internet connectivity between home and cloud. More complex networking than Options 1-2.

**Compose recipes:**
- Home: `docker-compose.gateway.yml` (lightweight, no postgres/redis if cloud-hosted)
- Cloud: `docker-compose.yml` + `docker-compose.brain.yml` + `docker-compose.inference.yml`

### Option 5: Cloud Only

**Target:** Users who want Nova running without maintaining hardware. Access via browser, Telegram, or API.

**What runs:** Everything on a single cloud VM or small set of VMs. Docker Compose deployment.

**Prerequisites:** Cloud account (AWS, GCP, DigitalOcean, Hetzner, etc.), domain (optional).

**Privacy model:** All data lives in the cloud provider's infrastructure. User accepts cloud provider's data handling.

**Inference options:**
- Cloud APIs only (cheapest VM — 4-8GB RAM sufficient)
- Local inference on a GPU VM (more expensive but no per-token API costs)
- Hybrid: small local model on VPS + cloud API fallback for larger models

**Trade-offs:** Ongoing cloud costs (~$20-50/mo for basic VM, more with GPU). No local hardware to manage. Latency depends on cloud region.

**Deployment:** Ansible playbook or Terraform provisions a VM, installs Docker, deploys Compose stack. Cloudflare tunnel or direct domain for access.

### Option 6: Cloud Scaled (Performance / Team)

**Target:** Teams, power users, future multi-tenant/SaaS path.

**What runs:** Kubernetes deployment with horizontal scaling. Managed databases. GPU node pools for inference.

**Prerequisites:** K8s cluster (EKS, GKE, self-hosted), Terraform/CDK for provisioning, Helm.

**Scaling model:** Single-tenant but horizontally scalable. Multiple replicas of stateless services (chat-api, llm-gateway). Managed postgres (RDS) and Redis (ElastiCache) handle data tier scaling.

> **Note:** Multi-tenant SaaS is an application architecture change (tenant isolation, per-user auth, per-tenant storage), not a deployment topology. Option 6 provides the infrastructure foundation but multi-tenant support is a separate project.

**Trade-offs:** Highest complexity and cost. Most operational overhead. But: most scalable, most resilient, best for team access.

**Deployment:** Terraform/CDK provisions infrastructure (EKS cluster, RDS, ElastiCache, S3, GPU nodes). Helm chart deploys Nova services with per-option values files.

### Decision Tree

```
Do you need everything fully private / air-gapped?
  Yes --> Option 1: Local Private
  No  --> Do you have (or want) dedicated hardware?
    No  --> Do you need team access or scaling?
      No  --> Option 5: Cloud Only
      Yes --> Option 6: Cloud Scaled
    Yes --> Do you have a GPU locally?
      Yes, on my main machine --> Option 2: Local + Cloud APIs (or Option 1 if privacy matters)
      Yes, on a separate machine --> Option 3: Distributed Home Lab
      No  --> Do you have always-on hardware (mini PC, RPi)?
        Yes --> Option 4: Home Gateway + Cloud Compute
        No  --> Option 2: Local + Cloud APIs (cheapest cloud models)
```

---

## Future Horizons

These are not current deployment options but are noted for future phased consideration:

### Managed SaaS (Future)

Aria Labs hosts Nova for users — no self-hosting required. Users sign up, get a Nova instance, and interact via browser/API/Telegram. This requires:

- Multi-tenant application architecture (per-tenant isolation, auth, storage, billing)
- Control plane for provisioning/managing tenant instances
- Usage metering and billing integration
- SLA guarantees, monitoring, on-call operations
- Compliance and data residency considerations

**Priority:** After Option 6 (Cloud Scaled) proves stable with single-tenant deployments. Multi-tenant is the highest-complexity architectural change in Nova's future.

### Edge / IoT / Robotics (Future)

Nova as an embedded AI brain in physical devices — robots, vehicles, kiosks, IoT hubs. This extends the Nano profile concept to:

- Hard real-time constraints (response latency guarantees)
- Sensor integration (camera, microphone, GPS, motor controllers) via MCP tools
- Offline-first operation with opportunistic sync
- Minimal resource footprint (ARM SBCs, 1-4GB RAM, no GPU)
- OTA update mechanism for remote fleet management
- Safety constraints (actuator control requires different guardrails than chat)

**Priority:** After Nano profile (Phase 6) is stable. Edge deployment builds on Nano's combined-process architecture but adds hardware integration and real-time concerns that are fundamentally different from server deployment.

---

## Service Tier Architecture

All deployment options compose from the same three logical service tiers. The tiers are a shared vocabulary — options differ in which tiers run where and with what resource profile.

### Gateway Tier (user-facing, always-on)

| Service | Purpose | RAM | Required? |
|---------|---------|-----|-----------|
| chat-api | WebSocket endpoint, the front door | ~150 MB | Yes |
| chat-bridge | Telegram/Slack relay | ~150 MB | Optional (profile: bridges) |
| dashboard | Admin UI (nginx) | ~50 MB | Yes |
| recovery | Backup/restore, stays alive when others crash | ~256 MB | Yes |
| llm-gateway | Routes LLM requests to inference tier | ~200 MB | Yes |
| voice-service | STT/TTS provider proxy | ~100 MB | Optional (profile: voice) |

**Dashboard proxy caveat:** The dashboard's nginx.conf currently hardcodes upstream URLs (`http://orchestrator:8000`, `http://llm-gateway:8001`, etc.) at build time. For distributed deployment, nginx must resolve service URLs at container startup — either via `envsubst` templating or an nginx Lua module. This is a prerequisite for Phase 2.

**Dashboard feature adaptation:** The dashboard should distinguish between services that are *intentionally not deployed* (per the deployment option's config) versus services that have *crashed*. Intentionally omitted services show a "not deployed in this configuration" state, not an error. This is driven by a deployment manifest that tells the dashboard which services to expect.

### Brain Tier (core intelligence)

| Service | Purpose | RAM | Always-on? |
|---------|---------|-----|------------|
| orchestrator | Task queue, pipeline, MCP tools | ~500 MB - 1 GB | Yes (chat depends on it) |
| memory-service | Engram network, embeddings, retrieval | ~500-600 MB (ONNX) / ~1.5 GB (PyTorch) | Yes (orchestrator depends on it) |
| cortex | Autonomous thinking loop, goals | ~256 MB | Optional |
| intel-worker | RSS/Reddit/GitHub feed polling | ~100 MB | Optional |
| knowledge-worker | Web crawling, document ingestion | ~100 MB | Optional |
| neural-router-trainer | ML re-ranker training | ~512 MB | Optional (batch job, requires PyTorch) |

Orchestrator and memory-service must be co-located with the Gateway Tier or reachable with low latency — chat-api calls orchestrator synchronously. In distributed options (3, 4), they typically run on the always-on machine.

**Neural-router-trainer:** Imports PyTorch at module level. Cannot run on machines using ONNX-only memory-service. Must either run on a Full/Inference tier machine or be disabled. Training is a periodic batch job — running it on the GPU machine when available is fine.

**Recovery service caveat:** Recovery's inference controller (`recovery-service/app/inference/controller.py`) hardcodes URLs for llm-gateway, vLLM, and SGLang. In distributed deployments where inference is remote, recovery's inference management must use configurable URLs or be scoped to local-only services.

### Inference Tier (LLM compute)

| Backend | Where | Cost | Availability |
|---------|-------|------|--------------|
| Local GPU (Ollama/vLLM/SGLang) | Same machine or LAN | Free (hardware cost sunk) | When powered on |
| Cheap VPS (small Ollama model) | Cloud | ~$5-20/mo | Always-on |
| Cloud API providers | Anthropic, OpenAI, Groq, etc. | Per-token | Always-on |

The llm-gateway routes to inference endpoints based on health probes, availability, and user preference.

---

## Resource Profiles

Resource profiles define how services are packaged for different hardware constraints. Deployment options compose these — for example, Option 3 uses Core profile on the mini PC and Full profile on the GPU machine.

### Full (16GB+ RAM) — Default

All services with full dependencies. PyTorch for neural router. Local inference. This is Nova today — no changes needed.

### Core (4-8GB RAM) — Mini PC / Modest VPS

Separate lightweight services via Docker Compose. Key optimizations:
- **ONNX Runtime** for embeddings instead of PyTorch (~500-600MB vs ~1.5GB)
- **PostgreSQL tuned** for 8GB machines (`shared_buffers`, `work_mem`, `effective_cache_size` — not just a lower container limit, as pgvector queries spike `work_mem`)
- **neural-router-trainer disabled** (requires PyTorch)
- **Optional workers** (cortex, intel-worker) enabled only if RAM allows

RAM budget (8GB machine):

| Component | RAM |
|-----------|-----|
| OS + overhead | ~1.5 GB |
| PostgreSQL (tuned) | ~1 - 1.5 GB |
| Redis | 512 MB |
| memory-service (ONNX) | ~500 - 600 MB |
| orchestrator | ~500 MB - 1 GB |
| llm-gateway | ~200 MB |
| chat-api + chat-bridge | ~300 MB |
| dashboard + recovery | ~300 MB |
| **Total** | **~4.9 - 6.1 GB** |

Headroom of ~2-3GB allows cortex (~256MB) and intel-worker (~100MB). If headroom is tight, cortex and intel-worker are the first to disable.

### Nano (2-4GB RAM) — RPi / Ultra-Cheap VPS (Future, Phase 6)

Single combined process. Major architectural differences from Core:

- **One FastAPI app** with orchestrator, chat, memory, and LLM proxy as routers
- **No PostgreSQL** — but this is not just "use SQLite." The engram network relies on pgvector cosine similarity, recursive CTEs for spreading activation, JSONB, TIMESTAMPTZ, and concurrent async writers. Nano needs a **fundamentally different memory backend**: keyword search + recency (no graph traversal), or API-based embedding search against a remote memory-service. This is the hardest design problem in Nano.
- **No Redis** — in-process asyncio.Queue for task dispatch, dict for state
- **No PyTorch** — embeddings via API or bundled ONNX model (~50MB)
- **~500MB - 1GB total RAM**
- **One-liner:** `docker run -e ANTHROPIC_API_KEY=... nova-nano`

> **Needs further discussion:** Nano memory backend design is a separate spec-worthy problem.

---

## Cross-Cutting Concerns

These operational concerns apply across multiple deployment options and must be addressed in the architecture, not per-option.

### Migration Between Options

Users will change options over time (buy a GPU, outgrow home hardware, move to cloud). Migration must be a supported path, not a "start over" event.

**Required tooling:**
- `nova export` — dump all state (postgres, engrams, sources, workspace, config) to a portable archive
- `nova import` — restore from archive into any deployment option
- Format must be option-agnostic: SQL dump + file archive + config mapping
- Migration guide per common transition (Option 2 to 1, Option 3 to 5, etc.)

**Data that migrates:** Postgres (engrams, sources, tasks, goals, cortex state), `./data/sources/` files, workspace contents, `.env` configuration (mapped to new option's format).

**Data that doesn't migrate:** Redis (ephemeral by design), model caches (re-downloaded), Docker volumes.

### Coordinated Updates Across Machines

When services span machines, version drift is dangerous. Service A at v1.5 talking to Service B at v1.4 could break API contracts.

**Mechanisms:**
- **Version handshake:** Services report their version at startup. Orchestrator logs warnings if versions mismatch across connected services.
- **nova-contracts version pinning:** The shared Pydantic contracts package has a version. Services reject connections from incompatible contract versions.
- **Update coordination:** The deployment tooling (Makefile, Ansible) updates all machines in sequence. For Compose-based options, a `make update-all` target SSHs (or uses Tailscale SSH) to each machine and runs the update.
- **Rollback:** Each machine keeps one previous version available for quick rollback.

### Remote Access

Options 1-4 involve home hardware. Accessing Nova remotely is not optional — it's the point of an always-on deployment. Each option's documentation must address remote access as a first-class sub-decision:

| Method | Complexity | Privacy | Reliability |
|--------|-----------|---------|-------------|
| Tailscale | Low | High (WireGuard, private) | High (works behind NAT/CGNAT) |
| Cloudflare Tunnel | Low | Medium (Cloudflare sees traffic) | High (Cloudflare edge) |
| Port forwarding | Medium | Low (exposed to internet) | Low (IP changes, firewall issues) |
| VPN (WireGuard manual) | High | High | Medium (self-managed) |

**Recommendation:** Tailscale for Options 1-3 (already in docker-compose). Cloudflare Tunnel for Option 4 (public access without VPN client). Direct domain for Options 5-6.

### Resilience & Intermittent Connectivity

Not everyone has reliable internet. Nova must degrade gracefully:

- **Cloud API unreachable:** Queue the request, retry with backoff, fall through to next provider or local model. Don't crash or lose the user's message.
- **Remote inference unreachable:** llm-gateway marks endpoint as UNREACHABLE, routes to next available backend. If all backends are down, return a clear "no inference available" response to the user (not a stack trace).
- **Internet drops mid-request:** SSE/WebSocket connections should reconnect. Partial responses should be recoverable from Redis session state.
- **Home-to-cloud link drops (Option 4):** Gateway tier should show a clear "cloud compute unreachable" status, not silently fail. If postgres is at home, local read operations still work.

This is not a separate deployment option — it's a resilience requirement that Options 2, 3, 4, and 5 all need.

### Privacy Mode Enforcement

Option 1's privacy guarantee needs enforcement, not just documentation:

- **`NOVA_PRIVACY_MODE=strict`**: Blocks all outbound HTTP calls except to explicitly allowlisted local endpoints. llm-gateway refuses to route to cloud providers even if API keys are configured.
- **Embedding enforcement:** If privacy mode is strict and no local embedding model is configured, startup fails with a clear error rather than silently falling back to a cloud embedding API.
- **Network policy (K8s):** For Option 6, Kubernetes NetworkPolicy can enforce egress restrictions at the cluster level.
- **Audit log:** In strict mode, log any attempted outbound call that gets blocked, so users can verify nothing is leaking.

### Version Consistency

Distributed deployments risk version drift between machines. Prevention:

- **Startup version check:** Each service reports its version and nova-contracts version to orchestrator at startup. Orchestrator logs a warning (and optionally blocks) if there's a mismatch.
- **Deployment manifest:** A `nova-manifest.json` generated at build time lists all service versions. Deployment tooling compares manifests across machines before completing an update.
- **API contract compatibility:** nova-contracts uses semver. Services accept requests from the same major version; minor version mismatches log warnings.

### Recovery Service Scope

Recovery manages containers via the Docker socket on its own machine. In distributed deployments:

- **Local scope (default):** Recovery manages only services on its own host. "Backup all" means "backup this machine's postgres and data."
- **Coordinated backup:** For multi-machine setups, each machine runs its own recovery instance. A "full backup" is triggered from the primary (gateway) machine, which coordinates with recovery instances on other machines via Tailscale/API.
- **Factory reset:** Scoped per-machine. Full-system reset requires running reset on each machine (or a coordinator command).

> **Needs further discussion:** Whether recovery should gain remote management capability (SSH/API to other machines) or stay local-only with a lightweight coordination layer.

---

## Configurable Service Discovery

### Current state (hardcoded container DNS)

```yaml
# docker-compose.yml
environment:
  LLM_GATEWAY_URL: http://llm-gateway:8001
  MEMORY_SERVICE_URL: http://memory-service:8002
  ORCHESTRATOR_URL: http://orchestrator:8000
```

### New state (env-var driven, backwards compatible)

Every inter-service URL becomes an environment variable that **defaults to the current container name** so single-machine deployments need zero config changes:

| Variable | Default (single-machine) | Example (distributed) |
|----------|--------------------------|----------------------|
| `LLM_GATEWAY_URL` | `http://llm-gateway:8001` | `http://minipc.tailnet:8001` |
| `MEMORY_SERVICE_URL` | `http://memory-service:8002` | `http://minipc.tailnet:8002` |
| `ORCHESTRATOR_URL` | `http://orchestrator:8000` | `http://minipc.tailnet:8000` |
| `OLLAMA_BASE_URL` | `http://ollama:11434` | `http://dell.tailnet:11434` |
| `POSTGRES_HOST` | `postgres` | `minipc.tailnet` |
| `REDIS_HOST` | `redis` | `minipc.tailnet` |

### Scope of hardcoded URL cleanup

The problem is worse than "add env vars to config.py." The orchestrator — the most critical service — has config-based URLs in `config.py` but bypasses them with inline hardcoded URLs in multiple files:

- `orchestrator/app/router.py` — hardcoded health check URLs
- `orchestrator/app/engram_router.py` — hardcoded memory-service URLs (not using `settings.memory_service_url`)
- `orchestrator/app/tools/diagnosis_tools.py` — hardcoded URL map
- `orchestrator/app/tools/memory_tools.py` — hardcoded `MEMORY_BASE`
- `recovery-service/app/inference/controller.py` — hardcoded vllm/sglang/llm-gateway URLs
- `dashboard/nginx.conf` — six hardcoded upstream URLs (requires nginx envsubst template)

Phase 1 must include a comprehensive grep-based audit of all inter-service URLs.

### Networking by deployment option

| Option | Service Discovery | Encryption |
|--------|-------------------|------------|
| 1 (Local Private) | Container DNS | Docker bridge (trusted) |
| 2 (Local + Cloud) | Container DNS | Docker bridge (trusted) |
| 3 (Distributed Home) | Tailscale DNS | WireGuard tunnel |
| 4 (Home + Cloud) | Tailscale DNS + cloud DNS | WireGuard tunnel |
| 5 (Cloud Only) | Container DNS or cloud DNS | Docker bridge or TLS |
| 6 (Cloud Scaled) | K8s service DNS | Service mesh mTLS |

### Inter-service auth & TLS

Today all inter-service traffic is on a Docker bridge network — trusted, unencrypted. In distributed deployments:

- **Home (Tailscale):** Encrypted in transit via WireGuard. No mutual auth between services, but the Tailscale network is private. Acceptable for personal use.
- **Cloud (K8s):** Requires service mesh (Istio, Linkerd) or mTLS. The `NOVA_ADMIN_SECRET` header protects admin endpoints but is not used for service-to-service calls — this gap must be addressed for cloud deployments.
- **VPS:** Tailscale between VPS and home provides encryption. Direct internet exposure without Tailscale is not supported.

---

## Health-Aware Inference Routing

### Current state

llm-gateway has routing strategies (`local-first`, `cloud-first`, etc.) that assume all backends are on the same network. The strategy is static — set once via env var or Redis config.

### New state: location-aware with health probing

The llm-gateway maintains a **live availability map** by periodically probing each configured inference endpoint:

```
Inference Endpoints (ordered by preference):
  1. Dell GPU (Ollama)    -> http://dell.tailnet:11434    -> HEALTHY / UNREACHABLE / DRAINING
  2. VPS (small Ollama)   -> http://vps.tailnet:11434     -> HEALTHY / UNREACHABLE / DRAINING
  3. Anthropic API        -> https://api.anthropic.com    -> HEALTHY / RATE_LIMITED / NO_KEY
  4. OpenAI API           -> https://api.openai.com       -> HEALTHY / RATE_LIMITED / NO_KEY
  5. Groq API             -> https://api.groq.com         -> HEALTHY / RATE_LIMITED / NO_KEY
```

**Routing logic:**

1. Walk the preference list top-to-bottom
2. Skip endpoints that are UNREACHABLE or DRAINING
3. For each HEALTHY endpoint, check if it can serve the requested model
4. If the top choice is UNREACHABLE and supports WoL, send a wake packet and queue the request (with a timeout — fall through to next backend if wake fails)
5. Rate-limited cloud endpoints get exponential backoff
6. In `NOVA_PRIVACY_MODE=strict`, skip all cloud endpoints regardless of health

**Health probing:**

- Local/VPS endpoints: HTTP health check every 30s (`GET /health/ready` or Ollama's `GET /api/tags`)
- Cloud APIs: Passive health — track recent request success/failure rates, no active probing
- Dell WoL state: Track last-seen time; if >5min since last health check, mark as UNREACHABLE (asleep)

**Configuration:** The endpoint list and preference order are configurable via dashboard UI (runtime Redis config) or env vars. This extends the existing `llm.routing_strategy` Redis config.

> **Needs further discussion:** WoL integration details (which service sends the magic packet, wake-to-ready latency, timeout before cloud fallback), request queuing semantics while waiting for WoL.

---

## Data & State Management

### PostgreSQL

PostgreSQL holds engrams, sources, tasks, goals, and cortex state. It's the most critical piece of persistent state.

**Options 1, 2, 3 (home-hosted):** Postgres runs on the always-on machine. For Core profile on 8GB machines, PostgreSQL needs tuning: `shared_buffers`, `work_mem`, and `effective_cache_size` must be set appropriately. pgvector similarity searches load vectors into `work_mem` for sorting; with large engram collections (10k+ at 768 dimensions), a single query can spike memory. Lowering the container limit without tuning causes OOM kills rather than graceful degradation.

**Option 4 (home gateway + cloud):** User chooses postgres location (see Option 4 description). Both are valid — trade-off is latency vs data sovereignty.

**Options 5, 6 (cloud):** Managed database (RDS, Cloud SQL) recommended. In-cluster PostgreSQL with PVC is an option but requires backup strategy. Both use the same `POSTGRES_HOST` env var.

**Nano (future):** Fundamentally different backend (see Nano resource profile section).

**Backup:** Recovery service handles backup/restore. For distributed deployments, backups should be pushed to object storage (S3) in addition to local filesystem.

### Redis

Ephemeral by design — handles task queues, rate limiting, session state, runtime config. Losing Redis data is recoverable.

**Options 1-4:** Redis runs on the always-on machine alongside PostgreSQL.

**Options 5-6:** ElastiCache or in-cluster Redis. Single-node is fine.

**Nano:** In-process asyncio.Queue and dict-based state.

### Volumes & Filesystem

| Data | Where | Cross-machine concern |
|------|-------|-----------------------|
| `./data/postgres` | Always-on machine | Single writer — never shared |
| `./data/redis` | Always-on machine | Single writer — never shared |
| `./data/sources` | Memory-service machine | knowledge-worker pushes via API, not filesystem |
| `NOVA_WORKSPACE` | Orchestrator machine | Agent working directory — must be local |
| Model caches | Inference tier machines | Each node manages its own cache |
| Backups | Primary machine + remote (S3) | Recovery writes locally; push remote for durability |

**Key constraint:** No shared filesystems between machines. Cross-machine communication is HTTP APIs only.

---

## Deployment Adapters & IaC

### Docker Compose Tiers (Phase 2)

Split the current monolithic `docker-compose.yml` into composable tier files:

```
docker-compose.yml              # Base: postgres, redis, shared config
docker-compose.gateway.yml      # Gateway tier services
docker-compose.brain.yml        # Brain tier services
docker-compose.inference.yml    # Local inference (self-contained, no postgres/redis dependency)
docker-compose.gpu.yml          # GPU overlay (existing)
docker-compose.rocm.yml         # ROCm overlay (existing)
```

The inference tier compose file must be **self-contained** — its own network definition, no dependency on the base file's YAML anchors or postgres/redis. Inference services just serve models; they don't need the data tier.

Makefile targets wrap common configurations:

```makefile
deploy-full:       # Single machine: everything (Options 1, 2)
deploy-core:       # Mini PC: gateway + brain (Option 3 gateway machine)
deploy-inference:  # GPU machine: inference only (Option 3 GPU machine)
deploy-cloud-vm:   # Cloud VM: full stack (Option 5)
deploy-nano:       # Ultra-light: combined process (Future)
```

### Deployment Wizard (`nova setup`)

An interactive CLI wizard that detects hardware, asks about the user's environment and preferences, and recommends + configures the right deployment option. Replaces the current single-machine `scripts/setup.sh`.

#### Step 1: Auto-Detect Current Machine

Runs automatically before any questions. Extends the existing `scripts/detect_hardware.sh`:

```
Detecting hardware...
  CPU:       Intel N95, 4 cores @ 3.4GHz (x86_64)
  RAM:       8 GB
  GPU:       None detected
  Disk:      180 GB free
  OS:        Linux (WSL2)
  Docker:    v27.1.1
  Tailscale: installed (3 devices on tailnet)
```

Detection covers:
- **CPU:** cores, architecture (x86_64, aarch64), model name
- **RAM:** total, available
- **GPU:** vendor, model, VRAM (via `nvidia-smi`, `rocm-smi`, or Metal detection)
- **Disk:** free space on target mount
- **OS:** Linux (native/WSL2), macOS, architecture
- **Docker:** installed, version, compose plugin version
- **Tailscale:** installed? If yes, enumerate devices on the tailnet (gives us a view of available machines for distributed options without manual entry)
- **Network:** LAN subnet (for detecting other machines without Tailscale)

Output is stored as `data/hardware.json` (existing format, extended with Tailscale and network fields).

#### Step 2: Inventory Questionnaire

Asks about the user's broader environment — what they have, what they want, what they're willing to pay for. Questions are adaptive (skip irrelevant ones based on prior answers).

**Machine inventory:**

```
What machines do you want Nova to use?

  This machine:
    Intel N95, 8GB RAM, no GPU (detected above)
    Role: [Gateway + Brain] [Full stack] [Inference only] [Skip]

  Other machines (check all that apply):
    [ ] Desktop/workstation with GPU
    [ ] Another mini PC or Raspberry Pi
    [ ] Cloud VM (already running)
    [ ] Cloud account (will provision new resources)
    [ ] None — just this machine

  (If Tailscale detected):
  Found 3 devices on your tailnet:
    dell-desktop (online, last seen: 2 min ago)
    macbook-pro  (online)
    cloud-vps    (offline, last seen: 3 days ago)
  Want to include any of these? [Select devices]
```

For each additional machine the user selects or describes, probe or ask for specs:
- If on Tailscale and online: attempt to SSH and run hardware detection remotely
- If not reachable: ask user for approximate specs (RAM, GPU yes/no, always-on yes/no)

**Preferences:**

```
Data privacy:
  (a) Strict — everything stays on my hardware, no external calls
  (b) Data local, cloud LLM APIs are fine
  (c) No preference — convenience over privacy

Cloud spending:
  (a) Free only — no cloud costs
  (b) Minimal (~$5-20/mo for API credits or a small VPS)
  (c) Moderate ($20-100/mo)
  (d) Whatever it takes

Remote access:
  (a) Local network only
  (b) I need access when away from home
  (c) Other people need access too

Users:
  (a) Just me
  (b) A few (family/friends/small team)
  (c) Many (team/organization)
```

#### Step 3: Recommendation Engine

A deterministic scoring matrix (not an LLM call) that evaluates each deployment option against the user's hardware profile, machine inventory, and preference answers.

**Scoring dimensions:**

| Dimension | Weight | Inputs |
|-----------|--------|--------|
| Hardware fit | High | RAM, GPU, CPU arch vs option's minimum requirements |
| Privacy alignment | High | User's privacy preference vs option's privacy model |
| Budget fit | Medium | User's spending tolerance vs option's cost profile |
| Complexity match | Medium | Number of machines, Tailscale familiarity, cloud experience |
| Capability coverage | Medium | Does the option support all desired features (remote access, multi-user)? |

**Scoring rules (examples):**
- User has 8GB, no GPU, privacy=flexible, has a second machine with GPU on tailnet → **Option 3** scores highest
- User has 16GB + GPU, privacy=strict → **Option 1** scores highest
- User has 4GB RPi, cloud account, budget=moderate → **Option 4** scores highest
- User has no hardware preference, budget=whatever → **Option 5** or **Option 6** based on user count

**Output:**

```
Recommendation: Option 3 — Distributed Home Lab

  This machine (n95-mini):
    Role: Gateway + Brain (always-on)
    Services: chat-api, dashboard, llm-gateway, orchestrator, memory-service,
              recovery, postgres, redis
    Estimated RAM: ~5.5 GB of 8 GB available
    Profile: Core (ONNX embeddings, tuned postgres)

  dell-desktop (via Tailscale):
    Role: Inference (on-demand)
    Services: Ollama (GPU)
    Wake-on-LAN: enabled (N95 wakes Dell when needed)

  Cloud fallback:
    Anthropic API, Groq free tier
    Estimated cost: $0-10/mo (fallback usage only)

  Why this option:
    - Your N95 has enough RAM for gateway + brain with Core profile
    - Your Dell has a GPU for free local inference
    - Cloud APIs fill in when the Dell is off
    - Tailscale already connects both machines
    - Data stays on your LAN; only LLM prompts hit cloud as fallback

  [Accept] [See all options ranked] [Customize]
```

If the user picks "See all options ranked," show all 6 options with scores and disqualification reasons:

```
  #1  Option 3: Distributed Home Lab      ████████░░  82/100
  #2  Option 2: Local + Cloud APIs        ██████░░░░  65/100  (all on N95, tight RAM)
  #3  Option 4: Home Gateway + Cloud      █████░░░░░  58/100  (adds cloud cost)
  #4  Option 1: Local Private             ███░░░░░░░  30/100  (no GPU — can't do local inference)
  #5  Option 5: Cloud Only                ███░░░░░░░  28/100  (you have local hardware)
  #6  Option 6: Cloud Scaled              █░░░░░░░░░  12/100  (overkill for single user)
```

#### Step 4: Config Generation

Once the user accepts a recommendation (or customizes):

1. **Generate `.env`** with correct settings:
   - `NOVA_PROFILE=core`
   - `NOVA_PRIVACY_MODE=flexible` (or `strict`)
   - Service URLs pointing to correct Tailscale hostnames
   - `NOVA_DEPLOYMENT_OPTION=3`
   - LLM provider API keys (prompted if needed)

2. **Generate `nova-manifest.json`**:
   ```json
   {
     "option": 3,
     "machines": {
       "n95-mini": {
         "role": "gateway+brain",
         "tailscale_hostname": "n95-mini",
         "profile": "core",
         "services": ["postgres", "redis", "orchestrator", "memory-service",
                      "llm-gateway", "chat-api", "dashboard", "recovery"],
         "compose_files": ["docker-compose.yml", "docker-compose.gateway.yml",
                           "docker-compose.brain.yml"]
       },
       "dell-desktop": {
         "role": "inference",
         "tailscale_hostname": "dell-desktop",
         "profile": "full",
         "services": ["ollama"],
         "compose_files": ["docker-compose.inference.yml", "docker-compose.gpu.yml"],
         "wol": {"mac": "AA:BB:CC:DD:EE:FF", "enabled": true}
       }
     },
     "cloud_fallback": {
       "providers": ["anthropic", "groq"],
       "privacy_mode": "flexible"
     },
     "generated_at": "2026-03-29T14:00:00Z",
     "nova_version": "1.0.0"
   }
   ```

3. **For multi-machine setups: generate transfer bundle**:
   - A `nova-inference-setup.tar.gz` containing the compose files, `.env`, and a setup script for the second machine
   - Or: print step-by-step instructions for setting up the second machine
   - Or: if Tailscale SSH is available, offer to deploy directly to the remote machine

4. **Run deployment** on the current machine with the right compose file combination.

#### Step 5: Post-Setup Validation

After deployment, verify everything is working:

```
Verifying deployment...
  [OK] PostgreSQL: healthy
  [OK] Redis: healthy
  [OK] Orchestrator: healthy
  [OK] Memory-service: healthy (ONNX backend)
  [OK] LLM Gateway: healthy
  [OK] Chat API: healthy
  [OK] Dashboard: healthy at http://localhost:3001
  [--] Dell inference: unreachable (expected — Dell is asleep)
  [OK] Cloud fallback: Anthropic API responding

Nova is ready! Access dashboard at http://localhost:3001
  Remote access: http://n95-mini.tailnet:3001
```

#### Dashboard First-Run Wizard

If someone reaches the dashboard without having run the CLI wizard (e.g., ran raw `docker compose up`), the dashboard shows a setup wizard with the same questions in a web UI. This calls a `/api/v1/setup/detect` endpoint for hardware detection and `/api/v1/setup/recommend` for the scoring engine. The dashboard wizard is a convenience layer — the CLI is the authoritative path.

#### Re-Running the Wizard

`nova setup` is re-runnable. If a `nova-manifest.json` already exists, it shows the current configuration and asks what the user wants to change (add a machine, change option, reconfigure). It does not destroy existing data — it updates config and restarts services.

#### Implementation Notes

- The scoring engine is a Python module (`scripts/wizard/recommender.py` or similar) that can be imported by both the CLI and a FastAPI endpoint
- Hardware detection extends `scripts/detect_hardware.sh` (or rewrites it in Python for portability)
- Tailscale device enumeration: `tailscale status --json` gives all devices, hostnames, and online status
- Remote hardware detection (if Tailscale SSH available): `ssh <device> "cat /proc/meminfo && nvidia-smi --query-gpu=name,memory.total --format=csv 2>/dev/null"`
- The manifest format is versioned — future wizard versions can read and migrate old manifests

### Helm Charts (Phase 5)

```
deploy/helm/nova/
  Chart.yaml
  values.yaml              # Defaults (Option 2 equivalent)
  values-private.yaml      # Option 1 (privacy mode, local inference)
  values-cloud.yaml        # Option 6 (managed DB, GPU node pools, scaling)
  templates/
    gateway/               # Gateway tier deployments + services
    brain/                 # Brain tier deployments + services
    inference/             # Inference tier deployments + services
    config/                # ConfigMaps, Secrets
    ingress.yaml           # Ingress controller config
```

> **Needs further discussion:** Chart structure, ingress strategy, secret management (Vault? Sealed Secrets? External Secrets Operator?), GPU node affinity, PVC sizing.

### Terraform / AWS CDK (Phase 5)

IaC provisions infrastructure that Nova deploys onto:

```
deploy/terraform/
  aws/
    eks.tf                 # EKS cluster, node groups (CPU + GPU)
    rds.tf                 # PostgreSQL (pgvector extension)
    elasticache.tf         # Redis
    networking.tf          # VPC, subnets, security groups
    s3.tf                  # Backup storage
  modules/
    nova-cluster/          # Reusable module
```

Or AWS CDK (TypeScript):

```
deploy/cdk/
  lib/
    nova-stack.ts          # VPC + EKS + RDS + ElastiCache + S3
  bin/
    deploy.ts              # Entry point with option selection
```

> **Needs further discussion:** Terraform vs CDK (Terraform is cloud-agnostic; CDK is AWS-native and aligns with SAA-C03 study). Could support both. Cost estimation for typical cloud deployments.

### Ansible (Phase 5)

For bare-metal / VPS deployment (Options 3, 4, 5):

```
deploy/ansible/
  inventory/
    example-home-lab.yml   # Option 3: mini PC + GPU desktop
    example-home-cloud.yml # Option 4: mini PC + cloud VPS
    example-cloud-only.yml # Option 5: single cloud VM
  playbooks/
    setup-node.yml         # Install Docker, Tailscale, configure firewall
    deploy-gateway.yml     # Deploy gateway tier
    deploy-brain.yml       # Deploy brain tier
    deploy-inference.yml   # Deploy inference tier with GPU setup
    update-all.yml         # Coordinated update across all machines
  roles/
    common/                # Docker, Tailscale, monitoring
    nova-gateway/
    nova-brain/
    nova-inference/
```

### Per-Option Documentation

Each deployment option gets its own quickstart page:

```
website/src/content/docs/nova/docs/deployment/
  choosing-an-option.md      # Decision tree + comparison table
  option-1-local-private.md  # Air-gapped, privacy-first setup
  option-2-local-cloud.md    # Default on-ramp (current setup guide)
  option-3-distributed.md    # Home lab multi-machine
  option-4-home-gateway.md   # Home + cloud hybrid
  option-5-cloud-only.md     # Single cloud VM
  option-6-cloud-scaled.md   # K8s + IaC
  migration.md               # Moving between options
  remote-access.md           # Tailscale, Cloudflare, VPN comparison
```

---

## Build Sequence

When implementation begins, build in this order. Each phase is independently useful:

### Phase 1: Configurable Service Discovery
- Comprehensive grep-based audit of all inter-service URLs
- Replace hardcoded container names with env vars across all services
- Convert dashboard nginx.conf to envsubst template for runtime URL resolution
- Update recovery service inference controller to use configurable URLs
- Backwards compatible — defaults to current behavior
- **Value:** Services can talk across machines with just env var changes
- **Enables:** All deployment options beyond single-machine

### Phase 2: Compose Tier Files + Deployment Wizard
- Split docker-compose.yml into gateway/brain/inference tier files
- Inference tier compose file is self-contained (no base file dependency)
- Create Makefile targets for common deployment configs
- Add `NOVA_PROFILE` env var for per-service runtime behavior
- Build deployment wizard CLI (`nova setup`):
  - Hardware auto-detection (extend `detect_hardware.sh`)
  - Tailscale device enumeration
  - Questionnaire (machine inventory, privacy, budget, remote access)
  - Recommendation engine (deterministic scoring matrix)
  - Config generation (`.env`, `nova-manifest.json`, compose file selection)
  - Multi-machine transfer bundle generation
  - Post-setup validation
- Dashboard first-run wizard (web UI calling same scoring engine)
- Document Options 1-3 (the Compose-based options)
- **Value:** Deploy Nova across two machines (Options 1, 2, 3 fully functional); any user can run `nova setup` and get a working deployment matched to their hardware

### Phase 3: Health-Aware Inference Routing
- Upgrade llm-gateway to probe multiple remote endpoints
- Add WoL integration for waking GPU machines
- Implement `NOVA_PRIVACY_MODE=strict` (block all cloud calls)
- Dashboard UI for managing inference endpoints and preference order
- Implement resilience: request queuing, graceful degradation, reconnection
- **Value:** Automatic fallback when GPU machine sleeps; privacy mode enforced

### Phase 4: Memory-Service Optimization
- Make PyTorch an optional dependency; conditional imports for neural router code
- Add ONNX Runtime as alternative embedding backend, selectable via `NOVA_PROFILE`
- Ship both backends — Full profile uses PyTorch, Core uses ONNX
- Disable neural-router-trainer in Core profile
- Tune PostgreSQL for 8GB machines (shared_buffers, work_mem, effective_cache_size)
- Profile and optimize RAM usage across all services
- **Value:** Nova Core runs comfortably on 8GB mini PC; Option 3 fully optimized

### Phase 5: Helm Charts + IaC + Ansible
- Create Helm chart with per-option values files
- Terraform/CDK modules for AWS infrastructure
- Ansible playbooks for bare-metal/VPS provisioning
- Coordinated update tooling (update-all across machines)
- Document Options 4, 5, 6
- **Value:** One-click cloud deployment; all six options documented and tooled

### Phase 6: Nova Nano (Future)
- Combined single-process entry point
- Fundamentally different memory backend (not SQLite compatibility layer)
- In-process queues replacing Redis
- Minimal Docker image (~200MB)
- **Value:** Run Nova on a Raspberry Pi or $5/mo VPS

### Phase 7: Migration Tooling
- `nova export` / `nova import` commands
- Portable archive format (SQL dump + files + config mapping)
- Per-transition migration guides
- **Value:** Users can change deployment options without starting over

---

## Hardware Reference

### Jeremy's setup (design target for Option 3)

**Always-on (N95 mini PC):**
- Always-on host: Intel 12th gen N95-class CPU, 4 cores @ 3.4GHz, 8GB DDR4, 256GB SSD
- Runs: Gateway Tier + Brain Tier (Core resource profile)
- WoL capable

**On-demand GPU (Dell desktop):**
- Personal daily driver, not always on
- GPU for local inference (Ollama)
- WoL capable — N95 can wake it when LLM requests arrive
- Runs: Inference Tier only

**Cloud fallback:**
- Cloud API providers (Anthropic, OpenAI, Groq) — pay-per-token
- Optional: cheap VPS with small Ollama model (~$5-20/mo) — always-on middle tier
- Optional: spin-up-on-demand cloud GPU for heavy inference

### Resource constraints driving design decisions

| Constraint | Impact |
|-----------|--------|
| N95 has 8GB RAM total | Memory-service must use ONNX (~500-600MB vs ~1.5GB PyTorch); postgres tuned with proper shared_buffers/work_mem |
| N95 has no GPU | All inference is remote — llm-gateway must route to Dell/VPS/cloud |
| Dell is intermittent | Health-aware routing with WoL + cloud fallback is required, not optional |
| K3s control plane needs ~500MB-1GB | K8s on the N95 is not viable; Compose is the right tool for home deployment |
| Raspberry Pi has 4-8GB ARM | Nano profile must eliminate PyTorch, PostgreSQL, and Redis entirely |

---

## Open Questions

These must be resolved before implementation:

1. **Memory-service ONNX migration** — Which embedding model? Accuracy delta vs PyTorch? Ship both backends selectable via config?
2. **Nano memory backend (Phase 6)** — pgvector has no SQLite equivalent. Simplified backend (keyword + recency), remote memory-service API, or something else? This is its own design problem.
3. **WoL integration** — Which service sends the magic packet? Wake-to-ready latency? Timeout before cloud fallback?
4. **Helm chart scope** — Minimal chart (Option 5 equivalent) first, or comprehensive (Option 6)?
5. **Terraform vs CDK** — Terraform is cloud-agnostic; CDK is AWS-native. Support both, or pick one?
6. **Secret management in cloud** — .env files don't work in K8s. AWS Secrets Manager? Vault? Sealed Secrets?
7. **Nano combined-process feasibility** — How much refactoring to run orchestrator + memory-service in-process? Threading/async conflicts?
8. **Cost modeling** — What does each cloud option cost? Decision tree needs ballpark numbers.
9. **Dashboard nginx template** — envsubst (simple, limited) vs Lua module (flexible, complex)?
10. **Recovery in distributed mode** — Local-only management with coordination layer, or SSH/API-based remote management?
11. **Inter-service auth for cloud** — Service mesh mTLS, shared service token, or something else?
12. **Option 4 postgres location** — Home (privacy, latency cost) vs cloud (simplicity, data leaves home)? Can we support both with clear trade-off docs?
13. **Dashboard deployment manifest** — Format for telling the dashboard which services are intentionally omitted vs crashed?
14. **Managed SaaS prerequisites** — What multi-tenant architecture changes are needed before SaaS is viable? Scope as a separate spec.
15. **Edge/IoT prerequisites** — What real-time, sensor integration, and OTA update capabilities are needed? Scope as a separate spec.
16. **Wizard UX** — CLI-only (Python/bash), or TUI with rich/textual for a nicer terminal experience? How much can we auto-detect vs. must ask?
17. **Remote hardware probing** — If Tailscale SSH is available, should the wizard auto-probe other machines? Privacy/security implications of SSH-ing into user devices during setup.
18. **Wizard re-run behavior** — When re-running after config changes (add a machine, change option), how do we handle services that are already running? Rolling restart? Full down/up?
