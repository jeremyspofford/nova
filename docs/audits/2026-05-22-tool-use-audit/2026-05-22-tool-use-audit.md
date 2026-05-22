---
date: 2026-05-22
commit_sha: 84ca86363c3b
audit_script_sha256: 5de95334f0da
llm_routing_strategy: unknown
run_duration_seconds: 300
run_id: 13f44f36
total_trials: 33
total_models: 3
---

# Tool-Use Audit Report

## TL;DR

| Model | Tools tested | Pass rate | P0 count |
| ----- | ------------ | --------- | -------- |
| gemini/gemini-1.5-flash | 11 | 0/11 | 0 |
| gpt-4o-mini | 11 | 7/11 | 0 |
| qwen2.5-coder:7b | 11 | 2/11 | 1 |

## Findings

### qwen2.5-coder:7b / memory-write-then-search

**Severity:** P0  
**Category:** wiring  
**Tool:** `memory.write`  
**Failure rate:** 100%  
**Recommended fix:** Investigate tool routing/registration; check tool name matches model's registered tool schema.  
**Effort:** M

Trace evidence: [trace](/home/jeremy/workspace/nova/.worktrees/engineer-agent-actually-uses-tools/docs/audits/2026-05-22-tool-use-audit/traces/memory-write-then-search__qwen2.5-coder:7b__t0.json)

### qwen2.5-coder:7b / nova-secrets-read

**Severity:** P1  
**Category:** model  
**Tool:** `nova.secrets.read`  
**Failure rate:** 100%  
**Recommended fix:** Evaluate model tool-calling capability; consider switching model or adding few-shot examples.  
**Effort:** M

Trace evidence: [trace](/home/jeremy/workspace/nova/.worktrees/engineer-agent-actually-uses-tools/docs/audits/2026-05-22-tool-use-audit/traces/nova-secrets-read__qwen2.5-coder:7b__t0.json)

### qwen2.5-coder:7b / browser-navigate-attempt

**Severity:** P1  
**Category:** model  
**Tool:** `browser_navigate`  
**Failure rate:** 100%  
**Recommended fix:** Evaluate model tool-calling capability; consider switching model or adding few-shot examples.  
**Effort:** M

### gpt-4o-mini / web-fetch-token-page

**Severity:** P1  
**Category:** model  
**Tool:** `web.fetch`  
**Failure rate:** 100%  
**Recommended fix:** Evaluate model tool-calling capability; consider switching model or adding few-shot examples.  
**Effort:** M

Trace evidence: [trace](/home/jeremy/workspace/nova/.worktrees/engineer-agent-actually-uses-tools/docs/audits/2026-05-22-tool-use-audit/traces/web-fetch-token-page__gpt-4o-mini__t0.json)

### gpt-4o-mini / browser-navigate-attempt

**Severity:** P1  
**Category:** model  
**Tool:** `browser_navigate`  
**Failure rate:** 100%  
**Recommended fix:** Evaluate model tool-calling capability; consider switching model or adding few-shot examples.  
**Effort:** M

### gemini/gemini-1.5-flash / fs-write-roundtrip

**Severity:** P1  
**Category:** model  
**Tool:** `fs.write`  
**Failure rate:** 100%  
**Recommended fix:** Evaluate model tool-calling capability; consider switching model or adding few-shot examples.  
**Effort:** M

Trace evidence: [trace](/home/jeremy/workspace/nova/.worktrees/engineer-agent-actually-uses-tools/docs/audits/2026-05-22-tool-use-audit/traces/fs-write-roundtrip__gemini_gemini-1.5-flash__t0.json)

### gemini/gemini-1.5-flash / fs-read-echo

**Severity:** P1  
**Category:** model  
**Tool:** `fs.read`  
**Failure rate:** 100%  
**Recommended fix:** Evaluate model tool-calling capability; consider switching model or adding few-shot examples.  
**Effort:** M

Trace evidence: [trace](/home/jeremy/workspace/nova/.worktrees/engineer-agent-actually-uses-tools/docs/audits/2026-05-22-tool-use-audit/traces/fs-read-echo__gemini_gemini-1.5-flash__t0.json)

### gemini/gemini-1.5-flash / shell-exec-echo-token

**Severity:** P1  
**Category:** model  
**Tool:** `shell.exec`  
**Failure rate:** 100%  
**Recommended fix:** Evaluate model tool-calling capability; consider switching model or adding few-shot examples.  
**Effort:** M

