-- Migration 014: proactivity pulse — seeded self-review schedule + guard config.
-- The pulse rides the verified scheduler; created_by='nova' rows are subject to the
-- kill switch / budget / tool-capability guards in app/scheduler/guards.py.

INSERT INTO app_config (key, value) VALUES ('proactivity.enabled', 'true')
    ON CONFLICT (key) DO NOTHING;
INSERT INTO app_config (key, value) VALUES ('proactivity.daily_task_budget', '12')
    ON CONFLICT (key) DO NOTHING;

-- First fire 4h after upgrade, then every 4h. Edit cadence in the Schedules page.
INSERT INTO schedules (name, prompt, trigger, enabled, created_by, next_fire)
SELECT
    'nova-self-review',
    E'You are Nova running your periodic self-review.\n\n'
    'Look for ONE small, genuinely useful thing to do right now. Check your memory '
    'for the user''s current projects and preferences (memory.search), and consider '
    'recent task or schedule outcomes if relevant.\n\n'
    'Rules:\n'
    '- If you find something concrete and useful, do it with your tools, then '
    'summarize what you did and why in 1-3 sentences.\n'
    '- Only act on things with clear value to the user. Do not invent busywork.\n'
    '- Do not send external communications or make destructive changes.\n'
    '- If nothing is genuinely worth doing, reply with exactly: NOTHING',
    '{"type": "interval", "every_seconds": 14400}'::jsonb,
    true,
    'nova',
    now() + interval '4 hours'
WHERE NOT EXISTS (
    SELECT 1 FROM schedules WHERE name = 'nova-self-review' AND created_by = 'nova'
);
