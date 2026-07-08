-- FK / filter-column index coverage (TD-04).
-- Raw asyncpg means Postgres does NOT auto-index foreign keys. An audit of
-- pg_index vs the most-filtered columns (task_id 17×, tenant_id 12×,
-- conversation_id, goal_id, agent_session_id, recommendation_id, source_id,
-- user_id, actor_id, session_id, pod_id) found these leading-column indexes
-- missing on tables that grow with activity — future full-table scans on join.
-- Scoped to append-heavy tables; small operator-managed config tables are
-- deliberately left unindexed. All idempotent.

-- ── Pipeline per-run (grow with every task) ────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_agent_sessions_task_id            ON agent_sessions(task_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_task_id                 ON artifacts(task_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_agent_session_id        ON artifacts(agent_session_id);
CREATE INDEX IF NOT EXISTS idx_code_reviews_task_id              ON code_reviews(task_id);
CREATE INDEX IF NOT EXISTS idx_code_reviews_agent_session_id     ON code_reviews(agent_session_id);
CREATE INDEX IF NOT EXISTS idx_guardrail_findings_task_id        ON guardrail_findings(task_id);
CREATE INDEX IF NOT EXISTS idx_guardrail_findings_agent_sess     ON guardrail_findings(agent_session_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_training_logs_task_id    ON pipeline_training_logs(task_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_training_logs_agent_sess ON pipeline_training_logs(agent_session_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_task_id                 ON audit_log(task_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_agent_session_id        ON audit_log(agent_session_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_pod_id                  ON audit_log(pod_id);

-- ── Tasks & goals ──────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_tasks_goal_id                     ON tasks(goal_id);
CREATE INDEX IF NOT EXISTS idx_tasks_pod_id                      ON tasks(pod_id);
CREATE INDEX IF NOT EXISTS idx_tasks_user_id                     ON tasks(user_id);
CREATE INDEX IF NOT EXISTS idx_goal_tasks_goal_id                ON goal_tasks(goal_id);
CREATE INDEX IF NOT EXISTS idx_goal_iterations_goal_id           ON goal_iterations(goal_id);
CREATE INDEX IF NOT EXISTS idx_goal_verifications_goal_id        ON goal_verifications(goal_id);
CREATE INDEX IF NOT EXISTS idx_cortex_reflections_goal_id        ON cortex_reflections(goal_id);
CREATE INDEX IF NOT EXISTS idx_cortex_reflections_task_id        ON cortex_reflections(task_id);
CREATE INDEX IF NOT EXISTS idx_selfmod_prs_task_id               ON selfmod_prs(task_id);
CREATE INDEX IF NOT EXISTS idx_selfmod_prs_goal_id               ON selfmod_prs(goal_id);

-- ── Conversations & quality ───────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_messages_conversation_id          ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_conversations_user_id             ON conversations(user_id);
CREATE INDEX IF NOT EXISTS idx_conversation_outcomes_conv_id     ON conversation_outcomes(conversation_id);
CREATE INDEX IF NOT EXISTS idx_conversation_outcomes_session_id  ON conversation_outcomes(session_id);
CREATE INDEX IF NOT EXISTS idx_quality_scores_conversation_id    ON quality_scores(conversation_id);
CREATE INDEX IF NOT EXISTS idx_quality_scores_task_id            ON quality_scores(task_id);

-- ── Approvals, capability & RBAC audit ─────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_approval_requests_task_id         ON approval_requests(task_id);
CREATE INDEX IF NOT EXISTS idx_approval_requests_tenant_id       ON approval_requests(tenant_id);
CREATE INDEX IF NOT EXISTS idx_capability_audit_task_id          ON capability_audit(task_id);
CREATE INDEX IF NOT EXISTS idx_capability_audit_tenant_id        ON capability_audit(tenant_id);
CREATE INDEX IF NOT EXISTS idx_capability_audit_actor_id         ON capability_audit(actor_id);
CREATE INDEX IF NOT EXISTS idx_capability_audit_user_id          ON capability_audit(user_id);
CREATE INDEX IF NOT EXISTS idx_rbac_audit_log_actor_id           ON rbac_audit_log(actor_id);
CREATE INDEX IF NOT EXISTS idx_rbac_audit_log_tenant_id          ON rbac_audit_log(tenant_id);

-- ── Usage, friction, auth ──────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_usage_events_session_id           ON usage_events(session_id);
CREATE INDEX IF NOT EXISTS idx_usage_events_tenant_id            ON usage_events(tenant_id);
CREATE INDEX IF NOT EXISTS idx_friction_log_task_id              ON friction_log(task_id);
CREATE INDEX IF NOT EXISTS idx_friction_log_user_id              ON friction_log(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id            ON refresh_tokens(user_id);

-- ── Intel & knowledge (grow per recommendation / crawl) ────────────────────
CREATE INDEX IF NOT EXISTS idx_intel_recommendations_task_id     ON intel_recommendations(task_id);
CREATE INDEX IF NOT EXISTS idx_intel_recommendations_goal_id     ON intel_recommendations(goal_id);
CREATE INDEX IF NOT EXISTS idx_intel_rec_memories_rec_id         ON intel_recommendation_memories(recommendation_id);
CREATE INDEX IF NOT EXISTS idx_intel_rec_sources_rec_id          ON intel_recommendation_sources(recommendation_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_crawl_log_source_id     ON knowledge_crawl_log(source_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_crawl_log_tenant_id     ON knowledge_crawl_log(tenant_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_page_cache_source_id    ON knowledge_page_cache(source_id);