Trace evidence: [trace](/home/jeremy/workspace/nova/.worktrees/engineer-agent-actually-uses-tools/docs/audits/2026-05-22-tool-use-audit/traces/shell-exec-echo-token__gemini_gemini-1.5-flash__t0.json)

### gemini/gemini-1.5-flash / code-execute-echo-token

**Severity:** P1  
**Category:** model  
**Tool:** `code.execute`  
**Failure rate:** 100%  
**Recommended fix:** Evaluate model tool-calling capability; consider switching model or adding few-shot examples.  
**Effort:** M

Trace evidence: [trace](/home/jeremy/workspace/nova/.worktrees/engineer-agent-actually-uses-tools/docs/audits/2026-05-22-tool-use-audit/traces/code-execute-echo-token__gemini_gemini-1.5-flash__t0.json)

### gemini/gemini-1.5-flash / memory-write-then-search

**Severity:** P1  
**Category:** model  
**Tool:** `memory.write`  
**Failure rate:** 100%  
**Recommended fix:** Evaluate model tool-calling capability; consider switching model or adding few-shot examples.  
**Effort:** M

Trace evidence: [trace](/home/jeremy/workspace/nova/.worktrees/engineer-agent-actually-uses-tools/docs/audits/2026-05-22-tool-use-audit/traces/memory-write-then-search__gemini_gemini-1.5-flash__t0.json)

### gemini/gemini-1.5-flash / memory-search-verbatim-echo

**Severity:** P1  
**Category:** model  
**Tool:** `memory.search`  
**Failure rate:** 100%  
**Recommended fix:** Evaluate model tool-calling capability; consider switching model or adding few-shot examples.  
**Effort:** M

Trace evidence: [trace](/home/jeremy/workspace/nova/.worktrees/engineer-agent-actually-uses-tools/docs/audits/2026-05-22-tool-use-audit/traces/memory-search-verbatim-echo__gemini_gemini-1.5-flash__t0.json)

### gemini/gemini-1.5-flash / nova-secrets-write

**Severity:** P1  
**Category:** model  
**Tool:** `nova.secrets.write`  
**Failure rate:** 100%  
**Recommended fix:** Evaluate model tool-calling capability; consider switching model or adding few-shot examples.  
**Effort:** M

Trace evidence: [trace](/home/jeremy/workspace/nova/.worktrees/engineer-agent-actually-uses-tools/docs/audits/2026-05-22-tool-use-audit/traces/nova-secrets-write__gemini_gemini-1.5-flash__t0.json)

### gemini/gemini-1.5-flash / nova-secrets-read

**Severity:** P1  
**Category:** model  
**Tool:** `nova.secrets.read`  
**Failure rate:** 100%  
**Recommended fix:** Evaluate model tool-calling capability; consider switching model or adding few-shot examples.  
**Effort:** M

Trace evidence: [trace](/home/jeremy/workspace/nova/.worktrees/engineer-agent-actually-uses-tools/docs/audits/2026-05-22-tool-use-audit/traces/nova-secrets-read__gemini_gemini-1.5-flash__t0.json)

### gemini/gemini-1.5-flash / web-fetch-token-page

**Severity:** P1  
**Category:** model  
**Tool:** `web.fetch`  
**Failure rate:** 100%  
**Recommended fix:** Evaluate model tool-calling capability; consider switching model or adding few-shot examples.  
**Effort:** M

Trace evidence: [trace](/home/jeremy/workspace/nova/.worktrees/engineer-agent-actually-uses-tools/docs/audits/2026-05-22-tool-use-audit/traces/web-fetch-token-page__gemini_gemini-1.5-flash__t0.json)

### gemini/gemini-1.5-flash / web-search-attempt

**Severity:** P1  
**Category:** model  
**Tool:** `web.search`  
**Failure rate:** 100%  
**Recommended fix:** Evaluate model tool-calling capability; consider switching model or adding few-shot examples.  
**Effort:** M

Trace evidence: [trace](/home/jeremy/workspace/nova/.worktrees/engineer-agent-actually-uses-tools/docs/audits/2026-05-22-tool-use-audit/traces/web-search-attempt__gemini_gemini-1.5-flash__t0.json)

### gemini/gemini-1.5-flash / browser-navigate-attempt

**Severity:** P1  
**Category:** model  
**Tool:** `browser_navigate`  
**Failure rate:** 100%  
**Recommended fix:** Evaluate model tool-calling capability; consider switching model or adding few-shot examples.  
**Effort:** M

### qwen2.5-coder:7b / fs-read-echo

