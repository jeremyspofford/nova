# Nova Platform Roadmap v2 — Production-Ready, Multi-User, Scalable

> **Status:** Draft spec for review
> **Date:** 2026-03-12
> **Scope:** Rearchitect Nova from a single-user self-hosted AI platform into a secure, multi-tenant system that works for 1 to unlimited users — self-hosted or SaaS, air-gapped or cloud-connected.

---

## Current State Assessment

### What Works Well
- **Core pipeline** (Quartet: Context → Task → Guardrail → Code Review → Decision) is solid
- **LLM Gateway** is stateless, multi-provider, horizontally scalable
- **Auth scaffolding** exists: JWT, RBAC roles (guest/viewer/member/admin/owner), tenants table, invite system
- **Memory service** has `tenant_id` columns in schema (not yet enforced in queries)
- **Dashboard** is multi-user aware (role-based UI, user management pages)
- **Recovery service** is properly isolated (minimal deps, stays alive when others crash)
- **Docker Compose** works reliably for single-machine deployment

### What's Broken or Incomplete for Multi-User

| Problem | Impact | Where |
|---------|--------|-------|
| Pods, tasks, MCP servers have no `tenant_id` | All users share pipeline config | `migrations/002`, `004` |
| Queries don't filter by `tenant_id` | Cross-tenant data leakage | memory-service, orchestrator |
| Hardcoded default tenant UUID everywhere | Can't create real tenants | `auth.py:84`, `cortex/config.py`, etc. |
| Cortex has hardcoded user/conversation IDs | Single autonomous brain for entire system | `cortex/app/config.py` |
| `platform_config` is a singleton | All tenants share one config | `migrations/005` |
| Redis keys lack tenant prefix | Session/state cross-contamination | `store.py`, `session.py` |
| No PostgreSQL row-level security | App-layer filtering only (easy to miss) | All services |
| Recovery backs up entire DB | Can't restore one tenant | `recovery-service/` |
| Redis has no auth, no TLS | Unauthenticated access if port exposed | `docker-compose.yml` |
| All ports on `0.0.0.0` | DB/Redis directly reachable | `docker-compose.yml` |
| `REQUIRE_AUTH=false` by default | Unauthenticated by default | `.env.example` |
| Single Redis instance (512MB) | Bottleneck at scale | `docker-compose.yml` |
| BRPOP single-consumer queue | Can't run multiple orchestrator replicas | `queue.py` |
| Shell sandbox config exists but isn't read | `run_shell` ignores sandbox tier setting | `sandbox.py`, `code_tools.py` |
| Slack adapter scaffolded but empty | Dead code in chat-bridge | `chat-bridge/app/adapters/` |
| Discovery endpoints call external APIs | Breaks in air-gapped environments | `llm-gateway/discovery.py` |
| Chat-api test UI uses CDN (marked.js) | Breaks offline | `chat-api/app/main.py` |
| No HTTPS between services | Plain HTTP inter-service traffic | All services |

### What to Deprecate / Remove
- **Old roadmap phases** that conflict with this plan (keep as `docs/roadmap-v1-archive.md`)
- **Slack adapter stub** in chat-bridge (rebuild properly when implementing)
- **Unused `shell_sandbox` config** path in `config.py` (either wire it up or remove)
- **`datetime.utcnow()`** calls (replace with `datetime.now(timezone.utc)`)
- **CDN dependency** in chat-api test UI (bundle marked.js locally or remove test UI)

---

## Design Principles

1. **Secure by default.** Auth on, secrets generated, ports locked down. Cloud/external services are opt-in, never required.
2. **Works for 1 user, scales to thousands.** Single-machine Docker Compose is the default. Kubernetes is an overlay, not a rewrite.
3. **Air-gap first.** Every feature must work without internet. Cloud providers, external APIs, and remote services are optional enhancements.
4. **Tenant isolation is non-negotiable.** Every row, every Redis key, every API response is tenant-scoped. No exceptions.
5. **No dev-mode code in production.** One code path that handles all deployment scenarios gracefully.
6. **Backward-compatible migrations.** Existing single-user deployments upgrade in place without data loss.

---

## Phase 1: Secure Foundations

**Goal:** Make Nova safe to expose to the internet with zero configuration beyond running `setup.sh`.

### 1.1 — Default-Secure Configuration

**Changes to `.env.example` and `setup.sh`:**

- `REQUIRE_AUTH=true` (was `false`) — auth is always on
- `POSTGRES_PASSWORD` — auto-generated 32-char random on first `setup.sh` run
- `NOVA_ADMIN_SECRET` — auto-generated 32-char random on first `setup.sh` run
- `JWT_SECRET` — auto-generated (already happens, but document it)
- `REDIS_PASSWORD` — new, auto-generated, passed to Redis via `--requirepass`
- First-run setup creates an admin account interactively (email + password)

**Changes to `docker-compose.yml`:**

- Bind internal-only services to `127.0.0.1`:
  - `postgres: 127.0.0.1:5432:5432`
  - `redis: 127.0.0.1:6379:6379`
  - `llm-gateway: 127.0.0.1:8001:8001` (internal only, orchestrator calls it)
  - `memory-service: 127.0.0.1:8002:8002` (internal only)
  - `cortex: 127.0.0.1:8100:8100` (internal only)
  - `recovery: 127.0.0.1:8888:8888` (admin only)
