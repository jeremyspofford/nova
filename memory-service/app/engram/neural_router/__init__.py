"""Neural Router — learned re-ranker for personalized memory retrieval."""

# 9 engram types matching the engrams table
ENGRAM_TYPES = [
    "fact",
    "episode",
    "entity",
    "preference",
    "procedure",
    "schema",
    "goal",
    "self_model",
    "topic",
]

# Types excluded from neural reranking (index nodes, not retrieval content)
RERANK_EXCLUDED_TYPES = {"topic"}