**Severity:** P2  
**Category:** prompt  
**Tool:** `fs.read`  
**Failure rate:** 0%  
**Recommended fix:** Refine system prompt to strengthen tool-use instruction for this probe.  
**Effort:** S

Trace evidence: [trace](/home/jeremy/workspace/nova/.worktrees/engineer-agent-actually-uses-tools/docs/audits/2026-05-22-tool-use-audit/traces/fs-read-echo__qwen2.5-coder:7b__t0.json)

### qwen2.5-coder:7b / shell-exec-echo-token

**Severity:** P2  
**Category:** prompt  
**Tool:** `shell.exec`  
**Failure rate:** 0%  
**Recommended fix:** Refine system prompt to strengthen tool-use instruction for this probe.  
**Effort:** S

Trace evidence: [trace](/home/jeremy/workspace/nova/.worktrees/engineer-agent-actually-uses-tools/docs/audits/2026-05-22-tool-use-audit/traces/shell-exec-echo-token__qwen2.5-coder:7b__t0.json)

### qwen2.5-coder:7b / code-execute-echo-token

**Severity:** P2  
**Category:** prompt  
**Tool:** `code.execute`  
**Failure rate:** 0%  
**Recommended fix:** Refine system prompt to strengthen tool-use instruction for this probe.  
**Effort:** S

Trace evidence: [trace](/home/jeremy/workspace/nova/.worktrees/engineer-agent-actually-uses-tools/docs/audits/2026-05-22-tool-use-audit/traces/code-execute-echo-token__qwen2.5-coder:7b__t0.json)

### qwen2.5-coder:7b / memory-search-verbatim-echo

**Severity:** P2  
**Category:** prompt  
**Tool:** `memory.search`  
**Failure rate:** 0%  
**Recommended fix:** Refine system prompt to strengthen tool-use instruction for this probe.  
**Effort:** S

Trace evidence: [trace](/home/jeremy/workspace/nova/.worktrees/engineer-agent-actually-uses-tools/docs/audits/2026-05-22-tool-use-audit/traces/memory-search-verbatim-echo__qwen2.5-coder:7b__t0.json)

### qwen2.5-coder:7b / web-fetch-token-page

**Severity:** P2  
**Category:** prompt  
**Tool:** `web.fetch`  
**Failure rate:** 0%  
**Recommended fix:** Refine system prompt to strengthen tool-use instruction for this probe.  
**Effort:** S

Trace evidence: [trace](/home/jeremy/workspace/nova/.worktrees/engineer-agent-actually-uses-tools/docs/audits/2026-05-22-tool-use-audit/traces/web-fetch-token-page__qwen2.5-coder:7b__t0.json)

### qwen2.5-coder:7b / web-search-attempt

**Severity:** P2  
**Category:** prompt  
**Tool:** `web.search`  
**Failure rate:** 0%  
**Recommended fix:** Refine system prompt to strengthen tool-use instruction for this probe.  
**Effort:** S

Trace evidence: [trace](/home/jeremy/workspace/nova/.worktrees/engineer-agent-actually-uses-tools/docs/audits/2026-05-22-tool-use-audit/traces/web-search-attempt__qwen2.5-coder:7b__t0.json)

### gpt-4o-mini / memory-search-verbatim-echo

**Severity:** P2  
**Category:** prompt  
**Tool:** `memory.search`  
**Failure rate:** 0%  
**Recommended fix:** Refine system prompt to strengthen tool-use instruction for this probe.  
**Effort:** S

Trace evidence: [trace](/home/jeremy/workspace/nova/.worktrees/engineer-agent-actually-uses-tools/docs/audits/2026-05-22-tool-use-audit/traces/memory-search-verbatim-echo__gpt-4o-mini__t0.json)

### qwen2.5-coder:7b / fs-write-roundtrip

**Severity:** P2  
**Category:** passing  
**Tool:** `fs.write`  
**Failure rate:** 0%  
**Recommended fix:** No action required — probe is passing.  
**Effort:** L

Trace evidence: [trace](/home/jeremy/workspace/nova/.worktrees/engineer-agent-actually-uses-tools/docs/audits/2026-05-22-tool-use-audit/traces/fs-write-roundtrip__qwen2.5-coder:7b__t0.json)

### qwen2.5-coder:7b / nova-secrets-write

**Severity:** P2  
**Category:** passing  
**Tool:** `nova.secrets.write`  
**Failure rate:** 0%  
**Recommended fix:** No action required — probe is passing.  
**Effort:** L