- Keep externally accessible on `0.0.0.0`:
  - `dashboard: 0.0.0.0:3000:8080` (user-facing)
  - `chat-api: 0.0.0.0:8080:8080` (WebSocket clients)
  - `orchestrator: 0.0.0.0:8000:8000` (API clients)
- Add Redis password to all service configs via `REDIS_PASSWORD` env var
- Add Redis `command: redis-server --requirepass ${REDIS_PASSWORD} --maxmemory 512mb --maxmemory-policy allkeys-lru`

**Changes to services:**

- All Redis connections: update URL format to `redis://:${REDIS_PASSWORD}@redis:6379/N`
- Add `REDIS_PASSWORD` to config.py in every service that uses Redis
- Remove trusted-network auth bypass for non-localhost origins (keep only `127.0.0.1/8`)
  - Tailscale/VPN users rely on JWT auth, not IP-based bypass
  - Current CIDR list (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `100.64.0.0/10`) is too broad

### 1.2 — Sandbox Tier Enforcement

**Current state:** `config.py` has `shell_sandbox: str = "workspace"` but `code_tools.py` ignores it.

**Wire it up:**

- `run_shell` tool reads `settings.shell_sandbox` and enforces:
  - `workspace` (default): Commands run only inside `NOVA_WORKSPACE` directory
  - `isolated`: Commands run in a throwaway Docker container (new)
  - `disabled`: `run_shell` tool is not registered
- Add `SHELL_SANDBOX` to `.env.example` with `workspace` default
- Add denylist enforcement (already partially exists): block `rm -rf /`, `sudo`, `curl | bash`, etc.

### 1.3 — Air-Gap Mode

**New env var:** `NOVA_AIRGAP=false` (default)

When `NOVA_AIRGAP=true`:

- LLM Gateway: skip discovery endpoint calls to Groq/OpenRouter/Gemini/GitHub APIs
  - `discovery.py` returns only locally-configured models (Ollama + any models.yaml entries)
- LLM routing strategy forced to `local-only`
- Chat-api: bundle `marked.js` locally (or use a simpler markdown renderer)
- Setup script: skip Ollama model pulls (assume models pre-loaded)
- Dashboard: no external font/CDN loads (already mostly clean)
- Ollama: support pre-loaded model directory mount (`OLLAMA_MODELS_DIR` → `/root/.ollama/models`)

**Air-gap deployment bundle (new script):**

```bash
./scripts/build-airgap-bundle.sh
# Outputs: nova-airgap-bundle-YYYY-MM-DD.tar.gz containing:
#   - All Docker images (docker save)
#   - Ollama models (from models.yaml)
#   - .env.example
#   - docker-compose.yml + overlays
#   - setup-airgap.sh (loads images, configures .env, starts services)
```

### 1.4 — Stale Code Cleanup

- **Remove** empty Slack adapter stub from `chat-bridge/app/adapters/` (rebuild when implementing)
- **Replace** all `datetime.utcnow()` → `datetime.now(timezone.utc)` across all services
- **Bundle** or remove CDN dependency in chat-api test UI
- **Wire up** or remove `shell_sandbox` config (done in 1.2)
- **Clean up** stale migration comments (002 has outdated inline notes)

### 1.5 — First-Run Experience

**`setup.sh` interactive flow:**

```
Nova Setup
==========
1. Generating secure credentials...
   ✓ POSTGRES_PASSWORD: (generated)
   ✓ NOVA_ADMIN_SECRET: (generated)
   ✓ REDIS_PASSWORD: (generated)

2. Create admin account
   Email: user@example.com
   Password: ********
   ✓ Admin account created

3. Hardware detection
   GPU: NVIDIA RTX 4090 detected
   ✓ GPU overlay enabled

4. LLM configuration
   Ollama: local (pulling models...)
   Cloud providers: (enter API keys or skip)
   ✓ LLM routing: local-first

5. Starting services...
   ✓ All 9 services healthy

Dashboard: http://localhost:3000
API: http://localhost:8000/docs
```

**Estimated effort:** 2-3 weeks

---

## Phase 2: True Multi-Tenancy

**Goal:** Every piece of data is tenant-scoped. A single Nova instance serves multiple isolated organizations.

### 2.1 — Schema Migrations

**New migration: `024_multi_tenancy.sql`**

Add `tenant_id` to all tables that currently lack it:

```sql
-- Tables that need tenant_id added:
ALTER TABLE pods ADD COLUMN tenant_id UUID REFERENCES tenants(id) DEFAULT '00000000-0000-0000-0000-000000000001';
ALTER TABLE pod_agents ADD COLUMN tenant_id UUID REFERENCES tenants(id) DEFAULT '00000000-0000-0000-0000-000000000001';
ALTER TABLE tasks ADD COLUMN tenant_id UUID REFERENCES tenants(id) DEFAULT '00000000-0000-0000-0000-000000000001';
ALTER TABLE mcp_servers ADD COLUMN tenant_id UUID REFERENCES tenants(id) DEFAULT '00000000-0000-0000-0000-000000000001';
ALTER TABLE goals ADD COLUMN tenant_id UUID REFERENCES tenants(id) DEFAULT '00000000-0000-0000-0000-000000000001';

-- Composite unique constraints (replace global uniqueness):
ALTER TABLE pods DROP CONSTRAINT IF EXISTS pods_name_key;
ALTER TABLE pods ADD CONSTRAINT pods_tenant_name_unique UNIQUE (tenant_id, name);

-- Indexes for tenant-scoped queries:
CREATE INDEX IF NOT EXISTS idx_pods_tenant ON pods(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tasks_tenant ON tasks(tenant_id);
CREATE INDEX IF NOT EXISTS idx_mcp_servers_tenant ON mcp_servers(tenant_id);
```

