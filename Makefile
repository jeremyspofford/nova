.PHONY: help install start up dev build down logs ps watch migrate backup restore test test-quick test-v2 prune prune-all uninstall

DASHBOARD    = dashboard

# ── GPU auto-detection ────────────────────────────────────────────────────────
# Override with NOVA_GPU=cpu|nvidia|rocm in .env or environment.
# v2 uses the host's Ollama for local inference — the GPU overlay is empty but
# kept for forward-compatibility when a containerised inference backend is added.
NOVA_GPU     ?= auto
GPU_OVERLAY  :=
ifeq ($(NOVA_GPU),nvidia)
  GPU_OVERLAY = -f docker-compose.gpu.yml
else ifeq ($(NOVA_GPU),rocm)
  GPU_OVERLAY = -f docker-compose.rocm.yml
else ifeq ($(NOVA_GPU),auto)
  GPU_OVERLAY = $(shell command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi >/dev/null 2>&1 && echo "-f docker-compose.gpu.yml")
endif

# OLLAMA_BASE_URL: 'auto' and 'host' are back-compat aliases handled inside
# the gateway (llm-gateway/app/config.py). The Makefile no longer pre-resolves
# them — the gateway treats them as http://ollama:11434, and the bundled
# Compose service is reachable at that internal hostname.

EDITOR_PROFILE := $(if $(filter vscode,$(EDITOR_FLAVOR)),--profile editor-vscode,$(if $(filter neovim,$(EDITOR_FLAVOR)),--profile editor-neovim,))

# Profiles are driven by COMPOSE_PROFILES in .env (set by ./install).
# Docker Compose reads COMPOSE_PROFILES automatically from .env — no --profile flags needed.
COMPOSE      = docker compose -f docker-compose.yml $(GPU_OVERLAY) $(EDITOR_PROFILE)

# ─────────────────────────────────────────────────────────────────────────────
help: ## Show available commands
	@awk 'BEGIN {FS = ":.*?## "}; /^[a-zA-Z_-]+:.*?## / \
	  {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install: ## Interactive install wizard (first-time or reconfigure)
	@./install

start: ## Production start: build + up + wait for health + report URLs
	@./start

uninstall: ## Remove Nova from this machine (preview first, then confirm)
	@./uninstall

# ── Deploy ───────────────────────────────────────────────────────────────────
up: ## Start all services detached (production / staging)
	$(COMPOSE) up -d

build: ## Rebuild all Docker images (run before up after code changes)
	$(COMPOSE) build

down: ## Stop and remove all containers (all profiles + orphans)
	docker compose -f docker-compose.yml $(GPU_OVERLAY) down --remove-orphans

restart: ## Stop and start all services without rebuilding (preserves cached images)
	docker compose -f docker-compose.yml $(GPU_OVERLAY) down --remove-orphans
	$(COMPOSE) up -d

# ── Develop ──────────────────────────────────────────────────────────────────
dev: ## Start all services + Vite dashboard (hot-reload; no `make build` needed for daily edits)
	$(COMPOSE) up -d --remove-orphans
	cd $(DASHBOARD) && npm run dev

watch: ## Sync Python source into running containers for backend hot-reload
	$(COMPOSE) watch

# ── Observe ──────────────────────────────────────────────────────────────────
logs: ## Tail logs for all services
	$(COMPOSE) logs -f

ps: ## Show container status
	$(COMPOSE) ps

# ── Database ─────────────────────────────────────────────────────────────────
migrate: ## Apply pending SQL migrations (runs inside agent-core container)
	$(COMPOSE) exec agent-core python -c \
	  "import asyncio; from app.db import init_db; asyncio.run(init_db())"

# ── Testing ──────────────────────────────────────────────────────────────────
test: ## Run integration tests against running services
	@cd tests && uv run --with pytest --with pytest-asyncio --with httpx --with websockets --with python-dotenv --with redis --with asyncpg --with requests --with psycopg2-binary --with uvicorn --with fastapi --with pydantic-settings --with cryptography \
	  pytest -v --tb=short

test-quick: ## Smoke test (health endpoints only)
	@cd tests && uv run --with pytest --with pytest-asyncio --with httpx --with websockets --with python-dotenv --with redis --with asyncpg --with requests --with psycopg2-binary --with uvicorn --with fastapi --with pydantic-settings --with cryptography \
	  pytest -v --tb=short -k "health"

test-v2: ## Run only v2-service integration tests (fast, no v1 noise) — run before and after any change
	@cd tests && uv run --with pytest --with pytest-asyncio --with httpx --with asyncpg \
	  pytest -v --tb=short \
	  test_agent_core.py \
	  test_llm_gateway.py \
	  test_llm_models_proxy.py \
	  test_model_discovery.py \
	  test_secrets.py \
	  test_voice_gateway.py \
	  test_health.py \
	  test_memory.py \
	  test_schedules.py

# ── Backup / Restore ─────────────────────────────────────────────────────────
backup: ## Create a database backup (emergency — normally use the Recovery UI)
	@./scripts/backup.sh

restore: ## List or restore backups (emergency — normally use the Recovery UI)
	@./scripts/restore.sh $(F)

# ── Cleanup ────────────────────────────────────────────────────────────────
prune: ## Remove stopped containers, dangling images, build cache (preserves ALL volumes)
	docker system prune -f
	@echo "\n  Volumes untouched. Use 'make prune-all' to also clean data volumes."

prune-all: ## Backup DB, then prune everything
	@echo "This will remove build caches and dangling volumes."
	@echo "Postgres and Redis data are safe (bind-mounted to ./data/)."
	@read -p "Continue? [y/N] " yn; [ "$$yn" = "y" ] || exit 1
	@./scripts/backup.sh
	docker system prune -f
	@for v in ollama-data llamacpp-models vllm-cache sglang-cache tailscale-state; do \
	  docker volume rm "nova_$$v" 2>/dev/null && echo "  Removed $$v" || true; \
	done

audit-tool-use: ## Tool-use audit — live services, ~10-30 min, never CI-gating
	@cd tests && uv run --with pytest --with pytest-asyncio --with httpx \
	  --with python-dotenv \
	  pytest -v -m audit test_chat_tool_usage.py || true