Trace evidence: [trace](/home/jeremy/workspace/nova/.worktrees/engineer-agent-actually-uses-tools/docs/audits/2026-05-22-tool-use-audit/traces/nova-secrets-write__qwen2.5-coder:7b__t0.json)

### gpt-4o-mini / fs-write-roundtrip

**Severity:** P2  
**Category:** passing  
**Tool:** `fs.write`  
**Failure rate:** 0%  
**Recommended fix:** No action required — probe is passing.  
**Effort:** L

Trace evidence: [trace](/home/jeremy/workspace/nova/.worktrees/engineer-agent-actually-uses-tools/docs/audits/2026-05-22-tool-use-audit/traces/fs-write-roundtrip__gpt-4o-mini__t0.json)

### gpt-4o-mini / fs-read-echo

**Severity:** P2  
**Category:** passing  
**Tool:** `fs.read`  
**Failure rate:** 0%  
**Recommended fix:** No action required — probe is passing.  
**Effort:** L

Trace evidence: [trace](/home/jeremy/workspace/nova/.worktrees/engineer-agent-actually-uses-tools/docs/audits/2026-05-22-tool-use-audit/traces/fs-read-echo__gpt-4o-mini__t0.json)

### gpt-4o-mini / shell-exec-echo-token

**Severity:** P2  
**Category:** passing  
**Tool:** `shell.exec`  
**Failure rate:** 0%  
**Recommended fix:** No action required — probe is passing.  
**Effort:** L

Trace evidence: [trace](/home/jeremy/workspace/nova/.worktrees/engineer-agent-actually-uses-tools/docs/audits/2026-05-22-tool-use-audit/traces/shell-exec-echo-token__gpt-4o-mini__t0.json)

### gpt-4o-mini / code-execute-echo-token

**Severity:** P2  
**Category:** passing  
**Tool:** `code.execute`  
**Failure rate:** 0%  
**Recommended fix:** No action required — probe is passing.  
**Effort:** L

Trace evidence: [trace](/home/jeremy/workspace/nova/.worktrees/engineer-agent-actually-uses-tools/docs/audits/2026-05-22-tool-use-audit/traces/code-execute-echo-token__gpt-4o-mini__t0.json)

### gpt-4o-mini / memory-write-then-search

**Severity:** P2  
**Category:** passing  
**Tool:** `memory.write`  
**Failure rate:** 0%  
**Recommended fix:** No action required — probe is passing.  
**Effort:** L

Trace evidence: [trace](/home/jeremy/workspace/nova/.worktrees/engineer-agent-actually-uses-tools/docs/audits/2026-05-22-tool-use-audit/traces/memory-write-then-search__gpt-4o-mini__t0.json)

### gpt-4o-mini / nova-secrets-write

**Severity:** P2  
**Category:** passing  
**Tool:** `nova.secrets.write`  
**Failure rate:** 0%  
**Recommended fix:** No action required — probe is passing.  
**Effort:** L

Trace evidence: [trace](/home/jeremy/workspace/nova/.worktrees/engineer-agent-actually-uses-tools/docs/audits/2026-05-22-tool-use-audit/traces/nova-secrets-write__gpt-4o-mini__t0.json)

### gpt-4o-mini / nova-secrets-read

**Severity:** P2  
**Category:** passing  
**Tool:** `nova.secrets.read`  
**Failure rate:** 0%  
**Recommended fix:** No action required — probe is passing.  
**Effort:** L

Trace evidence: [trace](/home/jeremy/workspace/nova/.worktrees/engineer-agent-actually-uses-tools/docs/audits/2026-05-22-tool-use-audit/traces/nova-secrets-read__gpt-4o-mini__t0.json)

### gpt-4o-mini / web-search-attempt

**Severity:** P2  
**Category:** infra  
**Tool:** `web.search`  
**Failure rate:** 100%  
**Recommended fix:** Investigate audit harness timeout; check service health and probe setup/cleanup paths.  
**Effort:** L

Trace evidence: [trace](/home/jeremy/workspace/nova/.worktrees/engineer-agent-actually-uses-tools/docs/audits/2026-05-22-tool-use-audit/traces/web-search-attempt__gpt-4o-mini__t0.json)

## Recommendations

