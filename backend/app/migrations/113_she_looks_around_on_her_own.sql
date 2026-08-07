-- Migration 113: the heartbeat — she looks around on her own.
--
-- ROADMAP #45, spec in docs/plans/heartbeat.md. Every surveyed assistant
-- (OpenClaw, Hermes, Vellum) converged on the same primitive Nova lacked:
-- a periodic agent turn over an operator-editable checklist, quiet unless
-- something needs attention. Jeremy decided 2026-08-07: default ON, every
-- 30 minutes inside heartbeat.active_hours (08:00-22:00 local), delivery
-- is web push + an inbox card.
--
-- A mechanical row like the restore drill (migration 112): handler names
-- scheduler code, so the quiet contract — HEARTBEAT_OK suppressed by the
-- BACKEND, delivery through notify + recommendations, both-channels-failed
-- is a FAILED run — is enforced in app/heartbeat.py, never requested of
-- the model. The agent turn happens inside the handler with its own trace
-- source ('heartbeat'), so beats never read as the operator's turns.
--
-- notify=false is deliberate: the generic notify:true relay would push
-- EVERY run summary — including every quiet one — which is 30-minute spam.
-- The handler delivers only when the contract says notify.
--
-- First run ~10 minutes out, same reasoning as migrations 109 and 112:
-- the first unattended run of anything should happen while someone can
-- still be watching.

INSERT INTO automations (name, description, instruction, agent_name,
                         interval_minutes, timeout_seconds,
                         enabled, is_system, next_run_at, notify, handler)
VALUES (
    'heartbeat',
    'Every 30 minutes (within Settings → Automations → Heartbeat active '
    'hours), Nova reads memory/heartbeat.md and checks only what it names. '
    'Nothing needs attention → the run records quiet and you hear nothing. '
    'Something does → web push + an inbox card. Edit the checklist in '
    'Library → Files.',
    'MECHANICAL — the scheduler runs heartbeat.beat() in code: it reads '
    'the checklist, runs a read-only agent pass over it, and the BACKEND '
    'decides quiet vs notify (HEARTBEAT_OK under 300 chars is suppressed; '
    'anything else is delivered). No agent receives this text; it exists '
    'so a human reading this row knows what runs and where.',
    'main',
    30,
    300,
    true, true,
    now() + interval '10 minutes',
    false,
    'heartbeat')
ON CONFLICT (name) DO NOTHING;