**New migration: `025_tenant_config.sql`**

Replace singleton `platform_config` with tenant-scoped config:

```sql
-- Tenant-scoped config (overrides global defaults)
CREATE TABLE IF NOT EXISTS tenant_config (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    key TEXT NOT NULL,
    value JSONB NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(tenant_id, key)
);

-- Global config remains as system defaults (fallback)
-- Lookup order: tenant_config → platform_config → env default
```

**New migration: `026_row_level_security.sql`**

```sql
-- Enable RLS on all tenant-scoped tables
ALTER TABLE pods ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_servers ENABLE ROW LEVEL SECURITY;
ALTER TABLE goals ENABLE ROW LEVEL SECURITY;
-- ... etc for all tenant-scoped tables

-- Policy: rows visible only to matching tenant
-- (Applied per-connection via SET app.current_tenant_id)
CREATE POLICY tenant_isolation ON pods
    USING (tenant_id = current_setting('app.current_tenant_id')::uuid);
-- ... repeat for all tables
```

### 2.2 — Tenant Context Propagation

**New middleware in orchestrator: `tenant_middleware.py`**

Every authenticated request sets the tenant context:

```python
# After auth resolves user:
#   1. Set PostgreSQL session variable for RLS
#   await conn.execute("SET app.current_tenant_id = $1", user.tenant_id)
#   2. Prefix Redis keys with tenant_id
#   3. Pass tenant_id to all downstream service calls
```

**Redis key namespacing:**

All Redis keys get tenant prefix:

```
Current:  nova:agent:{agent_id}
New:      nova:{tenant_id}:agent:{agent_id}

Current:  nova:task:{task_id}
New:      nova:{tenant_id}:task:{task_id}

Current:  nova:chat:session:{session_id}
New:      nova:{tenant_id}:chat:session:{session_id}

Current:  pipeline:tasks  (BRPOP queue)
New:      nova:{tenant_id}:pipeline:tasks
```

**Downstream service calls include tenant header:**

```
X-Tenant-Id: {tenant_id}
```

- Memory-service: filters engrams by `tenant_id`
- LLM-gateway: tracks usage by `tenant_id` (for per-tenant billing)
- Chat-api: scopes sessions by `tenant_id`

### 2.3 — Per-Tenant Configuration

**Three-tier config resolution:**

```
1. tenant_config (per-tenant overrides)  → highest priority
2. platform_config (instance defaults)   → fallback
3. env / settings.py defaults            → lowest priority
```

**What's tenant-scoped:**

| Config Key | Scope | Why |
|-----------|-------|-----|
| `llm.default_model` | Per-tenant | Different orgs want different defaults |
| `llm.routing_strategy` | Per-tenant | Some orgs cloud-only, some local-only |
| `nova.name` | Per-tenant | Each org names their AI |
| `nova.greeting` | Per-tenant | Custom greeting |
| `nova.system_prompt` | Per-tenant | Custom personality |
| `guest_allowed_models` | Per-tenant | Different guest restrictions |
| `auth.registration_mode` | Per-tenant | Invite-only vs open per org |

**What stays global (instance-level):**

| Config Key | Scope | Why |
|-----------|-------|-----|
| `llm.provider_api_keys` | Global | Keys belong to the instance operator |
| `auth.require_auth` | Global | Security policy is instance-wide |
| `shell_sandbox` | Global | Security boundary is instance-wide |
| `trusted_networks` | Global | Network policy is infrastructure |
| `redis_url`, `database_url` | Global | Infrastructure |

### 2.4 — Per-Tenant Cortex

**Current problem:** Cortex has one hardcoded user ID and one journal conversation. Can't support multiple autonomous brains.

**Solution: Cortex becomes tenant-aware:**

- Remove hardcoded `cortex_user_id` and `journal_conversation_id`
- On startup, Cortex discovers all active tenants
- Runs separate thinking cycles per tenant (round-robin or priority-based)
- Each tenant has its own:
  - Cortex state (active/paused)
  - Goals and drives
  - Budget tracking
  - Journal conversation
- Tenants can enable/disable Cortex independently via tenant_config

**Migration: `027_cortex_multi_tenant.sql`**

```sql
ALTER TABLE cortex_state ADD COLUMN tenant_id UUID REFERENCES tenants(id);
-- ... similar for cortex_goals, cortex_drives, cortex_budget
```

### 2.5 — Tenant-Aware Backup/Restore

**Recovery service changes:**

- **Full backup** (default): backs up entire database (for disaster recovery)
- **Tenant export** (new): exports one tenant's data as a portable archive
  - `POST /recovery/tenants/{tenant_id}/export` → downloadable archive
  - Contains: conversations, messages, engrams, pods, tasks, goals, config, API keys
  - Format: JSON lines (portable, no schema dependency)
- **Tenant import** (new): imports a tenant archive into a running instance
  - `POST /recovery/tenants/import` → creates new tenant with imported data
  - Handles ID remapping (new UUIDs, preserve relationships)
