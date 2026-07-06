---
title: "Agent Pipeline"
description: "Nova's multi-stage agent pipeline: Context, Task, Guardrail, Code Review, and Decision agents."
---

Every task in Nova flows through a configurable pipeline of specialized agents. The default pipeline -- called the **Quartet** -- runs four agents in sequence, with a fifth (Decision) triggered only on failure.

## Pipeline stages

```
Context Agent    ->  curates relevant code, docs, prior task history
Task Agent       ->  produces the actual output (code, config, answer)
Guardrail Agent  ->  checks for prompt injection, PII, credential leaks, spec drift
Code Review      ->  pass / needs_refactor / reject (loops back to Task, max 3 iterations)
                        | blocked + rejected
                     Decision Agent  ->  ADR artifact + human escalation
```

### What each agent does

| Agent | Role | Model class |
|-------|------|-------------|
| **Context** | Gathers relevant code, documentation, and prior task history. Detects ambiguous requests and can pause with clarification questions before the expensive Task Agent runs. | Standard |
| **Task** | Produces the actual output -- code, configuration, answers, or any artifact the user requested. | Standard |
| **Guardrail** | Lightweight safety check: prompt injection detection, PII scanning, credential leak detection, specification drift analysis. | Haiku-class (fast, cheap) |
| **Code Review** | Reviews the Task Agent's output. Verdicts: `pass`, `needs_refactor` (loops back to Task, max 3 iterations), or `reject` (escalates to Decision). | Standard |
| **Decision** | Triggered only on rejection. Produces an Architecture Decision Record (ADR) artifact and escalates to human review. | Standard |

## Post-pipeline agents

After the main pipeline completes, these agents run in **parallel**, on a **best-effort** basis (non-blocking -- failures don't affect the task result):

- **Documentation Agent** -- generates or updates docs for the task output
- **Diagramming Agent** -- creates architectural or flow diagrams
- **Security Review Agent** -- deeper security analysis beyond the guardrail check
- **Memory Extraction Agent** -- extracts key facts and patterns for long-term memory storage

## Task queue

The pipeline is driven by a Redis task queue:

| Parameter | Value |
|-----------|-------|
| **Dispatch mechanism** | Redis BRPOP -- long tasks don't block the HTTP layer |
| **Heartbeat interval** | 30 seconds |
| **Stale task timeout** | 150 seconds (reaper reclaims abandoned tasks) |
| **Checkpoints** | Pipeline state is checkpointed between stages for recovery |

### Task state machine

Tasks move through 11 states:

```
submitted -> queued -> context_running -> task_running -> guardrail_running
  -> review_running -> pending_human_review -> completing -> complete
```

Additional terminal/special states: `failed`, `cancelled`, `clarification_needed`, `waiting_human`.

- **`pending_human_review`** pauses the pipeline -- the task waits without failing
- **`clarification_needed`** -- Context Agent detected ambiguity and paused with questions. The user answers via `POST /clarify`, and the pipeline resumes from its checkpoint with enriched input
- **`waiting_human`** -- the Task Agent called `request_human_checkpoint` mid-flow (CAPTCHA, emailed verification code, judgment call). The conversation is snapshotted, a checkpoint card appears in Pending Approvals (and pushes to your phone), and your reply is injected back as the tool's result so the agent continues exactly where it stopped. Unanswered checkpoints are cancelled after 24h
- Tasks can be cancelled from the dashboard at any state

## Pod presets

A **pod** is a named pipeline configuration that determines which agents run and with what settings. Nova ships with five default pods:

| Pod | Agents | Use case |
|-----|--------|----------|
| **Quartet** (system default) | Context, Task, Guardrail, Code Review | All code and configuration tasks |
| **Quick Reply** | Task only | Fast answers, low-stakes queries |
| **Research** | Context, Task (with web search tools) | Information gathering |
| **Code Generation** | Full Quartet + git tools | Production code, auto-commit on pass |
| **Analysis** | Context, Task (read-only tools) | Codebase audit, no write operations |

## Agent configurability

Every agent is fully configurable. Settings are stored in the database and editable through the dashboard UI:

**Per-agent settings:**
- `name`, `role`, `model`, `temperature`, `max_tokens`, `timeout_seconds`, `max_retries`
- `system_prompt` override, `task_description`
- `allowed_tools[]` -- which MCP tools the agent can invoke
- `on_failure` behavior
- `run_condition` -- controls when the agent executes: `always`, `never`, `on_flag`, `has_tag`, or compound conditions (`and`, `or`)
- `output_schema` (JSON schema for structured output), `artifact_type`

**Per-pod settings:**
- `name`, `description`, `enabled`/`disabled`, `default_model`
- `max_cost_usd`, `max_execution_seconds`
- `require_human_review`, `escalation_threshold`
- `routing_keywords[]`, `routing_regex`, `priority`, `fallback_pod_id`
