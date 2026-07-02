from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Database
    database_url: str = "postgresql+asyncpg://nova:nova@postgres:5432/nova"
    db_echo: bool = False
    db_pool_size: int = 10
    db_max_overflow: int = 20

    # Redis
    redis_url: str = "redis://redis:6379/0"
    redis_embedding_cache_ttl: int = 86400  # 24h embedding cache

    # Orchestrator (used by feature-flags SDK to warm cache + receive
    # pubsub-driven invalidations; not on the engram hot path).
    orchestrator_url: str = "http://orchestrator:8000"

    # Memory backend selection — which storage engine serves /api/v1/memory/*.
    # Runtime override: Redis db1 nova:config:memory.backend (dashboard-set).
    # "engram" = pgvector graph; "okf" = OKF markdown bundle.
    memory_backend: str = "engram"

    # OKF markdown backend — bundle lives in the shared Nova workspace so
    # agent file tools (orchestrator mounts the same host dir) and humans
    # see the exact same files.
    okf_memory_dir: str = "/workspace/memory"
    okf_context_top_k: int = 8
    okf_context_max_chars: int = 16000  # ≈4k tokens
    okf_journal_retention_days: int = 45

    # LLM Gateway (for embedding generation)
    llm_gateway_url: str = "http://llm-gateway:8001"
    embedding_model: str = "nomic-embed-text"  # Ollama default
    embedding_dimensions: int = 768

    # Embedding resilience — fallback model if primary fails (gemini-embedding-001 = free Gemini)
    embedding_fallback_model: str = "gemini-embedding-001"
    embedding_max_retries: int = 2
    embedding_retry_delay: float = 1.0

    # Engram Network (Phase 1: Ingestion)
    engram_ingestion_enabled: bool = True
    engram_ingestion_queue: str = "memory:ingestion:queue"
    engram_ingestion_batch_timeout: float = 1.0  # BRPOP timeout in seconds
    engram_decomposition_model: str = "auto"
    engram_entity_similarity_threshold: float = (
        0.92  # embedding cosine threshold for dedup
    )
    engram_contradiction_similarity_threshold: float = 0.85
    engram_fact_dedup_threshold: float = 0.90  # cosine similarity for fact-level dedup

    # Engram Network (Phase 2: Spreading Activation)
    engram_seed_count: int = 10
    engram_max_hops: int = 3
    engram_decay_factor: float = 0.6
    engram_activation_threshold: float = 0.1
    engram_max_results: int = 20
    engram_max_fanout_per_hop: int = 50  # bounds rows examined per spread hop (P1 fix)
    engram_personal_seed_ratio: float = (
        0.4  # fraction of seed slots reserved for personal sources
    )
    engram_reconstruction_model: str = "auto"
    engram_narrative_cluster_threshold: int = 999  # disabled — template assembly always; LLM narrative hallucinates false connections

    # Engram Network (Phase 3: Working Memory Gate)
    engram_wm_self_model_budget: int = 500
    engram_wm_goal_budget: int = 300
    engram_wm_sticky_budget: int = 1000
    engram_wm_memory_budget: int = 4000
    engram_wm_sliding_budget: int = 3000
    engram_wm_expiring_budget: int = 200

    # Engram Network (Phase 4: Consolidation)
    engram_consolidation_enabled: bool = True
    engram_consolidation_idle_minutes: int = 30
    engram_consolidation_nightly_hour: int = 3  # 3 AM
    engram_consolidation_threshold: int = 50  # new engrams trigger
    engram_consolidation_model: str = "auto"
    # PERF-003 phase 2 — defer LLM-heavy consolidation phases when the user
    # chatted within the last N minutes so Ollama queue contention doesn't
    # hurt chat latency. Scheduled/nightly triggers bypass this gate.
    engram_consolidation_user_idle_minutes: int = 5
    engram_edge_decay: float = 0.95
    engram_prune_activation_floor: float = 0.01
    engram_merge_similarity_threshold: float = 0.88
    engram_merge_shortlist_k: int = 10  # HNSW top-K per candidate (P2)
    engram_merge_cycle_cap: int = (
        200  # candidates processed per consolidation cycle (P2)
    )
    engram_hnsw_ef_search: int = (
        40  # higher = better recall, slower probe; stable top-K (P2)
    )

    # Engram Network (Topic Clustering)
    engram_cluster_min_size: int = 5  # HDBSCAN min_cluster_size
    engram_cluster_umap_dims: int = 30  # UMAP target dimensions
    engram_cluster_umap_neighbors: int = 15  # UMAP n_neighbors
    engram_topic_assignment_threshold: float = 0.5  # cosine sim for new engram -> topic
    engram_topic_regeneration_pct: float = (
        0.3  # % membership change to trigger re-summary
    )
    engram_schema_coherence_threshold: float = (
        0.5  # min embedding coherence for schemas
    )
    engram_schema_max_tokens: int = 800  # max_tokens for schema synthesis
    engram_schema_dedup_threshold: float = 0.85  # embedding sim for schema dedup

    # Engram Network (Phase 5: Neural Router)
    neural_router_enabled: bool = True
    neural_router_min_observations: int = 200
    neural_router_embedding_threshold: int = 1000
    neural_router_retrain_every: int = 50
    neural_router_candidate_count: int = 50
    neural_router_seed_count: int = 30
    neural_router_model_check_interval: int = 60
    neural_router_training_epochs: int = 20
    neural_router_learning_rate: float = 1e-3
    neural_router_validation_split: float = 0.2
    neural_router_min_precision_gain: float = 0.0
    neural_router_max_inactive_models: int = 5
    neural_router_max_training_obs: int = 500  # cap observations to bound memory

    # Service
    service_host: str = "0.0.0.0"
    service_port: int = 8002
    log_level: str = "INFO"

    # Admin auth (SEC-004) — same pattern as llm-gateway + orchestrator.
    # Redis-backed rotatable secret + trusted-network bypass.
    nova_admin_secret: str = ""
    trusted_network_cidrs: str = ""  # empty = default list from nova_worker_common


settings = Settings()

SECONDS_PER_DAY = 86_400