- **Tenant deletion** (new): permanently removes all tenant data
  - `DELETE /recovery/tenants/{tenant_id}` (requires owner confirmation)
  - Cascading delete across all tenant-scoped tables

This enables **data portability** — users can export their data from SaaS and self-host, or vice versa.

### 2.6 — Upgrade Path for Existing Deployments

**Zero-downtime migration for single-user instances:**

1. Run migration `024_multi_tenancy.sql` — adds `tenant_id` columns with default value pointing to existing tenant
2. All existing data automatically belongs to the default tenant
3. Existing admin user becomes owner of default tenant
4. Platform config values copied to tenant_config for default tenant
5. No behavioral change for single-tenant users — everything works as before
6. Multi-tenancy is opt-in: only activates when a second tenant is created

**Estimated effort:** 4-6 weeks

---

## Phase 3: Pipeline & Queue Scalability

**Goal:** Allow multiple orchestrator instances to process tasks concurrently. Remove single-instance bottlenecks.

### 3.1 — Redis Streams Task Queue

**Replace BRPOP with Redis Streams + Consumer Groups:**

```
Current:  BRPOP pipeline:tasks 0  (single consumer, blocks)
New:      XREADGROUP GROUP nova-workers worker-{instance_id}
          COUNT 1 BLOCK 5000
          STREAMS nova:{tenant_id}:pipeline:tasks >
```

**Why:**
- BRPOP: only one consumer can read from the queue. Can't run 2+ orchestrator instances.
- Redis Streams: multiple consumers in a consumer group. Each message delivered to exactly one consumer. Built-in acknowledgment. Message replay on failure.

**Changes:**
- `orchestrator/app/queue.py` — replace `BRPOP` with `XREADGROUP`/`XACK`
- `orchestrator/app/reaper.py` — use `XPENDING` to find abandoned messages instead of heartbeat scanning
- Add `WORKER_ID` env var (auto-generated UUID per container instance)
- Heartbeat: `XCLAIM` stale messages instead of custom reaper logic

**Backward compatibility:** Migration script creates the stream from any existing BRPOP queue entries.

### 3.2 — Connection Pooling

**Add pgBouncer between services and PostgreSQL:**

```yaml
# docker-compose.yml
pgbouncer:
  image: bitnami/pgbouncer:latest
  environment:
    POSTGRESQL_HOST: postgres
    POSTGRESQL_PORT: 5432
    PGBOUNCER_POOL_MODE: transaction
    PGBOUNCER_MAX_CLIENT_CONN: 200
    PGBOUNCER_DEFAULT_POOL_SIZE: 20
  ports:
    - "127.0.0.1:6432:6432"
```

**Why:**
- Currently: orchestrator (2-10 conns) + memory-service (10+20 overflow) + cortex (2-5 conns) + recovery (1-3 conns) = up to 38 connections
- At scale with replicas: 38 × N replicas could exhaust PostgreSQL's `max_connections` (default 100)
- pgBouncer in transaction mode: each service opens many connections to pgBouncer, but pgBouncer multiplexes them over a small pool to PostgreSQL

