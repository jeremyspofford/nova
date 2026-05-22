import json
from pathlib import Path
from audit_tool_use.render import render_report
from audit_tool_use.types import Outcome, TrialResult


def _sample_trials():
    return [
        TrialResult(probe_id="fs-write-roundtrip", tool="fs.write", model="llama3.2",
                    trial_n=0, outcome=Outcome.SIDE_EFFECT_VERIFIED, latency_ms=1200,
                    error_msg=None, trace_path="traces/fs-write-roundtrip__llama3.2__t0.json",
                    cleanup_failed=False, run_id="abc"),
        TrialResult(probe_id="fs-write-roundtrip", tool="fs.write", model="llama3.2",
                    trial_n=1, outcome=Outcome.NOT_CALLED, latency_ms=900,
                    error_msg=None, trace_path="traces/fs-write-roundtrip__llama3.2__t1.json",
                    cleanup_failed=False, run_id="abc"),
    ]


def test_markdown_has_required_frontmatter(tmp_path):
    out = render_report(_sample_trials(), output_dir=tmp_path, date="2026-05-22",
                        commit_sha="abc1234", audit_script_sha="def5678",
                        llm_routing_strategy="local-first", run_duration_seconds=42)
    md = (tmp_path / "2026-05-22-tool-use-audit.md").read_text()
    assert "date: 2026-05-22" in md
    assert "commit_sha: abc1234" in md
    assert "audit_script_sha256: def5678" in md
    assert "llm_routing_strategy: local-first" in md
    assert "run_duration_seconds: 42" in md


def test_markdown_has_tldr_table(tmp_path):
    render_report(_sample_trials(), output_dir=tmp_path, date="2026-05-22",
                  commit_sha="abc", audit_script_sha="def",
                  llm_routing_strategy="local-first", run_duration_seconds=0)
    md = (tmp_path / "2026-05-22-tool-use-audit.md").read_text()
    assert "## TL;DR" in md
    assert "| Model |" in md
    assert "llama3.2" in md


def test_finding_blocks_have_required_fields(tmp_path):
    render_report(_sample_trials(), output_dir=tmp_path, date="2026-05-22",
                  commit_sha="abc", audit_script_sha="def",
                  llm_routing_strategy="local-first", run_duration_seconds=0)
    md = (tmp_path / "2026-05-22-tool-use-audit.md").read_text()
    assert "**Severity:**" in md
    assert "**Category:**" in md
    assert "**Recommended fix:**" in md
    assert "**Effort:**" in md


def test_traces_referenced_as_collapsed_details(tmp_path):
    render_report(_sample_trials(), output_dir=tmp_path, date="2026-05-22",
                  commit_sha="abc", audit_script_sha="def",
                  llm_routing_strategy="local-first", run_duration_seconds=0)
    md = (tmp_path / "2026-05-22-tool-use-audit.md").read_text()
    assert "<details>" in md
    assert "traces/" in md


def test_results_json_schema(tmp_path):
    render_report(_sample_trials(), output_dir=tmp_path, date="2026-05-22",
                  commit_sha="abc", audit_script_sha="def",
                  llm_routing_strategy="local-first", run_duration_seconds=0)
    js = json.loads((tmp_path / "results.json").read_text())
    assert "run_id" in js
    assert "models" in js
    assert isinstance(js["models"], list)
    assert js["models"][0]["model_id"] == "llama3.2"
    probe = js["models"][0]["probes"][0]
    assert "n_attempted" in probe
    assert "n_called_ok" in probe
    assert "n_side_effect_verified" in probe


def test_reproducibility_block_present(tmp_path):
    render_report(_sample_trials(), output_dir=tmp_path, date="2026-05-22",
                  commit_sha="abc", audit_script_sha="def",
                  llm_routing_strategy="local-first", run_duration_seconds=0)
    md = (tmp_path / "2026-05-22-tool-use-audit.md").read_text()
    assert "## Reproducibility" in md
    assert "make audit-tool-use" in md


def test_recommendations_ranked_by_impact_to_effort(tmp_path):
    md = render_report(_sample_trials(), output_dir=tmp_path, date="2026-05-22",
                       commit_sha="abc", audit_script_sha="def",
                       llm_routing_strategy="local-first", run_duration_seconds=0)
    assert (tmp_path / "2026-05-22-tool-use-audit.md").exists()
    text = (tmp_path / "2026-05-22-tool-use-audit.md").read_text()
    rec_idx = text.find("## Recommendations")
    repro_idx = text.find("## Reproducibility")
    assert rec_idx > 0 and repro_idx > rec_idx