1. **qwen2.5-coder:7b / memory-write-then-search** [P0, effort M]: Investigate tool routing/registration; check tool name matches model's registered tool schema.
2. **qwen2.5-coder:7b / nova-secrets-read** [P1, effort M]: Evaluate model tool-calling capability; consider switching model or adding few-shot examples.
3. **qwen2.5-coder:7b / browser-navigate-attempt** [P1, effort M]: Evaluate model tool-calling capability; consider switching model or adding few-shot examples.
4. **gpt-4o-mini / web-fetch-token-page** [P1, effort M]: Evaluate model tool-calling capability; consider switching model or adding few-shot examples.
5. **gpt-4o-mini / browser-navigate-attempt** [P1, effort M]: Evaluate model tool-calling capability; consider switching model or adding few-shot examples.
6. **gemini/gemini-1.5-flash / fs-write-roundtrip** [P1, effort M]: Evaluate model tool-calling capability; consider switching model or adding few-shot examples.
7. **gemini/gemini-1.5-flash / fs-read-echo** [P1, effort M]: Evaluate model tool-calling capability; consider switching model or adding few-shot examples.
8. **gemini/gemini-1.5-flash / shell-exec-echo-token** [P1, effort M]: Evaluate model tool-calling capability; consider switching model or adding few-shot examples.
9. **gemini/gemini-1.5-flash / code-execute-echo-token** [P1, effort M]: Evaluate model tool-calling capability; consider switching model or adding few-shot examples.
10. **gemini/gemini-1.5-flash / memory-write-then-search** [P1, effort M]: Evaluate model tool-calling capability; consider switching model or adding few-shot examples.
11. **gemini/gemini-1.5-flash / memory-search-verbatim-echo** [P1, effort M]: Evaluate model tool-calling capability; consider switching model or adding few-shot examples.
12. **gemini/gemini-1.5-flash / nova-secrets-write** [P1, effort M]: Evaluate model tool-calling capability; consider switching model or adding few-shot examples.
13. **gemini/gemini-1.5-flash / nova-secrets-read** [P1, effort M]: Evaluate model tool-calling capability; consider switching model or adding few-shot examples.
14. **gemini/gemini-1.5-flash / web-fetch-token-page** [P1, effort M]: Evaluate model tool-calling capability; consider switching model or adding few-shot examples.
15. **gemini/gemini-1.5-flash / web-search-attempt** [P1, effort M]: Evaluate model tool-calling capability; consider switching model or adding few-shot examples.
16. **gemini/gemini-1.5-flash / browser-navigate-attempt** [P1, effort M]: Evaluate model tool-calling capability; consider switching model or adding few-shot examples.
17. **qwen2.5-coder:7b / fs-read-echo** [P2, effort S]: Refine system prompt to strengthen tool-use instruction for this probe.
18. **qwen2.5-coder:7b / shell-exec-echo-token** [P2, effort S]: Refine system prompt to strengthen tool-use instruction for this probe.
19. **qwen2.5-coder:7b / code-execute-echo-token** [P2, effort S]: Refine system prompt to strengthen tool-use instruction for this probe.
20. **qwen2.5-coder:7b / memory-search-verbatim-echo** [P2, effort S]: Refine system prompt to strengthen tool-use instruction for this probe.
21. **qwen2.5-coder:7b / web-fetch-token-page** [P2, effort S]: Refine system prompt to strengthen tool-use instruction for this probe.
22. **qwen2.5-coder:7b / web-search-attempt** [P2, effort S]: Refine system prompt to strengthen tool-use instruction for this probe.
23. **gpt-4o-mini / memory-search-verbatim-echo** [P2, effort S]: Refine system prompt to strengthen tool-use instruction for this probe.
24. **qwen2.5-coder:7b / fs-write-roundtrip** [P2, effort L]: No action required — probe is passing.
25. **qwen2.5-coder:7b / nova-secrets-write** [P2, effort L]: No action required — probe is passing.
26. **gpt-4o-mini / fs-write-roundtrip** [P2, effort L]: No action required — probe is passing.
27. **gpt-4o-mini / fs-read-echo** [P2, effort L]: No action required — probe is passing.
28. **gpt-4o-mini / shell-exec-echo-token** [P2, effort L]: No action required — probe is passing.
29. **gpt-4o-mini / code-execute-echo-token** [P2, effort L]: No action required — probe is passing.
30. **gpt-4o-mini / memory-write-then-search** [P2, effort L]: No action required — probe is passing.
31. **gpt-4o-mini / nova-secrets-write** [P2, effort L]: No action required — probe is passing.
32. **gpt-4o-mini / nova-secrets-read** [P2, effort L]: No action required — probe is passing.
33. **gpt-4o-mini / web-search-attempt** [P2, effort L]: Investigate audit harness timeout; check service health and probe setup/cleanup paths.

