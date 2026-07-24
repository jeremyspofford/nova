"""Model eval harness — champion/challenger quality grading.

docs/plans/model-eval-pipeline.md. Phase 1 is the harness core: a sandboxed
memory store, frozen tool fixtures, and a runner that puts two models through
the same task. Grading, storage and the UI are later phases.

    python -m app.evals list
    python -m app.evals run ingestion/research-and-write-topic \\
        --champion openrouter:z-ai/glm-5.2 --challenger ollama:qwen3:8b
"""

from app.evals.runner import RunResult, run_pair, run_task
from app.evals.suites import Suite, Task, list_suites, load_suite, resolve

__all__ = ["RunResult", "Suite", "Task", "list_suites", "load_suite",
           "resolve", "run_pair", "run_task"]
