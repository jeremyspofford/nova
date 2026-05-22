from audit_tool_use.probes import PROBES


def test_all_probes_have_unique_ids():
    ids = [p.id for p in PROBES]
    assert len(ids) == len(set(ids)), f"duplicate probe ids: {ids}"


def test_all_probes_have_required_fields():
    for p in PROBES:
        assert p.id
        assert p.tool
        assert "{run_id}" in p.prompt_template or "{token}" in p.prompt_template, \
            f"probe {p.id} doesn't reference run_id/token in prompt"
        assert p.tier in ("READ", "MUTATE")


def test_memory_search_probe_forces_verbatim_echo():
    """Per spec-reviewer note #2: probe prompt must demand verbatim echo."""
    p = next(p for p in PROBES if p.tool == "memory.search")
    assert "verbatim" in p.prompt_template.lower() or "exactly" in p.prompt_template.lower()


def test_probe_count_in_expected_range():
    assert 9 <= len(PROBES) <= 14
