"""Suite-wide defaults.

THE EMBEDDER IS OFF UNLESS A TEST ASKS FOR IT.

MEMORY_EMBED_URL defaults to the bundled inference container
(http://ollama:11434) so the running deployment needs no configuration to get
semantic recall. That default would make this suite non-deterministic: on a
machine where the name `ollama` resolves and a model is pulled, /recall would
quietly become a hybrid search and the pinned numbers in
test_recall_quality.py would measure something other than what they claim to
— and on a machine where it does not resolve, every recall would pay a DNS
failure. A measurement that changes with the machine it runs on is not a
measurement.

So the environment is emptied here for every test, and the tests that want an
embedder set one up explicitly (a MockTransport, or — for the live pass in
test_recall_quality.py — a real one named by MEMORY_RECALL_EMBED_URL). The
default value itself is asserted in test_embedding.py rather than trusted,
because a default nothing checks is a default that can rot to anything.
"""

from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def embedder_off(monkeypatch):
    monkeypatch.setenv("MEMORY_EMBED_URL", "")