**Changes:**
- All services point `DATABASE_URL` at pgBouncer instead of direct PostgreSQL
- PostgreSQL `max_connections` remains default (pgBouncer handles multiplexing)
- Recovery service keeps direct PostgreSQL connection (needs `pg_dump`, which doesn't work through pgBouncer)

### 3.3 — Stateless Service Replication

**Services that can scale horizontally today (after Phase 3.1):**

| Service | Replicas | Notes |
|---------|----------|-------|
| llm-gateway | N | Already stateless |
| chat-api | N | Session state in Redis |
| chat-bridge | N (webhook mode) | Session state in Redis |
| memory-service | N | State in PostgreSQL + Redis cache |
| orchestrator | N | After queue migration (3.1) |
| dashboard | N | Static files served by nginx |

**Services that remain single-instance:**

| Service | Why | Future Fix |
|---------|-----|------------|
| cortex | Thinking loop must not duplicate | Distributed lock (Phase 5) |
| recovery | Docker socket access, backup coordination | Leader election (Phase 5) |

**Docker Compose scaling:**

```yaml
orchestrator:
  deploy:
    replicas: ${ORCHESTRATOR_REPLICAS:-1}
```

### 3.4 — Service Discovery via Environment

**Replace hardcoded service URLs:**

```python
# Current (hardcoded):
LLM_GATEWAY_URL = "http://llm-gateway:8001"

# New (configurable):
LLM_GATEWAY_URL = os.getenv("LLM_GATEWAY_URL", "http://llm-gateway:8001")
```

This allows:
- Docker Compose: defaults work (internal DNS)
- Kubernetes: set via Service DNS or env injection
- External services: point to managed/external endpoints

**Apply to all inter-service URLs:**
- `ORCHESTRATOR_URL` (used by chat-api, chat-bridge, cortex)
- `LLM_GATEWAY_URL` (used by orchestrator, cortex)
- `MEMORY_SERVICE_URL` (used by orchestrator, cortex)
- `REDIS_URL` (used by all services — already configurable, just document)
- `DATABASE_URL` (used by all DB services — already configurable)

### 3.5 — Observability Foundation

**Add structured telemetry (not full APM yet):**

- **Health endpoints** (already exist): `/health/live`, `/health/ready`
- **Metrics endpoint** (new): `/metrics` (Prometheus format)
  - Request count, latency histograms, active connections
  - Task queue depth, processing time
  - LLM token usage, provider latency
  - Memory service: ingestion rate, retrieval latency
- **Request tracing** (new): `X-Request-Id` header propagated across all inter-service calls
  - Generated at edge (dashboard/chat-api/orchestrator)
  - Logged in every service's structured JSON logs
  - Enables tracing a request across services via log correlation

**No external dependencies** — just structured logs and a `/metrics` endpoint. Grafana/Prometheus are optional add-ons.

**Estimated effort:** 3-4 weeks

---

## Phase 4: Deployment Flexibility

**Goal:** Support multiple deployment topologies without code changes.

### 4.1 — Deployment Profiles

**Define four official deployment profiles:**

#### Profile: `standalone` (default)
- Everything runs on one machine via Docker Compose
- PostgreSQL + Redis in containers
- Suitable for 1-10 users
- What ships today (but secured per Phase 1)

#### Profile: `managed-data`
- Application services in Docker Compose
- PostgreSQL → managed (RDS, Cloud SQL, Supabase, Neon)
- Redis → managed (ElastiCache, Memorystore, Upstash)
- Suitable for 10-100 users
- Requires: external `DATABASE_URL` and `REDIS_URL`

#### Profile: `kubernetes`
- All services as Kubernetes Deployments
- Managed DB + Redis
- Ingress + TLS via cert-manager
- Horizontal pod autoscaling
- Suitable for 100-10,000+ users
- Delivered as Helm chart

#### Profile: `airgap`
- Standalone profile + pre-built bundle
- No internet access required
- Local Ollama with pre-loaded models
- All Docker images pre-packaged
- Suitable for classified/secure environments

### 4.2 — Helm Chart (Kubernetes)

**`deploy/helm/nova/`**

```
nova/
├── Chart.yaml
├── values.yaml              # Default config (mirrors .env.example)
├── values-production.yaml   # Production overrides
├── templates/
│   ├── _helpers.tpl
│   ├── orchestrator-deployment.yaml
│   ├── orchestrator-service.yaml
│   ├── llm-gateway-deployment.yaml
│   ├── llm-gateway-service.yaml
│   ├── memory-service-deployment.yaml
│   ├── memory-service-service.yaml
│   ├── chat-api-deployment.yaml
│   ├── chat-api-service.yaml
│   ├── dashboard-deployment.yaml
│   ├── dashboard-service.yaml
│   ├── cortex-deployment.yaml
│   ├── cortex-service.yaml
│   ├── recovery-deployment.yaml
│   ├── recovery-service.yaml
│   ├── ingress.yaml
│   ├── configmap.yaml
│   ├── secret.yaml
│   ├── hpa.yaml             # Horizontal Pod Autoscaler
│   ├── pdb.yaml             # Pod Disruption Budget
│   └── networkpolicy.yaml   # Inter-service network rules
```

**Key Helm values:**

```yaml
global:
  database:
    external: true
    url: "postgresql://..."
  redis:
    external: true
    url: "redis://..."
  auth:
    requireAuth: true
    registrationMode: invite

orchestrator:
  replicas: 2
  resources:
    requests: { cpu: 500m, memory: 512Mi }
    limits: { cpu: 2000m, memory: 2Gi }

llmGateway:
  replicas: 2
  resources:
    requests: { cpu: 250m, memory: 256Mi }

cortex:
  enabled: true
  replicas: 1  # Must be 1 (distributed lock)
```

### 4.3 — Air-Gap Bundle Builder

**`scripts/build-airgap-bundle.sh`**

```bash
#!/bin/bash
# Builds a self-contained deployment bundle for air-gapped environments

BUNDLE_DIR="nova-airgap-$(date +%Y%m%d)"
mkdir -p "$BUNDLE_DIR"

# 1. Build all Docker images
docker compose build

# 2. Save images to tar
docker save $(docker compose config --images) | gzip > "$BUNDLE_DIR/images.tar.gz"

# 3. Export Ollama models
docker compose run --rm ollama ollama list | tail -n +2 | while read model _; do
  docker compose exec ollama ollama cp "$model" "/export/$model"
done
cp -r ollama-export/ "$BUNDLE_DIR/models/"

# 4. Include deployment files
cp docker-compose.yml docker-compose.gpu.yml docker-compose.rocm.yml "$BUNDLE_DIR/"
cp .env.example "$BUNDLE_DIR/"
cp -r scripts/ "$BUNDLE_DIR/scripts/"
cp "$BUNDLE_DIR/scripts/setup-airgap.sh" "$BUNDLE_DIR/install.sh"

# 5. Package
tar czf "$BUNDLE_DIR.tar.gz" "$BUNDLE_DIR/"
echo "Bundle: $BUNDLE_DIR.tar.gz ($(du -h "$BUNDLE_DIR.tar.gz" | cut -f1))"
```

**`scripts/setup-airgap.sh` (runs on target machine):**

```bash
# Load Docker images from bundle
docker load < images.tar.gz

# Copy Ollama models to volume
docker volume create ollama-data
docker run --rm -v ollama-data:/root/.ollama -v ./models:/import alpine \
  cp -r /import/* /root/.ollama/

# Configure
cp .env.example .env
# ... interactive setup (same as setup.sh but skip model pulls)

# Start
NOVA_AIRGAP=true docker compose up -d
```

### 4.4 — Edge / SBC Deployment

**Compose overlay: `docker-compose.edge.yml`**

For Raspberry Pi, Intel NUC, or other constrained hardware:

```yaml
# Reduced resource limits
services:
  orchestrator:
    deploy:
      resources:
        limits: { cpus: '1.0', memory: 512M }

  llm-gateway:
    deploy:
      resources:
        limits: { cpus: '0.5', memory: 256M }

  memory-service:
    deploy:
      resources:
        limits: { cpus: '0.5', memory: 256M }

  # Disable non-essential services
  cortex:
    profiles: ["full"]  # Not started by default on edge

  chat-bridge:
    profiles: ["bridges"]  # Optional

  postgres:
    deploy:
      resources:
        limits: { cpus: '1.0', memory: 512M }
    # Use external DB instead:
    # DATABASE_URL=postgresql://user:pass@nas.local:5432/nova
```

**Edge-specific config:**
- `LLM_ROUTING_STRATEGY=cloud-only` (no local inference on Pi)
- `EMBEDDING_MODEL=remote` (use LLM gateway for embeddings, not local)
- `CORTEX_ENABLED=false` (disable autonomous brain to save resources)

**Estimated effort:** 3-4 weeks

---

## Phase 5: Product Completeness

**Goal:** Fill in the feature gaps that matter for real users.

### 5.1 — Dashboard Improvements

**Priority features (from existing roadmap Phase 5b, filtered for what matters):**

1. **Task Board** — Submit goals, view task state machine, inspect pipeline stages
   - Shows: submitted → running → complete/failed flow
   - Click into a task to see each agent's input/output
   - Filter by status, pod, date range
   - Tenant-scoped (only shows current tenant's tasks)

2. **Pod Editor** — Visual pipeline configuration
   - Drag-and-drop agent ordering
   - Per-agent model/prompt/tool configuration
   - Run-condition builder (visual, not JSON)
   - Clone/fork pods
   - Tenant-scoped (each tenant has their own pods)

3. **Activity Feed** — Real-time event stream
   - SSE-based live updates
   - Task completions, errors, guardrail flags
   - Cortex thinking cycle summaries
   - Filterable by severity, source, type

4. **Memory Inspector** (enhancement) — Browse engram network
   - Graph visualization (nodes = engrams, edges = relationships)
   - Search by content, type, activation level
   - Manual engram creation/deletion
   - Consolidation status

### 5.2 — CLI & SDK

**`nova-cli/` — Command-line interface**

```bash
# Core commands
nova chat "What's the status of project X?"    # Interactive chat
nova task submit "Analyze this codebase"        # Submit pipeline task
nova task list --status running                 # List tasks
nova task logs <task-id>                        # Stream task output

# Configuration
nova config set llm.default_model claude-sonnet  # Set config
nova config get llm.routing_strategy             # Get config
nova models list                                 # Available models

# Management
nova keys create --name "CI pipeline"            # API key management
nova pods list                                   # Pod management
nova backup create                               # Trigger backup
nova health                                      # Service health check

# Auth
nova login                                       # Authenticate
nova register                                    # Create account (if open registration)
nova invite create --role member                  # Generate invite code
```

**Implementation:** Typer + httpx (async) + Rich (terminal UI)
**Package:** `pip install nova-cli` or Docker image `nova-cli:latest`

**`nova-sdk/` — Python SDK**

```python
from nova_sdk import NovaClient

client = NovaClient(
    base_url="http://localhost:8000",
    api_key="sk-nova-...",
)

# Chat
response = await client.chat("What is Nova?")

# Stream
async for chunk in client.chat_stream("Explain quantum computing"):
    print(chunk.content, end="")

# Tasks
task = await client.tasks.submit("Analyze this repo", pod="code-analysis")
result = await client.tasks.wait(task.id, timeout=300)

# Memory
await client.memory.ingest("Important context about the project")
results = await client.memory.search("project architecture")
```

**Implementation:** httpx (async) + Pydantic models (from nova-contracts)
**Package:** `pip install nova-sdk`

### 5.3 — Chat Platform Integrations

**Build on existing chat-bridge architecture:**

1. **Telegram** ✅ (already implemented)
2. **Slack** — New adapter using Slack Bolt framework
   - Slash commands: `/nova ask`, `/nova task`
   - Thread-based conversations (each Slack thread = Nova conversation)
   - App mentions: `@Nova what is...`
3. **Discord** — New adapter using discord.py
   - Slash commands: `/nova ask`, `/nova task`
   - Channel-based conversations
4. **Matrix** — New adapter for self-hosted chat (air-gap compatible)
   - Room-based conversations
   - E2E encryption support

Each adapter follows the existing `BaseAdapter` pattern in chat-bridge.

### 5.4 — MCP Integrations

**Priority integrations (from existing roadmap Phase 8b):**

| Integration | Category | Air-Gap Safe | Why |
|-------------|----------|--------------|-----|
| Filesystem | System | Yes | Core tool capability |
| Docker | System | Yes | Container management |
| Git/GitHub | Developer | No (GitHub) / Yes (local git) | Code workflow |
| Brave Search | Knowledge | No | Web research |
| Home Assistant | Homelab | Yes (LAN) | Smart home control |
| Prometheus/Grafana | System | Yes | Infrastructure monitoring |

**Implementation:** Each integration is an MCP server entry in the `mcp_servers` table. The MCP client infrastructure already exists — this is configuration + documentation, not new code.

**Estimated effort:** 6-8 weeks (5.1-5.4 combined, can be parallelized)

---

## Phase 6: Engram Network Completion

**Goal:** Complete the cognitive memory system (Phase 6 from v1 roadmap).

### Current state:
- Schema exists (`engrams`, `engram_edges`, `engram_archive`, `consolidation_log`, `retrieval_log`)
- Ingestion works (text → decomposed engrams)
- Spreading activation retrieval works
- `/engrams/context` endpoint recently fixed (JSON body)
- Consolidation daemon scaffolded

### Remaining work:
1. **Consolidation daemon** — merge related engrams, prune low-activation nodes
2. **Self-model** — Nova builds a model of its own capabilities and preferences
3. **Cross-session continuity** — engrams persist across conversations, activated by context
4. **Tenant isolation** — enforce `tenant_id` filtering in all engram queries (blocked by Phase 2)
5. **Embedding model flexibility** — support dimensions other than 768 (for different embedding models)

### Dependencies:
- Phase 2 (multi-tenancy) must be complete before tenant-isolated memory works

**Estimated effort:** 3-4 weeks

---

## Phase 7: Autonomy & Intelligence

**Goal:** Nova can work on long-running goals without constant human input.

### 7.1 — Goal Layer

**Builds on existing `goals` table and `goals_router.py`:**

- Planning Agent decomposes goal → subtask DAG
- Each subtask is a pipeline task (uses existing Quartet pipeline)
- Evaluation Agent assesses progress after each subtask
- Loop Controller enforces:
  - Max iterations per goal (default: 20)
  - Max cost per goal (configurable budget)
  - Human review checkpoints (configurable frequency)
  - Guardrail on every subtask (existing Guardrail Agent)

### 7.2 — Self-Introspection

Nova can read its own:
- Architecture (services, health, config)
- Capabilities (registered tools, available models)
- Performance (task success rates, latency trends)
- Budget (spending vs limits)

**New tools:**
- `platform_info` — returns service topology, versions, health status
- `get_config` — reads relevant config values
- `health_check` — runs health checks across services
- `get_capabilities` — lists available tools and models
- `get_own_logs` — reads recent log entries (filtered, not raw)

### 7.3 — Reinforcement from Experience

- Planning Agent reads prior episode memory ("last time I tried X, approach Y worked")
- Evaluation Agent produces structured `lessons_learned`
- Goal similarity matching (new goal → start from proven approach)
- Self-assessment (evaluate overall performance patterns)

### Dependencies:
- Phase 6 (Engram Network) for experience storage
- Phase 2 (multi-tenancy) for per-tenant autonomy
- Phase 1 (sandbox enforcement) for safe autonomous code execution

**Estimated effort:** 6-8 weeks

---

## Phase 8: SaaS Readiness

**Goal:** Run Nova as a hosted service at `nova.arialabs.ai`.

### 8.1 — Billing & Usage Metering

- **Stripe integration** for payment processing
- **Usage metering:**
  - LLM tokens consumed (already tracked in `usage_events`)
  - Task executions
  - Storage (engrams, conversations)
  - Active users per tenant
- **Tiers:**
  - **Free:** 1 user, limited tokens/month, community models only
  - **Pro:** Unlimited users, higher token limits, all models, Cortex enabled
  - **Enterprise:** Custom limits, dedicated infrastructure, SLA, SSO

### 8.2 — Onboarding Flow

**New user experience (SaaS):**

1. Sign up (email/password or Google OAuth)
2. Create organization (= tenant)
3. Choose plan (free/pro)
4. Configure AI:
   - Name your assistant
   - Choose default model
   - Set system prompt (or use default)
5. Start chatting

**New user experience (self-hosted):**

1. Run `setup.sh` (or `install.sh` for air-gap)
2. Create admin account
3. Invite team members (optional)
4. Configure AI (same as step 4 above)
5. Start chatting

### 8.3 — Data Portability

**Export/import (builds on Phase 2.5):**

- Users can export all their data at any time
- Format: JSON lines (human-readable, parseable)
- Includes: conversations, messages, engrams, goals, config, API keys
- Import into any Nova instance (self-hosted or different SaaS tenant)

**Self-hosting escape hatch:**
- SaaS user exports data
- Runs Nova locally via Docker Compose
- Imports data
- Full continuity (memory, conversations, config)

### 8.4 — Infrastructure (Kubernetes)

**SaaS deployment:**

- Kubernetes cluster (GKE, EKS, or bare-metal k3s)
- Managed PostgreSQL (Cloud SQL or RDS)
- Managed Redis (Memorystore or ElastiCache)
- Ingress + TLS (cert-manager + Let's Encrypt)
- Horizontal pod autoscaling per tenant load
- Namespace-per-tenant isolation (or shared namespace with RLS)

**Estimated effort:** 8-12 weeks

---

## Phase Sequencing & Dependencies

```
Phase 1: Secure Foundations ──────────────────────────────── (2-3 weeks)
    │
    ▼
Phase 2: True Multi-Tenancy ──────────────────────────────── (4-6 weeks)
    │                    │
    ▼                    ▼
Phase 3: Scalability     Phase 6: Engram Completion ──────── (3-4 weeks)
    │  (3-4 weeks)           │
    ▼                        ▼
Phase 4: Deployment     Phase 7: Autonomy ────────────────── (6-8 weeks)
    │  (3-4 weeks)
    ▼
Phase 5: Product Completeness ────────────────────────────── (6-8 weeks)
    │  (can start in parallel with Phase 3)
    ▼
Phase 8: SaaS Readiness ─────────────────────────────────── (8-12 weeks)
```

**Critical path:** Phase 1 → Phase 2 → Phase 3 → Phase 8

**Parallelizable:**
- Phase 5 (SDK, CLI, dashboard, integrations) can start after Phase 2
- Phase 6 (Engram) can start after Phase 2
- Phase 4 (deployment profiles) can start after Phase 3

---

## Migration Strategy

### For existing single-user deployments

1. **Phase 1** applies immediately — `setup.sh` regenerates secrets, enables auth
2. **Phase 2** migration runs automatically — existing data gets default tenant_id
3. No behavioral change unless additional tenants are created
4. Cortex continues working with single tenant (default)
5. All features remain accessible through existing dashboard

### For new users

1. Download / `git clone`
2. Run `./scripts/setup.sh`
3. Create admin account
4. Start using Nova

### For SaaS (Phase 8)

1. Deploy Kubernetes cluster with Helm chart
2. Configure managed DB + Redis
3. Set up Stripe billing
4. Enable open registration
5. Marketing site at `arialabs.ai`, app at `nova.arialabs.ai`

---

## Architecture After All Phases

```
┌─────────────────────────────────────────────────────────────┐
│                        Ingress / TLS                         │
│              (nginx, Cloudflare Tunnel, Tailscale)           │
└──────┬──────────────┬──────────────┬──────────────┬─────────┘
       │              │              │              │
  ┌────▼────┐   ┌─────▼─────┐  ┌────▼────┐  ┌─────▼─────┐
  │Dashboard│   │Orchestrator│  │ Chat-API│  │Chat-Bridge│
  │ (nginx) │   │  (N pods)  │  │(N pods) │  │ (N pods)  │
  └─────────┘   └──────┬─────┘  └────┬────┘  └───────────┘
                       │              │
         ┌─────────────┼──────────────┘
         │             │
   ┌─────▼─────┐ ┌────▼──────┐ ┌────────┐ ┌─────────┐
   │LLM Gateway│ │  Memory   │ │ Cortex │ │Recovery │
   │  (N pods) │ │  Service  │ │(1 pod) │ │(1 pod)  │
   └─────┬─────┘ │  (N pods) │ └────────┘ └─────────┘
         │        └─────┬─────┘
         │              │
   ┌─────▼─────┐  ┌────▼──────┐  ┌──────────┐
   │  Ollama   │  │ pgBouncer │  │  Redis   │
   │ (optional)│  └─────┬─────┘  │(Sentinel │
   └───────────┘  ┌─────▼─────┐  │ or managed)│
                  │PostgreSQL │  └──────────┘
                  │(managed or│
                  │ container)│
                  └───────────┘
```

**Key changes from today:**
- pgBouncer between services and PostgreSQL
- Redis Streams instead of BRPOP
- All services configurable via env vars (not hardcoded URLs)
- Tenant isolation at every layer (DB, Redis, API)
- Cortex tenant-aware (one brain per org)
- Horizontal scaling for stateless services

---

## What This Roadmap Replaces

The existing `docs/roadmap.md` (v1) contains 14 phases with detailed specs for many features. This v2 roadmap:

- **Subsumes** Phases 5b (dashboard), 5c (skills/rules), 6c (SDK/CLI), 7a (self-introspection), 8b (MCP integrations), 8c (chat integrations), 10 (edge), 11 (multi-cloud), 13 (multi-tenancy), 14 (SaaS)
- **Reorders** to prioritize security, multi-tenancy, and scalability before advanced features
- **Drops** Phase 7b (Supernova structured workflows — investigation phase, not committed), Phase 9b (Web IDE — nice-to-have, not critical path), Phase 12 (inference backends — handled by LLM gateway's existing multi-provider support)
- **Keeps** Phase 6 (Engram Network), Phase 7 (Autonomy), Phase 9 (Triggers/Events), Phase 9a (Reactive Events) as future work after the core platform is solid

The v1 roadmap should be archived as `docs/roadmap-v1-archive.md` for reference.

---

## Open Questions for Review

1. **Tenant model:** Should tenants map to "organizations" (multi-user teams) or "individuals" (each user is their own tenant)? Current design assumes org-based tenants.

2. **Billing model:** Token-based (pay per use), seat-based (pay per user), or hybrid? Affects how usage metering works.

3. **Cortex per tenant:** Running a separate thinking loop per tenant is expensive. Should Cortex be a paid feature? Should there be a shared Cortex mode for free-tier users?

4. **MCP server isolation:** Should each tenant have their own MCP server processes, or share system-wide MCP servers with tenant context? Per-tenant is safer but more resource-intensive.

5. **Data residency:** For SaaS, will we need to support region-specific data storage (EU, US, etc.)? Affects database architecture.

6. **SSO:** Should enterprise SSO (SAML, OIDC) be in Phase 8, or earlier? Some enterprise customers will require it before anything else.
