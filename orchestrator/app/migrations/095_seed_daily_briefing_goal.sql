-- 095_seed_daily_briefing_goal.sql
-- Morning briefing standing goal: distill yesterday into one phone push.
-- Fires via cortex's cron scheduler (requires the brain to be enabled);
-- delivery rides the ntfy channel through the send_push agent tool.
-- Cron is evaluated in UTC: 11:00 UTC = 07:00 US Eastern (DST) — edit the
-- schedule in the Goals UI to taste. schedule_next_at is initialized by
-- cortex's scheduler self-heal on its next PERCEIVE pass.

-- current_plan.pod routes briefing tasks to the Research pod (context+task
-- stages, no code-review) — the Quartet's code-review loop judges an
-- informational digest as code and escalates it to human review.
INSERT INTO goals (title, description, status, priority, schedule_cron,
                   check_interval_seconds, created_by, created_via,
                   max_cost_usd, review_policy, current_plan)
SELECT
    'Morning briefing',
    'Compose and deliver the operator''s morning briefing as one phone push.

Steps:
1. Review yesterday''s and today''s journal entries (search_memory / read_memory over journal/YYYY-MM-DD.md files) for completed work, decisions, failures, and open questions.
2. Call query_intel_content(since_hours=24, limit=20) and pick at most 3 genuinely notable ecosystem items.
3. Compose a briefing under 1200 characters, plain text, in short sections: "Yesterday" (what happened / was decided), "Watch" (failures or open questions needing the operator), "Intel" (one line per notable item). Drop empty sections. If everything is quiet, say so in one line — never pad.
4. Send it: send_push(title="Morning briefing", message=<the briefing>). Send exactly one push.
5. Complete the task with the briefing text as your report.

Rules:
- Do NOT create, modify, or delete any goals — this standing goal already exists and repeats daily on its own schedule.
- Send exactly one push per run via send_push; nothing else.
- If send_push fails for ANY reason, your final output must be the FULL briefing text itself (not a summary of what went wrong) — the completion notice delivers your output to the operator, so the briefing still arrives.',
    'active',
    3,
    '0 11 * * *',
    86400,
    'system',
    'migration',
    0.50,
    'auto',
    '{"pod": "Research"}'::jsonb
WHERE NOT EXISTS (
    SELECT 1 FROM goals WHERE title = 'Morning briefing'
);
