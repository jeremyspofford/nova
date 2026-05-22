"""Report renderer for the tool-use audit.

Takes a list of TrialResult records and writes:
  - {date}-tool-use-audit.md  — human-readable markdown audit report
  - results.json              — machine-readable summary for regression diffs
Both reference per-trial trace JSON files in traces/ (written by the harness).
"""
from __future__ import annotations

import json
from collections import defaultdict
from pathlib import Path

from audit_tool_use.types import Outcome, TrialResult


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def render_report(
    trials: list[TrialResult],
    *,
    output_dir: Path,
    date: str,
    commit_sha: str,
    audit_script_sha: str,
    llm_routing_strategy: str,
    run_duration_seconds: int,
) -> str:
    """Render the audit report to output_dir and return the markdown string."""
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # Aggregate counts per (model, probe_id)
    stats = _aggregate(trials)

    # Write results.json
    run_id = trials[0].run_id if trials else "unknown"
    results_json = _build_results_json(
        stats=stats,
        run_id=run_id,
        date=date,
        commit_sha=commit_sha,
    )
    (output_dir / "results.json").write_text(
        json.dumps(results_json, indent=2), encoding="utf-8"
    )

    # Build and write markdown
    md = _build_markdown(
        stats=stats,
        trials=trials,
        date=date,
        commit_sha=commit_sha,
        audit_script_sha=audit_script_sha,
        llm_routing_strategy=llm_routing_strategy,
        run_duration_seconds=run_duration_seconds,
        run_id=run_id,
    )
    (output_dir / f"{date}-tool-use-audit.md").write_text(md, encoding="utf-8")

    return md


# ---------------------------------------------------------------------------
# Aggregation
# ---------------------------------------------------------------------------

class _ProbeStat:
    """Mutable accumulator for a single (model, probe_id) pair."""

    def __init__(self, model: str, probe_id: str, tool: str) -> None:
        self.model = model
        self.probe_id = probe_id
        self.tool = tool
        self.n_attempted = 0
        self.n_called_ok = 0          # CALLED_OK | SIDE_EFFECT_VERIFIED
        self.n_side_effect_verified = 0
        self.n_called_error = 0
        self.n_not_called = 0
        self.n_infra_timeout = 0
        self.traces: list[str] = []   # trace_path values

    def add(self, trial: TrialResult) -> None:
        self.n_attempted += 1
        o = trial.outcome
        if o == Outcome.SIDE_EFFECT_VERIFIED:
            self.n_side_effect_verified += 1
            self.n_called_ok += 1
        elif o == Outcome.CALLED_OK:
            self.n_called_ok += 1
        elif o == Outcome.CALLED_ERROR:
            self.n_called_error += 1
        elif o == Outcome.NOT_CALLED:
            self.n_not_called += 1
        elif o == Outcome.AUDIT_INFRA_TIMEOUT:
            self.n_infra_timeout += 1
        if trial.trace_path:
            self.traces.append(trial.trace_path)

    @property
    def severity(self) -> str:
        if self.n_attempted == 0:
            return "P2"
        if self.n_called_error / self.n_attempted >= 0.5:
            return "P0"
        if self.n_not_called / self.n_attempted >= 0.5:
            return "P1"
        return "P2"

    @property
    def category(self) -> str:
        if self.n_attempted == 0:
            return "unknown"
        # Infra dominates
        if self.n_infra_timeout / self.n_attempted >= 0.5:
            return "infra"
        # Wiring: model tries but tool errors
        if self.n_called_error / self.n_attempted >= 0.5:
            return "wiring"
        # Model: not reaching for the tool
        if self.n_not_called / self.n_attempted >= 0.5:
            return "model"
        # Prompt: model calls OK but side-effect never verified
        if self.n_called_ok > 0 and self.n_side_effect_verified == 0:
            return "prompt"
        return "passing"

    @property
    def effort(self) -> str:
        cat = self.category
        if cat == "prompt":
            return "S"
        if cat in ("wiring", "model"):
            return "M"
        # infra / new tool wiring
        return "L"

    @property
    def recommended_fix(self) -> str:
        cat = self.category
        if cat == "prompt":
            return "Refine system prompt to strengthen tool-use instruction for this probe."
        if cat == "model":
            return "Evaluate model tool-calling capability; consider switching model or adding few-shot examples."
        if cat == "wiring":
            return "Investigate tool routing/registration; check tool name matches model's registered tool schema."
        if cat == "infra":
            return "Investigate audit harness timeout; check service health and probe setup/cleanup paths."
        return "No action required — probe is passing."

    @property
    def failure_rate_pct(self) -> int:
        if self.n_attempted == 0:
            return 0
        return round(100 * (self.n_attempted - self.n_called_ok) / self.n_attempted)

    @property
    def impact_effort_sort_key(self) -> tuple[int, int]:
        """Lower = higher priority. P0+S=0,0; P2+L=2,2."""
        sev_order = {"P0": 0, "P1": 1, "P2": 2}
        eff_order = {"S": 0, "M": 1, "L": 2}
        return sev_order.get(self.severity, 2), eff_order.get(self.effort, 2)


