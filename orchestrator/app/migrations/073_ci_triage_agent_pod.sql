-- Migration 073: CI Triage Agent pod — autonomous CI failure triage
-- Idempotent: ON CONFLICT DO NOTHING / WHERE NOT EXISTS throughout

-- ── Pod ──────────────────────────────────────────────────────────────────────

INSERT INTO pods (name, description, enabled, require_human_review, escalation_threshold, priority)
VALUES (
    'ci_triage_agent',
    'Triages failed GitHub Actions runs and proposes fixes',
    true,
    'on_escalation',
    'high',
    0
)
ON CONFLICT (name) DO NOTHING;

-- ── Pipeline agents ──────────────────────────────────────────────────────────

INSERT INTO pod_agents (
    pod_id, name, role, description, position,
    temperature, max_tokens, timeout_seconds, max_retries,
    on_failure, run_condition, allowed_tools
)
SELECT p.id, a.name, a.role, a.description, a.position,
       a.temperature, a.max_tokens, a.timeout_seconds, a.max_retries,
       a.on_failure, a.run_condition::jsonb, a.allowed_tools
FROM pods p
CROSS JOIN (VALUES
    ('Context Agent',   'context',    'Retrieves prior triage history and codebase context.',   1, 0.2, 4096,  60, 1, 'abort',    '{"type":"always"}',
     ARRAY['list_dir','read_file','search_codebase','search_memory','what_do_i_know']),
    ('Task Agent',      'task',       'Triages the CI failure: reads logs, diagnoses root cause, drafts a fix or comments.', 2, 0.4, 8192, 180, 2, 'abort', '{"type":"always"}',
     ARRAY['get_run_logs','get_run_details','get_check_runs','compare_to_main','diagnose_failure','draft_fix','open_fix_pr','comment_on_pr','list_dir','read_file','write_file','run_shell','search_codebase','search_memory']),
    ('Guardrail Agent', 'guardrail',  'Checks that any proposed patch is safe and minimal.',   3, 0.1, 2048,  30, 1, 'escalate', '{"type":"always"}',
     ARRAY['read_file','search_codebase']),
    ('Decision Agent',  'decision',   'ADR when Guardrail blocks a proposed patch.',            4, 0.2, 4096,  60, 1, 'escalate',
     '{"type":"on_flag","flag":"guardrail_blocked"}',
     NULL)
) AS a(name, role, description, position, temperature, max_tokens, timeout_seconds, max_retries, on_failure, run_condition, allowed_tools)
WHERE p.name = 'ci_triage_agent'
ON CONFLICT (pod_id, position) DO NOTHING;

-- ── System prompt for Task Agent ─────────────────────────────────────────────

UPDATE pod_agents
SET system_prompt = $$You triage failed CI runs on GitHub repos.
First, call compare_to_main to locate where the bug lives (in the PR or on main).
Read logs with get_run_logs to identify the failing step.
Diagnose the root cause via diagnose_failure.
Recall past triages from Memory for similar failures (use search_memory).
Draft a minimal patch via draft_fix (touch only files implicated by the diagnosis).
Open a PR with the fix targeting the correct base branch via open_fix_pr.
If diagnosis is uncertain (confidence < 0.5) or the patch is risky (large diff),
comment on the PR via comment_on_pr with the diagnosis only — do NOT open a PR.$$
WHERE role = 'task'
  AND system_prompt IS NULL
  AND pod_id = (SELECT id FROM pods WHERE name = 'ci_triage_agent');