## Reproducibility

To reproduce this audit run:

```bash
make audit-tool-use
```

Environment variables required:

| Variable | Purpose |
| -------- | ------- |
| `ADMIN_SECRET` | Nova admin secret (`X-Admin-Secret` header) |
| `LLM_ROUTING_STRATEGY` | LLM routing strategy (e.g. `local-first`) |
| `LOCAL_INFERENCE_URL` | Base URL of local inference backend |
| `LOCAL_COMPLETION_MODEL` | Default local completion model |

Recorded strategy for this run: `unknown`  
Commit: `84ca86363c3b`  
Audit script SHA-256: `5de95334f0da`

## Trace evidence

<details>
<summary>qwen2.5-coder:7b / fs-write-roundtrip trial 0 — side_effect_verified</summary>

Trace file: `/home/jeremy/workspace/nova/.worktrees/engineer-agent-actually-uses-tools/docs/audits/2026-05-22-tool-use-audit/traces/fs-write-roundtrip__qwen2.5-coder:7b__t0.json`  
Latency: 13966 ms  
Outcome: `side_effect_verified`

</details>

<details>
<summary>qwen2.5-coder:7b / fs-read-echo trial 0 — called_ok</summary>

Trace file: `/home/jeremy/workspace/nova/.worktrees/engineer-agent-actually-uses-tools/docs/audits/2026-05-22-tool-use-audit/traces/fs-read-echo__qwen2.5-coder:7b__t0.json`  
Latency: 11908 ms  
Outcome: `called_ok`

</details>

<details>
<summary>qwen2.5-coder:7b / shell-exec-echo-token trial 0 — called_ok</summary>

Trace file: `/home/jeremy/workspace/nova/.worktrees/engineer-agent-actually-uses-tools/docs/audits/2026-05-22-tool-use-audit/traces/shell-exec-echo-token__qwen2.5-coder:7b__t0.json`  
Latency: 12063 ms  
Outcome: `called_ok`

</details>

<details>
<summary>qwen2.5-coder:7b / code-execute-echo-token trial 0 — called_ok</summary>

Trace file: `/home/jeremy/workspace/nova/.worktrees/engineer-agent-actually-uses-tools/docs/audits/2026-05-22-tool-use-audit/traces/code-execute-echo-token__qwen2.5-coder:7b__t0.json`  
Latency: 28277 ms  
Outcome: `called_ok`

</details>

<details>
<summary>qwen2.5-coder:7b / memory-write-then-search trial 0 — called_error</summary>

Trace file: `/home/jeremy/workspace/nova/.worktrees/engineer-agent-actually-uses-tools/docs/audits/2026-05-22-tool-use-audit/traces/memory-write-then-search__qwen2.5-coder:7b__t0.json`  
Latency: 14737 ms  
Outcome: `called_error`

</details>

<details>
<summary>qwen2.5-coder:7b / memory-search-verbatim-echo trial 0 — called_ok</summary>

Trace file: `/home/jeremy/workspace/nova/.worktrees/engineer-agent-actually-uses-tools/docs/audits/2026-05-22-tool-use-audit/traces/memory-search-verbatim-echo__qwen2.5-coder:7b__t0.json`  
Latency: 13468 ms  
Outcome: `called_ok`

</details>

<details>
<summary>qwen2.5-coder:7b / nova-secrets-write trial 0 — side_effect_verified</summary>

Trace file: `/home/jeremy/workspace/nova/.worktrees/engineer-agent-actually-uses-tools/docs/audits/2026-05-22-tool-use-audit/traces/nova-secrets-write__qwen2.5-coder:7b__t0.json`  
Latency: 10853 ms  
Outcome: `side_effect_verified`

</details>

<details>
<summary>qwen2.5-coder:7b / nova-secrets-read trial 0 — not_called</summary>

Trace file: `/home/jeremy/workspace/nova/.worktrees/engineer-agent-actually-uses-tools/docs/audits/2026-05-22-tool-use-audit/traces/nova-secrets-read__qwen2.5-coder:7b__t0.json`  
Latency: 21998 ms  
Outcome: `not_called`

</details>

<details>
<summary>qwen2.5-coder:7b / web-fetch-token-page trial 0 — called_ok</summary>

Trace file: `/home/jeremy/workspace/nova/.worktrees/engineer-agent-actually-uses-tools/docs/audits/2026-05-22-tool-use-audit/traces/web-fetch-token-page__qwen2.5-coder:7b__t0.json`  
Latency: 11966 ms  
Outcome: `called_ok`

