.PHONY: help install start up dev build down logs ps watch migrate backup restore website test test-quick benchmark-quality prune prune-all uninstall observability

DASHBOARD    = dashboard

# ── Inference is hybrid ───────────────────────────────────────────────────────
# Bundled containers (compose profiles inference-ollama/-vllm/-sglang/-llamacpp,
# GPU via the docker-compose.gpu.yml overlay + COMPOSE_FILE) are managed by the
# recovery service from Settings → Local Inference. External servers (host
# Ollama, LM Studio, any OpenAI-compatible endpoint) are configured there too.

EDITOR_PROFILE := $(if $(filter vscode,$(EDITOR_FLAVOR)),--profile editor-vscode,$(if $(filter neovim,$(EDITOR_FLAVOR)),--profile editor-neovim,))

COMPOSE      = docker compose -f docker-compose.yml --profile voice $(EDITOR_PROFILE)
ALL_PROFILES = --profile voice --profile website --profile knowledge \
               --profile browser \
               --profile cloudflare-tunnel --profile tailscale \
               --profile editor-vscode --profile editor-neovim

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
	docker compose -f docker-compose.yml $(ALL_PROFILES) down --remove-orphans

restart: ## Stop and start all services without rebuilding (preserves cached images)
	docker compose -f docker-compose.yml $(ALL_PROFILES) down --remove-orphans
	$(COMPOSE) up -d

# ── Develop ──────────────────────────────────────────────────────────────────
dev: ## Start all services + Vite dashboard (Python hot-reload via --reload + compose watch; Vite HMR — no `make build` needed for daily edits)
	$(COMPOSE) --profile website up -d --remove-orphans
	cd $(DASHBOARD) && npm run dev

watch: ## Sync Python source into running containers for backend hot-reload
	$(COMPOSE) watch

website: ## Build and start the Nova website at http://localhost:4000
	$(COMPOSE) --profile website up -d --build website

# ── Observe ──────────────────────────────────────────────────────────────────
logs: ## Tail logs for all services
	$(COMPOSE) logs -f

ps: ## Show container status
	$(COMPOSE) ps

# ── Database ─────────────────────────────────────────────────────────────────
migrate: ## Apply pending SQL migrations (runs inside orchestrator container)
	$(COMPOSE) exec orchestrator python -c \
	  "import asyncio; from app.db import init_db; asyncio.run(init_db())"

# ── Backup / Restore ─────────────────────────────────────────────────────────
# ── Testing ──────────────────────────────────────────────────────────────────
test: ## Run integration tests against running services (deps: tests/requirements.txt)
	@cd tests && uv run --with-requirements requirements.txt \
	  pytest -v --tb=short

test-quick: ## Smoke test (health endpoints only)
	@cd tests && uv run --with-requirements requirements.txt \
	  pytest -v --tb=short -k "health"

benchmark-quality: ## Kick off the in-process AI quality benchmark (requires services running)
	@curl -sf -X POST -H "X-Admin-Secret: $${NOVA_ADMIN_SECRET:-nova-admin-secret-change-me}" \
	  http://localhost:8000/api/v1/quality/benchmarks/run | python3 -m json.tool

# ── Observability ─────────────────────────────────────────────────────────────
observability: ## Start Grafana (embedded at /monitoring) — extracts the JWT key first
	@docker compose exec -T postgres psql -U nova -d nova -tAc \
	  "SELECT value #>> '{}' FROM platform_config WHERE key='auth.jwt_secret'" \
	  | tr -d '"' | tr -d '[:space:]' > observability/grafana/.jwt-secret
	@python3 -c "import base64, json; s = open('observability/grafana/.jwt-secret').read().strip(); \
	  json.dump({'keys': [{'kty': 'oct', 'alg': 'HS256', 'use': 'sig', \
	  'k': base64.urlsafe_b64encode(s.encode()).decode().rstrip('=')}]}, \
	  open('observability/grafana/.jwt-jwks.json', 'w'))"
	@chmod 644 observability/grafana/.jwt-secret observability/grafana/.jwt-jwks.json  # grafana runs as uid 472
	@docker compose --profile observability up -d grafana
	@echo "Grafana up — embedded at /monitoring (direct: http://localhost:3001)"

# ── Backup / Restore ─────────────────────────────────────────────────────────
backup: ## Create a database backup (emergency — normally use the Recovery UI)
	@./scripts/backup.sh

restore: ## List or restore backups (emergency — normally use the Recovery UI)
	@./scripts/restore.sh $(F)

# ── Cleanup ────────────────────────────────────────────────────────────────
prune: ## Remove stopped containers, dangling images, build cache (preserves ALL volumes)
	docker system prune -f
	@echo "\n  Volumes untouched. Use 'make prune-all' to also clean model caches."

prune-all: ## Backup DB, then prune everything including named volumes
	@echo "This will remove named volumes (re-downloadable caches)."
	@echo "Postgres and Redis data are safe (bind-mounted to ./data/)."
	@read -p "Continue? [y/N] " yn; [ "$$yn" = "y" ] || exit 1
	@./scripts/backup.sh
	docker system prune -f
	@for v in tailscale-state; do \
	  docker volume rm "nova_$$v" 2>/dev/null && echo "  Removed $$v" || true; \
	done

refresh-llm-fixtures: ## Re-record all LLM fixtures (clears existing, records from llm-gateway)
	rm -rf memory-service/tests/fixtures/llm/*.json
	cd memory-service && RECORD_LLM_FIXTURES=1 uv run pytest tests/ -v
