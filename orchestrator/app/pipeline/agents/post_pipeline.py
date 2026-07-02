"""Post-pipeline agents: Documentation, Diagramming, Security Review, Memory Extraction."""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any

from .base import BaseAgent, PipelineState

logger = logging.getLogger(__name__)


class DocumentationAgent(BaseAgent):
    ROLE = "documentation"
    DEFAULT_SYSTEM = (
        "You are a Documentation agent. After a pipeline task completes, produce a structured summary.\n\n"
        "Use EXACTLY this Markdown format:\n\n"
        "## What was requested\n[1-2 sentences summarizing the user's original request]\n\n"
        "## What was done\n[2-4 sentences describing the work performed and outcome]\n\n"
        "## Key decisions\n[Bullet list of decisions made and why, or 'None']\n\n"
        "## Files touched\n[List each file created or modified with a brief description, or 'None']\n\n"
        "## Open questions\n[Any unresolved issues or follow-up items, or 'None']"
    )

    async def run(self, state: PipelineState, agent_cfg=None, task_id: str = "", **kwargs) -> dict[str, Any]:
        task_output = state.completed.get("task", {})
        messages = [
            {"role": "system", "content": self.system_prompt},
            {"role": "user", "content": f"## Request\n{state.task_input}\n\n## Task Output\n{json.dumps(task_output, indent=2)}"},
        ]
        content, _model = await self._call_llm_full(messages)
        return {"content": content, "artifact_type": "documentation"}


class DiagrammingAgent(BaseAgent):
    ROLE = "diagramming"
    DEFAULT_SYSTEM = (
        "You are a Diagramming agent. Generate Mermaid diagrams illustrating changes.\n"
        "Choose appropriate types: flowchart, sequenceDiagram, classDiagram, erDiagram.\n"
        "Output Mermaid code blocks wrapped in ```mermaid fences."
    )

    async def run(self, state: PipelineState, agent_cfg=None, task_id: str = "", **kwargs) -> dict[str, Any]:
        task_output = state.completed.get("task", {})
        messages = [
            {"role": "system", "content": self.system_prompt},
            {"role": "user", "content": f"## Request\n{state.task_input}\n\n## Task Output\n{json.dumps(task_output, indent=2)}"},
        ]
        content, _model = await self._call_llm_full(messages)
        return {"content": content, "artifact_type": "diagram"}


class SecurityReviewAgent(BaseAgent):
    ROLE = "security_review"
    DEFAULT_SYSTEM = (
        "You are a Security Review agent. Scan code for OWASP Top 10 vulnerabilities.\n"
        "Output JSON: {\"findings\": [{\"category\": \"...\", \"severity\": \"low|medium|high|critical\", "
        "\"description\": \"...\", \"remediation\": \"...\"}]}\n"
        "If no issues: {\"findings\": []}"
    )

    async def run(self, state: PipelineState, agent_cfg=None, task_id: str = "", **kwargs) -> dict[str, Any]:
        task_output = state.completed.get("task", {})
        messages = [
            {"role": "system", "content": self.system_prompt},
            {"role": "user", "content": f"## Code to Review\n{json.dumps(task_output, indent=2)}"},
        ]
        content, _model = await self._call_llm_full(messages)
        try:
            return json.loads(content.strip())
        except json.JSONDecodeError:
            return {"findings": [], "raw": content, "artifact_type": "security_review"}


class MemoryExtractionAgent(BaseAgent):
    ROLE = "memory_extraction"
    DEFAULT_SYSTEM = (
        "You are a Memory Extraction agent. Distill the pipeline execution into structured memory.\n"
        "Output JSON: {\"summary\": \"...\", \"key_facts\": [\"...\"], \"decisions\": [\"...\"], \"patterns\": [\"...\"]}"
    )

    async def run(self, state: PipelineState, agent_cfg=None, task_id: str = "", **kwargs) -> dict[str, Any]:
        all_outputs = {k: v for k, v in state.completed.items() if not k.startswith("_")}
        messages = [
            {"role": "system", "content": self.system_prompt},
            {"role": "user", "content": f"## Request\n{state.task_input}\n\n## Pipeline Outputs\n{json.dumps(all_outputs, indent=2)}"},
        ]
        content, _model = await self._call_llm_full(messages)
        try:
            result = json.loads(content.strip())
        except json.JSONDecodeError:
            result = {"summary": content}

        # Push to engram ingestion queue
        try:
            from app.store import get_redis
            redis = get_redis()
            payload = json.dumps({
                "raw_text": f"Task: {state.task_input}\n\nExtraction: {json.dumps(result)}",
                "source_type": "pipeline",
                "source_id": task_id or None,
                "occurred_at": datetime.now(timezone.utc).isoformat(),
                "source_title": f"Pipeline extraction: {state.task_input[:80]}",
                "metadata": {"extraction_type": "pipeline_memory"},
            })
            await redis.lpush("memory:ingestion:queue", payload)
        except Exception as e:
            logger.warning(f"Memory extraction push failed (non-fatal): {e}")

        return result