</details>

<details>
<summary>qwen2.5-coder:7b / web-search-attempt trial 0 — called_ok</summary>

Trace file: `/home/jeremy/workspace/nova/.worktrees/engineer-agent-actually-uses-tools/docs/audits/2026-05-22-tool-use-audit/traces/web-search-attempt__qwen2.5-coder:7b__t0.json`  
Latency: 14067 ms  
Outcome: `called_ok`

</details>

<details>
<summary>gpt-4o-mini / fs-write-roundtrip trial 0 — side_effect_verified</summary>

Trace file: `/home/jeremy/workspace/nova/.worktrees/engineer-agent-actually-uses-tools/docs/audits/2026-05-22-tool-use-audit/traces/fs-write-roundtrip__gpt-4o-mini__t0.json`  
Latency: 7258 ms  
Outcome: `side_effect_verified`

</details>

<details>
<summary>gpt-4o-mini / fs-read-echo trial 0 — side_effect_verified</summary>

Trace file: `/home/jeremy/workspace/nova/.worktrees/engineer-agent-actually-uses-tools/docs/audits/2026-05-22-tool-use-audit/traces/fs-read-echo__gpt-4o-mini__t0.json`  
Latency: 3525 ms  
Outcome: `side_effect_verified`

</details>

<details>
<summary>gpt-4o-mini / shell-exec-echo-token trial 0 — side_effect_verified</summary>

Trace file: `/home/jeremy/workspace/nova/.worktrees/engineer-agent-actually-uses-tools/docs/audits/2026-05-22-tool-use-audit/traces/shell-exec-echo-token__gpt-4o-mini__t0.json`  
Latency: 4138 ms  
Outcome: `side_effect_verified`

</details>

<details>
<summary>gpt-4o-mini / code-execute-echo-token trial 0 — side_effect_verified</summary>

Trace file: `/home/jeremy/workspace/nova/.worktrees/engineer-agent-actually-uses-tools/docs/audits/2026-05-22-tool-use-audit/traces/code-execute-echo-token__gpt-4o-mini__t0.json`  
Latency: 3436 ms  
Outcome: `side_effect_verified`

</details>

<details>
<summary>gpt-4o-mini / memory-write-then-search trial 0 — side_effect_verified</summary>

Trace file: `/home/jeremy/workspace/nova/.worktrees/engineer-agent-actually-uses-tools/docs/audits/2026-05-22-tool-use-audit/traces/memory-write-then-search__gpt-4o-mini__t0.json`  
Latency: 5180 ms  
Outcome: `side_effect_verified`

</details>

<details>
<summary>gpt-4o-mini / memory-search-verbatim-echo trial 0 — called_ok</summary>

Trace file: `/home/jeremy/workspace/nova/.worktrees/engineer-agent-actually-uses-tools/docs/audits/2026-05-22-tool-use-audit/traces/memory-search-verbatim-echo__gpt-4o-mini__t0.json`  
Latency: 6021 ms  
Outcome: `called_ok`

</details>

<details>
<summary>gpt-4o-mini / nova-secrets-write trial 0 — side_effect_verified</summary>

Trace file: `/home/jeremy/workspace/nova/.worktrees/engineer-agent-actually-uses-tools/docs/audits/2026-05-22-tool-use-audit/traces/nova-secrets-write__gpt-4o-mini__t0.json`  
Latency: 3548 ms  
Outcome: `side_effect_verified`

</details>

<details>
<summary>gpt-4o-mini / nova-secrets-read trial 0 — side_effect_verified</summary>

Trace file: `/home/jeremy/workspace/nova/.worktrees/engineer-agent-actually-uses-tools/docs/audits/2026-05-22-tool-use-audit/traces/nova-secrets-read__gpt-4o-mini__t0.json`  
Latency: 3518 ms  
Outcome: `side_effect_verified`

</details>

<details>
<summary>gpt-4o-mini / web-fetch-token-page trial 0 — not_called</summary>

Trace file: `/home/jeremy/workspace/nova/.worktrees/engineer-agent-actually-uses-tools/docs/audits/2026-05-22-tool-use-audit/traces/web-fetch-token-page__gpt-4o-mini__t0.json`  
Latency: 17289 ms  
Outcome: `not_called`

</details>

<details>
<summary>gpt-4o-mini / web-search-attempt trial 0 — audit_infra_timeout</summary>

