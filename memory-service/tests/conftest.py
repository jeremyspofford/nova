"""Pytest configuration for memory-service tests.

Real-DB fixtures live here (added in Tasks 1.4–1.10) and are auto-loaded
by pytest. Legacy mock fixtures live in conftest_legacy.py and must be
imported explicitly by tests still using them — never via pytest_plugins.
"""

from __future__ import annotations

# Real-DB fixtures will be appended below by Tasks 1.4–1.10.
