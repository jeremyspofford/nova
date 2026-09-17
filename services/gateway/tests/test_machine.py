"""What the machine has right now — and what it says when it cannot tell.

`hardware.json` is written once by install.sh and never refreshed. It is the
right answer to "what is this box" and the wrong answer to every question an
operator asks while watching a slow turn. These pin the live reader, and in
particular pin that a reading which could not be taken is a stated absence
rather than a zero: "no free memory" and "we could not read free memory" are
opposite findings, and a panel that renders the second as the first is the
silence this codebase keeps hunting.
"""

from __future__ import annotations

from app import machine


class TestMeminfo:
    def test_reads_the_kb_values_by_key(self):
        parsed = machine._meminfo(
            "MemTotal:       32741234 kB\nMemAvailable:   18234123 kB\nHugePages_Total:  0\n"
        )
        assert parsed["MemTotal"] == 32741234
        assert parsed["MemAvailable"] == 18234123

    def test_a_line_it_cannot_read_is_skipped_not_fatal(self):
        # A kernel that changes this format must cost the reading, not the
        # request it was serving.
        parsed = machine._meminfo("MemTotal: not-a-number\nMemAvailable: 100 kB\nnonsense\n")
        assert "MemTotal" not in parsed
        assert parsed["MemAvailable"] == 100

    def test_an_empty_file_parses_to_nothing_rather_than_raising(self):
        assert machine._meminfo("") == {}


class TestMemory:
    def test_reports_available_not_free(self, monkeypatch, tmp_path):
        """MemFree excludes the page cache, which the kernel hands back the
        moment anything asks — reporting it makes a healthy machine look
        moments from death, and an operator who believes it closes the wrong
        thing."""
        fake = tmp_path / "meminfo"
        fake.write_text("MemTotal: 1048576 kB\nMemFree: 1024 kB\nMemAvailable: 524288 kB\n")
        monkeypatch.setattr("builtins.open", lambda *a, **k: fake.open(encoding="utf-8"))

        answer = machine.memory()
        assert answer["total_mb"] == 1024
        assert answer["available_mb"] == 512  # MemAvailable, not the 1 MiB of MemFree
        assert answer["reason"] is None

    def test_an_unreadable_file_states_why_and_reports_no_numbers(self, monkeypatch):
        def boom(*_a, **_k):
            raise OSError("permission denied")

        monkeypatch.setattr("builtins.open", boom)
        answer = machine.memory()
        assert answer["total_mb"] is None
        assert answer["available_mb"] is None
        assert "permission denied" in answer["reason"]

    def test_a_format_it_does_not_recognise_says_so(self, monkeypatch, tmp_path):
        fake = tmp_path / "meminfo"
        fake.write_text("Something: 1 kB\n")
        monkeypatch.setattr("builtins.open", lambda *a, **k: fake.open(encoding="utf-8"))
        answer = machine.memory()
        assert answer["total_mb"] is None
        assert "MemTotal" in answer["reason"]


class TestCpu:
    def test_load_travels_with_the_core_count(self):
        """8 means nothing until you know whether the box has four cores or
        sixty-four, so the reader never has to supply the denominator."""
        answer = machine.cpu()
        assert answer["reason"] is None
        assert isinstance(answer["cores"], int) and answer["cores"] >= 1
        assert isinstance(answer["load_1m"], float)


class TestDisk:
    def test_reports_the_path_it_was_asked_about(self, tmp_path):
        answer = machine.disk(str(tmp_path))
        assert answer["reason"] is None
        assert answer["total_gb"] > 0
        assert answer["free_gb"] >= 0

    def test_a_path_that_is_not_there_states_it(self):
        answer = machine.disk("/no/such/place")
        assert answer["free_gb"] is None
        assert answer["total_gb"] is None
        assert "/no/such/place" in answer["reason"]


def test_read_degrades_one_field_at_a_time(monkeypatch):
    """A panel showing three numbers and one stated blank is more useful
    than a panel showing an error."""
    monkeypatch.setattr(
        machine, "disk", lambda *_a: {"free_gb": None, "total_gb": None, "reason": "nope"}
    )
    everything = machine.read()
    assert everything["disk"]["reason"] == "nope"
    assert everything["memory"]["total_mb"] is not None
    assert everything["cpu"]["cores"] is not None