Trace file: `/home/jeremy/workspace/nova/.worktrees/engineer-agent-actually-uses-tools/docs/audits/2026-05-22-tool-use-audit/traces/web-search-attempt__gpt-4o-mini__t0.json`  
Latency: 90151 ms  
Outcome: `audit_infra_timeout`

</details>

<details>
<summary>gemini/gemini-1.5-flash / fs-write-roundtrip trial 0 — not_called</summary>

Trace file: `/home/jeremy/workspace/nova/.worktrees/engineer-agent-actually-uses-tools/docs/audits/2026-05-22-tool-use-audit/traces/fs-write-roundtrip__gemini_gemini-1.5-flash__t0.json`  
Latency: 490 ms  
Outcome: `not_called`

</details>

<details>
<summary>gemini/gemini-1.5-flash / fs-read-echo trial 0 — not_called</summary>

Trace file: `/home/jeremy/workspace/nova/.worktrees/engineer-agent-actually-uses-tools/docs/audits/2026-05-22-tool-use-audit/traces/fs-read-echo__gemini_gemini-1.5-flash__t0.json`  
Latency: 547 ms  
Outcome: `not_called`

</details>

<details>
<summary>gemini/gemini-1.5-flash / shell-exec-echo-token trial 0 — not_called</summary>

Trace file: `/home/jeremy/workspace/nova/.worktrees/engineer-agent-actually-uses-tools/docs/audits/2026-05-22-tool-use-audit/traces/shell-exec-echo-token__gemini_gemini-1.5-flash__t0.json`  
Latency: 237 ms  
Outcome: `not_called`

</details>

<details>
<summary>gemini/gemini-1.5-flash / code-execute-echo-token trial 0 — not_called</summary>

Trace file: `/home/jeremy/workspace/nova/.worktrees/engineer-agent-actually-uses-tools/docs/audits/2026-05-22-tool-use-audit/traces/code-execute-echo-token__gemini_gemini-1.5-flash__t0.json`  
Latency: 229 ms  
Outcome: `not_called`

</details>

<details>
<summary>gemini/gemini-1.5-flash / memory-write-then-search trial 0 — not_called</summary>

Trace file: `/home/jeremy/workspace/nova/.worktrees/engineer-agent-actually-uses-tools/docs/audits/2026-05-22-tool-use-audit/traces/memory-write-then-search__gemini_gemini-1.5-flash__t0.json`  
Latency: 264 ms  
Outcome: `not_called`

</details>

<details>
<summary>gemini/gemini-1.5-flash / memory-search-verbatim-echo trial 0 — not_called</summary>

Trace file: `/home/jeremy/workspace/nova/.worktrees/engineer-agent-actually-uses-tools/docs/audits/2026-05-22-tool-use-audit/traces/memory-search-verbatim-echo__gemini_gemini-1.5-flash__t0.json`  
Latency: 280 ms  
Outcome: `not_called`

</details>

<details>
<summary>gemini/gemini-1.5-flash / nova-secrets-write trial 0 — not_called</summary>

Trace file: `/home/jeremy/workspace/nova/.worktrees/engineer-agent-actually-uses-tools/docs/audits/2026-05-22-tool-use-audit/traces/nova-secrets-write__gemini_gemini-1.5-flash__t0.json`  
Latency: 219 ms  
Outcome: `not_called`

</details>

<details>
<summary>gemini/gemini-1.5-flash / nova-secrets-read trial 0 — not_called</summary>

Trace file: `/home/jeremy/workspace/nova/.worktrees/engineer-agent-actually-uses-tools/docs/audits/2026-05-22-tool-use-audit/traces/nova-secrets-read__gemini_gemini-1.5-flash__t0.json`  
Latency: 275 ms  
Outcome: `not_called`

</details>

<details>
<summary>gemini/gemini-1.5-flash / web-fetch-token-page trial 0 — not_called</summary>

Trace file: `/home/jeremy/workspace/nova/.worktrees/engineer-agent-actually-uses-tools/docs/audits/2026-05-22-tool-use-audit/traces/web-fetch-token-page__gemini_gemini-1.5-flash__t0.json`  
Latency: 221 ms  
Outcome: `not_called`

</details>

<details>
<summary>gemini/gemini-1.5-flash / web-search-attempt trial 0 — not_called</summary>

Trace file: `/home/jeremy/workspace/nova/.worktrees/engineer-agent-actually-uses-tools/docs/audits/2026-05-22-tool-use-audit/traces/web-search-attempt__gemini_gemini-1.5-flash__t0.json`  
Latency: 225 ms  
Outcome: `not_called`

</details>