def _aggregate(trials: list[TrialResult]) -> dict[tuple[str, str], _ProbeStat]:
    """Return a dict keyed by (model, probe_id) containing accumulated stats."""
    stats: dict[tuple[str, str], _ProbeStat] = {}
    for t in trials:
        key = (t.model, t.probe_id)
        if key not in stats:
            stats[key] = _ProbeStat(model=t.model, probe_id=t.probe_id, tool=t.tool)
        stats[key].add(t)
    return stats


# ---------------------------------------------------------------------------
# results.json builder
# ---------------------------------------------------------------------------

def _build_results_json(
    stats: dict[tuple[str, str], _ProbeStat],
    run_id: str,
    date: str,
    commit_sha: str,
) -> dict:
    # Group probe stats by model, preserving insertion order
    model_probes: dict[str, list[_ProbeStat]] = defaultdict(list)
    for (model, _probe_id), ps in stats.items():
        model_probes[model].append(ps)

    models_list = []
    for model, probe_stats in model_probes.items():
        probes_list = [
            {
                "probe_id": ps.probe_id,
                "tool": ps.tool,
                "n_attempted": ps.n_attempted,
                "n_called_ok": ps.n_called_ok,
                "n_side_effect_verified": ps.n_side_effect_verified,
            }
            for ps in probe_stats
        ]
        models_list.append({"model_id": model, "probes": probes_list})

    return {
        "run_id": run_id,
        "date": date,
        "commit_sha": commit_sha,
        "models": models_list,
    }


# ---------------------------------------------------------------------------
# Markdown builder
# ---------------------------------------------------------------------------

def _build_markdown(
    stats: dict[tuple[str, str], _ProbeStat],
    trials: list[TrialResult],
    date: str,
    commit_sha: str,
    audit_script_sha: str,
    llm_routing_strategy: str,
    run_duration_seconds: int,
    run_id: str,
) -> str:
    all_probes = list(stats.values())

    # Per-model totals for TL;DR
    model_totals: dict[str, dict] = defaultdict(lambda: {
        "tools_tested": 0, "pass_rate_sum": 0, "p0_count": 0
    })
    for ps in all_probes:
        mt = model_totals[ps.model]
        mt["tools_tested"] += 1
        # pass = all trials side-effect verified
        probe_pass = ps.n_side_effect_verified == ps.n_attempted and ps.n_attempted > 0
        mt["pass_rate_sum"] += 1 if probe_pass else 0
        if ps.severity == "P0":
            mt["p0_count"] += 1

    sections: list[str] = []

    # --- Frontmatter ---
    total_trials = len(trials)
    total_models = len(model_totals)
    sections.append(
        f"---\n"
        f"date: {date}\n"
        f"commit_sha: {commit_sha}\n"
        f"audit_script_sha256: {audit_script_sha}\n"
        f"llm_routing_strategy: {llm_routing_strategy}\n"
        f"run_duration_seconds: {run_duration_seconds}\n"
        f"run_id: {run_id}\n"
        f"total_trials: {total_trials}\n"
        f"total_models: {total_models}\n"
        f"---\n"
    )

    sections.append("# Tool-Use Audit Report\n")

    # --- TL;DR table ---
    tldr_rows = ["| Model | Tools tested | Pass rate | P0 count |",
                 "| ----- | ------------ | --------- | -------- |"]
    for model, mt in sorted(model_totals.items()):
        n_tools = mt["tools_tested"]
        pass_rate = f"{mt['pass_rate_sum']}/{n_tools}" if n_tools else "0/0"
        tldr_rows.append(f"| {model} | {n_tools} | {pass_rate} | {mt['p0_count']} |")
    sections.append("## TL;DR\n\n" + "\n".join(tldr_rows) + "\n")

    # --- Findings ---
    finding_lines = ["## Findings\n"]
    for ps in sorted(all_probes, key=lambda p: p.impact_effort_sort_key):
        finding_lines.append(f"### {ps.model} / {ps.probe_id}\n")
        finding_lines.append(f"**Severity:** {ps.severity}  ")
        finding_lines.append(f"**Category:** {ps.category}  ")
        finding_lines.append(f"**Tool:** `{ps.tool}`  ")
        finding_lines.append(f"**Failure rate:** {ps.failure_rate_pct}%  ")
        finding_lines.append(f"**Recommended fix:** {ps.recommended_fix}  ")
        finding_lines.append(f"**Effort:** {ps.effort}\n")
        if ps.traces:
            finding_lines.append(f"Trace evidence: {', '.join(f'[trace]({t})' for t in ps.traces)}\n")
    sections.append("\n".join(finding_lines))

    # --- Recommendations (ranked P0+S first, P2+L last) ---
    rec_lines = ["## Recommendations\n"]
    ranked = sorted(all_probes, key=lambda p: p.impact_effort_sort_key)
    for i, ps in enumerate(ranked, start=1):
        rec_lines.append(
            f"{i}. **{ps.model} / {ps.probe_id}** "
            f"[{ps.severity}, effort {ps.effort}]: {ps.recommended_fix}"
        )
    sections.append("\n".join(rec_lines) + "\n")

    # --- Reproducibility ---
    repro = (
        "## Reproducibility\n\n"
        "To reproduce this audit run:\n\n"
        "```bash\n"
        "make audit-tool-use\n"
        "```\n\n"
        "Environment variables required:\n\n"
        "| Variable | Purpose |\n"
        "| -------- | ------- |\n"
        "| `ADMIN_SECRET` | Nova admin secret (`X-Admin-Secret` header) |\n"
        "| `LLM_ROUTING_STRATEGY` | LLM routing strategy (e.g. `local-first`) |\n"
        "| `LOCAL_INFERENCE_URL` | Base URL of local inference backend |\n"
        "| `LOCAL_COMPLETION_MODEL` | Default local completion model |\n"
        f"\nRecorded strategy for this run: `{llm_routing_strategy}`  \n"
        f"Commit: `{commit_sha}`  \n"
        f"Audit script SHA-256: `{audit_script_sha}`\n"
    )
    sections.append(repro)

    # --- Trace evidence (collapsed) ---
    trace_lines = ["## Trace evidence\n"]
    for t in trials:
        if t.trace_path:
            trace_lines.append(
                f"<details>\n"
                f"<summary>{t.model} / {t.probe_id} trial {t.trial_n} "
                f"— {t.outcome.value}</summary>\n\n"
                f"Trace file: `{t.trace_path}`  \n"
                f"Latency: {t.latency_ms} ms  \n"
                f"Outcome: `{t.outcome.value}`\n\n"
                f"</details>\n"
            )
    sections.append("\n".join(trace_lines))

    return "\n".join(sections)
